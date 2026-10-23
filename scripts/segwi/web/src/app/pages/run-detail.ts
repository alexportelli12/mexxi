import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { LiveService } from '../core/live';
import { RelativeTime } from '../core/relative-time';
import { absoluteTime } from '../core/time';
import type { EventMessage, RunDetail, Step } from '../models';
import { isFinal, statusCopy } from '../status';
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

const atBottom = (): boolean => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK_PX;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Only a plain https link is shown as one: a run's PR address comes from outside. */
/** A short name for a PR link, so a long address never wraps mid-word: "Pull request #42". */
export const prName = (url: string): string => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `Pull request #${number}` : 'Pull request';
};

export const safeLink = (url: string | null): string | null => (url && /^https:\/\//.test(url) ? url : null);

@Component({
  imports: [RouterLink, ApprovalCard, Banner, Button, Card, CopyButton, EmptyState, RelativeTime, Sheet, Skeleton, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:scroll)': 'onScroll()', '(window:resize)': 'refreshAway()' },
  template: `
    <h1 class="text-2xl font-semibold">{{ title }}</h1>

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
      <segwi-card class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <segwi-status-pill [status]="run()!.status" [reason]="run()!.reason" [live]="true" />
          @if (run()!.costUsd !== null) { <span class="text-sm text-muted">Cost <span class="font-code">\${{ run()!.costUsd!.toFixed(2) }}</span></span> }
        </div>
        <p class="text-[15px] break-words whitespace-pre-wrap">{{ run()!.task }}</p>
        <dl class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-[15px]">
          <dt class="text-muted">Repository</dt><dd class="font-code">{{ run()!.repo }}</dd>
          <dt class="text-muted">Action</dt><dd>{{ actionText() }}</dd>
          <dt class="text-muted">Branch</dt><dd class="font-code break-all">{{ run()!.branch ?? '–' }}</dd>
          <dt class="text-muted">Pull request</dt>
          <dd class="flex flex-wrap items-center gap-x-2">
            @if (prLink()) {
              <a [href]="prLink()" target="_blank" rel="noopener noreferrer" class="inline-flex min-h-11 items-center underline underline-offset-4">{{ prLabel() }}</a>
              <segwi-copy-button [text]="prLink()!" label="the pull request link" />
            } @else { – }
          </dd>
          <dt class="text-muted">Verify</dt>
          <dd>
            @switch (run()!.verify) {
              @case ('pass') { <span class="text-done">✓ Passed</span> }
              @case ('fail') { <span class="text-failed">✗ Failed</span> }
              @default { <span class="text-muted">– Not run yet</span> }
            }
          </dd>
          <dt class="text-muted">Started</dt><dd><segwi-time [iso]="run()!.createdAt" /></dd>
          @if (run()!.endedAt) { <dt class="text-muted">Ended</dt><dd><segwi-time [iso]="run()!.endedAt!" /></dd> }
        </dl>
      </segwi-card>

      @for (entry of approvals(); track entry.approval.id) {
        <segwi-approval-card [approval]="entry.approval" [result]="entry.result" />
      }

      <section aria-labelledby="steps-heading" class="flex flex-col gap-2">
        <h2 id="steps-heading" class="text-sm font-medium tracking-wide text-muted uppercase">Steps</h2>
        @if (!steps().length) {
          <p class="text-muted">{{ isFinal() ? 'No steps were recorded.' : 'Waiting for the first step…' }}</p>
        }
        <ol class="flex flex-col gap-2">
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
      </section>

      @if (isFinal()) {
        <segwi-card class="flex flex-col gap-2" role="region" aria-label="Outcome">
          <segwi-status-pill [status]="run()!.status" [reason]="run()!.reason" />
          @switch (run()!.status) {
            @case ('completed') {
              @if (prLink()) { <a [href]="prLink()" target="_blank" rel="noopener noreferrer" class="inline-flex min-h-11 items-center underline underline-offset-4">{{ prLabel() }}</a> }
              @else { <p class="text-muted">The run finished without a pull request.</p> }
            }
            @case ('failed') { <p>{{ run()!.reason ?? 'The run failed.' }}</p> }
            @default { <p class="text-muted">{{ outcomeText() }}</p> }
          }
        </segwi-card>
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

  protected readonly steps = computed(() => this.run()?.steps ?? []);
  protected readonly isFinal = computed(() => !!this.run() && isFinal(this.run()!.status));
  protected readonly prLink = computed(() => safeLink(this.run()?.prUrl ?? null));
  protected readonly prLabel = computed(() => prName(this.prLink() ?? ''));
  protected readonly approvals = computed(() => this.live.shownApprovals().filter((entry) => entry.approval.runId === this.id()));
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
    this.live.runUpdates.pipe(takeUntilDestroyed(destroyRef)).subscribe((message) => {
      if (message.runId === this.id()) void this.load();
    });
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

  private onEvent(message: EventMessage): void {
    const run = this.run();
    if (!run || message.runId !== run.id || !message.step) return;
    const wasAtBottom = atBottom();
    const step = message.step;
    const known = run.steps.some((entry) => entry.id === step.id);
    this.run.set({ ...run, steps: known ? run.steps.map((entry) => (entry.id === step.id ? step : entry)) : [...run.steps, step] });
    this.followIf(wasAtBottom);
  }

  /** New content keeps the view at the bottom only if it was there; scrolling up pauses that. */
  private followIf(wasAtBottom: boolean): void {
    setTimeout(() => {
      if (wasAtBottom) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
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
    this.away.set(this.userScrolled && scrollable && !atBottom());
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
