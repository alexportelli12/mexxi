import type { CiRepo, CiRun } from './models';
import { formatDuration, historyAria, paddedHistory, progress, repoState, runLine, runWhen, sortRepos, summarise, tally } from './ci-logic';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const run = (over: Partial<CiRun>): CiRun => ({
  id: 1, workflow: 'verify', branch: 'main', status: 'completed', conclusion: 'success', startedAt: '2026-06-10T11:20:00Z',
  durationSeconds: 112, jobsDone: null, jobsTotal: null, failedJob: null, failedStep: null, url: 'https://github.com/x/y/actions/runs/1', ...over,
});
const repo = (name: string, latest: CiRun | null): CiRepo => ({ repo: name, latest, history: [] });
const failing = (name: string) => repo(name, run({ conclusion: 'failure', failedJob: 'lint', failedStep: 'oxlint' }));
const running = (name: string) => repo(name, run({ status: 'in_progress', conclusion: null, jobsDone: 3, jobsTotal: 5, durationSeconds: null }));
const passing = (name: string) => repo(name, run({}));

describe('repo state', () => {
  it('calls a failed, cancelled or timed-out latest run failing, since main did not pass', () => {
    expect(repoState(failing('a'))).toBe('failing');
    expect(repoState(repo('a', run({ conclusion: 'cancelled' })))).toBe('failing');
    expect(repoState(repo('a', run({ conclusion: 'timed_out' })))).toBe('failing');
  });

  it('calls a queued or in-progress run running, and a repo without runs idle rather than passing', () => {
    expect(repoState(running('a'))).toBe('running');
    expect(repoState(repo('a', run({ status: 'queued', conclusion: null })))).toBe('running');
    expect(repoState(repo('a', null))).toBe('idle');
  });

  it('puts failing repos first and keeps the server order inside a state', () => {
    const sorted = sortRepos([passing('p1'), running('r1'), failing('f1'), passing('p2'), failing('f2'), repo('i', null)]);
    expect(sorted.map((r) => r.repo)).toEqual(['f1', 'f2', 'r1', 'p1', 'p2', 'i']);
  });

  it('counts each state for the status bar', () => {
    expect(tally([failing('a'), running('b'), passing('c'), passing('d'), repo('e', null)])).toEqual({ failing: 1, running: 1, passing: 2, idle: 1 });
  });
});

describe('the summary above the list', () => {
  it('names the failing repo, the running one and how many are green', () => {
    const s = summarise([failing('verifika'), running('thats-fair'), passing('a'), passing('b'), passing('c'), passing('d')]);
    expect(s).toEqual({
      headline: 'Main is failing on verifika',
      running: 'One run is in progress on thats-fair.',
      others: 'The other four repos are green.',
    });
  });

  it('names two failing repos and counts three or more instead of listing them', () => {
    expect(summarise([failing('a'), failing('b')]).headline).toBe('Main is failing on a and b');
    expect(summarise([failing('a'), failing('b'), failing('c')]).headline).toBe('Main is failing on 3 repos');
  });

  it('says main is green with nothing else to add when every repo passes', () => {
    expect(summarise([passing('a'), passing('b')])).toEqual({ headline: 'Main is green', running: null, others: null });
  });

  it('uses the plural for several running repos', () => {
    expect(summarise([running('a'), running('b')]).running).toBe('Two runs are in progress on a and b.');
  });
});

describe('a run in words', () => {
  it('says where a failure happened, job then step, and drops what the server did not give', () => {
    expect(runLine(failing('x').latest!)).toBe('verify on main failed at lint, step oxlint');
    expect(runLine(run({ conclusion: 'failure' }))).toBe('verify on main failed');
  });

  it('reports a running run by its jobs and a passed one plainly', () => {
    expect(runLine(running('x').latest!)).toBe('verify on main, 3 of 5 jobs done');
    expect(runLine(run({}))).toBe('verify on main passed');
  });

  it('gives the age and duration of a finished run and only the start of a running one', () => {
    expect(runWhen(run({ startedAt: '2026-06-10T11:20:00Z', durationSeconds: 112 }), NOW)).toBe('40 minutes ago, 1m 52s');
    expect(runWhen(run({ status: 'in_progress', conclusion: null, startedAt: '2026-06-10T11:58:00Z' }), NOW)).toBe('started 2 minutes ago');
  });

  it('formats durations the way the design shows them', () => {
    expect(formatDuration(48)).toBe('48s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(3720)).toBe('1h 2m');
  });

  it('shows progress only for a running run that reports its jobs', () => {
    expect(progress(running('x').latest!)).toBe(60);
    expect(progress(run({}))).toBeNull();
    expect(progress(run({ status: 'in_progress', conclusion: null, jobsTotal: null, jobsDone: null }))).toBeNull();
  });
});

describe('run history', () => {
  it('pads a short history with empty cells on the left so the newest run stays at the right edge', () => {
    expect(paddedHistory(['pass', 'fail'], 4)).toEqual(['none', 'none', 'pass', 'fail']);
  });

  it('keeps only the newest runs when the server sends more than fit', () => {
    expect(paddedHistory(['fail', 'pass', 'pass'], 2)).toEqual(['pass', 'pass']);
  });

  it('tells a screen reader how many of the runs failed', () => {
    expect(historyAria(['pass', 'fail', 'fail'])).toBe('Last 3 runs, 2 failed');
    expect(historyAria(['pass'])).toBe('Last 1 run');
  });
});
