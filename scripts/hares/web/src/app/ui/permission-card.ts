import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, untracked, effect } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, failureMessage, isStale } from '../core/api';
import { LiveService } from '../core/live';
import { permissionCopy } from '../core/permission-copy';
import { QueueTapGuard } from '../core/tap-guard';
import type { Decision, Pending } from '../models';
import { AskCard, type AskVariant } from './ask-card';
import { Banner } from './banner';
import { Button } from './button';
import { ConfirmPanel } from './confirm-panel';
import { CopyButton } from './copy-button';
import { PermissionContentView } from './permission-content';
import { VisibleText } from './visible-text';

let cards = 0;

/**
 * A permission prompt, decided by a person here and nowhere else: "Run once", "Always allow" behind a confirm
 * step that shows the exact rule, or "Don't run" with an optional reason. Nothing is a default and nothing
 * is allowed by a timer. A prompt too long to show whole offers no allow button at all.
 */
@Component({
  selector: 'hares-permission-card',
  imports: [AskCard, Banner, Button, ConfirmPanel, CopyButton, PermissionContentView, RouterLink, VisibleText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <hares-ask-card [variant]="variant()" [labelledBy]="titleId" [queue]="queue()" (previous)="previous.emit()" (next)="next.emit()">
      @let permission = pending().permission;
      <h2 [id]="titleId" class="text-[22px] leading-[1.24] font-semibold tracking-[-0.016em]" [class]="variant() === 'sheet' ? 'mt-4 px-2 lg:mt-0 lg:px-0' : 'mt-2 px-2'">{{ copy().title }}</h2>

      @if (permission) {
        <div class="mt-4 flex items-center gap-2 rounded-2xl bg-bg py-1.5 pr-1.5 pl-4">
          <code class="max-h-48 min-w-0 flex-1 overflow-auto font-mono text-[14.5px] leading-[1.5] break-words whitespace-pre-wrap text-text">@if (permission.tool === 'Bash') {<span class="text-faint">$ </span>}<hares-visible-text [text]="permission.exact" /></code>
          <hares-copy-button [text]="permission.exact" label="command" />
        </div>
        @if (permission.why) { <p class="mt-2 px-1 text-sm leading-[1.4] text-faint">{{ permission.why }}</p> }
        @if (permission.content; as content) { <hares-permission-content class="mt-3" [content]="content" /> }
      }

      @if (pending().answerable && permission && !permission.tooLong) {
        <button hares-button variant="primary" size="lg" class="mt-6 w-full" type="button" [disabled]="busy()" (click)="decide('once', $event)">{{ copy().once }}</button>
        @if (permission.always; as rule) {
          <button hares-button variant="outline" class="mt-2 w-full" type="button" [attr.aria-expanded]="confirming()" [class.border-red]="confirming()" (click)="toggleConfirm($event)">{{ copy().always }}</button>
          @if (confirming()) {
            <hares-confirm-panel class="mt-2" label="Confirm the rule" cancelLabel="Keep asking" confirmLabel="Add the rule" [shield]="true" [code]="rule.text" [busy]="busy()" (cancelled)="confirming.set(false)" (confirmed)="decide('always', null)">{{ copy().confirm }}</hares-confirm-panel>
          }
        }
        @if (error(); as message) {
          <hares-banner class="mt-3" kind="error">{{ message }}
            <button action hares-button size="sm" variant="quiet" type="button" (click)="checkAgain()">Check again</button>
          </hares-banner>
        }
        <div class="mt-6 flex gap-2 border-t border-line pt-4">
          <label [for]="reasonId" class="sr-only">Say no and explain</label>
          <input [id]="reasonId" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-bg px-4 text-base text-text" placeholder="Say no and tell Claude why" [value]="reason()" (input)="reason.set($any($event.target).value)" />
          <button hares-button type="button" [disabled]="busy()" (click)="decide('deny', $event)">{{ copy().deny }}</button>
        </div>
      } @else {
        <div class="mt-4 flex flex-col gap-3 px-1">
          <p class="text-[15px] leading-[1.45] text-muted">{{ pending().reason ?? (permission?.tooLong ? 'This is too long to show in full. Answer it in the terminal.' : 'Only the terminal can answer this one.') }}</p>
          <a hares-button size="sm" variant="primary" class="self-start" [routerLink]="['/s', pending().sessionId, 'terminal']">Answer in the terminal</a>
        </div>
      }
    </hares-ask-card>
  `,
})
export class PermissionCard {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly guard = inject(QueueTapGuard);
  readonly pending = input.required<Pending>();
  readonly variant = input<AskVariant>('sheet');
  readonly queue = input<{ index: number; total: number } | null>(null);
  readonly previous = output<void>();
  readonly next = output<void>();
  readonly decided = output<Decision>();

  protected readonly titleId = `permission-${++cards}`;
  protected readonly reasonId = `reason-${cards}`;
  protected readonly confirming = signal(false);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copy = computed(() => permissionCopy(this.pending()));
  /** The id alone: a reload that brings the same prompt again as a new object must not close its confirm step. */
  private readonly pendingId = computed(() => this.pending().id);

  constructor() {
    // A different prompt starts clean: an open confirm step for one never applies to another.
    effect(() => {
      this.pendingId();
      untracked(() => {
        this.confirming.set(false);
        this.reason.set('');
        this.error.set(null);
        this.busy.set(false);
      });
    });
  }

  protected toggleConfirm(event: MouseEvent): void {
    if (this.guard.accepts(event)) this.confirming.update((value) => !value);
  }

  protected async decide(decision: Decision, event: MouseEvent | null): Promise<void> {
    if (!this.guard.accepts(event) || this.busy()) return;
    const { id, expect, permission } = this.pending();
    const rule = permission?.always?.text;
    if (decision === 'always' && !rule) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.decide(id, {
        decision, expect,
        ...(decision === 'always' ? { rule } : {}),
        ...(decision === 'deny' && this.reason().trim() ? { reason: this.reason().trim() } : {}),
      });
      this.decided.emit(decision);
      void this.live.refresh();
    } catch (error) {
      this.error.set(failureMessage(error));
      if (isStale(error)) void this.live.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected async checkAgain(): Promise<void> {
    this.error.set(null);
    await this.live.refresh();
  }
}
