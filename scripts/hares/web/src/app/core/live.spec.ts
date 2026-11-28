import { TestBed } from '@angular/core/testing';
import type { Health, Session } from '../models';
import { GithubApi } from '../pages/github/github-api';
import { ApiError, ApiService } from './api';
import { backoffFor, LiveService, REFRESH_DEBOUNCE_MS } from './live';

class FakeEventSource {
  static last: FakeEventSource;
  static readonly CLOSED = 2;
  readyState = 1;
  listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
  close() {
    this.readyState = 2;
  }
}

const health = (connected: boolean): Health => ({ ok: true, herdr: { connected, protocol: 22, panes: 1, claudeSessions: 1, lastSeenAt: '2026-11-28T17:21:00Z' } });
const session = (id: string, status: Session['status']) => ({ id, status, alive: true, lastActivityAt: '2026-11-28T12:00:00Z' }) as Session;

function setup() {
  const api = {
    health: vi.fn().mockResolvedValue(health(true)),
    sessions: vi.fn().mockResolvedValue([session('a', 'blocked')]),
    questions: vi.fn().mockResolvedValue([]),
    notificationPrefs: vi.fn().mockResolvedValue({ prefs: {}, held: [] }),
    heldSeen: vi.fn(),
  };
  const github = { prs: vi.fn().mockResolvedValue([{ repo: 'r', number: 1, groups: ['review'] }, { repo: 'r', number: 2, groups: ['bumps'] }]) };
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: GithubApi, useValue: github }] });
  return { api, github, live: TestBed.inject(LiveService) };
}

describe('LiveService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps showing what it last saw while herdr is down, and says atlas is offline', async () => {
    const { api, live } = setup();
    await live.refresh();
    expect(live.sessions().map((entry) => entry.id)).toEqual(['a']);
    api.health.mockResolvedValue(health(false));
    api.sessions.mockResolvedValue([]);
    await live.refresh();
    expect(live.offline()).toBe(true);
    expect(live.sessions().map((entry) => entry.id)).toEqual(['a']);
  });

  it('treats an unreachable server the same way, without losing the list', async () => {
    const { api, live } = setup();
    await live.refresh();
    api.health.mockRejectedValue(new ApiError(0, 'Can’t reach the server.'));
    await live.refresh();
    expect(live.offline()).toBe(true);
    expect(live.sessions()).toHaveLength(1);
    api.health.mockResolvedValue(health(true));
    await live.refresh();
    expect(live.offline()).toBe(false);
  });

  it('folds a burst of question events into one reload, and ignores transcript events for the lists', async () => {
    const { api, live } = setup();
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    api.health.mockClear();
    const stream = FakeEventSource.last;
    stream.emit('question', { sessionId: 'a', at: 'x' });
    stream.emit('session', { sessionId: 'a', at: 'x' });
    stream.emit('question', { sessionId: 'b', at: 'x' });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    expect(api.health).toHaveBeenCalledTimes(1);
    const seen: string[] = [];
    live.events.subscribe((event) => seen.push(event.type));
    stream.emit('transcript', { sessionId: 'a', at: 'x' });
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10);
    expect(seen).toEqual(['transcript']);
    expect(api.health).toHaveBeenCalledTimes(1);
  });

  it('counts only the pull requests in the review group', async () => {
    const { live } = setup();
    await live.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(live.boardCount()).toBe(1);
  });

  it('waits longer between reconnects, up to ten seconds', () => {
    expect([0, 1, 2, 3, 9].map(backoffFor)).toEqual([1000, 2000, 5000, 10_000, 10_000]);
  });
});
