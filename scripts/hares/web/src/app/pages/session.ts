import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, failureMessage } from '../core/api';
import { now } from '../core/clock';
import { LiveService } from '../core/live';
import { trackSession } from '../core/session-detail';
import { expectOf, longAge, phaseOf, stateWord } from '../core/session-view';
import { Banner } from '../ui/banner';
import { BackLink } from '../ui/back-link';
import { Button } from '../ui/button';
import { ConfirmPanel } from '../ui/confirm-panel';
import { Icon } from '../ui/icon';
import { Lantern } from '../ui/lantern';
import { LinkChip } from '../ui/link-chip';
import { PermissionCard } from '../ui/permission-card';
import { QuestionCard } from '../ui/question-card';
import { Sheet } from '../ui/sheet';
import { Skeleton } from '../ui/skeleton';
import { Transcript } from '../ui/transcript';

/**
 * One session: its readable transcript, what it waits for, and what you can do with it. A question or a
 * permission docks to the bottom edge; with nothing pending there is a box to steer the session, or, once
 * its pane is closed, a way to resume it. The menu holds rename and the confirmed End.
 */
@Component({
  imports: [Banner, BackLink, Button, ConfirmPanel, Icon, Lantern, LinkChip, PermissionCard, QuestionCard, RouterLink, Sheet, Skeleton, Transcript],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'min-h-dvh flex-1' },
  template: `
    <header class="flex flex-col gap-3 border-b border-line px-3.5 pt-2 pb-5 lg:border-0 lg:px-0">
      <div class="flex items-center justify-between">
        <hares-back-link to="/" label="Now" />
        <div class="flex gap-2">
          <button type="button" class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl border border-strong bg-transparent px-3 text-[14.5px] font-medium text-text disabled:opacity-50" aria-label="Interrupt the session (Esc)" [disabled]="!session()?.alive" (click)="interrupt()"><hares-icon name="x" [size]="16" />Esc</button>
          <a [routerLink]="['/s', id(), 'terminal']" class="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-strong px-3 text-[14.5px] font-medium text-text no-underline"><hares-icon name="terminal" [size]="16" />Terminal</a>
          <button type="button" class="inline-flex size-11 cursor-pointer items-center justify-center rounded-xl border border-strong bg-transparent text-text" aria-label="More actions" (click)="menu.set(true)"><hares-icon name="dots" [size]="18" /></button>
        </div>
      </div>
      @if (session(); as current) {
        <div class="flex flex-col gap-2 px-1.5">
          <h1 class="text-[22px] leading-[1.22] font-semibold tracking-[-0.018em]">{{ current.title }}</h1>
          <p class="flex items-center gap-2 text-[14.5px] text-muted">
            <hares-lantern size="sm" [phase]="current.alive ? phaseOf(current.status) : 'idle'" />
            <span class="font-semibold" [class]="current.alive && current.status === 'blocked' ? 'text-amber-text' : current.alive && current.status === 'working' ? 'text-teal' : 'text-muted'">{{ word(current) }}</span>
            <span class="text-faint">{{ current.repo || 'No repo' }}, {{ current.alive ? age(current.startedAt) : 'finished ' + age(current.endedAt ?? current.lastActivityAt) + ' ago' }}</span>
          </p>
          @if (current.links.issue || current.links.branch || current.links.pr) {
            <div class="-mt-1 flex flex-wrap gap-x-1.5">
              @if (current.links.issue; as issue) { <hares-link-chip icon="issue" [label]="'Issue #' + issue.number" [href]="issue.url" /> }
              @if (current.links.branch; as branch) { <hares-link-chip icon="link" [label]="'Branch ' + branch.name" /> }
              @if (current.links.pr; as pr) { <hares-link-chip icon="pr" [label]="'PR #' + pr.number" [href]="pr.url" /> }
            </div>
          }
        </div>
      }
    </header>

    <main class="flex flex-1 flex-col gap-4 px-5 py-6 lg:px-0" aria-label="Session">
      @if (missing()) {
        <p class="text-base text-muted">This session isn’t here any more. It may have been closed before ħares saw it.</p>
        <a hares-button class="self-start" routerLink="/">Back to Now</a>
      } @else if (!detail() && !tracked.error()) {
        <hares-skeleton [count]="3" />
      } @else if (!detail()) {
        <hares-banner kind="error">{{ tracked.error() }}<button action hares-button size="sm" variant="quiet" type="button" (click)="tracked.reload()">Retry</button></hares-banner>
      } @else {
        <hares-transcript [entries]="detail()!.transcript" />
        @if (answered(); as text) {
          <div class="max-w-[84%] self-end rounded-[20px_20px_6px_20px] bg-glow px-4 py-3 text-[15.5px] leading-[1.45]"><span class="mb-1 block text-[13.5px] font-semibold text-amber-text">You answered</span>{{ text }}</div>
        }
      }
    </main>

    @if (failure(); as message) { <hares-banner class="mx-5 mb-3 lg:mx-0" kind="error">{{ message }}</hares-banner> }

    @if (detail()) {
      @if (pending(); as ask) {
        @if (ask.kind === 'question') {
          <hares-question-card variant="sheet" [pending]="ask" [queue]="position()" [focusOwn]="own() === '1'" (previous)="step(-1)" (next)="step(1)" (sent)="onAnswered($event)" />
        } @else {
          <hares-permission-card variant="sheet" [pending]="ask" [queue]="position()" (previous)="step(-1)" (next)="step(1)" (decided)="onDecided()" />
        }
      } @else {
        <div class="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-line bg-bg px-5 pt-4 pb-[calc(1.75rem+env(safe-area-inset-bottom))] lg:static lg:px-0">
          @if (notice(); as text) {
            <hares-banner kind="ok">{{ text }}<a action hares-button size="sm" variant="ghost" routerLink="/">Back</a></hares-banner>
          }
          @if (session()?.alive) {
            <form class="flex gap-2" (submit)="steer($event)">
              <label for="steer" class="sr-only">Message the session</label>
              <input id="steer" name="steer" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-surface px-4 text-base text-text" placeholder="Message the session" autocomplete="off" [value]="message()" (input)="message.set($any($event.target).value)" />
              <button hares-button type="submit" [disabled]="!message().trim() || busy()">Send</button>
            </form>
          } @else {
            <form class="flex gap-2" (submit)="resume($event)">
              <label for="resume" class="sr-only">What should it do next?</label>
              <input id="resume" name="resume" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-surface px-4 text-base text-text" placeholder="What should it do next?" autocomplete="off" [value]="message()" (input)="message.set($any($event.target).value)" />
              <button hares-button variant="primary" type="submit" [disabled]="busy()">Resume</button>
            </form>
          }
        </div>
      }
    }

    <hares-sheet [open]="menu()" [heading]="session()?.title ?? 'Session'" (closed)="closeMenu()">
      @if (session(); as current) {
        @if (!current.alive) {
          <button type="button" class="menu-item" (click)="resumeFromMenu()"><span class="text-teal"><hares-icon name="resume" /></span>Resume with a new message</button>
        }
        @if (current.links.pr; as pr) {
          <a class="menu-item no-underline" [routerLink]="['/prs', pr.repo, pr.number]" (click)="closeMenu()"><span class="text-muted"><hares-icon name="pr" /></span>Open PR #{{ pr.number }}</a>
        }
        @if (renaming()) {
          <form class="flex gap-2 px-3 py-2" (submit)="rename($event)">
            <label for="rename" class="sr-only">Name</label>
            <input id="rename" name="rename" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-bg px-4 text-base text-text" autocomplete="off" [value]="title()" (input)="title.set($any($event.target).value)" />
            <button hares-button variant="primary" type="submit" [disabled]="!title().trim() || busy()">Save</button>
          </form>
        } @else {
          <button type="button" class="menu-item" (click)="startRename(current.title)"><span class="text-muted"><hares-icon name="rename" /></span>Rename</button>
        }
        @if (current.alive) {
          <div class="mx-3 my-2 h-px bg-line"></div>
          <button type="button" class="menu-item text-red" [attr.aria-expanded]="ending()" (click)="ending.set(!ending())"><hares-icon name="x" />End session</button>
          @if (ending()) {
            <hares-confirm-panel class="mx-3 mt-1" label="Confirm ending the session" cancelLabel="Keep it" confirmLabel="End session" [busy]="busy()" (cancelled)="ending.set(false)" (confirmed)="end()">Closes its herdr pane. The transcript stays, and you can resume it later from the session list.</hares-confirm-panel>
          }
        }
      }
    </hares-sheet>
  `,
})
export class SessionPage {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly router = inject(Router);
  readonly id = input.required<string>();
  /** From a link: "own" asks for the own-answer field, "q" names the prompt to open. */
  readonly own = input<string>();
  readonly q = input<string>();

