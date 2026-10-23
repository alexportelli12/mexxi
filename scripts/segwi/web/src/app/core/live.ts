import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { Approval, EventMessage, Run, RunMessage } from '../models';
import { needsCount } from './runs-order';
import { ApiService } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting';
export type DecisionResult = 'allowed' | 'denied' | 'answered';
export const LINGER_MS = 2000;
export const BACKOFF_MS = [1000, 2000, 5000, 10_000];

/** The delay before the nth manual reconnect: 1 s, 2 s, 5 s, 10 s, then every 10 s. */
export const backoffFor = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];

/**
 * The one place that knows the current runs and approvals. A single EventSource keeps them
 * fresh; nothing polls. After a drop it refetches once, so a missed event cannot linger.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly api = inject(ApiService);
  readonly runs = signal<Run[]>([]);
  readonly approvals = signal<Approval[]>([]);
  readonly connection = signal<Connection>('connecting');
  /** Null until the first load finishes; a message after a failed first load. */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  /** Answered approvals stay on screen for 2 s so the person sees what happened. */
  readonly lingering = signal<{ approval: Approval; result: DecisionResult }[]>([]);
  readonly shownApprovals = computed(() => {
    const open = this.approvals();
    const ids = new Set(open.map((approval) => approval.id));
    const items = [
      ...open.map((approval) => ({ approval, result: null as DecisionResult | null })),
      ...this.lingering().filter((entry) => !ids.has(entry.approval.id)),
    ];
    return items.sort((a, b) => Date.parse(a.approval.createdAt) - Date.parse(b.approval.createdAt));
  });
  readonly needsCount = computed(() => needsCount(this.runs(), this.approvals()));
  /** Every step-level event, for the run detail screen. */
  readonly events = new Subject<EventMessage>();
  /** Every status change, so an open run can reload itself. */
  readonly runUpdates = new Subject<RunMessage>();
  /**
   * Fires when events may have been missed: the stream came back after a drop, or the server
   * sent `reset` because too many were missed to replay. An open run detail reloads on it.
   */
  readonly reloads = new Subject<void>();
  /** The server's caps, for input counters; sensible defaults until health answers. */
  readonly limits = signal({ taskMaxChars: 8000, inputMaxChars: 4000, idleTimeoutMinutes: 30 });

  private source: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private everConnected = false;

  start(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    void this.refresh();
    this.loadHealth();
    this.open();
  }

  /** Caps; read at the start and again after a reconnect, when the server may have changed. */
  private loadHealth(): void {
    this.api.health().then((health) => {
      this.limits.set(health.limits);
    }).catch(() => undefined);
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    if (this.retry) clearTimeout(this.retry);
  }

  /** Reloads both lists; used at the start, after a reconnect and by the Retry button. */
  async refresh(): Promise<void> {
    try {
      const [runs, approvals] = await Promise.all([this.api.runs(), this.api.approvals()]);
      this.runs.set(runs);
      this.approvals.set(approvals);
      this.loadError.set(null);
    } catch (error) {
      this.loadError.set((error as Error).message);
    } finally {
      this.loaded.set(true);
    }
  }

  async refreshApprovals(): Promise<void> {
    try {
      this.approvals.set(await this.api.approvals());
    } catch {
      // The next event or reconnect refetches.
    }
  }

  /** Shows what happened to an approval for 2 s, then lets it leave the list. */
  recordDecision(approval: Approval, result: DecisionResult): void {
    this.approvals.update((list) => list.filter((entry) => entry.id !== approval.id));
    this.lingering.update((list) => [...list.filter((entry) => entry.approval.id !== approval.id), { approval, result }]);
    setTimeout(() => this.lingering.update((list) => list.filter((entry) => entry.approval.id !== approval.id)), LINGER_MS);
  }

  private open(): void {
    const source = new EventSource('/api/stream');
    this.source = source;
    source.addEventListener('open', () => {
      const wasDown = this.connection() === 'reconnecting';
      this.connection.set('live');
      this.attempt = 0;
      this.everConnected = true;
      if (wasDown) this.reloadAll();
    });
    // The server could not replay what was missed, so nothing on screen can be trusted to be current.
    source.addEventListener('reset', () => this.reloadAll());
    source.addEventListener('run', (event) => this.onRun(JSON.parse((event as MessageEvent<string>).data) as RunMessage));
    source.addEventListener('event', (event) => this.onEvent(JSON.parse((event as MessageEvent<string>).data) as EventMessage));
    source.addEventListener('error', () => {
      this.connection.set('reconnecting');
      if (source.readyState !== EventSource.CLOSED) return; // the browser is already retrying
      source.close();
      this.source = null;
      this.retry = setTimeout(() => {
        this.open();
      }, backoffFor(this.attempt++));
    });
  }

  /** Reloads the lists and tells any open screen to reload what it shows. */
  private reloadAll(): void {
    void this.refresh();
    this.loadHealth();
    this.reloads.next();
  }

  private onRun(message: RunMessage): void {
    this.runUpdates.next(message);
    const known = this.runs().some((run) => run.id === message.runId);
    if (!known) {
      void this.refresh();
      return;
    }
    this.runs.update((list) => list.map((run) => (run.id === message.runId
      ? { ...run, status: message.status, reason: message.reason, branch: message.branch, prUrl: message.prUrl, verify: message.verify, lastActivityAt: message.at, updatedAt: message.at, endedAt: ['completed', 'failed', 'stopped', 'timed_out'].includes(message.status) ? message.at : run.endedAt }
      : run)));
    void this.refreshApprovals();
  }

  private onEvent(message: EventMessage): void {
    this.events.next(message);
    this.runs.update((list) => list.map((run) => (run.id === message.runId ? { ...run, lastActivityAt: message.at } : run)));
    if (message.kind === 'approval') void this.refreshApprovals();
  }

  /** Whether the stream has ever connected; the banner reads "Reconnecting…" only after that. */
  get hasConnected(): boolean {
    return this.everConnected;
  }
}
