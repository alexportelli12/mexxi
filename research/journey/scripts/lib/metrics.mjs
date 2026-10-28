// Per-session metrics, computed from one session in the shape sources.mjs
// yields. Only counts, byte sizes, timestamps and a few short quote
// candidates leave this function; the transcript itself is dropped.
// METHOD.md defines each metric and its known false positives.
import {
  CATEGORY, CHECK_CROSS, CHECK_OUTCOME_FAIL, CHECK_OUTCOME_PASS, CHECK_OUTPUT_FAILED, CHECK_TICKS, CLAIM_NEGATED, PARTIAL_COUNT, SIDE_FILE, CORRECTION, DONE_CLAIM, DONE_REPLY, EDIT_REFUSED, ERRORISH, FOLLOW_UP,
  MASKED_FAILURE, PORT_CLASH, REWORK, VERIFY, ZSH_PITFALL, commandSkeleton, isShellEdit, isVerifyCommand, normalizeCommand,
} from "./patterns.mjs";

// The Bash tool's 10-minute cap, with the retro's 5-second allowance.
export const BASH_CAP_MS = 595_000;
// Scratch and evidence places: a scripted edit there is not the work itself.
const SIDE_PLACE = /\/tmp\/|\/scratchpad\b|\.evidence\b|\/\.claude\/|\/memory\b/;
// A gap longer than this between events ends an active span (concurrency).
export const IDLE_GAP_MS = 30 * 60_000;
// session_retro.py's RETRY_MIN: a command run this often is a retry cluster.
export const RETRY_MIN = 3;

const bytes = (text) => Buffer.byteLength(text ?? "", "utf8");

// The lines where tools put causes, as session_retro.py reads them: the first
// four and last six, kept only when they read like an error.
function causeLines(output) {
  const lines = output.split("\n");
  return lines.slice(0, 4).concat(lines.slice(-6)).filter((line) => ERRORISH.test(line)).join("\n");
}

// Sentences of a reply that claim checks pass, without negating or hedging.
export function checkClaims(text) {
  const partial = (sentence) => [...sentence.matchAll(PARTIAL_COUNT)].some(([, done, total]) => Number(done) < Number(total));
  // Table rows are status reports ("| lint | pass |"), not claims.
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => !sentence.trimStart().startsWith("|") && DONE_CLAIM.test(sentence) && !CLAIM_NEGATED.test(sentence) && !partial(sentence));
}

export function activeSpans(times, gap = IDLE_GAP_MS) {
  const sorted = times.filter(Number.isFinite).sort((a, b) => a - b);
  const spans = [];
  for (const at of sorted) {
    const last = spans.at(-1);
    if (last && at - last[1] <= gap) last[1] = at;
    else spans.push([at, at]);
  }
  return spans;
}

