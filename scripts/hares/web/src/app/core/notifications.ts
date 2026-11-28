import { Injectable, inject, signal } from '@angular/core';
import { ApiError, ApiService } from './api';
import { readSetting, writeSetting } from './draft';

export type NotificationState = 'checking' | 'unsupported' | 'needs-home-screen' | 'not-set-up' | 'denied' | 'off' | 'on';

const SUBSCRIPTION_SETTING = 'push-subscription';

export function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Whether a subscription was made with the server's current key. */
export function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, index) => byte === wanted[index]);
}

type SubscriptionBody = { endpoint: string; keys: { p256dh: string; auth: string } };
const bodyOf = (subscription: PushSubscription): SubscriptionBody => {
  const { endpoint, keys } = subscription.toJSON() as SubscriptionBody;
  return { endpoint, keys };
};

/**
 * Makes sure the server knows this device's subscription. The server may have lost it (a new
 * database) or rotated its keys; a subscription made with an old key can never be delivered
 * to, so it is replaced with one made with the current key. Returns the server's id for it.
 */
export async function resyncSubscription(
  manager: PushManager,
  subscription: PushSubscription,
  serverKey: string,
  api: { subscribe(body: SubscriptionBody): Promise<string> },
): Promise<string> {
  const wanted = keyBytes(serverKey);
  let current = subscription;
  if (!sameKey(subscription.options?.applicationServerKey, wanted)) {
    await subscription.unsubscribe();
    current = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
  }
  return api.subscribe(bodyOf(current));
}

/** iPhone and iPad only deliver web push to an app added to the Home Screen. */
export function needsHomeScreen(): boolean {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return apple && !standalone;
}

/** Turns notifications on or off for this device; permission is asked only from an explicit call to `enable`. */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly api = inject(ApiService);
  readonly state = signal<NotificationState>('checking');
  readonly message = signal('');
  readonly busy = signal(false);

  constructor() {
    void this.check();
  }

  private supported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  private async check(): Promise<void> {
    if (needsHomeScreen()) return this.state.set('needs-home-screen');
    if (!this.supported()) return this.state.set('unsupported');
    if (Notification.permission === 'denied') return this.state.set('denied');
    let serverKey: string | null = null;
    try {
      serverKey = await this.api.pushKey();
    } catch (error) {
      // A 404 means push isn't set up on the server; any other failure is left for "Turn on" to report.
      if (error instanceof ApiError && error.status === 404) return this.state.set('not-set-up');
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!registration || !subscription || Notification.permission !== 'granted') return this.state.set('off');
      this.state.set('on');
      if (serverKey) writeSetting(SUBSCRIPTION_SETTING, await resyncSubscription(registration.pushManager, subscription, serverKey, this.api));
    } catch {
      // A failed re-subscribe leaves nothing to push to; "Turn on" starts again.
      const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      const left = await registration?.pushManager.getSubscription().catch(() => null);
      this.state.set(left ? 'on' : 'off');
    }
  }

  async enable(): Promise<void> {
    this.busy.set(true);
    this.message.set('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.state.set(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const key = await this.api.pushKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      writeSetting(SUBSCRIPTION_SETTING, await this.api.subscribe(bodyOf(subscription)));
      this.state.set('on');
    } catch (error) {
      this.message.set(error instanceof ApiError ? error.message : "Couldn't turn notifications on.");
      this.state.set('off');
    } finally {
      this.busy.set(false);
    }
  }

  async disable(): Promise<void> {
    this.busy.set(true);
    this.message.set('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      const id = readSetting(SUBSCRIPTION_SETTING);
      if (id) await this.api.unsubscribe(id).catch(() => undefined);
      writeSetting(SUBSCRIPTION_SETTING, null);
      this.state.set('off');
    } catch {
      this.message.set("Couldn't turn notifications off.");
    } finally {
      this.busy.set(false);
    }
  }
}
