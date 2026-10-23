// segwi's SQLite database. Every text from outside is redacted before it is
// written, and the audit table refuses UPDATE and DELETE.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { cleanDeep, cleanText } from "./clean.mjs";

export const FINAL = new Set(["completed", "failed", "stopped", "timed_out"]);
export const ACTIVE = ["queued", "running", "needs_input", "needs_approval"];

// Version 1 is the p2 schema, version 2 adds approvals (p3). Push subscriptions
// (p5) arrive as version 3.
const MIGRATIONS = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY, repo TEXT NOT NULL, action TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL,
     client_id TEXT UNIQUE, host_session_id TEXT, worktree_path TEXT, branch TEXT, pr_url TEXT,
     verify TEXT CHECK (verify IN ('pass','fail')), cost_usd REAL, reason TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, ended_at TEXT
   );
   CREATE INDEX runs_status ON runs (status);
   CREATE INDEX runs_created ON runs (created_at);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs (id), seq INTEGER NOT NULL,
     at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (run_id, seq)
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, origin TEXT NOT NULL,
     action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('ok','rejected','error')),
     detail TEXT NOT NULL
   );
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Version 2: approvals, and the hash of each run's secret (never the secret).
  `ALTER TABLE runs ADD COLUMN secret_hash TEXT;
   CREATE TABLE approvals (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs (id), tool TEXT NOT NULL, exact TEXT NOT NULL, cwd TEXT NOT NULL,
     why TEXT NOT NULL, risk TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired')),
     decided_by TEXT, decided_at TEXT, tool_use_id TEXT NOT NULL
   );
   CREATE INDEX approvals_status ON approvals (status, created_at);
   CREATE INDEX approvals_run ON approvals (run_id);`,
];

const RUN_COLUMNS = {
  status: "status", hostSessionId: "host_session_id", worktreePath: "worktree_path", branch: "branch", prUrl: "pr_url",
  verify: "verify", costUsd: "cost_usd", reason: "reason", lastActivityAt: "last_activity_at", endedAt: "ended_at",
};

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, repo: row.repo, action: row.action, task: row.task, status: row.status, clientId: row.client_id,
    hostSessionId: row.host_session_id, worktreePath: row.worktree_path, branch: row.branch, prUrl: row.pr_url,
    verify: row.verify, costUsd: row.cost_usd, reason: row.reason, createdAt: row.created_at,
    updatedAt: row.updated_at, lastActivityAt: row.last_activity_at, endedAt: row.ended_at,
  };
}

function approvalFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, tool: row.tool, exact: row.exact, cwd: row.cwd, why: row.why, risk: row.risk,
    createdAt: row.created_at, expiresAt: row.expires_at, status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at,
    toolUseId: row.tool_use_id,
  };
}

function eventFromRow(row) {
  return { id: row.id, runId: row.run_id, seq: row.seq, at: row.at, kind: row.kind, data: JSON.parse(row.data) };
}

