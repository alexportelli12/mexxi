import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { Icon } from './icon';

/** Copies `text` and says so out loud; where the clipboard API is blocked it selects the text to copy by hand. */
@Component({
  selector: 'hares-copy-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center' },
  template: `
    <button type="button" class="inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] text-muted hover:text-text" (click)="copy()" [attr.aria-label]="'Copy ' + label()">
      <hares-icon name="copy" [size]="18" />
    </button>
    <span class="sr-only" role="status" aria-live="polite">{{ message() }}</span>
  `,
})
export class CopyButton {
  readonly text = input.required<string>();
  readonly label = input('text');
  protected readonly message = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected async copy(): Promise<void> {
    let copied = false;
    try {
      await navigator.clipboard.writeText(this.text());
      copied = true;
    } catch {
      copied = this.selectAndCopy();
    }
    this.message.set(copied ? 'Copied' : 'Select the text and copy it');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(''), 2000);
  }

  /** The fallback: select the text in a hidden field, which is also what a person would do by hand. */
  private selectAndCopy(): boolean {
    const field = document.createElement('textarea');
    field.value = this.text();
    field.setAttribute('readonly', '');
    field.classList.add('fixed', 'opacity-0');
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}
