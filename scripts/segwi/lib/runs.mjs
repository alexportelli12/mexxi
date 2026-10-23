// The run lifecycle: validate-then-start, event handling, status changes, reply
// and stop. Routes call this; it never touches HTTP.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { statusAfterResult } from "../runners/contract.mjs";
import { audit } from "./audit.mjs";
import { checkoutProblem, checkoutState } from "./checkout.mjs";
import { HttpError } from "./errors.mjs";
import { parsePrepareOutput } from "./ibni-link.mjs";
import { assertWithinCaps, createWatchdog } from "./limits.mjs";
import { StepFolder } from "./steps.mjs";
import { FINAL } from "./store.mjs";

const RESTART_REASON = "segwi restarted while this run was active";
const DAY_CACHE_MS = 60_000;

export const hashSecret = (secret) => createHash("sha256").update(secret).digest("hex");

/** The run as the API shows it: no host session id, no filesystem path. */
export function publicRun(run) {
  if (!run) return null;
  const { hostSessionId, worktreePath, ...rest } = run;
  return rest;
}

// The verify command the checkout's .mexxi.json names, so the run's steps show it as a test.
async function verifyCommandFor(repoPath) {
  try {
    const value = JSON.parse(await readFile(path.join(repoPath, ".mexxi.json"), "utf8"));
    if (typeof value.verify === "string" && value.verify.trim()) return value.verify.trim();
  } catch {
    // No committed .mexxi.json: the default applies.
  }
  return "npm run verify";
}

