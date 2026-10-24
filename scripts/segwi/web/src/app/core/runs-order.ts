import type { Approval, Run } from '../models';
import { ACTIVE_STATUSES } from '../status';

export type RunFilter = 'active' | 'needs' | 'running' | 'done' | 'all';
/** Active is the default and has no URL parameter; every other chip is ?filter=<id>. */
export const DEFAULT_FILTER: RunFilter = 'active';
export const FILTERS: { id: RunFilter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

export const parseFilter = (value: string | null | undefined): RunFilter =>
  FILTERS.some((filter) => filter.id === value) ? (value as RunFilter) : DEFAULT_FILTER;

/** The filter's URL parameter: none for the default. */
export const filterParam = (filter: RunFilter): string | null => (filter === DEFAULT_FILTER ? null : filter);

/** A run needs you when it waits on a reply or has an open approval. */
export function needsYou(run: Run, approvals: Approval[]): boolean {
  return run.status === 'needs_input' || run.status === 'needs_approval' || approvals.some((approval) => approval.runId === run.id);
}

/** When the run began waiting: its oldest open approval, else its last activity. */
function waitingSince(run: Run, approvals: Approval[]): number {
  const times = approvals.filter((approval) => approval.runId === run.id).map((approval) => Date.parse(approval.createdAt));
  return times.length ? Math.min(...times) : Date.parse(run.lastActivityAt);
}

export interface RunGroups {
  needs: Run[];
  rest: Run[];
}

/** "Needs you" first, oldest waiting first; everything else newest first. */
export function groupRuns(runs: Run[], approvals: Approval[]): RunGroups {
  const needs = runs.filter((run) => needsYou(run, approvals)).sort((a, b) => waitingSince(a, approvals) - waitingSince(b, approvals));
  const rest = runs.filter((run) => !needsYou(run, approvals)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { needs, rest };
}

/** Applies a filter chip; the needs-you group is kept apart so it stays on top. */
export function filterGroups(groups: RunGroups, filter: RunFilter): RunGroups {
  switch (filter) {
    // Everything not yet over: queued, Working (waiting on a background command too) and what needs you.
    case 'active': return { needs: groups.needs, rest: groups.rest.filter((run) => ACTIVE_STATUSES.includes(run.status)) };
    case 'needs': return { needs: groups.needs, rest: [] };
    case 'running': return { needs: [], rest: groups.rest.filter((run) => run.status === 'running' || run.status === 'queued') };
    case 'done': return { needs: [], rest: groups.rest.filter((run) => ['completed', 'failed', 'stopped', 'timed_out'].includes(run.status)) };
    default: return groups;
  }
}

/** The number in the page title and on the Approvals tab. */
export const needsCount = (runs: Run[], approvals: Approval[]): number =>
  approvals.length + runs.filter((run) => run.status === 'needs_input').length;
