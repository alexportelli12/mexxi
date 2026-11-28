// hares's SQLite database. Every text from outside is redacted before it is
// written, and the audit table refuses UPDATE and DELETE. The one exception is a
// pending approval: a person must see exactly what would run, so its call is kept
// raw until it is decided, then redacted in place.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { cleanDeep, cleanText } from "./clean.mjs";

export const FINAL = new Set(["completed", "failed", "stopped", "timed_out"]);
export const ACTIVE = ["queued", "running", "needs_input", "needs_approval"];
export const AUDIT_RETENTION_DAYS = 90;
/** The notification events a person can turn on or off, and their defaults (plan §5). */
export const DEFAULT_NOTIFICATION_EVENTS = { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false };

// Version 1 is the p2 schema, version 2 adds approvals (p3), version 3 push subscriptions (p5),
// version 4 the content a file tool would write, version 5 what a run waits on and its ibni snapshot,
// version 6 a person's acceptance of a pull request's gate-weakening changes (decision 0027),
// version 7 the herdr era (sessions ħares starts, renames, hook-fed approvals, notification
// settings, gate acceptances keyed by pull request), version 8 the 90-day audit retention.
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
  // Version 3: where to push. The endpoint is unique, so subscribing twice updates one row.
  `CREATE TABLE push_subscriptions (
     id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, identity TEXT NOT NULL,
     created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT
   );`,
  "ALTER TABLE approvals ADD COLUMN content TEXT;",
  "ALTER TABLE runs ADD COLUMN waiting_on TEXT; ALTER TABLE runs ADD COLUMN snapshot TEXT;",
  // Version 6: one row per run and head commit a person accepted; a new push needs a new row. Never updated.
  `CREATE TABLE gate_acceptances (
     run_id TEXT NOT NULL REFERENCES runs (id), head_sha TEXT NOT NULL, accepted_by TEXT NOT NULL, accepted_at TEXT NOT NULL,
     detail TEXT NOT NULL, PRIMARY KEY (run_id, head_sha)
   );`,
  // Version 7. launches: a session ħares started, under its own id until herdr reports the Claude
  // session id. session_names: a person's name for a session. approvals is rebuilt so a row from the
  // hook (no run, no tool_use_id, no expiry) fits beside the approver's old rows, which keep
  // source 'approver'. notification_prefs and held_notifications: what to push and what quiet hours held.
  // pr_gate_acceptances: decision 0027's acceptances keyed by pull request, copied from the run-keyed ones.
  `CREATE TABLE IF NOT EXISTS launches (
     id TEXT PRIMARY KEY, client_id TEXT UNIQUE, session_id TEXT, pane_id TEXT, terminal_id TEXT, workspace_id TEXT,
     repo TEXT NOT NULL, action TEXT NOT NULL, task TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
     ended_at TEXT, ended_by TEXT, reason TEXT
   );
   CREATE INDEX IF NOT EXISTS launches_session ON launches (session_id);
   CREATE INDEX IF NOT EXISTS launches_created ON launches (created_at);
   CREATE TABLE IF NOT EXISTS session_names (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
   CREATE TABLE approvals_v7 (
     id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs (id), tool TEXT NOT NULL, exact TEXT NOT NULL, content TEXT, cwd TEXT NOT NULL,
     why TEXT NOT NULL, risk TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired')),
     decided_by TEXT, decided_at TEXT, tool_use_id TEXT,
     source TEXT NOT NULL DEFAULT 'approver' CHECK (source IN ('approver','hook')),
     session_id TEXT, pane_id TEXT, record_id TEXT, suggested_rule TEXT,
     decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('once','always','deny','gone')),
     CHECK (run_id IS NOT NULL OR session_id IS NOT NULL)
   );
   INSERT INTO approvals_v7 (id, run_id, tool, exact, content, cwd, why, risk, created_at, expires_at, status, decided_by, decided_at, tool_use_id)
     SELECT id, run_id, tool, exact, content, cwd, why, risk, created_at, expires_at, status, decided_by, decided_at, tool_use_id FROM approvals;
   DROP TABLE approvals;
   ALTER TABLE approvals_v7 RENAME TO approvals;
   CREATE INDEX approvals_status ON approvals (status, created_at);
   CREATE INDEX approvals_run ON approvals (run_id);
   CREATE INDEX approvals_session ON approvals (session_id, status);
   CREATE TABLE IF NOT EXISTS notification_prefs (
     identity TEXT PRIMARY KEY, events TEXT NOT NULL, quiet_start TEXT, quiet_end TEXT, tz TEXT, updated_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS held_notifications (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, shown_at TEXT
   );
   CREATE TABLE IF NOT EXISTS pr_gate_acceptances (
     repo TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT NOT NULL, accepted_by TEXT NOT NULL, accepted_at TEXT NOT NULL,
     detail TEXT NOT NULL, PRIMARY KEY (repo, number, head_sha)
   );
   INSERT OR IGNORE INTO pr_gate_acceptances (repo, number, head_sha, accepted_by, accepted_at, detail)
     SELECT r.repo, CAST(substr(r.pr_url, instr(r.pr_url, '/pull/') + 6) AS INTEGER), g.head_sha, g.accepted_by, g.accepted_at, g.detail
     FROM gate_acceptances g JOIN runs r ON r.id = g.run_id
     WHERE r.pr_url LIKE 'https://github.com/%/pull/%';`,
  // Version 8: the audit log keeps every row for 90 days, then a row may be purged (decision 0028). An
  // UPDATE is still refused, and so is a DELETE of any row younger than 90 days.
  `DROP TRIGGER audit_no_delete;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
     WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${AUDIT_RETENTION_DAYS} days')
     BEGIN SELECT RAISE(ABORT, 'audit is append-only: rows are kept for ${AUDIT_RETENTION_DAYS} days'); END;`,
];

