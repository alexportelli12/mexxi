import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { now } from '../core/clock';
import { phaseOf, shortAge } from '../core/session-view';
import type { Session } from '../models';
import { Lantern } from './lantern';

/** One session in a list: the lantern, the title with its age, what it is doing, and its repo. */
@Component({
  selector: 'hares-session-row',
  imports: [Lantern, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <a [routerLink]="['/s', session().id]" class="flex items-start gap-3.5 border-b border-line py-4 text-text no-underline" [class.opacity-50]="dim()">
      <hares-lantern class="mt-1.5" [phase]="phase()" />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex items-baseline justify-between gap-3">
          <span class="truncate text-base leading-[1.3] font-medium">{{ session().title }}</span>
          <span class="tnum flex-none text-[13.5px] text-faint">{{ age() }}</span>
        </span>
        <span class="truncate text-[14.5px] leading-[1.35]" [class]="phase() === 'waiting' ? 'text-amber-text' : phase() === 'working' ? 'text-muted' : 'text-faint'">{{ session().line }}</span>
        <span class="text-[13.5px] leading-[1.3] text-faint">{{ session().repo || 'No repo' }}</span>
      </span>
    </a>
  `,
})
export class SessionRow {
  readonly session = input.required<Session>();
  /** Shown at half strength while atlas can't be seen: what is listed may be out of date. */
  readonly dim = input(false);
  protected readonly phase = computed(() => (this.session().alive ? phaseOf(this.session().status) : 'idle'));
  protected readonly age = computed(() => shortAge(this.session().lastActivityAt, now()));
}
