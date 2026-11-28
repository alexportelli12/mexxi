// The store's migrations and its new tables. A database built with the version 6
// schema (copied below exactly as it shipped) must keep every row through the
// migration; the audit log keeps rows for 90 days and no less.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

// The schema before the herdr era, as store.mjs shipped it at version 6.
const V6_MIGRATIONS = [
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
];

function version6Database(file) {
  const db = new DatabaseSync(file);
  V6_MIGRATIONS.forEach((sql) => db.exec(sql));
  db.exec("PRAGMA user_version = 6");
  const at = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO runs (id, repo, action, task, status, created_at, updated_at, last_activity_at, pr_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("run-1", "my-app", "build", "Fix it", "completed", at, at, at, "https://github.com/me/my-app/pull/12");
  db.prepare(`INSERT INTO approvals (id, run_id, tool, exact, content, cwd, why, risk, created_at, expires_at, status, decided_by, decided_at, tool_use_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("ap-1", "run-1", "Bash", "curl example.com", null, "~/my-app", "Fetch", "network", at, at, "allowed", "me@example.com", at, "toolu_1");
  db.prepare("INSERT INTO gate_acceptances (run_id, head_sha, accepted_by, accepted_at, detail) VALUES (?, ?, ?, ?, ?)").run("run-1", "abc123", "me@example.com", at, "verify changed");
  db.close();
}

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);

test("a version 6 database migrates with its approver approvals intact and readable", (t) => {
  const file = path.join(tempDir(t), "hares.db");
  version6Database(file);
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 8);
  const approval = store.getApproval("ap-1");
  assert.equal(approval.runId, "run-1");
  assert.equal(approval.exact, "curl example.com");
  assert.equal(approval.status, "allowed");
  assert.equal(approval.decidedBy, "me@example.com");
  assert.equal(approval.toolUseId, "toolu_1");
  assert.equal(approval.source, "approver");
  assert.deepEqual(store.listApprovals({ status: "allowed" }).map((row) => row.id), ["ap-1"]);
});

test("a gate acceptance made on a run carries over to its pull request (decision 0027 re-keyed)", (t) => {
  const file = path.join(tempDir(t), "hares.db");
  version6Database(file);
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.prGateAcceptance("my-app", 12, "abc123")?.acceptedBy, "me@example.com");
  assert.equal(store.prGateAcceptance("my-app", 12, "def456"), null, "a new head commit needs a new acceptance");
  assert.equal(store.gateAcceptance("run-1", "abc123")?.acceptedBy, "me@example.com", "the run-keyed row is still there");
});

test("a hook approval is stored with no run, no tool_use_id and no expiry, but never with neither a run nor a session", () => {
  const store = openStore(":memory:");
  const approval = store.createApproval({ id: "h-1", tool: "Bash", exact: "ls", cwd: "~", why: "", risk: "read", source: "hook", sessionId: "s-1", paneId: "w:p1", recordId: "permission_x", suggestedRule: "Bash(ls:*)" });
  assert.deepEqual([approval.runId, approval.toolUseId, approval.expiresAt, approval.source, approval.sessionId, approval.suggestedRule], [null, null, null, "hook", "s-1", "Bash(ls:*)"]);
  assert.deepEqual(store.pendingApprovalsForSession("s-1").map((row) => row.id), ["h-1"]);
  assert.equal(store.decideApproval("h-1", "allowed", "me@example.com", "always"), true);
  assert.equal(store.getApproval("h-1").decidedVia, "always");
  assert.throws(() => store.createApproval({ id: "h-2", tool: "Bash", exact: "ls", cwd: "~", why: "", risk: "read", source: "hook" }), /CHECK/);
});

test("an audit row inside 90 days can't be deleted or changed, and one older than 90 days is purged", () => {
  let clock = daysAgo(91);
  const store = openStore(":memory:", { now: () => clock });
  store.addAudit({ actor: "me", origin: "web", action: "old", outcome: "ok" });
  clock = daysAgo(89);
  store.addAudit({ actor: "me", origin: "web", action: "recent", outcome: "ok" });
  assert.throws(() => store.db.exec("DELETE FROM audit WHERE action = 'recent'"), /kept for 90 days/);
  assert.throws(() => store.db.exec("UPDATE audit SET detail = 'x'"), /append-only/);
  assert.equal(store.purgeAudit(), 1);
  assert.deepEqual(store.listAudit().map((row) => row.action), ["recent"]);
  assert.equal(store.purgeAudit(), 0);
});

test("the activity view reads audit rows from a given time on, newest first", () => {
  let clock = daysAgo(3);
  const store = openStore(":memory:", { now: () => clock });
  store.addAudit({ actor: "me", origin: "web", action: "before", outcome: "ok" });
  clock = daysAgo(1);
  store.addAudit({ actor: "me", origin: "web", action: "after", outcome: "ok" });
  assert.deepEqual(store.listAuditSince(daysAgo(2).toISOString()).map((row) => row.action), ["after"]);
});

test("a launch keeps its client id unique, takes its session id later, and ends only once", () => {
  const store = openStore(":memory:");
  store.createLaunch({ id: "l-1", clientId: "c-1", repo: "my-app", action: "build", task: "Fix it" });
  assert.throws(() => store.createLaunch({ id: "l-2", clientId: "c-1", repo: "my-app", action: "build" }), /UNIQUE/);
  assert.equal(store.launchByClientId("c-1").id, "l-1");
  store.updateLaunch("l-1", { sessionId: "s-1", paneId: "w:p2", repo: "other" });
  assert.equal(store.launchBySession("s-1").id, "l-1");
  assert.equal(store.getLaunch("l-1").repo, "my-app", "only the herdr fields can change");
  assert.deepEqual(store.openLaunches().map((launch) => launch.id), ["l-1"]);
  assert.equal(store.endLaunch("l-1", { endedBy: "hares" }), true);
  assert.equal(store.endLaunch("l-1", { endedBy: "gone" }), false);
  assert.equal(store.getLaunch("l-1").endedBy, "hares");
  assert.deepEqual(store.openLaunches(), []);
});

test("launches count per day for the daily cap", () => {
  let clock = daysAgo(2);
  const store = openStore(":memory:", { now: () => clock });
  store.createLaunch({ id: "l-old", repo: "my-app", action: "session" });
  clock = new Date();
  store.createLaunch({ id: "l-new", repo: "my-app", action: "session" });
  assert.equal(store.countLaunchesSince(daysAgo(1).toISOString()), 1);
  assert.equal(store.lastLaunchFor("my-app").id, "l-new");
});

test("a session's name is stored once per session and a rename replaces it", () => {
  const store = openStore(":memory:");
  assert.equal(store.sessionName("s-1"), null);
  store.setSessionName("s-1", "First", "me");
  store.setSessionName("s-1", "Second", "me");
  assert.equal(store.sessionName("s-1"), "Second");
});

test("notification settings start from the defaults (PR ready and new bump off) and ignore unknown events", () => {
  const store = openStore(":memory:");
  assert.deepEqual(store.notificationPrefs("me").events, { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false });
  const saved = store.saveNotificationPrefs("me", { events: { prReady: true, asks: false, anything: true }, quietHours: { start: "23:00", end: "07:00", tz: "Europe/Malta" } });
  assert.deepEqual(saved.events, { asks: false, finishes: true, mainRed: true, prReady: true, newBump: false });
  assert.deepEqual(saved.quietHours, { start: "23:00", end: "07:00", tz: "Europe/Malta" });
  assert.equal(store.notificationPrefs("someone-else").events.asks, true);
});

test("a held notification shows until it is marked shown, and only once", () => {
  const store = openStore(":memory:");
  const id = store.holdNotification("asks", { sessionId: "s-1", url: "/s/s-1?q=r1" });
  assert.deepEqual(store.heldNotifications().map((row) => [row.id, row.kind, row.payload.url]), [[id, "asks", "/s/s-1?q=r1"]]);
  assert.equal(store.markNotificationsShown([id]), 1);
  assert.equal(store.markNotificationsShown([id]), 0);
  assert.deepEqual(store.heldNotifications(), []);
});
