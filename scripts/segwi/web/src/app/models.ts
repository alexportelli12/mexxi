import type { Action } from './words';

export type RunStatus =
  | 'queued' | 'running' | 'needs_input' | 'needs_approval'
  | 'completed' | 'failed' | 'stopped' | 'timed_out';

export type StepType = 'edit' | 'command' | 'test' | 'read' | 'message' | 'refusal';

export interface Step {
  id: string;
  seq: number;
  at: string;
  type: StepType;
  title: string;
  detail: string | null;
  ok?: boolean | null;
  from?: 'agent' | 'you';
  tool?: string;
}

export interface Run {
  id: string;
  repo: string;
  action: Action;
  task: string;
  status: RunStatus;
  branch: string | null;
  prUrl: string | null;
  verify: 'pass' | 'fail' | null;
  costUsd: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  /** What a Working run waits on, such as its own background command; absent from servers that predate it. */
  waitingOn?: string | null;
  /** The workspace tool's record of the run, on one run's page only (the list leaves it out). */
  snapshot?: IbniSnapshot | null;
}

/** The workspace tool's info and stats in its own shape, as the server keeps them: read with the run pane's snapshotFrom. */
export interface IbniSnapshot {
  branch?: string;
  state?: string;
  prUrl?: string | null;
  createdAt?: string;
  steps: { step: string; outcome: string; durationMs?: number; endedAt?: string }[];
  verify?: { attempts: number; passed: number; failed: number; history: { outcome: string; at?: string }[] };
  review?: { rounds: number; findings: number; byReviewer?: { cross?: { rounds: number } } };
  qa?: { rounds: number; findings: number };
  /** Set when the workspace tool stopped answering after the run had a workspace. */
  error?: string;
}

export interface RunDetail extends Run {
  steps: Step[];
}

/** What an Edit, Write or NotebookEdit call would put in the file, raw and complete. */
export type ApprovalContent =
  | { kind: 'write'; text: string }
  | { kind: 'edit'; oldText: string; newText: string; replaceAll: boolean }
  | { kind: 'notebook'; cellId: string | null; editMode: string | null; cellType: string | null; text: string };

export interface Approval {
  id: string;
  runId: string;
  repo: string;
  tool: string;
  /** The raw command, file path, URL or call: never redacted or cut. */
  exact: string;
  /** Null for calls that change no file; absent from servers that predate it. */
  content?: ApprovalContent | null;
  cwd: string;
  why: string;
  risk: string;
  riskLabel: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
}

export interface Repo {
  name: string;
  actions: Action[];
  defaultBranch: string;
  clean: boolean;
  onDefault: boolean;
  lastRun: { id: string; status: RunStatus; createdAt: string } | null;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  origin: string;
  action: string;
  target: string;
  outcome: string;
  detail: string;
}

/** A message on the SSE stream. */
export interface RunMessage {
  runId: string;
  at: string;
  status: RunStatus;
  reason: string | null;
  branch: string | null;
  prUrl: string | null;
  verify: 'pass' | 'fail' | null;
  waitingOn?: string | null;
  snapshot?: IbniSnapshot | null;
}

export interface EventMessage {
  runId: string;
  seq: number;
  at: string;
  kind: string;
  data: Record<string, unknown>;
  step: Step | null;
}

export interface Health {
  ok: boolean;
  limits: { taskMaxChars: number; inputMaxChars: number; idleTimeoutMinutes: number };
}