export function createRunService({ store, settings, runner, ibni, broker, serverUrl = () => "" }) {
  const { limits, repositories } = settings.segwi;
  /** @type {Map<string, { folder: StepFolder, chain: Promise<void>, prepareCalls: Set<string>, ibniSession: string|null, runSecret: string, repoPath: string }>} */
  const live = new Map();
  const watchdog = createWatchdog(limits, (runId, reason) => void timeOut(runId, reason));
  let detectCache = null;
  let shuttingDown = false;
  /** @type {Array<(runId: string) => void>} */
  const finishListeners = [];

  /** @type {Array<(status: string, run: object) => void>} */
  const statusListeners = [];

  const isFinal = (runId) => FINAL.has(store.getRun(runId)?.status);

  // A final status is the last word: a stop or timeout that lands while another path awaits
  // (an ibni lookup, the host starting) must not be overwritten when that path resumes.
  function setStatus(runId, status, reason = null, fields = {}) {
    const before = store.getRun(runId)?.status;
    if (FINAL.has(before)) return store.getRun(runId);
    const run = store.updateRun(runId, { status, reason, ...fields, ...(FINAL.has(status) ? { endedAt: new Date().toISOString() } : {}) });
    const row = store.addEvent(runId, "status", { status, reason, branch: run.branch, prUrl: run.prUrl, verify: run.verify });
    broker.publish(row);
    if (before !== status) statusListeners.forEach((listener) => listener(status, publicRun(run)));
    if (FINAL.has(status)) {
      watchdog.clear(runId);
      runner.close?.(runId);
      finishListeners.forEach((listener) => listener(runId));
    }
    return run;
  }

  async function refreshSummary(runId) {
    const state = live.get(runId);
    const run = store.getRun(runId);
    if (!state || run.action === "ask") return run;
    try {
      if (!state.ibniSession) {
        const taken = store.listRuns({ limit: 50 }).map((other) => other.worktreePath).filter(Boolean);
        const found = await ibni.findNewWorkspace(state.repoPath, run.createdAt, taken);
        if (!found) return run;
        state.ibniSession = found.sessionId;
        state.folder.root = found.worktreePath;
        store.updateRun(runId, { worktreePath: found.worktreePath });
      }
      const summary = await ibni.summary(state.repoPath, state.ibniSession);
      return store.updateRun(runId, { branch: summary.branch, prUrl: summary.prUrl, verify: summary.verify, worktreePath: summary.worktreePath });
    } catch {
      return store.getRun(runId);
    }
  }

  async function onEvent(runId, event) {
    const state = live.get(runId);
    const run = store.getRun(runId);
    if (!state || !run || FINAL.has(run.status)) return;
    if (event.kind === "session") {
      store.updateRun(runId, { hostSessionId: event.hostSessionId });
      return;
    }
    if (event.kind === "exit") {
      setStatus(runId, "failed", "The agent stopped without finishing.");
      return;
    }
    const { kind, ...data } = event;
    if (kind === "step" && data.phase === "call" && data.tool === "Bash" && /\bibni\s+prepare\b/.test(data.input.command ?? "")) {
      state.prepareCalls.add(data.toolUseId);
    }
    const row = store.addEvent(runId, kind, data);
    const step = state.folder.add(row);
    broker.publish(row, step);
    // Counted in the audit log too, so refusals across runs can be counted by action.
    if (kind === "refusal") audit(store, { actor: "system", origin: "system", action: "run.refused", target: runId, outcome: "rejected", detail: step.detail });
    if (run.status !== "needs_approval") watchdog.touch(runId);
    if (kind === "step" && data.phase === "result" && state.prepareCalls.has(data.toolUseId)) {
      const prepared = parsePrepareOutput(data.detail, settings.worktreeRoot);
      if (prepared) {
        state.ibniSession = prepared.sessionId;
        state.folder.root = prepared.worktreePath;
        store.updateRun(runId, { worktreePath: prepared.worktreePath, branch: prepared.branch });
        broker.publish(store.addEvent(runId, "status", { status: run.status, reason: null, branch: prepared.branch, prUrl: null, verify: null }));
      }
    }
    if (kind === "result") {
      store.updateRun(runId, { costUsd: data.costUsd });
      const updated = data.ok ? await refreshSummary(runId) : store.getRun(runId);
      // ibni lookups can take seconds; a stop or timeout in the meantime wins.
      if (FINAL.has(updated.status)) return;
      const status = statusAfterResult({ result: data, action: run.action, hasPullRequest: Boolean(updated.prUrl) });
      const reason = status === "failed" ? (data.subtype === "error_max_turns" ? "Reached the turn limit" : `The agent ended with ${data.subtype}`) : null;
      setStatus(runId, status, reason);
      if (status === "needs_input") watchdog.touch(runId);
    }
  }

  function emitterFor(runId) {
    return (event) => {
      const state = live.get(runId);
      if (!state || shuttingDown) return;
      state.chain = state.chain.then(() => onEvent(runId, event)).catch(() => {});
    };
  }

  /** The runner's own report, refreshed at most once a minute: `claude --version` is too slow to run per request. */
  async function detected() {
    if (!detectCache || Date.now() - detectCache.at > DAY_CACHE_MS) detectCache = { at: Date.now(), detected: await runner.detect() };
    return detectCache.detected;
  }

  async function timeOut(runId, reason) {
    const run = store.getRun(runId);
    if (!run || FINAL.has(run.status)) return;
    runner.stop(runId);
    setStatus(runId, "timed_out", reason);
    audit(store, { actor: "system", origin: "system", action: "run.timed_out", target: runId, outcome: "ok", detail: reason });
  }

  return {
    async create(input) {
      const existing = () => (input.clientId ? store.findByClientId(input.clientId) : null);
      if (existing()) return { run: publicRun(existing()), created: false };
      const repository = repositories.find((candidate) => candidate.name === input.repo);
      const problem = checkoutProblem(await checkoutState(repository.path));
      // A retry with the same clientId may have inserted its run while this one awaited; nothing awaits from here to the insert.
      if (existing()) return { run: publicRun(existing()), created: false };
      if (problem) throw new HttpError(409, problem);
      // Checked and inserted in one synchronous step, so two requests can't both pass.
      assertWithinCaps(store, limits);
      const id = randomUUID();
      store.createRun({ id, repo: input.repo, action: input.action, task: input.task, clientId: input.clientId ?? null });
      broker.publish(store.addEvent(id, "status", { status: "queued", reason: null, branch: null, prUrl: null, verify: null }));
      const runSecret = randomBytes(32).toString("hex");
      store.setRunSecretHash(id, hashSecret(runSecret));
      const verifyCommand = await verifyCommandFor(repository.path);
      // Stopped while queued: never start the host.
      if (isFinal(id)) return { run: publicRun(store.getRun(id)), created: true };
      live.set(id, { folder: new StepFolder({ root: repository.path, verifyCommand }), chain: Promise.resolve(), prepareCalls: new Set(), ibniSession: null, runSecret, repoPath: repository.path });
      setStatus(id, "running");
      watchdog.watch(id);
      try {
        await runner.start({
          runId: id, repoPath: repository.path, action: input.action, task: input.task, limits: { maxTurns: limits.maxTurns, approvalTimeoutMinutes: limits.approvalTimeoutMinutes }, model: settings.segwi.model || undefined,
          worktreeRoot: settings.worktreeRoot,
          browser: settings.browser, serverUrl: serverUrl(), bindPort: Number(new URL(serverUrl() || "http://127.0.0.1").port) || undefined, runSecret,
          tailnetName: settings.segwi.auth.web.mode === "tailscale-header" ? settings.segwi.auth.web.hostname : undefined,
        }, emitterFor(id));
      } catch (error) {
        setStatus(id, "failed", `The agent could not start: ${error.message}`);
      }
      // A stop or timeout during the start found no process to signal; signal the one that now exists.
      if (isFinal(id)) runner.stop(id);
      return { run: publicRun(store.getRun(id)), created: true };
    },

    get(id) {
      const run = store.getRun(id);
      if (!run) throw new HttpError(404, "No such run.");
      const state = live.get(id);
      const folder = state?.folder ?? new StepFolder({ root: run.worktreePath ?? repositories.find((r) => r.name === run.repo)?.path ?? null });
      if (!state) store.listEvents(id, 0, 5000).forEach((row) => folder.add(row));
      return { ...publicRun(run), steps: folder.steps };
    },
    list: (query) => store.listRuns(query).map(publicRun),
    events(id, since = 0) {
      if (!store.getRun(id)) throw new HttpError(404, "No such run.");
      return store.listEvents(id, since, 1000);
    },

    send(id, text) {
      const run = store.getRun(id);
      if (!run) throw new HttpError(404, "No such run.");
      if (run.status !== "needs_input" && run.status !== "running") throw new HttpError(409, `The run is ${run.status} and can't take a reply.`);
      try {
        runner.send(id, text);
      } catch (error) {
        throw new HttpError(409, error.message);
      }
      broker.publish(store.addEvent(id, "input", { text }), null);
      if (run.status === "needs_input") setStatus(id, "running");
      watchdog.touch(id);
      return publicRun(store.getRun(id));
    },

    stop(id) {
      const run = store.getRun(id);
      if (!run) throw new HttpError(404, "No such run.");
      if (FINAL.has(run.status)) throw new HttpError(409, `The run is already ${run.status}.`);
      runner.stop(id);
      return publicRun(setStatus(id, "stopped", "Stopped by you"));
    },

    /** Called with the run id whenever a run reaches a final status (approvals expire then). */
    onFinish: (listener) => finishListeners.push(listener),

    /** Called with the new status and the run each time a run's status changes. */
    onStatus: (listener) => statusListeners.push(listener),

    /** A person is being asked: the run waits, and idleness is not counted. */
    markWaiting(id) {
      const run = store.getRun(id);
      if (!run || FINAL.has(run.status) || run.status === "needs_approval") return;
      setStatus(id, "needs_approval");
      watchdog.pause(id);
    },

    /** The last pending approval was answered: the run goes on. */
    markResumed(id) {
      const run = store.getRun(id);
      if (!run || run.status !== "needs_approval") return;
      setStatus(id, "running");
      watchdog.touch(id);
    },

    /** Marks runs a previous process left active as failed. */
    recover() {
      store.interruptedRunIds().forEach((id) => {
        setStatus(id, "failed", RESTART_REASON);
        audit(store, { actor: "system", origin: "system", action: "run.recovered", target: id, outcome: "ok", detail: RESTART_REASON });
      });
    },

    async repos() {
      return Promise.all(repositories.map(async (repository) => {
        const state = await checkoutState(repository.path);
        const last = store.lastRunFor(repository.name);
        return {
          name: repository.name, actions: repository.actions, defaultBranch: state.defaultBranch, clean: state.clean, onDefault: state.onDefault,
          lastRun: last ? { id: last.id, status: last.status, createdAt: last.createdAt } : null,
        };
      }));
    },

    async health(version) {
      const { available, version: runnerVersion, testedVersions, problems } = await detected();
      return {
        ok: available, version,
        // The caps the app needs to size its inputs and word a timed-out run.
        limits: { taskMaxChars: limits.taskMaxChars, inputMaxChars: limits.inputMaxChars, idleTimeoutMinutes: limits.idleTimeoutMinutes },
        runner: { id: runner.id, available, version: runnerVersion, tested: runnerVersion !== null && testedVersions.includes(runnerVersion), problems },
      };
    },

    /** Ends every host before segwi exits; a runner without `shutdown` gets a stop per run. */
    async shutdown() {
      // The hosts' exits are segwi's doing, not the runs' outcome: the next start marks those runs as interrupted.
      shuttingDown = true;
      watchdog.stopAll();
      if (runner.shutdown) await runner.shutdown();
      else for (const id of live.keys()) runner.stop(id);
    },
  };
}
