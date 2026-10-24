import type { Approval, Run } from '../models';
import { filterGroups, filterParam, groupRuns, needsCount, parseFilter } from './runs-order';

const run = (id: string, status: Run['status'], createdAt: string, lastActivityAt = createdAt): Run => ({
  id, repo: 'my-app', action: 'build', task: id, status, branch: null, prUrl: null, verify: null, costUsd: null, reason: null,
  createdAt, updatedAt: lastActivityAt, lastActivityAt, endedAt: null,
});
const approval = (id: string, runId: string, createdAt: string): Approval => ({
  id, runId, repo: 'my-app', tool: 'Bash', exact: 'x', cwd: '/w', why: '', risk: 'other', riskLabel: 'x', createdAt, expiresAt: createdAt, status: 'pending',
});

describe('run ordering', () => {
  const runs = [
    run('old-done', 'completed', '2026-01-01T10:00:00Z'),
    run('new-done', 'failed', '2026-01-03T10:00:00Z'),
    run('reply-late', 'needs_input', '2026-01-02T09:00:00Z', '2026-01-03T12:00:00Z'),
    run('reply-early', 'needs_input', '2026-01-02T08:00:00Z', '2026-01-03T08:00:00Z'),
    run('ok-run', 'needs_approval', '2026-01-02T07:00:00Z', '2026-01-03T07:00:00Z'),
    run('busy', 'running', '2026-01-03T11:00:00Z'),
    run('waiting-bg', 'running', '2026-01-03T09:30:00Z'),
    run('next', 'queued', '2026-01-03T09:00:00Z'),
    run('stopped', 'stopped', '2026-01-02T10:00:00Z'),
    run('quiet', 'timed_out', '2026-01-02T06:00:00Z'),
  ];
  runs[7] = { ...runs[7], waitingOn: 'Waiting on npm run verify' };
  const approvals = [approval('a1', 'ok-run', '2026-01-03T10:00:00Z')];

  it('puts the runs that need you first, the longest waiting at the top', () => {
    const { needs, rest } = groupRuns(runs, approvals);
    expect(needs.map((r) => r.id)).toEqual(['reply-early', 'ok-run', 'reply-late']);
    expect(rest.map((r) => r.id)).toEqual(['busy', 'new-done', 'waiting-bg', 'next', 'stopped', 'quiet', 'old-done']);
  });

  it('filters while keeping the needs-you group out of the other chips', () => {
    const groups = groupRuns(runs, approvals);
    expect(filterGroups(groups, 'needs').rest).toEqual([]);
    expect(filterGroups(groups, 'running').rest.map((r) => r.id)).toEqual(['busy', 'waiting-bg', 'next']);
    expect(filterGroups(groups, 'done').rest.map((r) => r.id)).toEqual(['new-done', 'stopped', 'quiet', 'old-done']);
    expect(filterGroups(groups, 'all')).toEqual(groups);
  });

  it('counts pending approvals plus runs waiting for a reply', () => {
    expect(needsCount(runs, approvals)).toBe(3);
    expect(needsCount([], [])).toBe(0);
  });

  it('shows only what is not over by default: queued, working (waiting on a background command too) and needing you', () => {
    const active = filterGroups(groupRuns(runs, approvals), parseFilter(null));
    expect(active.needs.map((r) => r.id)).toEqual(['reply-early', 'ok-run', 'reply-late']);
    expect(active.rest.map((r) => r.id)).toEqual(['busy', 'waiting-bg', 'next']);
  });

  it('keeps every run under All, which has its own URL parameter while Active has none', () => {
    expect(parseFilter('all')).toBe('all');
    expect(filterGroups(groupRuns(runs, approvals), 'all').rest).toHaveLength(7);
    expect(filterParam('all')).toBe('all');
    expect(filterParam(parseFilter(null))).toBeNull();
  });

  it('falls back to Active for an unknown filter in the URL', () => {
    expect(parseFilter('running')).toBe('running');
    expect(parseFilter('nonsense')).toBe('active');
  });
});
