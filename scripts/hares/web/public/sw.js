// The service worker does one job: show a notification when the server pushes one,
// open the right screen when it is tapped, and keep the server's copy of the push
// subscription current when the browser replaces it. It has no fetch handler, so it never
// caches or intercepts anything; offline use is not supported yet.

const COPY = {
  needs_input: 'Needs your reply',
  needs_approval: 'Needs your OK',
  completed: 'Done',
  failed: 'Failed',
};

// Only a same-origin path to a run or an approval is opened. Anything else goes to the run list,
// so a forged payload cannot send the window somewhere else.
function safeTarget(url, origin) {
  try {
    const target = new URL(url, origin);
    if (target.origin === origin && /^\/(runs|approvals)\/[\w-]+$/.test(target.pathname)) return target.pathname;
  } catch {
    // Fall through to the default.
  }
  return '/runs';
}

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || payload.v !== 1 || typeof payload.title !== 'string') return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: COPY[payload.kind] || '',
      tag: typeof payload.tag === 'string' ? payload.tag : undefined,
      renotify: true,
      icon: '/icons/icon-192.png',
      data: { url: safeTarget(payload.url, self.location.origin) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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
