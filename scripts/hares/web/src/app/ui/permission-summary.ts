import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { now } from '../core/clock';
import { permissionCopy } from '../core/permission-copy';
import { relativeTime } from '../core/time';
import type { Pending } from '../models';
import { AskCard } from './ask-card';
import { Button } from './button';
import { VisibleText } from './visible-text';

let cards = 0;

/**
 * A permission waiting in the queue on Now. It shows what is asked and opens the session to decide: a
 * permission is never decided from a list, where a finger could land on the wrong row.
 */
@Component({
  selector: 'hares-permission-summary',
  imports: [AskCard, Button, RouterLink, VisibleText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <hares-ask-card variant="card" [lead]="pending().asker + ' needs your OK'" [labelledBy]="titleId" [queue]="queue()" [age]="queue() ? null : age()" (previous)="previous.emit()" (next)="next.emit()">
      <h2 [id]="titleId" class="mt-2 mb-3 px-4 text-[22px] leading-[1.24] font-semibold tracking-[-0.016em]">{{ title() }}</h2>
      @if (pending().permission; as permission) {
        <code class="mx-2 mb-1 block max-h-24 overflow-hidden rounded-2xl bg-bg px-4 py-3 font-mono text-[14.5px] leading-[1.5] break-words whitespace-pre-wrap text-text">@if (permission.tool === 'Bash') {<span class="text-faint">$ </span>}<hares-visible-text [text]="permission.exact" /></code>
      }
      <div class="flex items-center gap-2 pt-3 pr-2 pb-2 pl-4">
        <span class="flex-1 text-[14.5px] text-muted">Decide it on the session screen.</span>
        <a hares-button variant="primary" [routerLink]="['/s', pending().sessionId]" [queryParams]="{ q: pending().id }">Review</a>
      </div>
    </hares-ask-card>
  `,
})
export class PermissionSummary {
  readonly pending = input.required<Pending>();
  readonly queue = input<{ index: number; total: number } | null>(null);
  readonly previous = output<void>();
  readonly next = output<void>();
  protected readonly titleId = `summary-${++cards}`;
  protected readonly title = computed(() => permissionCopy(this.pending()).title);
  protected readonly age = computed(() => relativeTime(this.pending().askedAt, now()));
}