export function sessionMetrics(session) {
  const m = {
    toolCalls: 0, bashCalls: 0, bashFailures: 0,
    globAborts: 0, hiddenExitCodes: 0, timeouts: 0, bashCapHits: 0, portClashes: 0, missingPackages: 0, commandNotFound: 0,
    failingRetries: 0, environmentalFailures: 0, editBeforeRead: 0, editRefused: 0, compactions: 0,
    toolOutputBytes: 0, checkRunBytes: [],
    doneClaims: 0, unverifiedDoneClaims: 0, prompts: 0, reworkPrompts: 0, followUps: 0, corrections: 0,
    quoteCandidates: [],
  };
  const known = new Set();
  const commands = new Map();
  // Whether a check has passed since the last edit; a session that never
  // edits starts unverified too, so a claim needs some passing run behind it.
  let verified = false;
  let editedEver = false;
  let claimedDoneSincePrompt = false;

  const settleCheck = (failed) => {
    verified = !failed;
  };
  // A check's outcome read back from a log or output file.
  const readBack = (output) => {
    if (CHECK_OUTCOME_FAIL.test(output)) settleCheck(true);
    else if (CHECK_OUTCOME_PASS.test(output) || (CHECK_TICKS.test(output) && !CHECK_CROSS.test(output))) settleCheck(false);
  };

  for (const event of session.events) {
    if (event.kind === "compact") {
      m.compactions += 1;
    } else if (event.kind === "settle") {
      if (event.tool.tool === "Bash" && isVerifyCommand(event.tool.command)) settleCheck(event.failed);
    } else if (event.kind === "tool") {
      m.toolCalls += 1;
      const output = event.output ?? "";
      m.toolOutputBytes += bytes(output);
      for (const file of event.reads) known.add(file);
      if (event.tool === "Edit") {
        for (const file of event.edits) {
          if (!known.has(file)) m.editBeforeRead += 1;
        }
      }
      if (event.failed && EDIT_REFUSED.test(output.slice(0, 3000))) m.editRefused += 1;
      if ((event.tool === "Edit" || event.tool === "Write") && !event.failed) {
        const files = [...event.edits, ...event.writes];
        for (const file of files) known.add(file);
        if (files.some((file) => !SIDE_FILE.test(file))) {
          verified = false;
          editedEver = true;
        }
      }
      if (PORT_CLASH.test(output)) m.portClashes += 1;
      if (event.tool === "Read") readBack(output);
      if (event.tool !== "Bash") continue;

      m.bashCalls += 1;
      const raw = event.command ?? "";
      const command = normalizeCommand(raw);
      let failed = event.failed;
      if (ZSH_PITFALL.test(output)) m.globAborts += 1;
      const retroCheck = VERIFY.test(commandSkeleton(command));
      if (retroCheck && !failed && MASKED_FAILURE.test(output)) {
        m.hiddenExitCodes += 1;
        failed = true;
      }
      if (event.durationMs !== null && event.durationMs >= BASH_CAP_MS) m.bashCapHits += 1;
      if (failed) {
        m.bashFailures += 1;
        const causes = causeLines(output);
        const timeout = CATEGORY.timeout.test(causes) || (event.durationMs ?? 0) >= BASH_CAP_MS;
        const missing = CATEGORY.missingPackage.test(causes);
        const notFound = CATEGORY.commandNotFound.test(causes);
        if (CATEGORY.timeout.test(causes)) m.timeouts += 1;
        if (missing) m.missingPackages += 1;
        if (notFound) m.commandNotFound += 1;
        // A failure the environment caused rather than the work: the shell, the
        // clock, a busy port or a missing tool.
        if (timeout || missing || notFound || ZSH_PITFALL.test(output) || PORT_CLASH.test(output)) m.environmentalFailures += 1;
      }
      // A scripted edit and the check after it often share one call, so the
      // edit counts first and the check's outcome then settles it.
      if (isShellEdit(raw) && !SIDE_PLACE.test(raw.split("\n", 1)[0]) && !failed) {
        verified = false;
        editedEver = true;
      }
      // ibni reuses CI's passing run on the base commit instead of running.
      if (/\bibni prepare\b/.test(command) && /"reused":\s*true/.test(output)) settleCheck(false);
      if (isVerifyCommand(raw)) {
        if (!event.background) {
          m.checkRunBytes.push(bytes(output));
          settleCheck(event.failed || CHECK_OUTPUT_FAILED.test(output));
        }
      } else {
        readBack(output);
      }
      if (command) {
        const cluster = commands.get(command) ?? { runs: 0, failures: 0 };
        cluster.runs += 1;
        cluster.failures += failed ? 1 : 0;
        commands.set(command, cluster);
      }
    } else if (event.kind === "reply") {
      const claims = checkClaims(event.text);
      if (claims.length) {
        m.doneClaims += 1;
        const unverified = !verified;
        if (unverified) m.unverifiedDoneClaims += 1;
        const sentence = claims[0].trim();
        m.quoteCandidates.push({ kind: unverified ? "unverified-claim" : "verified-claim", text: sentence, at: event.at, editedEver });
      }
      if (claims.length || DONE_REPLY.test(event.text)) claimedDoneSincePrompt = true;
    } else if (event.kind === "prompt") {
      m.prompts += 1;
      const text = event.text;
      // As session_retro.py counts them: a follow-up, else a correction.
      if (FOLLOW_UP.test(text)) m.followUps += 1;
      else if (text.length < 1500 && CORRECTION.test(text)) m.corrections += 1;
      if (claimedDoneSincePrompt && text.length < 1500 && (CORRECTION.test(text) || REWORK.test(text) || FOLLOW_UP.test(text))) m.reworkPrompts += 1;
      claimedDoneSincePrompt = false;
    }
  }
  for (const { runs, failures } of commands.values()) {
    if (runs >= RETRY_MIN && failures >= 2) m.failingRetries += 1;
  }
  return m;
}
