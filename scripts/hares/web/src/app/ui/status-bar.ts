import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BarSegment } from '../core/session-view';

const LOOK: Record<BarSegment['phase'], string> = {
  waiting: 'bg-amber text-on-amber',
  working: 'bg-teal text-on-teal',
  idle: 'bg-raised text-muted',
  neutral: 'bg-raised text-muted',
};

/**
 * How many sessions wait, work and idle, as one bar. It replaces any ring or circle: each group is a
 * segment whose width follows its count and whose words say what it is.
 */
@Component({
  selector: 'hares-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'img', class: 'flex gap-0.75', '[attr.aria-label]': 'label()', '[class.h-12]': '!compact()', '[class.h-11]': 'compact()' },
  template: `
    @for (segment of segments(); track segment.phase; let first = $first; let last = $last) {
      <span class="flex items-center gap-1.25 overflow-hidden px-3.5 whitespace-nowrap" [class]="look(segment) + (compact() ? ' text-sm' : ' text-[14.5px]')"
        [style.flex]="segment.flex" [style.border-radius]="radius(first, last)" [style.box-shadow]="segment.phase === 'waiting' ? '0 0 28px var(--glow)' : null">
        @if (segment.n) { <b class="tnum font-bold">{{ segment.n }}</b> }
        <span class="font-medium">{{ segment.word }}</span>
      </span>
    }
  `,
})
export class StatusBar {
  readonly segments = input.required<BarSegment[]>();
  readonly label = input.required<string>();
  readonly compact = input(false);
  protected look = (segment: BarSegment): string => LOOK[segment.phase];
  protected radius = (first: boolean, last: boolean): string => (first && last ? '14px' : first ? '14px 4px 4px 14px' : last ? '4px 14px 14px 4px' : '4px');
}
