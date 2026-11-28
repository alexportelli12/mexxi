import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService, failureMessage } from '../core/api';
import { FILTERS, groupByDay } from '../core/activity';
import { now } from '../core/clock';
import type { ActivityKind, AuditRow } from '../models';
import { Banner } from '../ui/banner';
import { BackLink } from '../ui/back-link';
import { ChipRow } from '../ui/chip-row';
import { Skeleton } from '../ui/skeleton';
import { brand } from '../words';

const TONE: Record<ActivityKind, string> = { answer: 'bg-amber', merge: 'bg-teal', session: 'bg-teal', rule: 'bg-red', ci: 'bg-muted', other: 'bg-muted' };
/** How many rows one load reads: 90 days of one person's actions is well within it. */
const LIMIT = 500;

/** Everything done from the app, grouped by day. The server keeps 90 days. */
@Component({
  imports: [Banner, BackLink, ChipRow, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1' },
  template: `
    <header class="flex items-center px-3.5 pt-2"><hares-back-link to="/settings" label="Settings" /></header>
    <main class="flex flex-col px-5 pt-3 pb-12">
      <h1 class="text-[30px] leading-[1.1] font-semibold tracking-[-0.026em]">Activity</h1>
      <p class="mt-3 max-w-[32ch] text-base leading-[1.45] text-muted">Everything you did from {{ brand }}, kept for 90 days.</p>
      <hares-chip-row class="mt-5" label="Show" [chips]="filters" [value]="filter()" (chosen)="filter.set($any($event))" />
      @if (error(); as message) {
        <hares-banner class="mt-6" kind="error">{{ message }}</hares-banner>
      } @else if (!rows()) {
        <hares-skeleton class="mt-8" [count]="4" />
      } @else {
        @for (day of days(); track day.name) {
          <section class="mt-8 flex flex-col" [attr.aria-label]="day.name">
            <div class="sect-head"><h2>{{ day.name }}</h2></div>
            @for (item of day.items; track item.id) {
              <div class="flex items-start gap-3.5 border-b border-line py-3.5">
                <span aria-hidden="true" class="mt-1.75 size-2 flex-none rounded-full" [class]="tone[item.kind]"></span>
                <span class="flex flex-1 flex-col gap-0.75">
                  <span class="text-[15.5px] leading-[1.4]">{{ item.text }}</span>
                  @if (item.where) { <span class="text-[13.5px] text-faint">{{ item.where }}</span> }
                </span>
                <span class="tnum flex-none text-[13.5px] text-faint">{{ item.time }}</span>
              </div>
            }
          </section>
        }
        @if (!days().length) { <p class="mt-8 text-[15px] text-muted">Nothing here yet.</p> }
      }
    </main>
  `,
})
export class ActivityPage {
  private readonly api = inject(ApiService);
  protected readonly brand = brand;
  protected readonly filters = FILTERS;
  protected readonly tone = TONE;
  protected readonly filter = signal<ActivityKind | 'all'>('all');
  protected readonly rows = signal<AuditRow[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly days = computed(() => groupByDay(this.rows() ?? [], this.filter(), now()));

  constructor() {
    this.api.audit(LIMIT).then((rows) => this.rows.set(rows), (error) => this.error.set(failureMessage(error)));
  }
}
