import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, failureMessage } from '../core/api';
import { now } from '../core/clock';
import { LiveService } from '../core/live';
import { trackSession } from '../core/session-detail';
import { barLabel, barSegments, clockTime, expectOf, heading, longAge, phaseOf, stateWord } from '../core/session-view';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Lantern } from '../ui/lantern';
import { PermissionCard } from '../ui/permission-card';
import { QuestionCard } from '../ui/question-card';
import { StatusBar } from '../ui/status-bar';
import { Transcript } from '../ui/transcript';

/** How much of the transcript the cockpit shows; the session page has all of it. */
const SHOWN_ENTRIES = 12;

/**
 * Now on a wide screen: the sessions on the left, the chosen one on the right with its transcript and, when it
 * waits on you, the question as three tiles. J and K move between sessions, 1 to 9 pick an option, E interrupts.
 * Picking an option does not send it: Send answer does, so a stray key never answers for you.
 */
@Component({
  selector: 'hares-cockpit',
  imports: [Banner, Button, Icon, Lantern, PermissionCard, QuestionCard, RouterLink, StatusBar, Transcript],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-wrap items-start gap-12' },
  template: `
    <aside class="flex min-w-80 flex-[0_1_380px] flex-col gap-8">
      <section class="flex flex-col">
        <h1 class="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em]">{{ top().title }}</h1>
        <p class="mt-3 text-base leading-[1.45] text-muted">{{ top().sub }}</p>
        @if (live.loaded()) { <hares-status-bar class="mt-6" [compact]="true" [segments]="segments()" [label]="barText()" /> }
      </section>
      @if (live.offline()) {
        <hares-banner kind="error">Can’t reach {{ host() }}.@if (lastSeen()) { You’re seeing what it showed at {{ lastSeen() }}. }
          <button action hares-button size="sm" variant="quiet" type="button" (click)="live.refresh()">Retry</button>
        </hares-banner>
      }
      <section aria-labelledby="dh-atlas" class="flex flex-col">
        <div class="sect-head mb-1.5"><h2 id="dh-atlas">On {{ host() }}</h2><span class="text-[13.5px] text-faint">{{ live.sessions().length }} {{ live.sessions().length === 1 ? 'session' : 'sessions' }}</span></div>
        @for (session of live.ordered(); track session.id) {
          <button type="button" class="-mx-3.5 flex cursor-pointer items-start gap-3.5 rounded-2xl border-0 px-3.5 py-3 text-left text-text" [class]="session.id === selected()?.id ? 'bg-surface' : 'bg-transparent'" [attr.aria-pressed]="session.id === selected()?.id" (click)="selectedId.set(session.id)">
            <hares-lantern class="mt-1.5" [phase]="session.alive ? phaseOf(session.status) : 'idle'" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.75">
              <span class="flex justify-between gap-3"><span class="truncate text-[15.5px] leading-[1.3] font-medium">{{ session.title }}</span><span class="tnum flex-none text-[13px] text-faint">{{ age(session.lastActivityAt) }}</span></span>
              <span class="truncate text-sm" [class]="session.status === 'blocked' ? 'text-amber-text' : session.status === 'working' ? 'text-muted' : 'text-faint'">{{ session.line }}</span>
              <span class="text-[13px] text-faint">{{ session.repo || 'No repo' }}</span>
            </span>
          </button>
        }
        @if (!live.ordered().length && live.loaded()) { <p class="py-4 text-[14.5px] text-muted">No sessions yet. Press N to start one.</p> }
      </section>
      <p class="text-[13.5px] leading-8 text-faint">
        <kbd class="key">J</kbd> <kbd class="key">K</kbd> move between sessions &nbsp; <kbd class="key">1</kbd>–<kbd class="key">3</kbd> answer &nbsp; <kbd class="key">E</kbd> interrupt
      </p>
    </aside>

    @if (selected(); as session) {
      <section aria-labelledby="dc-title" class="flex min-w-0 flex-[1_1_620px] flex-col">
        <div class="flex items-start justify-between gap-4 border-b border-line pb-5">
          <div class="flex flex-col gap-2">
            <h2 id="dc-title" class="text-2xl leading-[1.2] font-semibold tracking-[-0.02em]">{{ session.title }}</h2>
            <p class="flex items-center gap-2 text-[14.5px] text-muted">
              <hares-lantern size="sm" [phase]="session.alive ? phaseOf(session.status) : 'idle'" />
              <span class="font-semibold" [class]="session.status === 'blocked' ? 'text-amber-text' : session.status === 'working' ? 'text-teal' : 'text-muted'">{{ word(session) }}</span>
              <span class="text-faint">{{ session.repo || 'No repo' }}, {{ since(session.startedAt) }}</span>
            </p>
          </div>
          <div class="flex gap-2">
            <button type="button" class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl border border-strong bg-transparent px-3 text-sm font-medium text-text disabled:opacity-50" [disabled]="!session.alive" (click)="interrupt()"><hares-icon name="x" [size]="16" />Esc</button>
            <a [routerLink]="['/s', session.id, 'terminal']" class="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-strong px-3 text-sm font-medium text-text no-underline"><hares-icon name="terminal" [size]="16" />Terminal</a>
          </div>
        </div>
        @if (failure(); as message) { <hares-banner class="mt-4" kind="error">{{ message }}</hares-banner> }
        <div class="max-w-160 py-7">
          @if (detail(); as loaded) { <hares-transcript [entries]="recent()" /> } @else { <p class="text-muted" role="status">Loading the transcript…</p> }
        </div>
        @if (pending(); as ask) {
          @if (ask.kind === 'question') { <hares-question-card #card variant="cockpit" [pending]="ask" /> }
          @else { <hares-permission-card variant="cockpit" [pending]="ask" /> }
        }
      </section>
    }
  `,
})
export class CockpitPage {
  protected readonly live = inject(LiveService);
  private readonly api = inject(ApiService);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly phaseOf = phaseOf;
  private readonly card = viewChild<QuestionCard>('card');

