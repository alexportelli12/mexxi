export {};
// The service worker is a plain script, so the test loads its text and runs it against a stand-in for `self`.
const nodeFs = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (file: string, encoding: 'utf8') => string };
// ng test runs from the web package folder.
const swSource = readFileSync('public/sw.js', 'utf8');

type Listener = (event: unknown) => void;

function loadWorker(origin = 'https://app.example.com') {
  const listeners: Record<string, Listener> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const fetches: { url: string; init?: RequestInit }[] = [];
  const subscribed: unknown[] = [];
  const fakeFetch = (url: string, init?: RequestInit) => {
    fetches.push({ url, init });
    const body = url === '/api/push/key' ? { publicKey: 'AQID' } : { id: 'sub' };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  const subscription = (endpoint: string) => ({ toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' }, expirationTime: null }) });
  const self = {
    location: { origin },
    addEventListener: (name: string, listener: Listener) => { listeners[name] = listener; },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); return Promise.resolve(); },
      pushManager: { subscribe: (options: unknown) => { subscribed.push(options); return Promise.resolve(subscription('https://fcm.googleapis.com/fcm/send/renewed')); } },
    },
    clients: {
      matchAll: () => Promise.resolve(self.windows),
      openWindow: (url: string) => { opened.push(url); return Promise.resolve(); },
    },
    windows: [] as unknown[],
  };
  const guard = new Function('self', 'fetch', `${swSource}\nreturn safeTarget;`)(self, fakeFetch) as (url: unknown, origin: string) => string;
  return { listeners, shown, opened, navigated, self, guard, fetches, subscribed, subscription };
}

const waitable = () => {
  const box: { promise?: Promise<unknown> } = {};
  return { box, waitUntil: (promise: Promise<unknown>) => { box.promise = promise; } };
};

describe('service worker', () => {
  const origin = 'https://app.example.com';

  it('only accepts a same-origin path to a run or an approval', () => {
    const { guard } = loadWorker();
    expect(guard('/runs/abc-123', origin)).toBe('/runs/abc-123');
    expect(guard('/approvals/9f', origin)).toBe('/approvals/9f');
    expect(guard(`${origin}/runs/abc`, origin)).toBe('/runs/abc');
    for (const bad of ['https://evil.example/runs/abc', '//evil.example/runs/abc', '/audit', '/runs', '/runs/', 'javascript:alert(1)', '/runs/../audit', '/runs/a/b', undefined, 42]) {
      expect(guard(bad, origin)).toBe('/runs');
    }
  });

  it('shows a notification for a version 1 payload and ignores anything else', async () => {
    const worker = loadWorker();
    const send = async (payload: unknown) => {
      const event = { data: { json: () => payload }, ...waitable() };
      worker.listeners['push'](event);
      await event.box.promise;
    };
    await send({ v: 1, kind: 'needs_approval', title: 'my-app needs your OK', url: '/approvals/ab', tag: 'run-1' });
    await send({ v: 2, kind: 'failed', title: 'nope' });
    await send(null);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe('my-app needs your OK');
    expect(worker.shown[0].options).toMatchObject({ body: 'Needs your OK', tag: 'run-1', renotify: true, data: { url: '/approvals/ab' } });
  });

  it('opens a window when none is open, and focuses and navigates one that is', async () => {
    const worker = loadWorker();
    const click = async (url: string) => {
      const event = { notification: { close: () => undefined, data: { url } }, ...waitable() };
      worker.listeners['notificationclick'](event);
      await event.box.promise;
    };
    await click('/runs/abc');
    expect(worker.opened).toEqual(['/runs/abc']);
    const client = { focus: () => Promise.resolve(client), navigate: (url: string) => { worker.navigated.push(url); return Promise.resolve(); } };
    worker.self.windows = [client];
    await click('https://evil.example/runs/abc');
    expect(worker.navigated).toEqual(['/runs']);
  });

  it('posts a replaced subscription to the server when the browser hands over the new one', async () => {
    const worker = loadWorker();
    const event = { newSubscription: worker.subscription('https://fcm.googleapis.com/fcm/send/new'), oldSubscription: null, ...waitable() };
    worker.listeners['pushsubscriptionchange'](event);
    await event.box.promise;
    expect(worker.subscribed).toEqual([]);
    expect(worker.fetches).toHaveLength(1);
    expect(worker.fetches[0].url).toBe('/api/push/subscriptions');
    expect(worker.fetches[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(worker.fetches[0].init!.body as string)).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('subscribes again with the old options when there is no new subscription, or with the server key', async () => {
    const worker = loadWorker();
    const key = new Uint8Array([9, 9]).buffer;
    const event = { oldSubscription: { options: { applicationServerKey: key } }, ...waitable() };
    worker.listeners['pushsubscriptionchange'](event);
    await event.box.promise;
    expect(worker.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: key }]);
    expect(JSON.parse(worker.fetches[0].init!.body as string).endpoint).toBe('https://fcm.googleapis.com/fcm/send/renewed');

    const bare = loadWorker();
    const second = { ...waitable() };
    bare.listeners['pushsubscriptionchange'](second);
    await second.box.promise;
    expect(bare.fetches.map((entry) => entry.url)).toEqual(['/api/push/key', '/api/push/subscriptions']);
    expect([...(bare.subscribed[0] as { applicationServerKey: Uint8Array }).applicationServerKey]).toEqual([1, 2, 3]);
  });

  it('has no fetch handler', () => {
    expect(loadWorker().listeners['fetch']).toBeUndefined();
  });
});
