import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { Health, HeldNotification, Pending, Session } from '../models';
import { GithubApi } from '../pages/github/github-api';
import type { PrSummary } from '../pages/github/models';
import { ApiError, ApiService } from './api';
import { countPhases, sortSessions } from './session-view';

export type Connection = 'connecting' | 'live' | 'reconnecting';
export const BACKOFF_MS = [1000, 2000, 5000, 10_000];
/** Events arrive in bursts; one refetch follows the last of them. */
export const REFRESH_DEBOUNCE_MS = 150;

/** The delay before the nth manual reconnect: 1 s, 2 s, 5 s, 10 s, then every 10 s. */
export const backoffFor = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];

/** A message on the stream that an open screen may care about. */
export interface StreamEvent {
  type: 'session' | 'question' | 'transcript';
  sessionId: string;
  at: string;
}

/**
 * The one place that knows the sessions, the question queue and herdr's health. A single EventSource keeps
 * them fresh; nothing polls. After a drop it refetches once, so a missed event cannot linger. While atlas
 * can't be seen, what was last shown stays on screen, marked with the time it was current.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly api = inject(ApiService);
  private readonly github = inject(GithubApi);
  readonly sessions = signal<Session[]>([]);
  readonly questions = signal<Pending[]>([]);
  readonly health = signal<Health | null>(null);
  /** Every open pull request in the review group, newest first; Now shows the first few. */
  readonly toReview = signal<PrSummary[]>([]);
  readonly held = signal<HeldNotification[]>([]);
  readonly connection = signal<Connection>('connecting');
  /** False until the first load finishes, so a screen shows a skeleton instead of "nothing needs you". */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  /** When the lists were last read from a live atlas. */
  readonly lastSeenAt = signal<string | null>(null);
  /** True while the server can't be reached at all. */
  private readonly unreachable = signal(false);

  readonly ordered = computed(() => sortSessions(this.sessions()));
  readonly counts = computed(() => countPhases(this.sessions()));
  readonly needsCount = computed(() => this.questions().length);
  /** The server answers but herdr doesn't, or the server doesn't answer: either way atlas can't be seen. */
  readonly offline = computed(() => this.unreachable() || this.health()?.herdr.connected === false);
  /** The time shown as "last seen": the last good read, else when herdr last answered. */
  readonly lastSeenLabel = computed(() => this.lastSeenAt() ?? this.health()?.herdr.lastSeenAt ?? null);
  readonly boardCount = computed(() => (this.toReview().length ? this.toReview().length : null));

  /** Stream events for the open screen, such as a session's transcript. */
  readonly events = new Subject<StreamEvent>();
  /** Fires when events may have been missed; an open screen reloads what it shows. */
  readonly reloads = new Subject<void>();

  private source: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private everConnected = false;

  start(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    void this.refresh();
    this.open();
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    if (this.retry) clearTimeout(this.retry);
    if (this.pending) clearTimeout(this.pending);
  }

  /** Reloads everything; used at the start, after a reconnect and by the Retry button. Events skip the pull requests, which GitHub's own cache answers slowly. */
  async refresh(withBoard = true): Promise<void> {
    try {
      const [health, sessions, questions] = await Promise.all([this.api.health(), this.api.sessions(), this.api.questions()]);
      this.unreachable.set(false);
      this.health.set(health);
      this.loadError.set(null);
      if (health.herdr.connected) {
        this.sessions.set(sessions);
        this.questions.set(questions);
        this.lastSeenAt.set(new Date().toISOString());
      } else if (!this.loaded()) {
        // Nothing was ever shown, so what the server kept is all there is.
        this.sessions.set(sessions);
        this.questions.set(questions);
      }
      if (withBoard) void this.refreshBoard();
    } catch (error) {
      this.loadError.set((error as Error).message);
      if (error instanceof ApiError && error.status === 0) this.unreachable.set(true);
    } finally {
      this.loaded.set(true);
    }
  }

  /** The pull requests waiting for you and the notifications held while you were away; both are optional extras. */
  private async refreshBoard(): Promise<void> {
    this.github.prs().then((prs) => this.toReview.set(prs.filter((pr) => pr.groups.includes('review'))), () => undefined);
    this.api.notificationPrefs().then((prefs) => this.held.set(prefs.held), () => undefined);
  }

  /** Marks held notifications as seen, so they leave Now. */
  async markHeldSeen(ids: string[]): Promise<void> {
    this.held.update((list) => list.filter((entry) => !ids.includes(entry.id)));
    await this.api.heldSeen(ids).then((held) => this.held.set(held), () => undefined);
  }

  /** Re-reads soon, folding a burst of events into one request. */
  scheduleRefresh(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.refresh(false);
    }, REFRESH_DEBOUNCE_MS);
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
    for (const type of ['session', 'question', 'transcript'] as const) {
      source.addEventListener(type, (event) => this.onEvent(type, JSON.parse((event as MessageEvent<string>).data) as { sessionId: string; at: string }));
    }
    source.addEventListener('error', () => {
      this.connection.set('reconnecting');
      if (source.readyState !== EventSource.CLOSED) return; // the browser is already retrying
      source.close();
      this.source = null;
      this.retry = setTimeout(() => this.open(), backoffFor(this.attempt++));
    });
  }

  private reloadAll(): void {
    void this.refresh();
    this.reloads.next();
  }

  private onEvent(type: StreamEvent['type'], data: { sessionId: string; at: string }): void {
    this.events.next({ type, sessionId: data.sessionId, at: data.at });
    // A transcript moving changes no list; a session or a question does.
    if (type !== 'transcript') this.scheduleRefresh();
  }

  /** Whether the stream has ever connected; the banner reads "Reconnecting…" only after that. */
  get hasConnected(): boolean {
    return this.everConnected;
  }
}
