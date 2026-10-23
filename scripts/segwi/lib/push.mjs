// Web push: who is subscribed, and one notification per run transition that needs
// you (needs_input, needs_approval, completed, failed). A payload names the run,
// repo and status only, never the task, output or a command, so a leak from a push
// service reveals nothing a stranger can use (plan section 11.5).
import { createHash, randomBytes } from "node:crypto";
import webpush from "web-push";
import { audit } from "./audit.mjs";
import { cleanText } from "./clean.mjs";
import { HttpError } from "./errors.mjs";
import { readVapid } from "./vapid.mjs";

const NOTIFIED = new Set(["needs_input", "needs_approval", "completed", "failed", "canary_failed"]);
const COPY = { needs_input: "needs your reply", needs_approval: "needs your OK", completed: "is done", failed: "failed" };
// The nightly canary has no run and no repo. Its payload is fixed text, so there is nothing in it to leak.
const CANARY_PAYLOAD = { v: 1, kind: "canary_failed", status: "canary_failed", title: "segwi canary failed", url: "/", tag: "canary" };
// The push services browsers subscribe with (Chrome, Firefox, Safari, Edge). Any other host is refused,
// because a public name can still resolve to an internal address.
const PUSH_SERVICES = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "notify.windows.com"];
const TITLE_MAX = 80;

/** The SSRF guard: https on the default port, to a known browser push service only. */
export function endpointAllowed(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  return PUSH_SERVICES.some((service) => host === service || host.endsWith(`.${service}`));
}

/**
 * @param {{ store: object, settings: object, stateDir: string, allowEndpoint?: (endpoint: string) => boolean, agent?: object,
 *   send?: Function }} deps
 *   `allowEndpoint`, `agent` and `send` are injected by tests (a local stand-in push service); config and requests never set them.
 */
export function createPushService({ store, settings, stateDir, allowEndpoint = endpointAllowed, agent, send = webpush.sendNotification }) {
  const inflight = new Set();

  function payloadFor(kind, run) {
    if (kind === "canary_failed") return CANARY_PAYLOAD;
    const approval = kind === "needs_approval" ? store.pendingApprovalsFor(run.id)[0] : null;
    return {
      v: 1, kind, runId: run.id, ...(approval ? { approvalId: approval.id } : {}), repo: run.repo, status: kind,
      title: cleanText(`${run.repo} ${COPY[kind]}`, TITLE_MAX),
      url: approval ? `/approvals/${approval.id}` : `/runs/${run.id}`,
      tag: `run-${run.id}`,
    };
  }

  async function deliver(subscription, body, options) {
    try {
      await send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, body, options);
      store.markSubscription(subscription.id);
    } catch (error) {
      const host = new URL(subscription.endpoint).host;
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        store.deleteSubscription(subscription.id);
        audit(store, { actor: "system", origin: "system", action: "push.gone", target: subscription.id, outcome: "ok", detail: `${host} answered ${error.statusCode}` });
      } else {
        store.markSubscription(subscription.id, `${error?.statusCode ?? "error"} ${error?.message ?? ""}`);
        audit(store, { actor: "system", origin: "system", action: "push.failed", target: subscription.id, outcome: "error", detail: `${host} ${error?.statusCode ?? error?.code ?? "failed"}` });
      }
    }
  }

  /** Everything a push is signed with, or null while push is off or not fully set up. */
  function vapidDetails() {
    const subject = settings.segwi.vapidSubject ?? "";
    if (!settings.segwi.push || !subject) return null;
    const keys = readVapid(stateDir);
    return keys ? { subject, ...keys } : null;
  }

  return {
    /** The public key a browser subscribes with, or null while push is off or not set up. */
    publicKey: () => vapidDetails()?.publicKey ?? null,

    /** What is missing before push works, in words for the person setting it up; null when nothing is. */
    setupProblem() {
      if (!settings.segwi.push) return "Push is turned off in segwi.push.";
      const missing = [];
      if (!readVapid(stateDir)) missing.push("run segwi vapid init");
      if (!(settings.segwi.vapidSubject ?? "")) missing.push("set segwi.vapidSubject in config.json to a mailto: address or https:// URL you own");
      return missing.length ? `Push isn't set up. To set it up, ${missing.join(", and ")}.` : null;
    },

    subscribe({ endpoint, keys }, identity) {
      if (!allowEndpoint(endpoint)) throw new HttpError(400, "That push endpoint isn't allowed.");
      return store.saveSubscription({ id: randomBytes(12).toString("hex"), endpoint, p256dh: keys.p256dh, auth: keys.auth, identity });
    },

    unsubscribe(id) {
      if (!store.deleteSubscription(id)) throw new HttpError(404, "No such subscription.");
    },

    /** Sends one notification per subscription (`run` is null for `canary_failed`). Never throws into the run. */
    notify(kind, run) {
      try {
        const vapid = vapidDetails();
        if (!vapid || !NOTIFIED.has(kind) || (!run && kind !== "canary_failed")) return;
        const body = JSON.stringify(payloadFor(kind, run));
        const options = {
          TTL: 3600, urgency: kind.startsWith("needs_") ? "high" : "normal",
          topic: `run-${createHash("sha256").update(run?.id ?? "canary").digest("hex").slice(0, 12)}`,
          vapidDetails: vapid, timeout: 10_000, ...(agent ? { agent } : {}),
        };
        for (const subscription of store.listSubscriptions()) {
          const pending = deliver(subscription, body, options).finally(() => inflight.delete(pending));
          inflight.add(pending);
        }
      } catch (error) {
        console.error(`segwi: push: ${error.message}`);
      }
    },

    /** Resolves once every send started so far has finished; tests use it. */
    idle: async () => { while (inflight.size) await Promise.all([...inflight]); },
  };
}
