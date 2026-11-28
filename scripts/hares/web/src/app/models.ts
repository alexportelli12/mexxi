/**
 * The shapes the web app reads and writes. They are the contract with the server: core/api.ts lists
 * each endpoint with the JSON it takes and returns, in these types.
 */

/** What herdr reports for a session's pane. "blocked" is waiting on a person. */
export type SessionStatus = 'blocked' | 'working' | 'idle' | 'done' | 'unknown';

/** The three groups the status bar counts. Idle covers idle, done and unknown. */
export type Phase = 'waiting' | 'working' | 'idle';

/** What the server knew about a session when the person looked: sent back with every answer. */
export interface Expect {
  /** The pane's terminal; null while a session has no pane (a folder-trust prompt, a finished session). */
  terminalId: string | null;
  /** The Claude session id; null before the first prompt, such as on a folder-trust prompt. */
  sessionId: string | null;
  status: SessionStatus;
  /** herdr's state_change_seq: the server refuses the answer when it has moved. */
  seq: number;
}

export interface SessionLinks {
  /** Every link carries the evidence it was derived from; nothing is guessed. */
  issue: { number: number; url: string; evidence: string } | null;
  branch: { name: string; evidence: string } | null;
  pr: { number: number; repo: string; url: string; evidence: string } | null;
}

export interface Session {
  /** The Claude session id, or a launch id until herdr reports one. */
  id: string;
  /** The person's rename, else the terminal title, else the first prompt. */
  title: string;
  /** The configured repository name, or an empty string when the folder is in none. */
  repo: string;
  status: SessionStatus;
  /** False once the pane is closed: the transcript stays and the session can be resumed. */
  alive: boolean;
  seq: number;
  terminalId: string | null;
  /** "app" when this app started it, "you" when it was started by hand in a terminal. */
  startedBy: 'app' | 'you';
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  /** One plain line for lists: what it is doing or asking. */
  line: string;
  /** Why a blocked session waits: a question or a permission prompt; null when it is not blocked. */
  waitingOn: 'question' | 'permission' | null;
  pendingCount: number;
  links: SessionLinks;
}

export interface TranscriptStep {
  title: string;
  ok: boolean | null;
  detail: string | null;
}

/** One row of the readable transcript. Tool steps are folded into a single "steps" row. */
export type TranscriptEntry =
  | { seq: number; at: string; kind: 'you'; text: string }
  | { seq: number; at: string; kind: 'agent'; text: string }
  | { seq: number; at: string; kind: 'answer'; text: string }
  | { seq: number; at: string; kind: 'steps'; summary: string; steps: TranscriptStep[] };

export interface SessionDetail extends Session {
  transcript: TranscriptEntry[];
  /** The newest transcript seq, to ask only for what is new next time. */
  nextSince: number;
  pending: Pending[];
}

export interface QuestionOption {
  /** The digit that picks it on the terminal; the server turns the label into keys from a fresh screen. */
  n: number;
  label: string;
  description?: string;
}

