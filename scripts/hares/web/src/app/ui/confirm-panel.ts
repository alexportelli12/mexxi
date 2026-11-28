import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Button } from './button';
import { Icon } from './icon';

/**
 * The confirm step for anything that can't be taken back: a red-tinted panel that says what will happen, shows
 * the exact rule when there is one, and offers "keep" or "do it". Nothing is sent until the second button.
 */
@Component({
  selector: 'hares-confirm-panel',
  imports: [Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3 rounded-2xl bg-red-soft p-4', role: 'group', '[attr.aria-label]': 'label()' },
  template: `
    <div class="flex items-start gap-2.5">
      @if (shield()) { <span class="mt-0.5 inline-flex text-red"><hares-icon name="shield" [size]="18" /></span> }
      <p class="text-[15px] leading-[1.45]"><ng-content /></p>
    </div>
    @if (code()) { <code class="ml-7 self-start rounded-lg bg-bg px-2.5 py-1.5 font-mono text-[13.5px] text-text">{{ code() }}</code> }
    <div class="flex gap-2">
      <button hares-button size="sm" class="flex-1" type="button" (click)="cancelled.emit()">{{ cancelLabel() }}</button>
      <button hares-button size="sm" variant="danger" class="flex-[1.2]" type="button" [disabled]="busy()" (click)="confirmed.emit()">{{ confirmLabel() }}</button>
    </div>
  `,
})
export class ConfirmPanel {
  readonly label = input.required<string>();
  readonly cancelLabel = input('Keep it');
  readonly confirmLabel = input.required<string>();
  /** The exact rule or target, shown in code. */
  readonly code = input<string | null>(null);
  readonly shield = input(false);
  readonly busy = input(false);
  readonly cancelled = output<void>();
  readonly confirmed = output<void>();
}