const RUN_COLUMNS = {
  status: "status", hostSessionId: "host_session_id", worktreePath: "worktree_path", branch: "branch", prUrl: "pr_url",
  verify: "verify", costUsd: "cost_usd", reason: "reason", lastActivityAt: "last_activity_at", endedAt: "ended_at",
  waitingOn: "waiting_on", snapshot: "snapshot",
};

/** A column's stored value: texts from outside are redacted, and the ibni snapshot is kept as JSON. */
function columnValue(key, value) {
  if (value === undefined || value === null) return null;
  if ((key === "reason" || key === "waitingOn") && value) return cleanText(value, 500);
  if (key === "snapshot") return JSON.stringify(cleanDeep(value));
  return value;
}

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, repo: row.repo, action: row.action, task: row.task, status: row.status, clientId: row.client_id,
    hostSessionId: row.host_session_id, worktreePath: row.worktree_path, branch: row.branch, prUrl: row.pr_url,
    verify: row.verify, costUsd: row.cost_usd, reason: row.reason, createdAt: row.created_at,
    updatedAt: row.updated_at, lastActivityAt: row.last_activity_at, endedAt: row.ended_at,
    waitingOn: row.waiting_on ?? null, snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
  };
}

function approvalFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, tool: row.tool, exact: row.exact, cwd: row.cwd, why: row.why, risk: row.risk,
    createdAt: row.created_at, expiresAt: row.expires_at, status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at,
    toolUseId: row.tool_use_id, content: row.content ? JSON.parse(row.content) : null,
    source: row.source ?? "approver", sessionId: row.session_id ?? null, paneId: row.pane_id ?? null, recordId: row.record_id ?? null,
    suggestedRule: row.suggested_rule ?? null, decidedVia: row.decided_via ?? null,
  };
}

function launchFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, clientId: row.client_id, sessionId: row.session_id, paneId: row.pane_id, terminalId: row.terminal_id,
    workspaceId: row.workspace_id, repo: row.repo, action: row.action, task: row.task, createdAt: row.created_at,
    endedAt: row.ended_at, endedBy: row.ended_by, reason: row.reason,
  };
}

const LAUNCH_COLUMNS = { sessionId: "session_id", paneId: "pane_id", terminalId: "terminal_id", workspaceId: "workspace_id" };

function eventFromRow(row) {
  return { id: row.id, runId: row.run_id, seq: row.seq, at: row.at, kind: row.kind, data: JSON.parse(row.data) };
}

