import type { Action } from './words';

export type RunStatus =
  | 'queued' | 'running' | 'needs_input' | 'needs_approval'
  | 'completed' | 'failed' | 'stopped' | 'timed_out';

export type StepType = 'edit' | 'command' | 'test' | 'read' | 'message';

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
