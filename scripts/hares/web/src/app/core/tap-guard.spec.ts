import { TestBed } from '@angular/core/testing';
import { ApiService } from './api';
import { GithubApi } from '../pages/github/github-api';
import { LiveService } from './live';
import { MoveGuard, QueueTapGuard, SETTLE_MS, listShape } from './tap-guard';
import type { Pending } from '../models';

const tap = (detail = 1) => new MouseEvent('click', { detail });

describe('MoveGuard', () => {
  it('ignores taps for 500 ms after a move, then accepts them', () => {
    const guard = new MoveGuard();
    expect(SETTLE_MS).toBe(500);
    expect(guard.accepts(0)).toBe(true);
    guard.moved(1000);
    expect(guard.accepts(1000)).toBe(false);
    expect(guard.accepts(1499)).toBe(false);
    expect(guard.accepts(1500)).toBe(true);
    guard.moved(1600);
    expect(guard.accepts(1700)).toBe(false);
  });

  it('sees a change in membership or order, not a re-render of the same list', () => {
    expect(listShape(['a', 'b'])).toBe(listShape(['a', 'b']));
    expect(listShape(['a', 'b'])).not.toBe(listShape(['b', 'a']));
    expect(listShape(['a', 'b'])).not.toBe(listShape(['a']));
    expect(listShape(['ab'])).not.toBe(listShape(['a', 'b']));
  });
});

describe('QueueTapGuard', () => {
  let clock = 10_000;
  const pending = (id: string) => ({ id, sessionId: 's' }) as Pending;

  beforeEach(() => {
    clock = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: {} }, { provide: GithubApi, useValue: {} }] });
  });
  afterEach(() => vi.restoreAllMocks());

  it('ignores a tap right after the queue changes, and keyboard presses never', () => {
    const guard = TestBed.inject(QueueTapGuard);
    const live = TestBed.inject(LiveService);
    TestBed.tick();
    clock += SETTLE_MS;
    expect(guard.accepts(tap())).toBe(true);

    live.questions.set([pending('a'), pending('b')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(false);
    expect(guard.accepts(tap(0))).toBe(true);
    clock += SETTLE_MS;
    expect(guard.accepts(tap())).toBe(true);

    // The same queue again is not a move.
    live.questions.set([pending('a'), pending('b')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(true);

    // A question leaving moves the ones below it.
    live.questions.set([pending('b')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(false);
  });

  it('counts the previous and next buttons as a move', () => {
    const guard = TestBed.inject(QueueTapGuard);
    TestBed.tick();
    clock += SETTLE_MS;
    expect(guard.accepts(tap())).toBe(true);
    guard.moved();
    expect(guard.accepts(tap())).toBe(false);
  });
});
