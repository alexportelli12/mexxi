import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { LiveService } from '../core/live';
import { RelativeTime } from '../core/relative-time';
import { FILTERS, filterGroups, groupRuns, parseFilter } from '../core/runs-order';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { NotificationsSetting } from '../ui/notifications-setting';
import { SandboxBanner } from '../ui/sandbox-banner';
import { Skeleton } from '../ui/skeleton';
import { StatusPill } from '../ui/status-pill';
import { actionLabels, commandFor, titles } from '../words';
import type { Run } from '../models';

@Component({
  imports: [NgTemplateOutlet, RouterLink, Banner, Button, Card, EmptyState, NotificationsSetting, RelativeTime, SandboxBanner, Skeleton, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold">{{ title }}</h1>

    <segwi-sandbox-banner />

    <nav class="flex flex-wrap gap-2" aria-label="Filter runs">
      @for (chip of filters; track chip.id) {
        <a [routerLink]="[]" [queryParams]="{ filter: chip.id === 'all' ? null : chip.id }" replaceUrl
          [attr.aria-current]="filter() === chip.id ? 'true' : null"
          class="inline-flex min-h-11 items-center rounded-full border px-4 text-[15px]"
          [class]="filter() === chip.id ? 'border-accent bg-(--accent-soft) text-text' : 'border-border-strong text-muted hover:text-text'">{{ chip.label }}</a>
      }
    </nav>

    @if (!live.loaded()) {
      <segwi-skeleton height="6.5rem" /><segwi-skeleton height="6.5rem" /><segwi-skeleton height="6.5rem" />
    } @else if (live.loadError() && !live.runs().length) {
      <segwi-banner tone="error">
        Couldn't load runs. {{ live.loadError() }}
        <button bannerAction segwi-button type="button" (click)="live.refresh()">Retry</button>
      </segwi-banner>
    } @else if (!live.runs().length) {
      <segwi-empty-state title="No runs yet" hint="Start one and it shows up here, with every step as it happens.">
        <a segwi-button variant="primary" routerLink="/new">Start a run</a>
      </segwi-empty-state>
    } @else {
      @if (groups().needs.length) {
        <section aria-labelledby="needs-heading" class="flex flex-col gap-3">
          <h2 id="needs-heading" class="text-sm font-medium tracking-wide text-needs-you uppercase">Needs you</h2>
          @for (run of groups().needs; track run.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ run }" /> }
        </section>
      }
      @if (groups().rest.length) {
        <section aria-labelledby="rest-heading" class="flex flex-col gap-3">
          @if (groups().needs.length) { <h2 id="rest-heading" class="text-sm font-medium tracking-wide text-muted uppercase">Everything else</h2> }
          @for (run of groups().rest; track run.id) { <ng-container [ngTemplateOutlet]="card" [ngTemplateOutletContext]="{ run }" /> }
        </section>
      }
      @if (!groups().needs.length && !groups().rest.length) {
        <segwi-empty-state title="Nothing here" hint="No runs match this filter." />
      }
    }

    <div class="lg:hidden"><segwi-notifications-setting /></div>
    <p class="lg:hidden"><a routerLink="/audit" class="inline-flex min-h-11 items-center text-muted underline underline-offset-4">Audit log</a></p>

    <ng-template #card let-run="run">
      <a [routerLink]="['/runs', run.id]" class="block rounded-card focus-visible:outline-offset-2">
        <segwi-card class="flex flex-col gap-2 transition-colors hover:border-border-strong">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <segwi-status-pill [status]="run.status" [reason]="run.reason" />
            <span class="text-sm text-muted"><segwi-time [iso]="run.lastActivityAt" /></span>
          </div>
          <p class="line-clamp-2 text-[15px] break-words">{{ run.task }}</p>
          <p class="flex flex-wrap gap-x-3 text-sm text-muted"><span class="font-code">{{ run.repo }}</span><span>{{ actionText(run) }}</span></p>
        </segwi-card>
      </a>
    </ng-template>
  `,
})
export class RunsPage {
  protected readonly live = inject(LiveService);
  protected readonly title = titles.runs;
  protected readonly filters = FILTERS;
  protected readonly filter = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((params) => parseFilter(params.get('filter')))), { initialValue: 'all' as const });
  protected readonly groups = computed(() => filterGroups(groupRuns(this.live.runs(), this.live.approvals()), this.filter()));

  protected actionText(run: Run): string {
    const command = commandFor(run.action);
    return command ? `${actionLabels[run.action]} ${command}` : actionLabels[run.action];
  }
}
