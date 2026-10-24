import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { LiveService } from '../core/live';
import { latestActivity } from '../core/activity';
import { now } from '../core/clock';
import { TONE_CLASS, duration, journeyView, type StageState } from '../core/journey';
import { absoluteTime } from '../core/time';
import type { EventMessage, RunDetail, RunMessage, Step } from '../models';
import { isFinal, statusCopy, waitingLine } from '../status';
import { ApprovalCard } from '../ui/approval-card';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { CopyButton } from '../ui/copy-button';
import { EmptyState } from '../ui/empty-state';
import { Sheet } from '../ui/sheet';
import { Skeleton } from '../ui/skeleton';
import { StatusPill } from '../ui/status-pill';
import { actionLabels, commandFor, titles } from '../words';

const BOTTOM_SLACK_PX = 160;
const STEP_LABELS: Record<Step['type'], string> = { edit: 'Edit', command: 'Command', test: 'Test', read: 'Read', message: 'Message', refusal: 'Blocked' };

/** A task longer than this, or on several lines, is cut to two lines until tapped. */
const LONG_TASK_CHARS = 120;
const MARKS: Record<StageState, { glyph: string; tone: string; words: string }> = {
  done: { glyph: '✓', tone: 'text-done', words: 'done' },
  current: { glyph: '●', tone: 'text-accent', words: 'in progress' },
  failed: { glyph: '✗', tone: 'text-failed', words: 'failed' },
  pending: { glyph: '○', tone: 'text-muted', words: 'not yet' },
  skipped: { glyph: '–', tone: 'text-muted', words: 'skipped' },
};

const atBottom = (): boolean => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK_PX;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short name for a PR link, so a long address never wraps mid-word: "Pull request #42". */
export const prName = (url: string): string => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `Pull request #${number}` : 'Pull request';
};

