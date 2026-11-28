import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LiveService } from '../core/live';
import { QueueTapGuard } from '../core/tap-guard';
import { barLabel, barSegments, clockTime, heading } from '../core/session-view';
import { Viewport } from '../core/viewport';
import type { PrSummary } from './github/models';
import { relativeTime } from '../core/time';
import { now } from '../core/clock';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Lantern } from '../ui/lantern';
import { PermissionSummary } from '../ui/permission-summary';
import { QuestionCard } from '../ui/question-card';
import { SessionRow } from '../ui/session-row';
import { Skeleton } from '../ui/skeleton';
import { StatusBar } from '../ui/status-bar';
import { brand } from '../words';
import { CockpitPage } from './cockpit';

/**
 * Now: what needs you, at a glance. A headline says how many sessions wait, one bar counts them, and the
 * question that has waited longest is open right there. Several waiting questions show "1 of 3" with
 * previous and next, each answered on its own. Below, every session on the machine and the pull requests
 * waiting for your review. On a desktop the same data is the cockpit.
 */
@Component({
  imports: [Banner, Button, CockpitPage, Icon, Lantern, PermissionSummary, QuestionCard, RouterLink, SessionRow, Skeleton, StatusBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1' },
  template: `
    @if (viewport.desktop()) {
      <hares-cockpit />
    } @else {
      <header class="flex items-center justify-between px-5 pt-3">
        <span class="flex items-center gap-4">
          <span class="inline-flex min-h-11 items-center gap-2.5">
            <hares-lantern [phase]="live.counts().waiting ? 'waiting' : live.counts().working ? 'working' : 'idle'" />
            <span class="text-xl font-bold tracking-[-0.025em]">{{ brand }}</span>
          </span>
          <span class="inline-flex items-center gap-1.5 text-[13px] font-medium" [class]="live.offline() ? 'text-red' : 'text-teal'">
            <span aria-hidden="true" class="size-1.5 rounded-full" [class]="live.offline() ? 'bg-red' : 'bg-teal'"></span>{{ host() }} {{ live.offline() ? 'offline' : 'live' }}
          </span>
        </span>
        <span class="flex items-center gap-1">
          <a routerLink="/settings" aria-label="Settings" class="inline-flex size-11 items-center justify-center rounded-full text-muted no-underline"><hares-icon name="gear" [size]="22" /></a>
          <a routerLink="/start" aria-label="Start a session" class="inline-flex size-12 items-center justify-center rounded-full bg-amber text-on-amber no-underline shadow-[0_8px_24px_-10px_var(--amber)]"><hares-icon name="plus" [size]="22" /></a>
        </span>
      </header>

      @if (live.offline()) {
        <hares-banner class="mx-5 mt-4" kind="error">
          Can’t reach {{ host() }}.@if (lastSeen()) { You’re seeing what it showed at {{ lastSeen() }}. }
          <button action hares-button size="sm" variant="quiet" type="button" (click)="live.refresh()">Retry</button>
        </hares-banner>
      }
      @if (sent(); as what) {
        <hares-banner class="mx-5 mt-4" kind="ok">Answer sent. The session is working again.</hares-banner>
      }

      <div class="flex flex-col gap-8 px-5 pt-6 pb-8">
        <section class="flex flex-col">
          <h1 class="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em]">{{ top().title }}</h1>
          <p class="mt-3 max-w-[32ch] text-base leading-[1.45] text-muted">{{ top().sub }}</p>
          @if (live.loaded()) {
            <hares-status-bar class="mt-6" [segments]="segments()" [label]="barText()" />
          }
        </section>

        @if (!live.loaded()) {
          <hares-skeleton [count]="4" />
        } @else {
          @if (!live.offline() && current(); as pending) {
            @if (pending.kind === 'question') {
              <hares-question-card [pending]="pending" [queue]="position()" (previous)="step(-1)" (next)="step(1)" (sent)="onSent()" />
            } @else {
              <hares-permission-summary [pending]="pending" [queue]="position()" (previous)="step(-1)" (next)="step(1)" />
            }
          }

          @if (live.held().length) {
            <section aria-labelledby="h-held" class="flex flex-col">
              <div class="sect-head"><h2 id="h-held">Held while you were away</h2><span class="text-[13.5px] text-faint">{{ live.held().length }}</span></div>
              @for (entry of live.held(); track entry.id) {
                <a [routerLink]="entry.url" (click)="live.markHeldSeen([entry.id])" class="flex flex-col gap-1 border-b border-line py-3.5 text-text no-underline">
                  <span class="text-base font-medium">{{ entry.title }}</span>
                  <span class="text-[14.5px] text-muted">{{ entry.text }}</span>
                  <span class="text-[13.5px] text-faint">{{ age(entry.createdAt) }}</span>
                </a>
              }
            </section>
          }

          <section aria-labelledby="h-atlas" class="flex flex-col">
            <div class="sect-head"><h2 id="h-atlas">On {{ host() }}</h2><span class="text-[13.5px] text-faint">{{ live.offline() && lastSeen() ? 'as of ' + lastSeen() : live.sessions().length + (live.sessions().length === 1 ? ' session' : ' sessions') }}</span></div>
            @for (session of live.ordered(); track session.id) { <hares-session-row [session]="session" [dim]="live.offline()" /> }
            @if (!live.ordered().length) { <p class="py-4 text-[14.5px] text-muted">No sessions yet. Start one with the plus button.</p> }
          </section>

          @if (shownPrs().length) {
            <section aria-labelledby="h-review" class="flex flex-col">
              <div class="sect-head"><h2 id="h-review">To review</h2>@if (live.boardCount()) { <a routerLink="/prs" class="-my-3 inline-flex min-h-11 items-center text-[14.5px] text-muted no-underline">See all {{ live.boardCount() }}</a> }</div>
              @for (pr of shownPrs(); track pr.repo + pr.number) {
                <div class="flex items-center gap-4 border-b border-line py-3.5">
                  <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <a [routerLink]="['/prs', pr.repo, pr.number]" class="-my-2.5 flex min-h-11 items-center truncate text-base leading-[1.3] font-medium text-text no-underline">{{ pr.title }}</a>
                    <span class="flex items-center gap-2 text-[13.5px] text-faint">
                      <span role="img" [attr.aria-label]="checksLabel(pr.checks)" class="inline-flex w-9.5 flex-none gap-0.5">
                        @for (check of pr.checks; track $index) { <span class="size-2 rounded-xs" [class]="check === 'pass' ? 'bg-teal' : check === 'fail' ? 'bg-red' : 'bg-strong'"></span> }
                      </span>
                      {{ pr.repo }} #{{ pr.number }}@if (pr.unresolvedThreads) {, {{ pr.unresolvedThreads }} unresolved}
                    </span>
                  </span>
                  <a hares-button size="sm" [variant]="isReady(pr) ? 'primary' : 'quiet'" [routerLink]="['/prs', pr.repo, pr.number]">{{ isReady(pr) ? 'Merge' : pr.groups.includes('failing') ? 'Fix' : 'Review' }}</a>
                </div>
              }
            </section>
          }
        }
      </div>
    }
  `,
})
export class NowPage {
  protected readonly live = inject(LiveService);
  protected readonly viewport = inject(Viewport);
  private readonly guard = inject(QueueTapGuard);
  protected readonly brand = brand;
  protected readonly sent = signal<string | null>(null);
  private readonly currentId = signal<string | null>(null);
  private sentTimer: ReturnType<typeof setTimeout> | undefined;

  /** The first three pull requests waiting for your review; the rest are on the Pull requests screen. */
  protected readonly shownPrs = computed(() => this.live.toReview().slice(0, 3));
  protected isReady = (pr: PrSummary): boolean => pr.groups.includes('ready');
  protected host = () => this.live.health()?.host ?? 'atlas';
  protected readonly lastSeen = computed(() => {
    const at = this.live.lastSeenLabel();
    return at ? clockTime(at) : '';
  });
  protected readonly offlineInfo = computed(() => (this.live.offline() ? { lastSeen: this.lastSeen() || 'unknown' } : null));
  protected readonly segments = computed(() => barSegments(this.live.counts(), this.offlineInfo()));
  protected readonly barText = computed(() => barLabel(this.live.counts(), this.offlineInfo(), this.host()));
  protected readonly top = computed(() => heading(this.live.counts(), { offline: this.live.offline(), toReview: this.live.boardCount(), host: this.host() }));
  protected readonly index = computed(() => {
    const at = this.live.questions().findIndex((entry) => entry.id === this.currentId());
    return at < 0 ? 0 : at;
  });
  protected readonly current = computed(() => this.live.questions()[this.index()] ?? null);
  protected readonly position = computed(() => (this.live.questions().length > 1 ? { index: this.index(), total: this.live.questions().length } : null));

  /** Moves through the queue; the card under the finger changes, so taps pause for a moment. */
  protected step(by: number): void {
    const list = this.live.questions();
    if (list.length < 2) return;
    this.guard.moved();
    this.currentId.set(list[(this.index() + by + list.length) % list.length].id);
  }

  protected onSent(): void {
    this.sent.set('sent');
    clearTimeout(this.sentTimer);
    this.sentTimer = setTimeout(() => this.sent.set(null), 5000);
  }

  protected age = (iso: string): string => relativeTime(iso, now());
  protected checksLabel = (checks: readonly string[]): string => `${checks.filter((check) => check === 'pass').length} of ${checks.length} checks passed`;
}
