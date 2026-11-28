// The service worker does one job: show a notification when the server pushes one,
// open the right screen when it is tapped (or send the answer a button carries), and keep the server's copy of the push
// subscription current when the browser replaces it. It has no fetch handler, so it never
// caches or intercepts anything; offline use is not supported yet.

const COPY = {
  asks: 'Needs your answer',
  finishes: 'Finished',
  mainRed: 'Main is red',
  prReady: 'Ready to merge',
  newBump: 'A dependency bump arrived',
  // The kinds of the run-based app, for a notification sent before the update.
  needs_input: 'Needs your reply',
  needs_approval: 'Needs your OK',
  completed: 'Done',
  failed: 'Failed',
};
const STALE = 'The session changed since you looked; check it again';

// Only a same-origin path to a session (with a question to open), a pull request or an old run or approval
// link is opened. Anything else goes to Now, so a forged payload cannot send the window somewhere else.
function safeTarget(url, origin) {
  try {
    const target = new URL(url, origin);
    if (target.origin === origin) {
      if (/^\/s\/[\w-]+$/.test(target.pathname) && (target.search === '' || /^\?q=[\w-]+$/.test(target.search))) return target.pathname + target.search;
      if (/^\/prs\/[\w.-]+\/\d+$/.test(target.pathname) && target.search === '') return target.pathname;
      if (/^\/(runs|approvals)\/[\w-]+$/.test(target.pathname) && target.search === '') return target.pathname;
    }
  } catch {
    // Fall through to the default.
  }
  return '/';
}

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || payload.v !== 1 || typeof payload.title !== 'string') return;
  // A question may carry buttons that answer it. Each button names the one request it sends, made when
  // the notification was: it answers a question and nothing else, and the server still refuses it if the
  // session moved since. Permissions never come with buttons.
  const buttons = Array.isArray(payload.actions) ? payload.actions.filter((entry) => entry && typeof entry.action === 'string' && typeof entry.title === 'string' && payload.answers && payload.answers[entry.action]).slice(0, 2) : [];
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === 'string' ? payload.body : COPY[payload.kind] || '',
      tag: typeof payload.tag === 'string' ? payload.tag : undefined,
      renotify: true,
      icon: '/icons/icon-192.png',
      actions: buttons.map((entry) => ({ action: entry.action, title: entry.title })),
      data: { url: safeTarget(payload.url, self.location.origin), answers: buttons.length ? payload.answers : null },
    }),
  );
});

// An answer button sends its stored answer to the one session it belongs to, then says whether it went.
async function answerFrom(event) {
  const sent = event.notification.data && event.notification.data.answers && event.notification.data.answers[event.action];
  if (!sent || typeof sent.sessionId !== 'string' || !/^[\w-]+$/.test(sent.sessionId)) return false;
  const response = await fetch('/api/sessions/' + encodeURIComponent(sent.sessionId) + '/answer', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: sent.questionId, expect: sent.expect, answers: sent.answers }),
  });
  if (!response.ok) {
    await self.registration.showNotification('Answer not sent', { body: response.status === 409 ? STALE : 'It could not be sent. Open the question to answer it.', tag: 'answer-failed', icon: '/icons/icon-192.png', data: { url: safeTarget(event.notification.data.url, self.location.origin), answers: null } });
  }
  return response.ok;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action) {
    event.waitUntil(answerFrom(event).catch(() => false));
    return;
  }
  const url = safeTarget(event.notification.data && event.notification.data.url, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => 'focus' in client);
      if (!open) return self.clients.openWindow(url);
      return open.focus().then((client) => (client && 'navigate' in client ? client.navigate(url) : undefined));
    }),
  );
});

function keyBytes(base64Url) {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

// The browser can expire or replace a subscription at any time. Without this the server
// would keep pushing to the old one and nothing would arrive. Only the same origin is
// ever contacted, and only with the subscription's endpoint and keys.
async function resubscribe(event) {
  let subscription = event.newSubscription;
  if (!subscription) {
    let key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
    if (!key) {
      const response = await fetch('/api/push/key', { credentials: 'same-origin' });
      if (!response.ok) return;
      key = keyBytes((await response.json()).publicKey);
    }
    subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  const { endpoint, keys } = subscription.toJSON();
  await fetch('/api/push/subscriptions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, keys }),
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event).catch(() => undefined));
});
