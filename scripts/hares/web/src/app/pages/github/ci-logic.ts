import type { CiRepo, CiRun, RunState } from './models';
import { relativeTime } from '../../core/time';

export type RepoState = 'failing' | 'running' | 'passing' | 'idle';

export function repoState(repo: CiRepo): RepoState {
  const run = repo.latest;
  if (!run) return 'idle';
  if (run.status !== 'completed') return 'running';
  return run.conclusion === 'success' ? 'passing' : 'failing';
}

const ORDER: RepoState[] = ['failing', 'running', 'passing', 'idle'];

/** Failing repos first, then running, passing and idle; the server order holds inside each. */
export function sortRepos(repos: readonly CiRepo[]): CiRepo[] {
  return repos
    .map((repo, index) => ({ repo, index, rank: ORDER.indexOf(repoState(repo)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.repo);
}

export function tally(repos: readonly CiRepo[]): Record<RepoState, number> {
  const counts: Record<RepoState, number> = { failing: 0, running: 0, passing: 0, idle: 0 };
  for (const repo of repos) counts[repoState(repo)]++;
  return counts;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const word = (n: number) => WORDS[n] ?? String(n);

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.length} repos`;
}

export interface CiSummary {
  /** "Main is failing on verifika" */
  headline: string;
  /** "One run is in progress on thats-fair." or null */
  running: string | null;
  /** "The other four repos are green." or null */
  others: string | null;
}

export function summarise(repos: readonly CiRepo[]): CiSummary {
  const failing = repos.filter((r) => repoState(r) === 'failing').map((r) => r.repo);
  const running = repos.filter((r) => repoState(r) === 'running').map((r) => r.repo);
  const passing = repos.filter((r) => repoState(r) === 'passing').length;
  return {
    headline: failing.length ? `Main is failing on ${names(failing)}` : 'Main is green',
    running: running.length
      ? `${word(running.length)} ${running.length === 1 ? 'run is' : 'runs are'} in progress on ${names(running)}.`
      : null,
    others: passing && failing.length + running.length
      ? `The other ${word(passing).toLowerCase()} ${passing === 1 ? 'repo is' : 'repos are'} green.`
      : null,
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "verify on main failed at lint, step oxlint" */
export function runLine(run: CiRun): string {
  const where = `${run.workflow} on ${run.branch}`;
  if (run.status !== 'completed') {
    return run.jobsDone !== null && run.jobsTotal !== null ? `${where}, ${run.jobsDone} of ${run.jobsTotal} jobs done` : `${where} is running`;
  }
  if (run.conclusion === 'success') return `${where} passed`;
  if (run.conclusion === 'cancelled') return `${where} was cancelled`;
  if (run.conclusion === 'timed_out') return `${where} timed out`;
  const at = run.failedJob ? ` at ${run.failedJob}` : '';
  const step = run.failedStep ? `, step ${run.failedStep}` : '';
  return `${where} failed${at}${step}`;
}

/** "40 min ago, 1m 52s" for a finished run, "started 2 min ago" for a running one. */
export function runWhen(run: CiRun, now: number): string {
  const ago = relativeTime(run.startedAt, now);
  if (run.status !== 'completed') return `started ${ago}`;
  return run.durationSeconds === null ? ago : `${ago}, ${formatDuration(run.durationSeconds)}`;
}

/** 0 to 100, or null when the server did not say how many jobs there are. */
export function progress(run: CiRun): number | null {
  if (run.status === 'completed' || !run.jobsTotal || run.jobsDone === null) return null;
  return Math.min(100, Math.round((run.jobsDone / run.jobsTotal) * 100));
}

export type HistoryCell = RunState | 'none';

/** Always `size` cells, oldest first: runs the repo does not have yet are empty cells on the left. */
export function paddedHistory(history: readonly RunState[], size: number): HistoryCell[] {
  const recent = history.slice(-size);
  return [...Array<HistoryCell>(size - recent.length).fill('none'), ...recent];
}

export function historyAria(history: readonly RunState[]): string {
  const failed = history.filter((h) => h === 'fail').length;
  const base = `Last ${history.length} ${history.length === 1 ? 'run' : 'runs'}`;
  return failed ? `${base}, ${failed} failed` : base;
}
