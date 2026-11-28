import type { Step } from '../models';
import { latestActivity } from './activity';

const step = (id: string, from: Step['from'] = 'agent', type: Step['type'] = 'command'): Step => ({ id, seq: 0, at: '2026-01-01T00:00:00Z', type, title: id, detail: null, from });

describe('latest activity', () => {
  it('shows the agent\'s latest step now and at most three before it, newest first, leaving out your replies', () => {
    const steps = [step('a'), step('b'), step('c'), step('d'), step('reply', 'you', 'message'), step('e')];
    const { now, recent } = latestActivity(steps);
    expect(now?.id).toBe('e');
    expect(recent.map((entry) => entry.id)).toEqual(['d', 'c', 'b']);
  });

  it('has nothing to show before the first step, and no recent list after only one', () => {
    expect(latestActivity([])).toEqual({ now: null, recent: [] });
    expect(latestActivity([step('a')]).recent).toEqual([]);
  });
});
