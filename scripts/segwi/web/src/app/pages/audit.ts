import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ApiService } from '../core/api';
import { RelativeTime } from '../core/relative-time';
import type { AuditRow } from '../models';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Skeleton } from '../ui/skeleton';
import { titles } from '../words';

const PAGE = 50;

/** The audit log: read-only, newest first. The API returns the latest rows, so "Load more" asks for more of them. */
@Component({
  imports: [Banner, Button, EmptyState, RelativeTime, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold">{{ title }}</h1>
    @if (error()) {
      <segwi-banner tone="error">
        Couldn't load the audit log. {{ error() }}
        <button bannerAction segwi-button type="button" (click)="load()">Retry</button>
      </segwi-banner>
    } @else if (rows() === null) {
      <segwi-skeleton height="3rem" /><segwi-skeleton height="3rem" /><segwi-skeleton height="3rem" />
    } @else if (!rows()!.length) {
      <segwi-empty-state title="Nothing recorded yet" hint="Every action on the server is written here." />
    } @else {
      <ul class="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
        @for (row of rows(); track row.id) {
          <li class="grid gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:grid-cols-[8rem_1fr_auto]">
            <span class="text-muted"><segwi-time [iso]="row.at" /></span>
            <span class="font-code break-all">{{ row.action }}@if (row.target) { <span class="text-muted"> {{ row.target }}</span> }</span>
            <span [class]="row.outcome === 'ok' ? 'text-done' : 'text-failed'">{{ row.outcome === 'ok' ? 'OK' : row.outcome === 'rejected' ? 'Rejected' : 'Error' }}</span>
            <span class="text-muted sm:col-span-3">{{ row.actor }} · {{ row.origin }}@if (row.detail) { · {{ row.detail }} }</span>
          </li>
        }
      </ul>
      @if (canLoadMore()) {
        <button segwi-button type="button" class="self-center" (click)="more()">Load more</button>
      }
    }
  `,
})
export class AuditPage {
  private readonly api = inject(ApiService);
  protected readonly title = titles.audit;
  protected readonly rows = signal<AuditRow[] | null>(null);
  protected readonly error = signal('');
  protected readonly canLoadMore = signal(false);
  private limit = PAGE;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.error.set('');
    try {
      const rows = await this.api.audit(this.limit);
      this.rows.set(rows);
      this.canLoadMore.set(rows.length >= this.limit && this.limit < 200);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }

  protected more(): Promise<void> {
    this.limit = Math.min(this.limit + PAGE, 200);
    return this.load();
  }
}
