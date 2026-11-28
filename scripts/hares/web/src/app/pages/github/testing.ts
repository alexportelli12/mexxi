import type { CiRepo, CiRun, Issue, PrDetail, PrSummary } from './models';

/** Builders for the specs: a complete record with the fields a test cares about overridden. */
export const prSummary = (over: Partial<PrSummary> = {}): PrSummary => ({
  repo: 'eduline-ai-shop', number: 231, title: 'Jev view-picker spike', url: 'https://github.com/alex/eduline-ai-shop/pull/231', author: 'alex', bot: false,
  draft: false, createdAt: '2026-06-10T11:00:00Z', additions: 412, deletions: 38, groups: ['review', 'ready'], checks: ['pass', 'pass', 'pass', 'pass'],
  failureNote: null, ciRunId: null, unresolvedThreads: 0, bump: null, docsOnly: false, headSha: '3f2c1a09b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3',
  headRef: 'agent/jev-view-picker', baseRef: 'main', commits: 6, deployWorkflow: null, session: null, ...over,
});

export const prDetail = (over: Partial<PrDetail> = {}): PrDetail => ({
  ...prSummary(), state: 'open', changedFiles: 2, issue: 28, bodyHtml: '<h1>What this does</h1><p>Adds a spike.</p>',
  checkRuns: [{ name: 'verify:ci', state: 'pass', duration: '4m 12s', url: null }],
  files: [{ path: 'src/jev/view-picker.ts', additions: 188, deletions: 0 }, { path: 'package.json', additions: 2, deletions: 1 }],
  threads: [], readiness: { ready: true, checks: [{ name: 'ci-green', pass: true, detail: 'All checks passed' }] }, previewUrl: null, ...over,
});

export const issue = (over: Partial<Issue> = {}): Issue => ({
  repo: 'thats-fair', number: 19, title: 'OG images for listings', url: 'https://github.com/alex/thats-fair/issues/19', labels: ['launch blocker'],
  createdAt: '2026-01-01T00:00:00Z', session: null, ...over,
});

export const ciRun = (over: Partial<CiRun> = {}): CiRun => ({
  id: 77, workflow: 'verify', branch: 'main', status: 'completed', conclusion: 'failure', startedAt: '2026-06-10T11:20:00Z', durationSeconds: 112,
  jobsDone: null, jobsTotal: null, failedJob: 'lint', failedStep: 'oxlint', url: 'https://github.com/alex/verifika/actions/runs/77', ...over,
});

export const ciRepo = (over: Partial<CiRepo> = {}): CiRepo => ({ repo: 'verifika', latest: ciRun(), history: ['pass', 'pass', 'fail'], ...over });
