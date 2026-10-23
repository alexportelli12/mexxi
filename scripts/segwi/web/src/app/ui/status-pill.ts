import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { RunStatus } from '../models';
import { STATUS, statusCopy } from '../status';

/** A run's state as an icon and words. The words are always visible; colour only reinforces. */
@Component({
  selector: 'segwi-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '"inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1 text-sm font-medium " + info().tone',
    '[attr.aria-live]': 'live() ? "polite" : null',
  },
  template: `
    <svg class="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      @switch (info().icon) {
        @case ('clock') { <circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /> }
        @case ('spinner') { <path class="origin-center motion-safe:animate-spin" d="M8 2a6 6 0 1 0 6 6" /> }
        @case ('bubble') { <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /> }
        @case ('shield') { <path d="M8 1.5l5 2v4c0 3-2 5-5 7-3-2-5-4-5-7v-4z" /> }
        @case ('check') { <path d="M3 8.5l3.2 3L13 4.5" /> }
        @case ('cross') { <path d="M4 4l8 8M12 4l-8 8" /> }
        @case ('square') { <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /> }
      }
    </svg>
    <span>{{ copy() }}</span>
  `,
})
export class StatusPill {
  readonly status = input.required<RunStatus>();
  readonly reason = input<string | null>(null);
  /** Announce changes politely: set on the pill of the run that is open. */
  readonly live = input(false);
  protected readonly info = computed(() => STATUS[this.status()]);
  protected readonly copy = computed(() => statusCopy(this.status(), { reason: this.reason() }));
}
