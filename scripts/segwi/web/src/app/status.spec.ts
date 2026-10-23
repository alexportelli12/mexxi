import { ACTIVE_STATUSES, STATUS, STATUSES, idleMinutes, isFinal, statusCopy } from './status';

describe('status map', () => {
  it('covers every run state with words and an icon', () => {
    expect(STATUSES.sort()).toEqual(['completed', 'failed', 'needs_approval', 'needs_input', 'queued', 'running', 'stopped', 'timed_out'].sort());
    for (const status of STATUSES) {
      expect(STATUS[status].copy.length).toBeGreaterThan(0);
      expect(STATUS[status].icon).toBeTruthy();
    }
  });

  it('uses the plan copy', () => {
    expect(STATUS.queued.copy).toBe('Waiting to start');
    expect(STATUS.running.copy).toBe('Working');
    expect(STATUS.needs_input.copy).toBe('Needs your reply');
    expect(STATUS.needs_approval.copy).toBe('Needs your OK');
    expect(STATUS.completed.copy).toBe('Done');
    expect(STATUS.failed.copy).toBe('Failed');
    expect(STATUS.stopped.copy).toBe('Stopped by you');
  });

  it('says how long a timed-out run was quiet, from the reason the server recorded', () => {
    expect(idleMinutes('No activity for 45 min')).toBe(45);
    expect(idleMinutes('Hit the time limit')).toBeNull();
    expect(statusCopy('timed_out', { reason: 'No activity for 45 min' })).toBe('Stopped: no activity for 45 min');
    expect(statusCopy('timed_out', { reason: null })).toBe('Stopped: no activity');
  });

  it('tells active states from final ones', () => {
    expect(ACTIVE_STATUSES.every((status) => !isFinal(status))).toBe(true);
    expect(isFinal('completed')).toBe(true);
  });
});
