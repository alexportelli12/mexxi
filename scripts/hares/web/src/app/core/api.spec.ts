import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService, failureMessage, isStale, STALE_MESSAGE } from './api';

const expect1 = { terminalId: 't1', sessionId: 's1', status: 'blocked' as const, seq: 41 };

function reply(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, text: () => Promise.resolve(body === null ? '' : JSON.stringify(body)) });
}

describe('ApiService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the status and sequence the person saw with an answer, to that session', async () => {
    const fetchSpy = reply(200, { session: {} });
    vi.stubGlobal('fetch', fetchSpy);
    await TestBed.inject(ApiService).answer('s 1', { questionId: 'q1', expect: expect1, answers: [{ kind: 'option', n: 2 }] });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/sessions/s%201/answer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ questionId: 'q1', expect: expect1, answers: [{ kind: 'option', n: 2 }] });
  });

  it('adds the confirmation to an always-allow decision and to nothing else', async () => {
    const fetchSpy = reply(200, { session: {} });
    vi.stubGlobal('fetch', fetchSpy);
    const api = TestBed.inject(ApiService);
    await api.decide('p1', { decision: 'always', expect: expect1, rule: 'Bash(pnpm add:*)' });
    await api.decide('p1', { decision: 'once', expect: expect1 });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ decision: 'always', expect: expect1, rule: 'Bash(pnpm add:*)', confirm: true });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ decision: 'once', expect: expect1 });
  });

  it('reads a 409 from the server as the session having moved, and always words it the same way', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'seq 41 is now 43', code: 'stale' }));
    const error = await TestBed.inject(ApiService).esc('s1', expect1).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(isStale(error)).toBe(true);
    expect(failureMessage(error)).toBe(STALE_MESSAGE);
    expect(STALE_MESSAGE).toBe('The session changed since you looked; check it again');
  });

  it('does not call another failure stale', () => {
    expect(isStale(new ApiError(500, 'broke'))).toBe(false);
    expect(isStale(new ApiError(409, 'other', 'merge_conflict'))).toBe(false);
    expect(failureMessage(new ApiError(400, 'Needs the confirm step.'))).toBe('Needs the confirm step.');
  });

  it('reports an unreachable server as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    const error = (await TestBed.inject(ApiService).health().catch((failure: unknown) => failure)) as ApiError;
    expect(error.status).toBe(0);
  });
});
