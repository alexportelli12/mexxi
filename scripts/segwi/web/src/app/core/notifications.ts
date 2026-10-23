import { Injectable, inject, signal } from '@angular/core';
import { ApiError, ApiService } from './api';
import { readSetting, writeSetting } from './draft';

export type NotificationState = 'checking' | 'unsupported' | 'needs-home-screen' | 'not-set-up' | 'denied' | 'off' | 'on';

const SUBSCRIPTION_SETTING = 'push-subscription';

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    try {
      await this.api.pushKey();
    } catch (error) {
      // A 404 means the server has no push keys yet; any other failure is left for "Turn on" to report.
      if (error instanceof ApiError && error.status === 404) return this.state.set('not-set-up');
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      this.state.set(subscription && Notification.permission === 'granted' ? 'on' : 'off');
    } catch {
      this.state.set('off');
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
      const { endpoint, keys } = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      writeSetting(SUBSCRIPTION_SETTING, await this.api.subscribe({ endpoint, keys }));
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
