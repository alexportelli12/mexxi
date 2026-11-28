// Web push: who is subscribed, and the delivery of one payload to each of
// their devices. What a payload says, and when one is sent or held for quiet
// hours, is notify.mjs's job; this module only signs and delivers, and keeps the
// endpoint guard. A payload names a session or a pull request and a short title
// only, never a task, transcript, command or call, so a leak from a push service
// reveals nothing a stranger can use (plan section 11.5).
import { createHash, randomBytes } from "node:crypto";
import webpush from "web-push";
import { audit } from "./audit.mjs";
import { HttpError } from "./errors.mjs";
import { readVapid } from "./vapid.mjs";

// The push services browsers subscribe with (Chrome, Firefox, Safari, Edge). Any other host is refused,
// because a public name can still resolve to an internal address.
const PUSH_SERVICES = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "notify.windows.com"];

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
    const subject = settings.hares.vapidSubject ?? "";
    if (!settings.hares.push || !subject) return null;
    const keys = readVapid(stateDir);
    return keys ? { subject, ...keys } : null;
  }

  return {
    /** The public key a browser subscribes with, or null while push is off or not set up. */
    publicKey: () => vapidDetails()?.publicKey ?? null,

    /** True once push can sign and send. */
    ready: () => vapidDetails() !== null,

    /** What is missing before push works, in words for the person setting it up; null when nothing is. */
    setupProblem() {
      if (!settings.hares.push) return "Push is turned off in hares.push.";
      const missing = [];
      if (!readVapid(stateDir)) missing.push("run hares vapid init");
      if (!(settings.hares.vapidSubject ?? "")) missing.push("set hares.vapidSubject in config.json to a mailto: address or https:// URL you own");
      return missing.length ? `Push isn't set up. To set it up, ${missing.join(", and ")}.` : null;
    },

    subscribe({ endpoint, keys }, identity) {
      if (!allowEndpoint(endpoint)) throw new HttpError(400, "That push endpoint isn't allowed.");
      return store.saveSubscription({ id: randomBytes(12).toString("hex"), endpoint, p256dh: keys.p256dh, auth: keys.auth, identity });
    },

    unsubscribe(id) {
      if (!store.deleteSubscription(id)) throw new HttpError(404, "No such subscription.");
    },

    /** The identities with at least one subscribed device. */
    identities: () => [...new Set(store.listSubscriptions().map((subscription) => subscription.identity))],

    /**
     * Sends one payload to every device of `identity` (every device when it is null). `tag` groups
     * pushes about the same thing; `urgent` asks the push service to deliver at once. Never throws.
     */
    send(payload, { identity = null, tag = payload?.tag ?? "hares", urgent = false } = {}) {
      try {
        const vapid = vapidDetails();
        if (!vapid) return 0;
        const body = JSON.stringify(payload);
        const options = {
          TTL: 3600, urgency: urgent ? "high" : "normal",
          topic: createHash("sha256").update(String(tag)).digest("hex").slice(0, 32),
          vapidDetails: vapid, timeout: 10_000, ...(agent ? { agent } : {}),
        };
        const targets = store.listSubscriptions().filter((subscription) => identity === null || subscription.identity === identity);
        for (const subscription of targets) {
          const pending = deliver(subscription, body, options).finally(() => inflight.delete(pending));
          inflight.add(pending);
        }
        return targets.length;
      } catch (error) {
        console.error(`hares: push: ${error.message}`);
        return 0;
      }
    },

    /** Resolves once every send started so far has finished; tests use it. */
    idle: async () => { while (inflight.size) await Promise.all([...inflight]); },
  };
}
