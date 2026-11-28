/** Shapes the GitHub screens read. github-api.ts documents which endpoint returns which. */

export type CheckState = 'pass' | 'fail' | 'pending';
/** The four groups the server sorts open pull requests into. One pull request can be in several (a failing bump is in both). */
export type PrGroup = 'review' | 'ready' | 'failing' | 'bumps';
export type BumpKind = 'major' | 'minor' | 'patch' | 'security';
export type SessionState = 'working' | 'waiting' | 'idle' | 'done';

/** A session that ħares can show, linked by evidence (branch name, transcript, pull request body). */
export interface LinkedSession {
  id: string;
  title: string;
  state: SessionState;
}

export interface PrSummary {
  repo: string;
  number: number;
  title: string;
  /** The pull request on github.com. */
  url: string;
  author: string;
  /** Dependabot, Renovate and the like. */
  bot: boolean;
  draft: boolean;
  createdAt: string;
  additions: number;
  deletions: number;
  groups: PrGroup[];
  /** One entry per check, in display order. */
  checks: CheckState[];
  /** Why checks failed, in the server's words ("verify:ci failed at lint"); null when none failed or it is unknown. */
  failureNote: string | null;
  /** A workflow run whose failed jobs can be rerun; null when there is none. */
  ciRunId: number | null;
  /** Review threads still open. */
  unresolvedThreads: number;
  bump: BumpKind | null;
  docsOnly: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  commits: number;
  /** The workflow that runs after a merge into the base branch, when there is one. */
  deployWorkflow: string | null;
  session: LinkedSession | null;
}

export interface CheckRun {
  name: string;
  state: CheckState;
  /** "4m 12s"; null while pending. */
  duration: string | null;
  url: string | null;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ThreadComment {
  id: number;
  author: string;
  /** Written by you. */
  mine: boolean;
  createdAt: string;
  /** Sanitised on the server, and rendered through Angular's sanitiser again. */
  bodyHtml: string;
}

/** A line-comment thread (path and line set) or a conversation comment (both null). */
export interface Thread {
  /** The first comment's id: replies go to it. */
  id: number;
  path: string | null;
  line: number | null;
  resolved: boolean;
  comments: ThreadComment[];
}

export interface PrReadiness {
  ready: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

export interface PrDetail extends PrSummary {
  state: 'open' | 'closed' | 'merged';
  changedFiles: number;
  /** The issue this pull request closes or came from, when known by evidence. */
  issue: number | null;
  /** Sanitised on the server, and rendered through Angular's sanitiser again. */
  bodyHtml: string;
  checkRuns: CheckRun[];
  files: ChangedFile[];
  threads: Thread[];
  readiness: PrReadiness;
  /** A preview deployment, when the pull request has one. */
  previewUrl: string | null;
}

export interface Issue {
  repo: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
  /** A session that is already working on it. */
  session: LinkedSession | null;
}

export type RunState = 'pass' | 'fail' | 'running';

export interface CiRun {
  id: number;
  /** The workflow's name, or several joined with "and" ("verify and docs"). */
  workflow: string;
  branch: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | null;
  startedAt: string;
  durationSeconds: number | null;
  jobsDone: number | null;
  jobsTotal: number | null;
  failedJob: string | null;
  failedStep: string | null;
  url: string;
}

export interface CiRepo {
  repo: string;
  /** The newest run on the default branch; null when the repo has none. */
  latest: CiRun | null;
  /** Up to 20 runs on the default branch, oldest first. */
  history: RunState[];
}

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
/** What a session started from a pull request should do first. */
export type SessionAsk = 'review-comments' | 'failing-check';