  /** The chosen session, else the one whose question has waited longest, else the first. */
  protected readonly selected = computed(() => {
    const list = this.live.ordered();
    const waitingLongest = this.live.questions()[0]?.sessionId;
    return list.find((session) => session.id === this.selectedId()) ?? list.find((session) => session.id === waitingLongest) ?? list[0] ?? null;
  });
  private readonly tracked = trackSession(() => this.selected()?.id ?? null);
  protected readonly detail = this.tracked.detail;
  protected readonly recent = computed(() => this.detail()?.transcript.slice(-SHOWN_ENTRIES) ?? []);
  protected readonly pending = computed(() => this.live.questions().find((entry) => entry.sessionId === this.selected()?.id) ?? null);

  protected host = () => this.live.health()?.host ?? 'atlas';
  protected readonly lastSeen = computed(() => (this.live.lastSeenLabel() ? clockTime(this.live.lastSeenLabel()!) : ''));
  private readonly offlineInfo = computed(() => (this.live.offline() ? { lastSeen: this.lastSeen() || 'unknown' } : null));
  protected readonly segments = computed(() => barSegments(this.live.counts(), this.offlineInfo()));
  protected readonly barText = computed(() => barLabel(this.live.counts(), this.offlineInfo(), this.host()));
  protected readonly top = computed(() => heading(this.live.counts(), { offline: this.live.offline(), toReview: this.live.boardCount(), desktop: true, host: this.host() }));
  protected word = stateWord;
  protected age = (iso: string): string => longAge(iso, now());
  protected since = (iso: string): string => longAge(iso, now());

  protected async interrupt(): Promise<void> {
    const session = this.selected();
    if (!session) return;
    this.failure.set(null);
    try {
      await this.api.esc(session.id, expectOf(session));
      void this.live.refresh();
    } catch (error) {
      this.failure.set(failureMessage(error));
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
    const key = event.key.toLowerCase();
    const list = this.live.ordered();
    const at = list.findIndex((session) => session.id === this.selected()?.id);
    if (key === 'j' && list.length) this.selectedId.set(list[Math.min(at + 1, list.length - 1)].id);
    else if (key === 'k' && list.length) this.selectedId.set(list[Math.max(at - 1, 0)].id);
    else if (key === 'e') void this.interrupt();
    else if (/^[1-9]$/.test(key)) this.card()?.choose(Number(key));
  }
}