/** Only a plain https link is shown as one: a run's PR address comes from outside. */
export const safeLink = (url: string | null): string | null => (url && /^https:\/\//.test(url) ? url : null);

@Component({
  imports: [RouterLink, ApprovalCard, Banner, Button, Card, CopyButton, EmptyState, Sheet, Skeleton, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:scroll)': 'onScroll()', '(window:resize)': 'refreshAway()' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">{{ title }}</h1>
      @if (run()) { <segwi-status-pill [status]="run()!.status" [reason]="run()!.reason" [live]="true" /> }
    </div>

    @if (missing()) {
      <segwi-empty-state title="No such run" hint="It may have been removed, or the link is wrong.">
        <a segwi-button variant="primary" routerLink="/runs">Go to Runs</a>
      </segwi-empty-state>
    } @else if (error() && !run()) {
      <segwi-banner tone="error">
        Couldn't load this run. {{ error() }}
        <button bannerAction segwi-button type="button" (click)="load()">Retry</button>
      </segwi-banner>
    } @else if (!run()) {
      <segwi-skeleton height="9rem" /><segwi-skeleton height="12rem" />
    } @else {
      <div class="-mt-2 flex flex-col gap-3">
        <segwi-card class="flex flex-col gap-1.5" data-testid="run-summary">
          @if (waiting()) {
            <p class="flex items-center gap-1.5 text-sm text-muted" data-testid="waiting-on">
              <svg class="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>
              <span class="min-w-0 truncate">{{ waiting() }}</span>
            </p>
          }
          @if (longTask()) {
            <button type="button" class="cursor-pointer text-left text-[15px] break-words whitespace-pre-wrap" [class.line-clamp-2]="!taskOpen()"
              [attr.aria-expanded]="taskOpen()" (click)="taskOpen.set(!taskOpen())">{{ run()!.task }}<span class="sr-only">{{ taskOpen() ? ', show less' : ', show all' }}</span></button>
          } @else {
            <p class="text-[15px] break-words whitespace-pre-wrap">{{ run()!.task }}</p>
          }
          <p class="flex flex-wrap gap-x-2 text-sm text-muted">
            <span class="font-code">{{ run()!.repo }}</span><span aria-hidden="true">·</span><span>{{ actionText() }}</span><span aria-hidden="true">·</span>
            <span [title]="'Started ' + started()">{{ elapsed() }}<span class="sr-only"> since it started</span></span>
            @if (run()!.costUsd !== null) { <span aria-hidden="true">·</span><span>Cost <span class="font-code">\${{ run()!.costUsd!.toFixed(2) }}</span></span> }
            @if (!journey()) {
              <span aria-hidden="true">·</span>
              @switch (run()!.verify) {
                @case ('pass') { <span class="text-done">✓ Verify passed</span> }
                @case ('fail') { <span class="text-failed">✗ Verify failed</span> }
                @default { <span>Verify not run</span> }
              }
            }
          </p>
          @if (run()!.branch || prLink()) {
            <div class="flex items-center gap-3 text-sm" [class.min-h-11]="prLink()">
              @if (run()!.branch) { <span class="font-code min-w-0 flex-1 truncate text-muted" [title]="run()!.branch!"><span class="sr-only">Branch </span>{{ run()!.branch }}</span> }
              @if (prLink()) {
                <a [href]="prLink()" target="_blank" rel="noopener noreferrer" class="inline-flex min-h-11 shrink-0 items-center text-[15px] underline underline-offset-4">{{ prLabel() }}</a>
                <segwi-copy-button [text]="prLink()!" label="the pull request link" />
              }
            </div>
          }
        </segwi-card>

        @if (journey(); as view) {
          <section aria-labelledby="journey-heading" class="rounded-card border border-border bg-surface p-4" data-testid="journey">
            <h2 id="journey-heading" class="sr-only">Journey</h2>
            <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span class="font-code rounded-full border border-border-strong px-2 text-xs font-semibold tracking-wide" [class]="tone(view.headline.tone)" data-testid="journey-headline">{{ view.headline.label }}</span>
              <span class="text-muted" data-testid="journey-progress">{{ view.done }} of {{ view.total }}</span>
              @if (view.onStage) { <span class="ml-auto text-muted">{{ view.onStage }}</span> }
            </div>
            <ol class="flex flex-col text-sm">
              @for (stage of view.stages; track stage.key) {
                <li class="flex items-center gap-2 leading-6" [attr.data-state]="stage.state">
                  <span class="w-4 shrink-0 text-center" [class]="mark(stage.state).tone" aria-hidden="true">{{ mark(stage.state).glyph }}</span>
                  <span class="shrink-0" [class.font-semibold]="stage.state === 'current'" [class.text-muted]="stage.state === 'pending' || stage.state === 'skipped'">{{ stage.label }}<span class="sr-only">: {{ mark(stage.state).words }}</span></span>
                  @if (stage.detail) { <span class="ml-auto min-w-0 truncate text-muted">{{ stage.detail }}</span> }
                </li>
              }
            </ol>
          </section>
        }

        <section aria-labelledby="now-heading" class="rounded-card border border-border bg-surface p-4" data-testid="now">
          <div class="flex items-baseline gap-2">
            <h2 id="now-heading" class="w-18 shrink-0 text-xs font-semibold tracking-wide text-accent uppercase">{{ isFinal() ? 'Last' : 'Now' }}</h2>
            @if (activity().now; as step) {
              <p class="min-w-0 line-clamp-2 text-[15px] break-words" [class.font-code]="step.type !== 'message'" data-testid="now-line"><span class="sr-only">{{ stepLabel(step) }}: </span>{{ step.title }}</p>
              @if (step.ok === true) { <span class="ml-auto text-done" aria-hidden="true">✓</span><span class="sr-only">Succeeded</span> }
              @if (step.ok === false) { <span class="ml-auto text-failed" aria-hidden="true">✗</span><span class="sr-only">Failed</span> }
            } @else {
              <p class="text-muted">{{ isFinal() ? 'No steps were recorded.' : 'Waiting for the first step…' }}</p>
            }
          </div>
          @if (activity().now) {
            @if (activity().recent.length) {
              <ul class="mt-2 flex flex-col gap-0.5 border-t border-border pt-2 text-sm text-muted" aria-label="Recent">
                @for (step of activity().recent; track step.id) {
                  <li class="flex gap-2"><span class="w-18 shrink-0 text-xs leading-5 tracking-wide uppercase">{{ stepLabel(step) }}</span><span class="min-w-0 truncate" [class.font-code]="step.type !== 'message'">{{ step.title }}</span></li>
                }
              </ul>
            }
          }
        </section>
      </div>

      @for (entry of approvals(); track entry.approval.id) {
        <segwi-approval-card [approval]="entry.approval" [result]="entry.result" />
      }

      <!-- The pill and the pull request link are above; the outcome adds only what they don't say. -->
      @if (isFinal() && !(run()!.status === 'completed' && prLink())) {
        <segwi-card role="region" aria-label="Outcome">
          @switch (run()!.status) {
            @case ('completed') { <p class="text-muted">The run finished without a pull request.</p> }
            @case ('failed') { <p>{{ run()!.reason ?? 'The run failed.' }}</p> }
            @default { <p class="text-muted">{{ outcomeText() }}</p> }
          }
        </segwi-card>
      }

      @if (steps().length) {
        <section aria-labelledby="steps-heading" class="flex flex-col gap-2">
          <h2 id="steps-heading" class="sr-only">Steps</h2>
          <button segwi-button variant="ghost" type="button" class="self-start" aria-controls="steps" [attr.aria-expanded]="activityOpen()" (click)="toggleActivity()">
            {{ activityOpen() ? 'Hide activity' : 'Show activity' }} <span class="text-sm">({{ steps().length }})</span>
            <svg class="size-4 shrink-0 transition-transform" [class.rotate-180]="activityOpen()" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4" /></svg>
          </button>
          @if (activityOpen()) {
            <ol id="steps" class="flex flex-col gap-2">
              @for (step of steps(); track step.id) {
                <li class="rounded-card border border-border bg-surface">
                  <button type="button" class="flex min-h-11 w-full items-center gap-3 rounded-card px-3 py-2 text-left" [attr.aria-expanded]="isOpen(step)" (click)="toggle(step)">
                    <span class="w-18 shrink-0 text-xs font-medium tracking-wide text-muted uppercase">{{ stepLabel(step) }}</span>
                    <span class="min-w-0 flex-1 truncate text-[15px]" [class.font-code]="step.type !== 'message'">{{ step.title }}</span>
                    @if (step.ok === true) { <span class="text-done" aria-hidden="true">✓</span><span class="sr-only">Succeeded</span> }
                    @if (step.ok === false) { <span class="text-failed" aria-hidden="true">✗</span><span class="sr-only">Failed</span> }
                    <svg class="size-4 shrink-0 text-muted transition-transform" [class.rotate-180]="isOpen(step)" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                  </button>
                  @if (isOpen(step)) {
                    <div class="flex flex-col gap-2 border-t border-border px-3 py-3">
                      @if (step.type === 'command' || step.type === 'test') {
                        <div class="flex items-center justify-between gap-2"><span class="text-sm text-muted">Command</span><segwi-copy-button [text]="step.title" label="the command" /></div>
                        <pre class="font-code overflow-auto rounded-card bg-bg p-3 text-sm whitespace-pre-wrap break-words" tabindex="0">{{ step.title }}</pre>
                      }
                      @if (step.detail) {
                        <pre class="max-h-72 overflow-auto rounded-card bg-bg p-3 text-sm whitespace-pre-wrap break-words" [class.font-code]="step.type !== 'message'" tabindex="0" [attr.aria-label]="'Details of ' + step.title">{{ step.detail }}</pre>
                      } @else if (step.type !== 'command' && step.type !== 'test') {
                        <p class="text-sm text-muted">{{ step.type === 'message' ? '' : 'No output.' }}</p>
                      }
                    </div>
                  }
                </li>
              }
            </ol>
          }
        </section>
      }

      <div [class]="isFinal() ? 'sticky-anchor' : 'sticky-bar flex flex-col gap-3'">
        @if (away()) {
          <button segwi-button variant="primary" type="button" class="jump-to-latest shadow-lg" (click)="jump()">Jump to latest</button>
        }
        @if (!isFinal()) {
          @if (run()!.status === 'needs_input') {
            <form class="flex flex-col gap-2" (submit)="send($event)">
              <label for="reply" class="text-sm text-muted">Your reply</label>
              <textarea id="reply" rows="2" class="min-h-16 rounded-card border border-border-strong bg-surface-raised p-3 text-[15px]" [maxLength]="live.limits().inputMaxChars"
                [value]="reply()" (input)="reply.set($any($event.target).value)" aria-describedby="reply-count"></textarea>
              <div class="flex items-center justify-between gap-3">
                <span id="reply-count" class="text-sm text-muted">{{ reply().length }} / {{ live.limits().inputMaxChars }}</span>
                <button segwi-button variant="primary" type="submit" [disabled]="!reply().trim() || sending()">{{ sending() ? 'Sending…' : 'Send' }}</button>
              </div>
            </form>
          }
          @if (actionError()) { <p class="text-sm text-failed" role="alert">{{ actionError() }}</p> }
          <button segwi-button type="button" class="self-start" (click)="confirming.set(true)">Stop…</button>
        }
      </div>

      <segwi-sheet [open]="confirming()" heading="Stop this run?" (closed)="confirming.set(false)">
        <p class="text-muted">The agent stops now; its branch and any open PR stay.</p>
        <div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button segwi-button type="button" autofocus (click)="confirming.set(false)">Keep running</button>
          <button segwi-button variant="danger" type="button" [disabled]="stopping()" (click)="stop()">Stop run</button>
        </div>
      </segwi-sheet>
    }
  `,
})
export class RunDetailPage {
  /** The run's id, bound from the route. */
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);
  protected readonly live = inject(LiveService);
  protected readonly title = titles.runDetail;
  protected readonly run = signal<RunDetail | null>(null);
  protected readonly missing = signal(false);
  protected readonly error = signal('');
  protected readonly actionError = signal('');
  protected readonly reply = signal('');
  protected readonly sending = signal(false);
  protected readonly stopping = signal(false);
  protected readonly confirming = signal(false);
  protected readonly away = signal(false);
  /** Set once the reader scrolls; "Jump to latest" never shows on a page they haven't moved. */
  private userScrolled = false;
  private jumping = false;
  private readonly overrides = signal<Record<string, boolean>>({});
  protected readonly taskOpen = signal(false);
  /** The full list of steps is behind "Show activity"; the page leads with the snapshot. */
  protected readonly activityOpen = signal(false);

  protected readonly steps = computed(() => this.run()?.steps ?? []);
  protected readonly isFinal = computed(() => !!this.run() && isFinal(this.run()!.status));
  protected readonly prLink = computed(() => safeLink(this.run()?.prUrl ?? null));
  protected readonly prLabel = computed(() => prName(this.prLink() ?? ''));
  protected readonly approvals = computed(() => this.live.shownApprovals().filter((entry) => entry.approval.runId === this.id()));
  protected readonly waiting = computed(() => (this.run() ? waitingLine(this.run()!) : null));
  protected readonly longTask = computed(() => {
    const task = this.run()?.task ?? '';
    return task.length > LONG_TASK_CHARS || task.includes('\n');
  });
  protected readonly journey = computed(() => (this.run() ? journeyView(this.run()!.id, this.run()!.snapshot, now()) : null));
  protected readonly activity = computed(() => latestActivity(this.steps()));
  protected readonly started = computed(() => (this.run() ? absoluteTime(this.run()!.createdAt) : ''));
  protected readonly elapsed = computed(() => {
    const run = this.run();
    if (!run) return '';
    return duration((run.endedAt ? Date.parse(run.endedAt) : now()) - Date.parse(run.createdAt));
  });
  protected readonly tone = (tone: keyof typeof TONE_CLASS): string => TONE_CLASS[tone];
  protected readonly mark = (state: StageState) => MARKS[state];
  protected readonly actionText = computed(() => {
    const run = this.run();
    if (!run) return '';
    const command = commandFor(run.action);
    return command ? `${actionLabels[run.action]} · ${command}` : actionLabels[run.action];
  });
  protected readonly outcomeText = computed(() => {
    const run = this.run();
    if (!run) return '';
    const when = run.endedAt ? ` ${absoluteTime(run.endedAt)}` : '';
    return `${statusCopy(run.status, run)}.${when}`.replace('..', '.');
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
    this.live.events.pipe(takeUntilDestroyed(destroyRef)).subscribe((message) => this.onEvent(message));
    this.live.runUpdates.pipe(takeUntilDestroyed(destroyRef)).subscribe((message) => this.onRun(message));
    // After a drop or a server reset the steps on screen may have gaps; fetch the run again.
    this.live.reloads.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => void this.load());
  }

  protected async load(): Promise<void> {
    const wasAtBottom = this.run() ? atBottom() : false;
    this.error.set('');
    try {
      this.run.set(await this.api.run(this.id()));
      this.missing.set(false);
      this.followIf(wasAtBottom);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 400)) this.missing.set(true);
      else this.error.set((error as Error).message);
    }
  }

  /**
   * A status message carries the run's status, waitingOn and workspace snapshot, so the page redraws from
   * it in place. Only a new status loads the run again, for what the message leaves out (cost, end time).
   */
  private onRun(message: RunMessage): void {
    const run = this.run();
    if (!run || message.runId !== run.id) return;
    this.run.set({
      ...run, status: message.status, reason: message.reason, branch: message.branch, prUrl: message.prUrl, verify: message.verify,
      ...(message.waitingOn !== undefined ? { waitingOn: message.waitingOn } : {}),
      ...(message.snapshot !== undefined ? { snapshot: message.snapshot } : {}),
    });
    if (message.status !== run.status) void this.load();
  }

  private onEvent(message: EventMessage): void {
    const run = this.run();
    if (!run || message.runId !== run.id || !message.step) return;
    const wasAtBottom = atBottom();
    const step = message.step;
    const known = run.steps.some((entry) => entry.id === step.id);
    this.run.set({ ...run, steps: known ? run.steps.map((entry) => (entry.id === step.id ? step : entry)) : [...run.steps, step] });
    this.followIf(wasAtBottom);
  }

  /** New content keeps the open activity at the bottom only if it was there; scrolling up pauses that. */
  private followIf(wasAtBottom: boolean): void {
    setTimeout(() => {
      if (wasAtBottom && this.activityOpen()) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      this.refreshAway();
    });
  }

  protected onScroll(): void {
    if (this.jumping) {
      // Our own smooth scroll passes through the middle of the page; it must not bring the button back.
      if (atBottom()) this.jumping = false;
      else return;
    }
    this.userScrolled = !atBottom();
    this.refreshAway();
  }

  protected refreshAway(): void {
    const scrollable = document.documentElement.scrollHeight > window.innerHeight + 40;
    this.away.set(this.activityOpen() && this.userScrolled && scrollable && !atBottom());
  }

  protected toggleActivity(): void {
    this.activityOpen.update((open) => !open);
    setTimeout(() => this.refreshAway());
  }

  protected jump(): void {
    this.jumping = true;
    this.userScrolled = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reducedMotion() ? 'instant' : 'smooth' });
    this.away.set(false);
    setTimeout(() => (this.jumping = false), 1500);
  }

  protected stepLabel = (step: Step): string => (step.type === 'message' ? (step.from === 'you' ? 'You' : 'Agent') : STEP_LABELS[step.type]);

  protected isOpen(step: Step): boolean {
    const forced = this.overrides()[step.id];
    return forced ?? step.id === this.steps().at(-1)?.id;
  }

  protected toggle(step: Step): void {
    this.overrides.update((map) => ({ ...map, [step.id]: !this.isOpen(step) }));
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.reply().trim() || this.sending()) return;
    this.sending.set(true);
    this.actionError.set('');
    try {
      await this.api.reply(this.id(), this.reply().trim());
      this.reply.set('');
      await this.load();
    } catch (error) {
      this.actionError.set((error as Error).message);
    } finally {
      this.sending.set(false);
    }
  }

  protected async stop(): Promise<void> {
    this.stopping.set(true);
    this.actionError.set('');
    try {
      await this.api.stop(this.id());
      this.confirming.set(false);
      await this.load();
    } catch (error) {
      this.confirming.set(false);
      this.actionError.set((error as Error).message);
    } finally {
      this.stopping.set(false);
    }
  }
}
