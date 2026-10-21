// Jev triage through OpenRouter's Decisions API: the questions, the payload
// (redacted and capped), one bounded call, and the answers as recorded. Every
// failure becomes a recorded reason rather than an error, because triage must
// never change how a run proceeds.
import { redact } from "../../lib/redact.mjs";

// The request shape follows OpenRouter's Decisions API reference: noul
// criteria are {true, false}, choice criteria map each label to its meaning,
// and score criteria are ordered from level 0 upwards.
export const QUESTIONS = {
  existingUi: {
    type: "noul",
    instructions: "Does this change alter UI that already exists?",
    criteria: {
      true: "It changes screens, components, styles or copy that users can already see.",
      false: "It adds only new UI, or touches no UI at all.",
    },
  },
  userFacing: {
    type: "noul",
    instructions: "Is this change user-facing?",
    criteria: {
      true: "End users would see or feel the difference in a running app.",
      false: "Only developers, tooling, tests, docs or internals change.",
    },
  },
  oneWayDoor: {
    type: "noul",
    instructions: "Does it touch migrations, data writes, public contracts or deploys?",
    criteria: {
      true: "It changes a schema or migration, writes or deletes stored data, alters a public API or contract, or changes how the app is deployed.",
      false: "None of those; reverting the pull request would undo it completely.",
    },
  },
  size: {
    type: "choice",
    instructions: "How big is this change?",
    criteria: {
      mechanical: "Renames, formatting, dependency bumps or copy and config tweaks with no behaviour change.",
      local: "A contained change to one feature or module.",
      feature: "New or changed behaviour across a few modules.",
      "cross-cutting": "Touches many areas, shared infrastructure or architecture.",
      other: "None of these fit.",
    },
  },
  reviewValue: {
    type: "score",
    instructions: "How much would an independent code review add beyond automated checks?",
    criteria: [
      "Nothing: mechanical or trivially verified.",
      "Little: small and local; a second look is unlikely to change it.",
      "Some: real behaviour or logic change where a second view could catch a mistake.",
      "Substantial: architectural, security, integration or broad user-facing change.",
    ],
  },
};

// What each answer recommends for the gate the agent decides; Phase 7 compares
// these with what the agent did. Review is recommended from the "Some" level up.
const REVIEW_LEVEL = 2;
export const GATE_QUESTIONS = {
  beforeShots: (answers) => answers.existingUi.answer === "yes",
  renderedQa: (answers) => answers.userFacing.answer === "yes",
  review: (answers) => answers.reviewValue.level >= REVIEW_LEVEL,
};

const CONTEXT = "A coding agent's task, triaged once its contract is set. changedPaths and diffStats describe the work so far and may be empty before implementation starts.";
const TRUNCATED = "\n[truncated]";

// Fields are shortened in this order when the request would reach the cap:
// the path list first (diffStats keeps the totals), then the raw request
// (the contract restates it), and the contract last.
export const TRUNCATION_ORDER = ["changedPaths", "request", "contract"];

