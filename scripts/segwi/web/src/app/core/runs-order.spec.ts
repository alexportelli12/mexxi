import type { Approval, Run } from '../models';
import { filterGroups, groupRuns, needsCount, parseFilter } from './runs-order';

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
  ];
  const approvals = [approval('a1', 'ok-run', '2026-01-03T10:00:00Z')];

  it('puts the runs that need you first, the longest waiting at the top', () => {
    const { needs, rest } = groupRuns(runs, approvals);
    expect(needs.map((r) => r.id)).toEqual(['reply-early', 'ok-run', 'reply-late']);
    expect(rest.map((r) => r.id)).toEqual(['busy', 'new-done', 'old-done']);
  });

  it('filters while keeping the needs-you group out of the other chips', () => {
    const groups = groupRuns(runs, approvals);
    expect(filterGroups(groups, 'needs').rest).toEqual([]);
    expect(filterGroups(groups, 'running').rest.map((r) => r.id)).toEqual(['busy']);
    expect(filterGroups(groups, 'done').rest.map((r) => r.id)).toEqual(['new-done', 'old-done']);
    expect(filterGroups(groups, 'all')).toEqual(groups);
  });

  it('counts pending approvals plus runs waiting for a reply', () => {
    expect(needsCount(runs, approvals)).toBe(3);
    expect(needsCount([], [])).toBe(0);
  });

  it('falls back to All for an unknown filter in the URL', () => {
    expect(parseFilter('running')).toBe('running');
    expect(parseFilter('nonsense')).toBe('all');
    expect(parseFilter(null)).toBe('all');
  });
});