/** One question of a call. A call can carry several, and each can allow more than one pick. */
export interface QuestionItem {
  header?: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** What an Edit, Write or NotebookEdit call would put in the file, raw and complete. */
export type PermissionContent =
  | { kind: 'write'; text: string }
  | { kind: 'edit'; oldText: string; newText: string; replaceAll: boolean }
  | { kind: 'notebook'; cellId: string | null; editMode: string | null; cellType: string | null; text: string };

export interface PermissionRule {
  /** The exact rule, such as Bash(pnpm add:*), or the access it grants, from the prompt's own option label. */
  text: string;
  /** "rule" is permanent for the repo; "session" lasts until the session ends. */
  scope: 'rule' | 'session';
}

export interface Permission {
  tool: string;
  /** "run a command", "edit a file": what Claude wants to do, in words. */
  verb: string;
  /** The raw command, path, URL or call: never redacted or cut. */
  exact: string;
  content?: PermissionContent | null;
  risk: string;
  riskLabel: string;
  why: string;
  /** Too long to show whole: no Allow or Always buttons, only "answer in the terminal". */
  tooLong: boolean;
  /** Null when the prompt offers no always-allow option, or it is one only the terminal may take. */
  always: PermissionRule | null;
}

export type PendingKind = 'question' | 'plan' | 'permission' | 'trust';

/** Something a session waits for you to decide: the queue on Now is a list of these. */
export interface Pending {
  id: string;
  sessionId: string;
  kind: PendingKind;
  /** Who asks: the session's repo or title. "That’s Fair is asking". */
  asker: string;
  /** A short topic for the line above the question, such as "templates". */
  topic?: string;
  askedAt: string;
  items: QuestionItem[];
  /** "Type something" is offered, so an own answer can be typed. */
  freeText: boolean;
  /** "Chat about this" is offered, so "Talk it through instead" works. */
  chat: boolean;
  permission?: Permission;
  expect: Expect;
  /** False when only the terminal can answer it, with the reason in words. */
  answerable: boolean;
  reason: string | null;
}

/** One answer per question item, in order. */
export type Answer =
  | { kind: 'option'; n: number }
  | { kind: 'options'; ns: number[] }
  | { kind: 'text'; text: string }
  | { kind: 'chat'; text: string };

export type Decision = 'once' | 'always' | 'deny';

export interface HerdrHealth {
  connected: boolean;
  protocol: number | null;
  panes: number;
  claudeSessions: number;
  /** When herdr last answered; shown as "last seen" while it is down. */
  lastSeenAt: string | null;
}

export interface Health {
  ok: boolean;
  version?: string;
  /** The machine's name, such as atlas. Shown wherever the screens say where sessions run. */
  host?: string;
  herdr: HerdrHealth;
  /** Whether a default branch is red, for the dot on CI; absent until GitHub is set up. */
  board?: { mainRed: boolean };
}

export interface RepoInfo {
  name: string;
  /** The path in tilde form. */
  path: string;
  /** "owner/name" on GitHub, or null. */
  github: string | null;
  defaultBranch: string;
}

/** A local extension's page, linked from Settings. */
export interface Extension {
  name: string;
  title: string;
  url: string;
}

export interface NotificationEvents {
  asks: boolean;
  finishes: boolean;
  mainRed: boolean;
  prReady: boolean;
  newBump: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** "23:00" */
  start: string;
  /** "07:00" */
  end: string;
}

export interface HeldNotification {
  id: string;
  kind: string;
  title: string;
  text: string;
  /** A same-origin path: the question or pull request it was about. */
  url: string;
  createdAt: string;
}

export interface NotificationPrefs {
  events: NotificationEvents;
  quietHours: QuietHours;
}

export type ActivityKind = 'answer' | 'merge' | 'session' | 'rule' | 'ci' | 'other';

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  origin: string;
  action: string;
  target: string;
  outcome: string;
  detail: string;
  /** What happened, in words. When the server sends none, the app words it from the action. */
  text?: string;
  /** Where: the repository and session. */
  where?: string;
  kind?: ActivityKind;
}

/** What starts a session, without the id the app adds. */
export type StartBody = StartRequest extends infer T ? (T extends unknown ? Omit<T, 'clientId'> : never) : never;

/** What starts a session. All four open a new herdr pane. */
export type StartRequest =
  | { clientId: string; repo: string; kind: 'prompt'; prompt: string }
  | { clientId: string; repo: string; kind: 'command'; command: string; args: string }
  | { clientId: string; repo: string; kind: 'issue'; issue: number }
  | { clientId: string; repo: string; kind: 'pr'; pr: number; ask: 'review-comments' | 'failing-check' };

/** A screen of a session's terminal, as plain text. */
export interface Screen {
  text: string;
  expect: Expect;
  at: string;
  /** An overlay is open: it looks idle, so steering is refused until it is closed in the terminal. */
  overlay: boolean;
}
