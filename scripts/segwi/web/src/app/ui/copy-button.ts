import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { Button } from './button';

/** Copies `text` and says so out loud; where the clipboard API is blocked it selects the text to copy by hand. */
@Component({
  selector: 'segwi-copy-button',
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center' },
  template: `
    <button segwi-button variant="ghost" type="button" (click)="copy()" [attr.aria-label]="'Copy ' + label()">
      <svg class="size-4" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
      <span class="text-sm">Copy</span>
    </button>
    <span class="sr-only" role="status" aria-live="polite">{{ message() }}</span>
    @if (message()) { <span class="text-sm text-muted" aria-hidden="true">{{ message() }}</span> }
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
    field.style.position = 'fixed';
    field.style.opacity = '0';
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
