import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { now } from '../core/clock';
import { DecisionResult, LiveService } from '../core/live';
import { untilTime } from '../core/time';
import type { Approval } from '../models';
import { Button } from './button';
import { Card } from './card';
import { CopyButton } from './copy-button';

/** One approval: what exactly would run, where, why, and the two answers. Enter never approves. */
@Component({
  selector: 'segwi-approval-card',
  imports: [Button, Card, CopyButton, RouterLink],
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
          <h3 class="text-sm text-muted">{{ approval().tool === 'Bash' ? 'Command' : 'Call' }}</h3>
          <segwi-copy-button [text]="approval().exact" label="the command" />
        </div>
        <pre class="font-code max-h-60 overflow-auto rounded-card border border-border bg-bg p-3 text-sm whitespace-pre-wrap break-words" tabindex="0" [attr.aria-label]="'Exact ' + approval().tool + ' call'">{{ approval().exact }}</pre>
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[15px]">
        <dt class="text-muted">Runs in</dt>
        <dd class="font-code text-sm break-all">{{ approval().cwd }}</dd>
        @if (approval().why) {
          <dt class="text-muted">Why</dt>
          <dd>{{ approval().why }}</dd>
        }
      </dl>

      @if (result()) {
        <p class="flex min-h-11 items-center font-medium" role="status" [class.text-done]="result() === 'allowed'" [class.text-muted]="result() !== 'allowed'">{{ resultText() }}</p>
      } @else {
        <p class="text-sm text-muted">Denied automatically in {{ expiry() }}</p>
        @if (error()) { <p class="text-sm text-failed" role="alert">{{ error() }}</p> }
        <div class="flex items-center justify-between gap-6">
          <button #deny segwi-button type="button" [disabled]="busy()" (click)="answer('deny')">Deny</button>
          <button segwi-button variant="primary" type="button" [disabled]="busy()" (click)="answer('allow')">Approve</button>
        </div>
      }
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
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly deny = viewChild('deny', { read: ElementRef<HTMLButtonElement> });
  protected readonly expiry = computed(() => untilTime(this.approval().expiresAt, now()));
  protected readonly resultText = computed(() => {
    const result = this.result();
    if (result === 'allowed') return 'Allowed';
    if (result === 'denied') return 'Denied';
    return 'Someone already answered this one.';
  });

  constructor() {
    afterNextRender(() => {
      if (this.focusDeny()) this.deny()?.nativeElement.focus({ preventScroll: false });
    });
  }

  protected async answer(decision: 'allow' | 'deny'): Promise<void> {
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
