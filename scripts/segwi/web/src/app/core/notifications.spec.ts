import { keyBytes, resyncSubscription, sameKey } from './notifications';

const SERVER_KEY = 'AQIDBA'; // bytes 1, 2, 3, 4

function fakeSubscription(endpoint: string, key: number[] | null) {
  return {
    endpoint,
    unsubscribed: false,
    options: { applicationServerKey: key ? new Uint8Array(key).buffer : null, userVisibleOnly: true },
    toJSON() {
      return { endpoint, expirationTime: null, keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` } };
    },
    async unsubscribe() {
      this.unsubscribed = true;
      return true;
    },
  };
}

function fakeManager() {
  const made: unknown[] = [];
  return {
    made,
    async subscribe(options: { applicationServerKey: Uint8Array }) {
      made.push(options);
      return fakeSubscription('https://fcm.googleapis.com/new', [...options.applicationServerKey]);
    },
  };
}

describe('push subscription resync', () => {
  it('compares keys byte for byte', () => {
    expect([...keyBytes(SERVER_KEY)]).toEqual([1, 2, 3, 4]);
    expect(sameKey(new Uint8Array([1, 2, 3, 4]).buffer, keyBytes(SERVER_KEY))).toBe(true);
    expect(sameKey(new Uint8Array([1, 2, 3, 5]).buffer, keyBytes(SERVER_KEY))).toBe(false);
    expect(sameKey(new Uint8Array([1, 2, 3]).buffer, keyBytes(SERVER_KEY))).toBe(false);
    expect(sameKey(null, keyBytes(SERVER_KEY))).toBe(false);
  });

  it('posts the existing subscription again when it was made with the current key', async () => {
    const subscription = fakeSubscription('https://fcm.googleapis.com/old', [1, 2, 3, 4]);
    const manager = fakeManager();
    const posted: unknown[] = [];
    const id = await resyncSubscription(manager as never, subscription as never, SERVER_KEY, { subscribe: async (body) => { posted.push(body); return 'id-1'; } });
    expect(id).toBe('id-1');
    expect(subscription.unsubscribed).toBe(false);
    expect(manager.made).toEqual([]);
    expect(posted).toEqual([{ endpoint: 'https://fcm.googleapis.com/old', keys: { p256dh: 'p-https://fcm.googleapis.com/old', auth: 'a-https://fcm.googleapis.com/old' } }]);
  });

  it('replaces a subscription made with an old key, then posts the new one', async () => {
    const subscription = fakeSubscription('https://fcm.googleapis.com/old', [9, 9, 9, 9]);
    const manager = fakeManager();
    const posted: { endpoint: string }[] = [];
    await resyncSubscription(manager as never, subscription as never, SERVER_KEY, { subscribe: async (body) => { posted.push(body); return 'id-2'; } });
    expect(subscription.unsubscribed).toBe(true);
    expect(manager.made).toHaveLength(1);
    expect([...(manager.made[0] as { applicationServerKey: Uint8Array }).applicationServerKey]).toEqual([1, 2, 3, 4]);
    expect(posted.map((body) => body.endpoint)).toEqual(['https://fcm.googleapis.com/new']);
  });
});
