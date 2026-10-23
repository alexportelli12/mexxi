import { TestBed } from '@angular/core/testing';
import { ApiService } from './api';
import { LiveService } from './live';
import { ApprovalTapGuard, MoveGuard, SETTLE_MS, listShape } from './tap-guard';
import type { Approval } from '../models';

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

describe('ApprovalTapGuard', () => {
  let clock = 10_000;
  const approval = (id: string, createdAt: string) => ({ id, runId: 'r', createdAt }) as Approval;

  beforeEach(() => {
    clock = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: {} }] });
  });
  afterEach(() => vi.restoreAllMocks());

  it('ignores a tap right after the approvals list changes, and keyboard presses never', () => {
    const guard = TestBed.inject(ApprovalTapGuard);
    const live = TestBed.inject(LiveService);
    TestBed.tick();
    clock += SETTLE_MS;
    expect(guard.accepts(tap())).toBe(true);

    live.approvals.set([approval('a', '2026-01-01T00:00:00Z'), approval('b', '2026-01-01T00:01:00Z')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(false);
    expect(guard.accepts(tap(0))).toBe(true);
    clock += SETTLE_MS - 1;
    expect(guard.accepts(tap())).toBe(false);
    clock += 1;
    expect(guard.accepts(tap())).toBe(true);

    // The same list again is not a move.
    live.approvals.set([approval('a', '2026-01-01T00:00:00Z'), approval('b', '2026-01-01T00:01:00Z')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(true);

    // A card leaving moves the ones below it.
    live.approvals.set([approval('b', '2026-01-01T00:01:00Z')]);
    TestBed.tick();
    expect(guard.accepts(tap())).toBe(false);
  });

  it('counts a card changing height as a move', () => {
    const guard = TestBed.inject(ApprovalTapGuard);
    TestBed.tick();
    clock += SETTLE_MS;
    expect(guard.accepts(tap())).toBe(true);
    guard.moved();
    expect(guard.accepts(tap())).toBe(false);
  });
});