export function openStore(file, { now = () => new Date() } = {}) {
  const db = new DatabaseSync(file);
  // secure_delete overwrites freed pages, so a redacted approval's raw call doesn't linger in the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
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
    insertApproval: db.prepare(`INSERT INTO approvals (id, run_id, tool, exact, content, cwd, why, risk, created_at, expires_at, status, tool_use_id,
                                  source, session_id, pane_id, record_id, suggested_rule)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`),
    pendingForSession: db.prepare("SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at, rowid"),
    insertLaunch: db.prepare(`INSERT INTO launches (id, client_id, session_id, repo, action, task, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getLaunch: db.prepare("SELECT * FROM launches WHERE id = ?"),
    launchByClient: db.prepare("SELECT * FROM launches WHERE client_id = ?"),
    launchBySession: db.prepare("SELECT * FROM launches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    endLaunch: db.prepare("UPDATE launches SET ended_at = ?, ended_by = ?, reason = ? WHERE id = ? AND ended_at IS NULL"),
    openLaunches: db.prepare("SELECT * FROM launches WHERE ended_at IS NULL ORDER BY created_at, rowid"),
    launchesSince: db.prepare("SELECT COUNT(*) AS n FROM launches WHERE created_at >= ?"),
    lastLaunch: db.prepare("SELECT * FROM launches WHERE repo = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
    setName: db.prepare(`INSERT INTO session_names (session_id, title, by, at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (session_id) DO UPDATE SET title = excluded.title, by = excluded.by, at = excluded.at`),
    getName: db.prepare("SELECT * FROM session_names WHERE session_id = ?"),
    getPrefs: db.prepare("SELECT * FROM notification_prefs WHERE identity = ?"),
    savePrefs: db.prepare(`INSERT INTO notification_prefs (identity, events, quiet_start, quiet_end, tz, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT (identity) DO UPDATE SET events = excluded.events, quiet_start = excluded.quiet_start,
                           quiet_end = excluded.quiet_end, tz = excluded.tz, updated_at = excluded.updated_at`),
    holdNotification: db.prepare("INSERT INTO held_notifications (kind, payload, created_at) VALUES (?, ?, ?) RETURNING id"),
    heldUnshown: db.prepare("SELECT * FROM held_notifications WHERE shown_at IS NULL ORDER BY id"),
    markShown: db.prepare("UPDATE held_notifications SET shown_at = ? WHERE id = ? AND shown_at IS NULL"),
    insertPrAcceptance: db.prepare("INSERT OR IGNORE INTO pr_gate_acceptances (repo, number, head_sha, accepted_by, accepted_at, detail) VALUES (?, ?, ?, ?, ?, ?)"),
    getPrAcceptance: db.prepare("SELECT * FROM pr_gate_acceptances WHERE repo = ? AND number = ? AND head_sha = ?"),
    purgeAudit: db.prepare(`DELETE FROM audit WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${AUDIT_RETENTION_DAYS} days')`),
    auditSince: db.prepare("SELECT * FROM audit WHERE at >= ? ORDER BY id DESC LIMIT ?"),
    getApproval: db.prepare("SELECT * FROM approvals WHERE id = ?"),
    decideApproval: db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, exact = ?, content = ?, decided_via = ? WHERE id = ? AND status = 'pending'"),
    pendingFor: db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid"),
    getSubscription: db.prepare("SELECT * FROM push_subscriptions WHERE id = ?"),
    subscriptionByEndpoint: db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?"),
    insertSubscription: db.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, identity, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    updateSubscription: db.prepare("UPDATE push_subscriptions SET p256dh = ?, auth = ?, identity = ?, last_error = NULL WHERE id = ?"),
    deleteSubscription: db.prepare("DELETE FROM push_subscriptions WHERE id = ?"),
    insertAcceptance: db.prepare("INSERT OR IGNORE INTO gate_acceptances (run_id, head_sha, accepted_by, accepted_at, detail) VALUES (?, ?, ?, ?, ?)"),
    getAcceptance: db.prepare("SELECT * FROM gate_acceptances WHERE run_id = ? AND head_sha = ?"),
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
      const values = entries.map(([key, value]) => columnValue(key, value));
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
    latestEventId: () => db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id,

    /** Only the hash of a run's secret is stored; the secret itself lives in the run's MCP config. */
    setRunSecretHash: (runId, hash) => statements.setSecret.run(hash, runId),
    getRunSecretHash: (runId) => statements.getSecret.get(runId)?.secret_hash ?? null,
    lastEventOfKind: (runId, kind) => {
      const row = statements.lastOfKind.get(runId, kind);
      return row ? eventFromRow(row) : null;
    },

    /** `exact` and `content` are stored raw: the person decides on exactly what runs. */
    createApproval({ id, runId = null, tool, exact, content = null, cwd, why, risk, expiresAt = null, toolUseId = null, source = "approver", sessionId = null, paneId = null, recordId = null, suggestedRule = null }) {
      const short = (value, max) => (value === null || value === undefined ? null : cleanText(value, max));
      statements.insertApproval.run(id, runId, cleanText(tool, 200), exact, content ? JSON.stringify(content) : null, cleanText(cwd, 500), cleanText(why, 300), risk, stamp(), expiresAt,
        short(toolUseId, 200), source, short(sessionId, 200), short(paneId, 200), short(recordId, 200), short(suggestedRule, 2000));
      return approvalFromRow(statements.getApproval.get(id));
    },
    getApproval: (id) => approvalFromRow(statements.getApproval.get(id)),
    /** Moves a pending approval to its final status, redacting its call now nobody needs it raw. Returns false if it was no longer pending. */
    decideApproval(id, status, decidedBy, decidedVia = null) {
      const row = statements.getApproval.get(id);
      if (!row || row.status !== "pending") return false;
      const content = row.content ? JSON.stringify(cleanDeep(JSON.parse(row.content))) : null;
      const changed = statements.decideApproval.run(status, decidedBy ? cleanText(decidedBy, 200) : null, stamp(), cleanText(row.exact), content, decidedVia, id).changes === 1;
      // The write-ahead log still holds the raw page until a checkpoint; empty it now if no reader holds it.
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy: the next checkpoint does it */ }
      return changed;
    },
    pendingApprovalsFor: (runId) => statements.pendingFor.all(runId).map(approvalFromRow),
    pendingApprovalsForSession: (sessionId) => statements.pendingForSession.all(sessionId).map(approvalFromRow),
    listApprovals({ status = "pending", limit = 100 } = {}) {
      return db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at, rowid LIMIT ?").all(status, limit).map(approvalFromRow);
    },

    /** Subscribing the same endpoint again keeps its id and refreshes its keys. */
    saveSubscription({ id, endpoint, p256dh, auth, identity }) {
      const existing = statements.subscriptionByEndpoint.get(endpoint);
      if (existing) {
        statements.updateSubscription.run(p256dh, auth, identity, existing.id);
        return existing.id;
      }
      statements.insertSubscription.run(id, endpoint, p256dh, auth, identity, stamp());
      return id;
    },
    getSubscription: (id) => statements.getSubscription.get(id) ?? null,
    listSubscriptions: () => db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at, rowid").all(),
    deleteSubscription: (id) => statements.deleteSubscription.run(id).changes === 1,
    markSubscription(id, error = null) {
      if (error) db.prepare("UPDATE push_subscriptions SET last_error = ? WHERE id = ?").run(cleanText(error, 300), id);
      else db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?").run(stamp(), id);
    },

    /** A person accepted the gate-weakening changes of `headSha`; the first acceptance of a commit stands. */
    acceptGateChange({ runId, headSha, acceptedBy, detail }) {
      // The whole list of flags the person saw: the cap is far above any real diff's, so the record says all of it.
      statements.insertAcceptance.run(runId, headSha, cleanText(acceptedBy, 200), stamp(), cleanText(detail, 50_000));
    },
    gateAcceptance(runId, headSha) {
      const row = statements.getAcceptance.get(runId, headSha);
      return row ? { runId: row.run_id, headSha: row.head_sha, acceptedBy: row.accepted_by, acceptedAt: row.accepted_at, detail: row.detail } : null;
    },

    /** Accepts a pull request's gate-weakening changes at one head commit; the first acceptance of a commit stands. */
    acceptPrGateChange({ repo, number, headSha, acceptedBy, detail }) {
      statements.insertPrAcceptance.run(repo, number, headSha, cleanText(acceptedBy, 200), stamp(), cleanText(detail, 50_000));
    },
    prGateAcceptance(repo, number, headSha) {
      const row = statements.getPrAcceptance.get(repo, number, headSha);
      return row ? { repo: row.repo, number: row.number, headSha: row.head_sha, acceptedBy: row.accepted_by, acceptedAt: row.accepted_at, detail: row.detail } : null;
    },

    // --- Launches: sessions ħares started. The id is ħares's until herdr names the Claude session.
    createLaunch({ id, clientId = null, sessionId = null, repo, action, task = "" }) {
      statements.insertLaunch.run(id, clientId, sessionId, repo, action, cleanText(task), stamp());
      return launchFromRow(statements.getLaunch.get(id));
    },
    getLaunch: (id) => launchFromRow(statements.getLaunch.get(id)),
    launchByClientId: (clientId) => launchFromRow(statements.launchByClient.get(clientId)),
    launchBySession: (sessionId) => launchFromRow(statements.launchBySession.get(sessionId)),
    updateLaunch(id, fields) {
      const entries = Object.entries(fields).filter(([key]) => key in LAUNCH_COLUMNS);
      if (entries.length) db.prepare(`UPDATE launches SET ${entries.map(([key]) => `${LAUNCH_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, value]) => value ?? null), id);
      return launchFromRow(statements.getLaunch.get(id));
    },
    /** Marks a launch ended once; endedBy is 'hares' (a person or client ended it), 'gone' (the pane closed otherwise) or 'failed'. */
    endLaunch(id, { endedBy, reason = null }) {
      return statements.endLaunch.run(stamp(), endedBy, reason ? cleanText(reason, 500) : null, id).changes === 1;
    },
    openLaunches: () => statements.openLaunches.all().map(launchFromRow),
    listLaunches({ repo, limit = 50 } = {}) {
      const rows = repo
        ? db.prepare("SELECT * FROM launches WHERE repo = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(repo, limit)
        : db.prepare("SELECT * FROM launches ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
      return rows.map(launchFromRow);
    },
    countLaunchesSince: (sinceIso) => statements.launchesSince.get(sinceIso).n,
    lastLaunchFor: (repo) => launchFromRow(statements.lastLaunch.get(repo)),

    // --- A person's name for a session, keyed by the Claude session id.
    setSessionName(sessionId, title, by) {
      statements.setName.run(sessionId, cleanText(title, 200), cleanText(by, 200), stamp());
    },
    sessionName: (sessionId) => statements.getName.get(sessionId)?.title ?? null,

    // --- Notification settings per identity, and pushes held during quiet hours.
    notificationPrefs(identity) {
      const row = statements.getPrefs.get(identity);
      const stored = row ? JSON.parse(row.events) : {};
      return {
        events: { ...DEFAULT_NOTIFICATION_EVENTS, ...stored },
        quietHours: row?.quiet_start && row?.quiet_end ? { start: row.quiet_start, end: row.quiet_end, tz: row.tz ?? null } : null,
      };
    },
    saveNotificationPrefs(identity, { events = {}, quietHours = null }) {
      const known = Object.fromEntries(Object.keys(DEFAULT_NOTIFICATION_EVENTS).filter((key) => typeof events[key] === "boolean").map((key) => [key, events[key]]));
      statements.savePrefs.run(identity, JSON.stringify(known), quietHours?.start ?? null, quietHours?.end ?? null, quietHours?.tz ?? null, stamp());
      return this.notificationPrefs(identity);
    },
    holdNotification(kind, payload) {
      return statements.holdNotification.get(cleanText(kind, 100), JSON.stringify(cleanDeep(payload)), stamp()).id;
    },
    heldNotifications: () => statements.heldUnshown.all().map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload), createdAt: row.created_at })),
    markNotificationsShown(ids) {
      const at = stamp();
      return ids.reduce((count, id) => count + statements.markShown.run(at, id).changes, 0);
    },

    /** Deletes audit rows past the retention; the trigger refuses anything younger. Returns how many went. */
    purgeAudit: () => Number(statements.purgeAudit.run().changes),
    /** Audit rows at or after sinceIso, newest first, for the Activity page. */
    listAuditSince: (sinceIso, limit = 1000) => statements.auditSince.all(sinceIso, limit).map((row) => ({
      id: row.id, at: row.at, actor: row.actor, origin: row.origin, action: row.action, target: row.target, outcome: row.outcome, detail: row.detail,
    })),

    addAudit({ actor, origin, action, target = "", outcome, detail = "" }) {
      statements.insertAudit.run(stamp(), cleanText(actor, 200), origin, cleanText(action, 200), cleanText(target, 200), outcome, cleanText(detail, 500));
    },
    listAudit: (limit = 50) => statements.listAudit.all(limit).map((row) => ({
      id: row.id, at: row.at, actor: row.actor, origin: row.origin, action: row.action, target: row.target, outcome: row.outcome, detail: row.detail,
    })),
  };
}
