// Notifications (plan §5): which events push, to whom, and when they wait.
//
// Events: asks (a session asks a question or for a permission), finishes (a
// session stops working), mainRed (a default branch's CI goes red, polled from
// the board every few minutes), prReady and newBump (off by default). Each
// identity with a subscribed device has its own switches and quiet hours; a
// push due in quiet hours is held (held_notifications) and shown on Now.
//
// A payload is what web/public/sw.js reads: {v: 1, kind, title, body, url, tag,
// actions, answers}, with a same-origin deep link (/s/<session>?q=<record> or
// /prs/<repo>/<n>) and ids, never a task, transcript, command or call. Only a
// waiting QUESTION may carry action buttons: each names one answer to
// POST /api/sessions/<id>/answer with the expect captured when the push was
// made, so the guard refuses it once the session moved. A permission, plan or
// folder-trust prompt never gets buttons, so no notification can allow a call
// or add an always-allow rule.
import { audit } from "./audit.mjs";
import { cleanText } from "./clean.mjs";
import { DEFAULT_NOTIFICATION_EVENTS } from "./store.mjs";

export const NOTIFY_EVENTS = Object.keys(DEFAULT_NOTIFICATION_EVENTS);
const TITLE_MAX = 80;
const MAIN_RED_POLL_MS = 5 * 60_000;
const DEFAULT_QUIET = { enabled: false, start: "23:00", end: "07:00" };
const MAX_ACTIONS = 2;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (hhmm) => {
  const match = HHMM.exec(String(hhmm ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** The minutes past midnight of `date` in `timeZone` (the machine's own zone when it is empty or unknown). */
export function localMinutes(date, timeZone = "") {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
    const value = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return value("hour") * 60 + value("minute");
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

/** True when `date` falls in the quiet hours; a window whose start is after its end runs past midnight. */
export function inQuietHours(quietHours, date, timeZone = "") {
  if (!quietHours?.enabled) return false;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const now = localMinutes(date, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Answer buttons for a push about a question: the first options of a single-choice, single-question
 * prompt the session waits on, each carrying the expect seen now. Anything else (a permission, plan or
 * trust prompt, several questions, a multi-select, a prompt only the terminal can answer) gets none.
 */
export function answerButtons(facts) {
  const item = facts.item;
  const none = { actions: [], answers: {} };
  if (!item || item.kind !== "question" || item.step === "review" || !item.answerable || !facts.expect) return none;
  if (item.questions?.length !== 1 || item.questions[0].multiSelect) return none;
  const options = item.questions[0].options.slice(0, MAX_ACTIONS);
  const actions = options.map((option) => ({ action: `answer-${option.n}`, title: cleanText(option.label, 40) }));
  const answers = Object.fromEntries(options.map((option) => [`answer-${option.n}`, {
    sessionId: facts.sessionId, questionId: item.id, expect: facts.expect, answers: [{ kind: "option", n: option.n }],
  }]));
  return { actions, answers };
}

/** What each event's push says. Titles name a repository or session title, cut short and redacted. */
export function payloadFor(kind, facts) {
  const title = (text) => cleanText(text, TITLE_MAX);
  switch (kind) {
    case "asks": {
      const who = facts.repo || facts.title || "A session";
      const what = facts.waiting === "question" ? "is asking" : "needs your OK";
      const payload = {
        v: 1, kind, title: title(`${who} ${what}`), body: "", url: `/s/${encodeURIComponent(facts.sessionId)}${facts.recordId ? `?q=${encodeURIComponent(facts.recordId)}` : ""}`,
        tag: `session-${facts.sessionId}`, sessionId: facts.sessionId, recordId: facts.recordId ?? null, actions: [], answers: {},
      };
      Object.assign(payload, answerButtons(facts));
      return payload;
    }
    case "finishes":
      return { v: 1, kind, title: title(`${facts.repo || facts.title || "A session"} finished`), body: "", url: `/s/${encodeURIComponent(facts.sessionId)}`, tag: `session-${facts.sessionId}`, sessionId: facts.sessionId };
    case "mainRed":
      return { v: 1, kind, title: title(`${facts.repo}: ${facts.branch || "main"} is red`), body: "", url: "/ci", tag: `ci-${facts.repo}`, repo: facts.repo };
    case "prReady":
    case "newBump":
      return {
        v: 1, kind, title: title(kind === "prReady" ? `${facts.repo} #${facts.number} is ready` : `${facts.repo}: new bump #${facts.number}`), body: "",
        url: `/prs/${encodeURIComponent(facts.repo)}/${facts.number}`, tag: `pr-${facts.repo}-${facts.number}`, repo: facts.repo, number: facts.number,
      };
    default:
      throw new Error(`unknown notification kind ${kind}`);
  }
}

/**
 * @param {{ store: object, push: object, settings: object, sessions?: object, board?: object, now?: () => Date,
 *   pollMs?: number, log?: Function }} deps
 */
export function createNotifier({ store, push, settings, sessions = null, board = null, now = () => new Date(), pollMs = MAIN_RED_POLL_MS, log = () => {} }) {
  const configured = settings.hares.notifications ?? {};
  const defaults = {
    events: { ...DEFAULT_NOTIFICATION_EVENTS, ...(configured.events ?? {}) },
    quietHours: { ...DEFAULT_QUIET, ...(configured.quietHours ?? {}) },
  };
  const timeZone = configured.timeZone ?? "";
  const hasRow = store.db.prepare("SELECT 1 AS found FROM notification_prefs WHERE identity = ?");
  let timer = null;
  let detach = [];
  /** What the last board poll saw: red repos, ready and bump pull requests. Null until the first poll. */
  let seen = null;

  /** One identity's switches and quiet hours, in the web app's shape; the config's defaults until it saves its own. */
  function prefs(identity) {
    if (!hasRow.get(identity)) return structuredClone(defaults);
    const stored = store.notificationPrefs(identity);
    return {
      events: stored.events,
      quietHours: stored.quietHours ? { enabled: true, start: stored.quietHours.start, end: stored.quietHours.end } : { ...defaults.quietHours, enabled: false },
    };
  }

  function savePrefs(identity, { events, quietHours }) {
    const window = quietHours?.enabled ? { start: quietHours.start, end: quietHours.end, tz: timeZone || null } : null;
    store.saveNotificationPrefs(identity, { events, quietHours: window });
    // The times are kept even while quiet hours are off, so turning them back on restores them.
    const saved = prefs(identity);
    if (!quietHours?.enabled && quietHours) saved.quietHours = { enabled: false, start: quietHours.start, end: quietHours.end };
    return saved;
  }

  /** Held pushes for one identity, newest first, in the web app's shape. */
  function held(identity) {
    return store.heldNotifications()
      .filter((row) => row.payload?.identity === identity)
      .map((row) => ({ id: String(row.id), kind: row.kind, title: row.payload.title ?? "", text: row.payload.body ?? "", url: row.payload.url ?? "/", createdAt: row.createdAt }))
      .reverse();
  }

  function markSeen(identity, ids) {
    const mine = new Set(held(identity).map((entry) => entry.id));
    return store.markNotificationsShown(ids.filter((id) => mine.has(String(id))).map(Number));
  }

  /** Sends or holds one event for every identity that wants it; returns {sent, held} identities. */
  function dispatch(kind, facts) {
    const payload = payloadFor(kind, facts);
    const result = { sent: [], held: [] };
    for (const identity of push.identities()) {
      const wanted = prefs(identity);
      if (!wanted.events[kind]) continue;
      if (inQuietHours(wanted.quietHours, now(), timeZone)) {
        // A held push is shown later on Now, by when its answer buttons would be stale; it keeps only the link.
        store.holdNotification(kind, { ...payload, actions: [], answers: {}, identity });
        result.held.push(identity);
      } else {
        push.send(payload, { identity, tag: payload.tag, urgent: kind === "asks" });
        result.sent.push(identity);
      }
    }
    if (result.sent.length || result.held.length) {
      audit(store, { actor: "system", origin: "system", action: `notify.${kind}`, target: payload.sessionId ?? payload.repo ?? "", outcome: "ok", detail: `sent ${result.sent.length}, held ${result.held.length}` });
    }
    return result;
  }

  async function sessionFacts(sessionId, recordId = null) {
    try {
      const { session, pending } = await sessions.get(sessionId, { limit: 0 });
      const item = recordId ? pending.items.find((candidate) => candidate.id === recordId) ?? null : null;
      return { repo: session.repo, title: session.title, waiting: item?.kind ?? session.waiting, item, expect: session.expect };
    } catch {
      return { repo: "", title: "", waiting: null, item: null, expect: null };
    }
  }

  /** One look at the board: a default branch that turned red, a pull request that became ready, a new bump. */
  async function pollBoard() {
    if (!board) return;
    let current;
    try {
      current = await board.board({ fresh: true });
    } catch (error) {
      log(`notify: board poll failed: ${error.message}`);
      return;
    }
    const red = new Map();
    const ready = new Set();
    const bumps = new Set();
    for (const repo of current.repos ?? []) {
      if (repo.actions?.main?.red) red.set(repo.name, repo.actions.defaultBranch);
      const groups = repo.pulls?.pulls ?? {};
      for (const pull of groups.ready ?? []) ready.add(`${repo.name}#${pull.number}`);
      for (const group of Object.values(groups)) {
        if (Array.isArray(group)) for (const pull of group) if (pull.bump) bumps.add(`${repo.name}#${pull.number}`);
      }
    }
    // The first poll is the baseline: what was already red or ready when ħares started is not news.
    if (seen) {
      for (const [repo, branch] of red) if (!seen.red.has(repo)) dispatch("mainRed", { repo, branch });
      for (const key of ready) if (!seen.ready.has(key)) dispatch("prReady", { repo: key.split("#")[0], number: Number(key.split("#")[1]) });
      for (const key of bumps) if (!seen.bumps.has(key)) dispatch("newBump", { repo: key.split("#")[0], number: Number(key.split("#")[1]) });
    }
    seen = { red, ready, bumps };
  }

  return {
    prefs, savePrefs, held, markSeen, dispatch, pollBoard,
    defaults: () => structuredClone(defaults),
    /** Whether any default branch was red at the last board poll; null before the first one. */
    mainRed: () => (seen ? seen.red.size > 0 : null),

    /** Follows the session service and polls the board; returns a stop function. */
    start() {
      if (sessions) {
        detach.push(sessions.on("question.added", ({ sessionId, recordId, initial }) => {
          if (initial) return; // already waiting when ħares started: not news
          void sessionFacts(sessionId, recordId).then((facts) => dispatch("asks", { sessionId, recordId, ...facts }));
        }));
        detach.push(sessions.on("session.finished", ({ id, reason }) => {
          if (reason === "ended") return; // a person ended it from ħares
          void sessionFacts(id).then((facts) => dispatch("finishes", { sessionId: id, ...facts }));
        }));
      }
      if (board) {
        void pollBoard();
        timer = setInterval(() => void pollBoard(), pollMs);
        timer.unref();
      }
      return () => this.stop();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      detach.forEach((off) => off());
      detach = [];
    },
  };
}