function byteSize(body) {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

// The largest n in [0, max] for which fits(n) holds, assuming fits is monotonic.
function largestFitting(max, fits) {
  let low = 0;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function shortenText(text, length) {
  if (length >= text.length) return text;
  let kept = text.slice(0, length);
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${TRUNCATED}`;
}

function shortenPaths(paths, count) {
  return count >= paths.length ? paths : [...paths.slice(0, count), `... and ${paths.length - count} more`];
}

// Builds the request body: redacted first, then shortened field by field until
// it is strictly below maxBytes. Returns null when even empty fields do not fit.
export function buildRequest({ model, request, contract, changedPaths, diffStats, maxBytes, zeroDataRetention }) {
  let redactions = 0;
  const clean = (text) => {
    const result = redact(text);
    redactions += result.count;
    return result.text;
  };
  const state = {
    context: CONTEXT,
    request: clean(request),
    contract: clean(contract),
    changedPaths: changedPaths.map(clean),
    diffStats,
  };
  const body = {
    model,
    state,
    questions: QUESTIONS,
    ...(zeroDataRetention ? { provider: { zdr: true } } : {}),
  };
  const fits = () => byteSize(body) < maxBytes;
  const truncated = [];
  for (const field of TRUNCATION_ORDER) {
    if (fits()) break;
    const original = state[field];
    const shorten = field === "changedPaths" ? shortenPaths : shortenText;
    const kept = largestFitting(original.length, (length) => {
      state[field] = shorten(original, length);
      return fits();
    });
    state[field] = shorten(original, kept);
    truncated.push(field);
  }
  if (!fits()) return null;
  return { body, bytes: byteSize(body), redactions, truncated };
}

class TriageFailure extends Error {}

const probability = (value) => typeof value === "number" && value >= 0 && value <= 1;

// Jev's noul answer is only the probability of yes; its confidence here is the
// probability of the answer given, so every question reads the same way.
function parseAnswer(name, question, raw) {
  const fail = (what) => { throw new TriageFailure(`malformed response: ${name} ${what}`); };
  if (!raw || typeof raw !== "object") fail("is missing");
  if (question.type === "noul") {
    if (!probability(raw.noul)) fail("has no noul probability");
    return { answer: raw.noul >= 0.5 ? "yes" : "no", confidence: Math.max(raw.noul, 1 - raw.noul), probability: raw.noul };
  }
  if (!probability(raw.confidence)) fail("has no confidence");
  if (question.type === "choice") {
    if (!Object.hasOwn(question.criteria, raw.choice)) fail("chose an unknown option");
    return { answer: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities ?? null };
  }
  const top = question.criteria.length - 1;
  if (typeof raw.score !== "number" || raw.score < 0 || raw.score > top) fail("has no score in range");
  return { answer: Math.round(raw.score * 100) / 100, level: Math.round(raw.score), of: top, confidence: raw.confidence, probabilities: raw.probabilities ?? null };
}

export function parseResponse(payload) {
  if (!payload || typeof payload !== "object" || !payload.answers || typeof payload.answers !== "object") {
    throw new TriageFailure("malformed response: no answers");
  }
  const answers = {};
  for (const [name, question] of Object.entries(QUESTIONS)) answers[name] = parseAnswer(name, question, payload.answers[name]);
  const cost = payload.usage?.cost;
  return {
    answers,
    cost: typeof cost === "number" ? cost : null,
    inputTokens: Number.isInteger(payload.usage?.input_tokens) ? payload.usage.input_tokens : null,
    responseModel: typeof payload.model === "string" ? payload.model : null,
    responseId: typeof payload.id === "string" ? payload.id : null,
  };
}

const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 2000;

function retryDelay(response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : RETRY_DELAY_MS;
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
  } catch {
    return "";
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// One call with a per-attempt timeout and a single retry on 429. Resolves to
// {outcome: "answered", ...} or {outcome: "failed", reason}; never rejects.
export async function askJev({ endpoint, apiKey, body, timeoutMs, fetchImpl = fetch, sleep = defaultSleep, now = () => performance.now() }) {
  const started = now();
  let attempts = 0;
  let httpStatus = null;
  const finish = (result) => ({ attempts, httpStatus, latencyMs: Math.round(now() - started), ...result });
  try {
    for (;;) {
      attempts += 1;
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      httpStatus = response.status;
      if (response.status === 429 && attempts === 1) {
        await sleep(retryDelay(response));
        continue;
      }
      if (!response.ok) return finish({ outcome: "failed", reason: `HTTP ${response.status}${await errorMessage(response)}`.slice(0, 300) });
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
        throw new TriageFailure("malformed response: not JSON");
      }
      return finish({ outcome: "answered", reason: null, ...parseResponse(payload) });
    }
  } catch (error) {
    if (error instanceof TriageFailure) return finish({ outcome: "failed", reason: error.message });
    if (error.name === "TimeoutError" || error.name === "AbortError") return finish({ outcome: "failed", reason: `timed out after ${timeoutMs} ms` });
    return finish({ outcome: "failed", reason: `request failed: ${error.cause?.message ?? error.message}`.slice(0, 300) });
  }
}
