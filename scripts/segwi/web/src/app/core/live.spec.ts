import { TestBed } from '@angular/core/testing';
import { ApiService } from './api';
import { BACKOFF_MS, LiveService, backoffFor } from './live';

describe('reconnect backoff', () => {
  it('waits 1 s, 2 s, 5 s, 10 s, then 10 s every time', () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 5000, 10_000]);
    expect([0, 1, 2, 3, 4, 20].map(backoffFor)).toEqual([1000, 2000, 5000, 10_000, 10_000, 10_000]);
  });
});

/** A stand-in EventSource the test drives by hand. */
class FakeSource {
  static last: FakeSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  private readonly listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(name: string, listener: (event: unknown) => void): void {
    (this.listeners[name] ??= []).push(listener);
  }
  emit(name: string, data?: unknown): void {
    for (const listener of this.listeners[name] ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  close(): void {
    this.readyState = FakeSource.CLOSED;
  }
}

describe('LiveService reloads', () => {
  let original: unknown;
  let listCalls = 0;
  const api = {
    runs: async () => { listCalls += 1; return []; },
    approvals: async () => [],
    health: async () => ({ ok: true, limits: { taskMaxChars: 1, inputMaxChars: 1, idleTimeoutMinutes: 1 } }),
  };

  beforeEach(() => {
    original = (globalThis as { EventSource?: unknown }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    listCalls = 0;
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
  });
  afterEach(() => {
    TestBed.inject(LiveService).stop();
    (globalThis as { EventSource?: unknown }).EventSource = original;
  });

  it('asks open screens to reload when the stream comes back after a drop, but not on the first connect', async () => {
    const live = TestBed.inject(LiveService);
    let reloads = 0;
    live.reloads.subscribe(() => (reloads += 1));
    live.start();
    const source = FakeSource.last!;
    source.emit('open');
    expect(reloads).toBe(0);
    source.emit('error');
    expect(live.connection()).toBe('reconnecting');
    source.emit('open');
    expect(reloads).toBe(1);
    await Promise.resolve();
    expect(listCalls).toBe(2);
  });

  it('reloads everything when the server sends reset', async () => {
    const live = TestBed.inject(LiveService);
    let reloads = 0;
    live.reloads.subscribe(() => (reloads += 1));
    live.start();
    FakeSource.last!.emit('open');
    FakeSource.last!.emit('reset', { reason: 'truncated' });
    expect(reloads).toBe(1);
    await Promise.resolve();
    expect(listCalls).toBe(2);
  });
});