  protected readonly tracked = trackSession(() => this.id());
  protected readonly detail = this.tracked.detail;
  protected readonly missing = this.tracked.missing;
  /** The live row for this session, fresher than the loaded detail between loads. */
  protected readonly session = computed(() => {
    const loaded = this.detail();
    const row = this.live.sessions().find((entry) => entry.id === (loaded?.id ?? this.id()));
    return row ?? loaded;
  });
  protected readonly phaseOf = phaseOf;
  protected word = stateWord;
  protected age = (iso: string): string => longAge(iso, now());

  protected readonly menu = signal(false);
  protected readonly renaming = signal(false);
  protected readonly ending = signal(false);
  protected readonly title = signal('');
  protected readonly message = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly answered = signal<string | null>(null);

  private readonly selectedPending = signal<string | null>(null);
  protected readonly mine = computed(() => this.live.questions().filter((entry) => entry.sessionId === (this.detail()?.id ?? this.id())));
  protected readonly pendingIndex = computed(() => {
    const wanted = this.selectedPending() ?? this.q();
    const at = this.mine().findIndex((entry) => entry.id === wanted);
    return at < 0 ? 0 : at;
  });
  protected readonly pending = computed(() => this.mine()[this.pendingIndex()] ?? null);
  protected readonly position = computed(() => (this.mine().length > 1 ? { index: this.pendingIndex(), total: this.mine().length } : null));

