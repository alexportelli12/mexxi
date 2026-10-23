import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { now } from '../core/clock';
import { DecisionResult, LiveService } from '../core/live';
import { ApprovalTapGuard } from '../core/tap-guard';
import { untilTime } from '../core/time';
import { escapeCount, visibleSegments } from '../core/visible-text';
import type { Approval } from '../models';
import { Button } from './button';
import { Card } from './card';
import { CopyButton } from './copy-button';
import { VisibleText } from './visible-text';

/** What `exact` holds for each tool, as its heading. */
const EXACT_LABELS: Record<string, string> = { Bash: 'Command', Edit: 'File', Write: 'File', NotebookEdit: 'File', Read: 'File', WebFetch: 'URL' };

/** One approval: what exactly would run, where, why, and the two answers. Enter never approves. */
@Component({
  selector: 'segwi-approval-card',
  imports: [Button, Card, CopyButton, RouterLink, VisibleText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[id]': '"approval-" + approval().id', class: 'block' },
  template: `
    <segwi-card class="flex flex-col gap-4 border-border-strong">
      <div class="flex items-start justify-between gap-3">
        <p class="flex items-center gap-2 font-medium text-needs-you">
          <svg class="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l5 2v4c0 3-2 5-5 7-3-2-5-4-5-7v-4z" /><path d="M8 5.5v3M8 10.5v.01" /></svg>
          {{ approval().riskLabel }}
        </p>
        <a [routerLink]="['/runs', approval().runId]" class="inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 hover:text-text">Open run in {{ approval().repo }}</a>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm text-muted">{{ exactLabel() }}</h2>
          <segwi-copy-button [text]="approval().exact" [label]="'the ' + exactLabel().toLowerCase()" />
        </div>
        @if (hiddenCount()) {
          <p class="text-sm text-needs-you" data-testid="hidden-characters">{{ hiddenNote() }}</p>
        }
        <!-- Shown whole: a scrolling box, never cut, with hidden characters as chips. -->
        <pre class="font-code max-h-60 overflow-auto rounded-card border border-border bg-bg p-3 text-sm whitespace-pre-wrap break-words" tabindex="0" data-testid="approval-exact" [attr.aria-label]="'Exact ' + approval().tool + ' call'"><segwi-visible-text [text]="approval().exact" /></pre>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
        <dt class="text-muted">Runs in</dt>
        <dd class="font-code text-sm break-all">{{ approval().cwd }}</dd>
        @if (approval().why) {
          <dt class="text-muted">Why</dt>
          <dd class="min-w-0 break-words whitespace-pre-wrap" data-testid="approval-why"><segwi-visible-text [text]="approval().why" /></dd>
        }
      </dl>

      <!-- The answer takes the controls' place in the same grid cell, so an answered card keeps its height while it lingers. -->
      <div class="grid">
        <div class="col-start-1 row-start-1 flex flex-col gap-4" [class.invisible]="!!result()" [attr.aria-hidden]="result() ? 'true' : null" data-testid="approval-controls">
          <p class="text-sm text-muted">Denied automatically in {{ expiry() }}</p>
          @if (error()) { <p class="text-sm text-failed" role="alert">{{ error() }}</p> }
          <div class="flex items-center justify-between gap-6">
            <button #deny segwi-button type="button" [disabled]="busy() || !!result()" (click)="answer('deny', $event)">Deny</button>
            <button segwi-button variant="primary" type="button" [disabled]="busy() || !!result()" (click)="answer('allow', $event)">Approve</button>
          </div>
        </div>
        @if (result()) {
          <p class="col-start-1 row-start-1 flex min-h-11 items-center self-center font-medium" role="status" [class.text-done]="result() === 'allowed'" [class.text-muted]="result() !== 'allowed'">{{ resultText() }}</p>
        }
      </div>
    </segwi-card>
  `,
})
export class ApprovalCard {
  readonly approval = input.required<Approval>();
  readonly result = input<DecisionResult | null>(null);
  /** Move focus to Deny when the card appears: the default answer is the safe one. */
  readonly focusDeny = input(false);

  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly tapGuard = inject(ApprovalTapGuard);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly deny = viewChild('deny', { read: ElementRef<HTMLButtonElement> });
  protected readonly exactLabel = computed(() => EXACT_LABELS[this.approval().tool] ?? 'Call');
  protected readonly hiddenCount = computed(() => escapeCount(visibleSegments(this.approval().exact)) + escapeCount(visibleSegments(this.approval().why ?? '')));
  protected readonly hiddenNote = computed(() => {
    const count = this.hiddenCount();
    return `${count} hidden or control character${count === 1 ? '' : 's'} shown as marked codes. Copy gives the exact text.`;
  });
  protected readonly expiry = computed(() => untilTime(this.approval().expiresAt, now()));
  protected readonly resultText = computed(() => {
    const result = this.result();
    if (result === 'allowed') return 'Allowed';
    if (result === 'denied') return 'Denied';
    return 'Someone already answered this one.';
  });

  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    afterNextRender(() => {
      if (this.focusDeny()) this.deny()?.nativeElement.focus({ preventScroll: false });
      this.watchHeight(host);
    });
  }

  /** A card that grows or shrinks moves every card below it, so it tells the tap guard. */
  private watchHeight(host: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return;
    let height = host.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const next = host.getBoundingClientRect().height;
      if (next !== height) this.tapGuard.moved();
      height = next;
    });
    observer.observe(host);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  protected async answer(decision: 'allow' | 'deny', event: MouseEvent | null = null): Promise<void> {
    // A tap that lands just after the cards moved was probably meant for another card.
    if (!this.tapGuard.accepts(event)) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.decide(this.approval().id, decision);
      this.live.recordDecision(this.approval(), decision === 'allow' ? 'allowed' : 'denied');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) this.live.recordDecision(this.approval(), 'answered');
      else this.error.set((error as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
