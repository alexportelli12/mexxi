import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A message strip. `status` is announced politely; `alert` interrupts, for errors. */
@Component({
  selector: 'segwi-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.role]': 'tone() === "error" ? "alert" : "status"',
    '[attr.aria-live]': 'tone() === "error" ? "assertive" : "polite"',
    '[class]': '"flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-3 text-[15px] " + (tone() === "error" ? "border-failed text-text" : "border-border-strong bg-surface-raised text-text")',
  },
  template: `
    <span class="flex items-center gap-2">
      @if (tone() === 'error') {
        <svg class="size-4 shrink-0 text-failed" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
      }
      <span><ng-content /></span>
    </span>
    <ng-content select="[bannerAction]" />
  `,
})
export class Banner {
  readonly tone = input<'info' | 'error'>('info');
}