  constructor() {
    // The answer line is shown until the transcript carries the real one.
    effect(() => {
      this.detail()?.nextSince;
      untracked(() => this.answered.set(null));
    });
  }

  protected step(by: number): void {
    const list = this.mine();
    if (list.length < 2) return;
    this.selectedPending.set(list[(this.pendingIndex() + by + list.length) % list.length].id);
  }

  protected onAnswered(text: string): void {
    this.answered.set(text);
    this.notice.set('Answer sent. The session is working again.');
    void this.tracked.reload();
  }

  protected onDecided(): void {
    this.notice.set('Decision sent. The session carries on.');
    void this.tracked.reload();
  }

  private async act(work: () => Promise<unknown>, after?: () => void): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      await work();
      after?.();
      void this.live.refresh();
      void this.tracked.reload();
    } catch (error) {
      this.failure.set(failureMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected interrupt(): void {
    const session = this.session();
    if (session) void this.act(() => this.api.esc(session.id, expectOf(session)));
  }

  protected steer(event: Event): void {
    event.preventDefault();
    const session = this.session();
    const text = this.message().trim();
    if (!session || !text) return;
    void this.act(() => this.api.steer(session.id, expectOf(session), text), () => {
      this.message.set('');
      this.notice.set('Message sent.');
    });
  }

  protected resume(event: Event): void {
    event.preventDefault();
    const session = this.session();
    if (!session) return;
    void this.act(() => this.api.resume(session.id, this.message().trim() || undefined), () => {
      this.message.set('');
      this.notice.set('Resumed in a new herdr pane.');
    });
  }

  protected resumeFromMenu(): void {
    this.closeMenu();
    queueMicrotask(() => document.getElementById('resume')?.focus());
  }

  protected startRename(current: string): void {
    this.title.set(current);
    this.renaming.set(true);
  }

  protected rename(event: Event): void {
    event.preventDefault();
    const session = this.session();
    const title = this.title().trim();
    if (!session || !title) return;
    void this.act(() => this.api.rename(session.id, title), () => this.closeMenu());
  }

  protected end(): void {
    const session = this.session();
    if (!session) return;
    void this.act(() => this.api.end(session.id, expectOf(session)), () => {
      this.closeMenu();
      void this.router.navigate(['/']);
    });
  }

  protected closeMenu(): void {
    this.menu.set(false);
    this.renaming.set(false);
    this.ending.set(false);
  }
}
