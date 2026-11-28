import type { Session } from '../models';
import { barLabel, barSegments, countPhases, dayLabel, expectOf, heading, phaseOf, shortAge, sortSessions, stateWord } from './session-view';

const row = (status: Session['status'], extra: Partial<Session> = {}) => ({ status, alive: true, lastActivityAt: '2026-11-28T12:00:00Z', ...extra }) as Session;

describe('session view', () => {
  it('counts only blocked as waiting, so a finished session never lights the lantern', () => {
    expect(phaseOf('blocked')).toBe('waiting');
    expect(phaseOf('working')).toBe('working');
    for (const status of ['idle', 'done', 'unknown'] as const) expect(phaseOf(status)).toBe('idle');
    expect(countPhases([row('blocked'), row('working'), row('working'), row('done')])).toEqual({ waiting: 1, working: 2, idle: 1 });
  });

  it('draws one bar segment per group that has sessions, with the counts for a screen reader', () => {
    const counts = { waiting: 1, working: 2, idle: 0 };
    expect(barSegments(counts, null).map((segment) => [segment.phase, segment.n])).toEqual([['waiting', '1'], ['working', '2']]);
    expect(barLabel(counts, null)).toBe('Sessions: 1 waiting, 2 working');
  });

  it('replaces the counts with the last-seen time when atlas can’t be seen', () => {
    const counts = { waiting: 1, working: 0, idle: 0 };
    expect(barSegments(counts, { lastSeen: '17:21' })).toEqual([{ phase: 'neutral', n: '', word: 'Last seen at 17:21', flex: 1 }]);
    expect(barLabel(counts, { lastSeen: '17:21' }, 'atlas')).toBe('atlas offline, last seen at 17:21');
  });

  it('words the headline for one waiting, several waiting, nothing waiting and offline', () => {
    expect(heading({ waiting: 1, working: 2, idle: 1 }, { offline: false, toReview: 3 })).toEqual({
      title: 'One session is waiting for you',
      sub: 'Four sessions are running on atlas, and three pull requests need your review.',
    });
    expect(heading({ waiting: 1, working: 2, idle: 1 }, { offline: false, toReview: 3, desktop: true }).sub).toBe('Four sessions on atlas, three pull requests to review.');
    expect(heading({ waiting: 3, working: 1, idle: 0 }, { offline: false, toReview: null }).title).toBe('Three sessions are waiting for you');
    expect(heading({ waiting: 0, working: 2, idle: 2 }, { offline: false, toReview: null })).toEqual({
      title: 'Nothing needs you right now',
      sub: 'Two sessions are working. You’ll get a notification the moment one asks you something.',
    });
    expect(heading({ waiting: 0, working: 0, idle: 0 }, { offline: true, toReview: null }).title).toBe('Can’t see atlas right now');
  });

  it('puts waiting sessions first, then working, newest first inside a group', () => {
    const sorted = sortSessions([
      row('idle', { lastActivityAt: '2026-11-28T12:05:00Z', title: 'idle' }),
      row('working', { lastActivityAt: '2026-11-28T12:01:00Z', title: 'old work' }),
      row('working', { lastActivityAt: '2026-11-28T12:04:00Z', title: 'new work' }),
      row('blocked', { lastActivityAt: '2026-11-28T11:00:00Z', title: 'waits' }),
    ]);
    expect(sorted.map((session) => session.title)).toEqual(['waits', 'new work', 'old work', 'idle']);
  });

  it('says a closed pane is finished whatever status it last had', () => {
    expect(stateWord({ status: 'blocked', alive: false, waitingOn: 'question' })).toBe('Finished');
    expect(stateWord({ status: 'blocked', alive: true, waitingOn: 'permission' })).toBe('Needs your approval');
    expect(stateWord({ status: 'blocked', alive: true, waitingOn: 'question' })).toBe('Waiting for you');
  });

  it('sends back the status and sequence the person saw', () => {
    expect(expectOf({ id: 's1', terminalId: 't1', status: 'blocked', seq: 41 })).toEqual({ terminalId: 't1', sessionId: 's1', status: 'blocked', seq: 41 });
  });

  it('shortens ages for a list and names the day for Activity', () => {
    const now = Date.parse('2026-11-28T12:00:00');
    expect(shortAge('2026-11-28T11:19:00', now)).toBe('41m');
    expect(shortAge('2026-11-28T10:00:00', now)).toBe('2h');
    expect(shortAge('2026-11-28T11:59:40', now)).toBe('now');
    expect(dayLabel('2026-11-28T01:00:00', now)).toBe('Today');
    expect(dayLabel('2026-11-27T23:00:00', now)).toBe('Yesterday');
  });
});