export function openStore(file, { now = () => new Date() } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[next]);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (file !== ":memory:" && existsSync(file)) chmodSync(file, 0o600);
  const stamp = () => now().toISOString();

  const statements = {
    insertRun: db.prepare(`INSERT INTO runs (id, repo, action, task, status, client_id, created_at, updated_at, last_activity_at)
                           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`),
    getRun: db.prepare("SELECT * FROM runs WHERE id = ?"),
    byClient: db.prepare("SELECT * FROM runs WHERE client_id = ?"),
    countActive: db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN (${ACTIVE.map(() => "?").join(",")})`),
    countSince: db.prepare("SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?"),
    lastRun: db.prepare("SELECT * FROM runs WHERE repo = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    nextSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?"),
    insertEvent: db.prepare("INSERT INTO events (run_id, seq, at, kind, data) VALUES (?, ?, ?, ?, ?) RETURNING id"),
    runEvents: db.prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
    eventsAfter: db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?"),
    insertAudit: db.prepare("INSERT INTO audit (at, actor, origin, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    listAudit: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?"),
    setSecret: db.prepare("UPDATE runs SET secret_hash = ? WHERE id = ?"),
    getSecret: db.prepare("SELECT secret_hash FROM runs WHERE id = ?"),
    lastOfKind: db.prepare("SELECT * FROM events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1"),
    insertApproval: db.prepare(`INSERT INTO approvals (id, run_id, tool, exact, cwd, why, risk, created_at, expires_at, status, tool_use_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`),
    getApproval: db.prepare("SELECT * FROM approvals WHERE id = ?"),
    decideApproval: db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'"),
    pendingFor: db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid"),
    interrupted: db.prepare(`SELECT id FROM runs WHERE status IN (${ACTIVE.map(() => "?").join(",")})`),
  };

  return {
    db,
    close: () => db.close(),

    createRun({ id, repo, action, task, clientId = null }) {
      const at = stamp();
      statements.insertRun.run(id, repo, action, cleanText(task), clientId, at, at, at);
      return this.getRun(id);
    },
    getRun: (id) => runFromRow(statements.getRun.get(id)),
    findByClientId: (clientId) => runFromRow(statements.byClient.get(clientId)),
    listRuns({ status, repo, limit = 50 } = {}) {
      const where = [];
      const values = [];
      if (status) { where.push("status = ?"); values.push(status); }
      if (repo) { where.push("repo = ?"); values.push(repo); }
      const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      return db.prepare(sql).all(...values, limit).map(runFromRow);
    },
    updateRun(id, fields) {
      const entries = Object.entries(fields).filter(([key]) => key in RUN_COLUMNS);
      const at = stamp();
      const sets = entries.map(([key]) => `${RUN_COLUMNS[key]} = ?`);
      const values = entries.map(([key, value]) => (key === "reason" && value ? cleanText(value, 500) : value ?? null));
      db.prepare(`UPDATE runs SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`).run(...values, at, id);
      return this.getRun(id);
    },
    countActive: () => statements.countActive.get(...ACTIVE).n,
    countSince: (sinceIso) => statements.countSince.get(sinceIso).n,
    lastRunFor: (repo) => runFromRow(statements.lastRun.get(repo)),
    interruptedRunIds: () => statements.interrupted.all(...ACTIVE).map((row) => row.id),

    addEvent(runId, kind, data = {}) {
      const at = stamp();
      const seq = statements.nextSeq.get(runId).seq;
      const { id } = statements.insertEvent.get(runId, seq, at, kind, JSON.stringify(cleanDeep(data)));
      db.prepare("UPDATE runs SET last_activity_at = ? WHERE id = ?").run(at, runId);
      return { id, runId, seq, at, kind, data: JSON.parse(db.prepare("SELECT data FROM events WHERE id = ?").get(id).data) };
    },
    listEvents: (runId, since = 0, limit = 1000) => statements.runEvents.all(runId, since, limit).map(eventFromRow),
    eventsAfter: (id, limit = 1000) => statements.eventsAfter.all(id, limit).map(eventFromRow),

    /** Only the hash of a run's secret is stored; the secret itself lives in the run's MCP config. */
    setRunSecretHash: (runId, hash) => statements.setSecret.run(hash, runId),
    getRunSecretHash: (runId) => statements.getSecret.get(runId)?.secret_hash ?? null,
    lastEventOfKind: (runId, kind) => {
      const row = statements.lastOfKind.get(runId, kind);
      return row ? eventFromRow(row) : null;
    },

    createApproval({ id, runId, tool, exact, cwd, why, risk, expiresAt, toolUseId }) {
      statements.insertApproval.run(id, runId, cleanText(tool, 200), cleanText(exact, 2000), cleanText(cwd, 500), cleanText(why, 300), risk, stamp(), expiresAt, cleanText(toolUseId, 200));
      return approvalFromRow(statements.getApproval.get(id));
    },
    getApproval: (id) => approvalFromRow(statements.getApproval.get(id)),
    /** Moves a pending approval to its final status. Returns false if it was no longer pending. */
    decideApproval: (id, status, decidedBy) => statements.decideApproval.run(status, decidedBy ? cleanText(decidedBy, 200) : null, stamp(), id).changes === 1,
    pendingApprovalsFor: (runId) => statements.pendingFor.all(runId).map(approvalFromRow),
    listApprovals({ status = "pending", limit = 100 } = {}) {
      return db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at, rowid LIMIT ?").all(status, limit).map(approvalFromRow);
    },

    addAudit({ actor, origin, action, target = "", outcome, detail = "" }) {
      statements.insertAudit.run(stamp(), cleanText(actor, 200), origin, cleanText(action, 200), cleanText(target, 200), outcome, cleanText(detail, 500));
    },
    listAudit: (limit = 50) => statements.listAudit.all(limit).map((row) => ({
      id: row.id, at: row.at, actor: row.actor, origin: row.origin, action: row.action, target: row.target, outcome: row.outcome, detail: row.detail,
    })),
  };
}
