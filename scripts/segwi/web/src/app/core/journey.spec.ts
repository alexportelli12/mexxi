import type { IbniSnapshot } from '../models';
import { journeyView } from './journey';

// The snapshot as the server stores it from the workspace tool's info and stats (lib/ibni-link.mjs beside the web app).
const base: IbniSnapshot = {
  branch: 'agent/footer', state: 'active', prUrl: null, createdAt: '2026-01-01T10:00:00Z',
  steps: [{ step: 'prepare', outcome: 'succeeded', durationMs: 900, endedAt: '2026-01-01T10:00:01Z' }],
};
const at = (iso: string) => Date.parse(iso);

describe('journey view', () => {
  it('has no journey before the run has a workspace', () => {
    expect(journeyView('r1', null, 0)).toBeNull();
  });

  it('reads a run that is building as BUILDING, 1 of 6, with the time since the workspace record last changed', () => {
    const view = journeyView('r1', base, at('2026-01-01T10:12:01Z'))!;
    expect(view.headline).toEqual({ label: 'BUILDING', tone: 'claude' });
    expect([view.done, view.total]).toEqual([1, 6]);
    expect(view.stages.map((stage) => stage.state)).toEqual(['done', 'current', 'pending', 'pending', 'pending', 'pending']);
    expect(view.onStage).toBe('12m on Build the change');
  });

  it('reads a red verify as needing attention, and a cross-family review from the server\'s byReviewer', () => {
    const verify = { attempts: 2, passed: 1, failed: 1, history: [{ outcome: 'pass', at: '2026-01-01T10:05:00Z' }, { outcome: 'fail', at: '2026-01-01T10:09:00Z' }] };
    const red = journeyView('r1', { ...base, verify }, at('2026-01-01T10:10:00Z'))!;
    expect(red.headline).toEqual({ label: 'NEEDS ATTENTION', tone: 'error' });
    expect(red.stages.find((stage) => stage.key === 'verify')).toMatchObject({ state: 'failed', detail: 'red · 1 of 2 runs passed' });

    const reviewed = journeyView('r1', {
      ...base, verify: { ...verify, history: [...verify.history, { outcome: 'pass', at: '2026-01-01T10:20:00Z' }] },
      review: { rounds: 1, findings: 2, byReviewer: { cross: { rounds: 1 } } },
    }, at('2026-01-01T10:30:00Z'))!;
    expect(reviewed.stages.find((stage) => stage.key === 'review')?.detail).toBe('1 pass · 2 findings · cross-family');
  });

  it('says the workspace tool is offline when the server could not reach it', () => {
    const { headline } = journeyView('r1', { ...base, error: "didn't answer" }, 0)!;
    expect(headline.tone).toBe('warning');
    expect(headline.label).toMatch(/ OFFLINE$/);
  });
});
