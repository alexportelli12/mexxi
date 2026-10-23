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
  const self = {
    location: { origin },
    addEventListener: (name: string, listener: Listener) => { listeners[name] = listener; },
    registration: { showNotification: (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); return Promise.resolve(); } },
    clients: {
      matchAll: () => Promise.resolve(self.windows),
      openWindow: (url: string) => { opened.push(url); return Promise.resolve(); },
    },
    windows: [] as unknown[],
  };
  const guard = new Function('self', `${swSource}\nreturn safeTarget;`)(self) as (url: unknown, origin: string) => string;
  return { listeners, shown, opened, navigated, self, guard };
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

  it('has no fetch handler', () => {
    expect(loadWorker().listeners['fetch']).toBeUndefined();
  });
});
