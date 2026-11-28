import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService, failureMessage } from '../core/api';
import { NotificationsService, type NotificationState } from '../core/notifications';
import type { HeldNotification, NotificationEvents, NotificationPrefs } from '../models';
import { Banner } from '../ui/banner';
import { BackLink } from '../ui/back-link';
import { Button } from '../ui/button';
import { Sheet } from '../ui/sheet';
import { Switch } from '../ui/switch';
import { brand, iosHomeScreenHint, notificationsExplainer } from '../words';

const EVENTS: { id: keyof NotificationEvents; name: string; hint: string }[] = [
  { id: 'asks', name: 'A session asks you something', hint: 'Questions and approvals' },
  { id: 'finishes', name: 'A session finishes', hint: 'Including the PR it opened' },
  { id: 'mainRed', name: 'Main goes red', hint: 'CI fails on a default branch' },
  { id: 'prReady', name: 'A PR is ready to merge', hint: 'All checks passed' },
  { id: 'newBump', name: 'A dependency bump arrives', hint: 'From dependabot or renovate' },
];

/** Why this device can't get notifications, in words; null when it can. */
const UNAVAILABLE: Partial<Record<NotificationState, string>> = {
  denied: 'Your browser blocks notifications for this site. Allow them in the browser’s site settings, then reload this page.',
  'needs-home-screen': iosHomeScreenHint,
  unsupported: 'This browser can’t show notifications.',
  'not-set-up': 'Push isn’t set up on the server yet, so it can’t send notifications.',
};

/**
 * Notifications: which events reach you, quiet hours, and whether this device receives them. A tap on one
 * opens the exact question or pull request. Changes save as you make them.
 */
@Component({
  imports: [Banner, BackLink, Button, Sheet, Switch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1' },
  template: `
    <header class="flex items-center px-3.5 pt-2"><hares-back-link to="/settings" label="Settings" /></header>
    <main class="flex flex-col gap-8 px-5 pt-3 pb-12">
      <div>
        <h1 class="text-[30px] leading-[1.1] font-semibold tracking-[-0.026em]">Notifications</h1>
        <p class="mt-3 max-w-[32ch] text-base leading-[1.45] text-muted">Tapping one opens the exact question or pull request.</p>
      </div>

      <figure class="m-0 flex flex-col gap-2.5">
        <div role="img" aria-label="Example notification: That’s Fair is asking how to handle Angular template linting, with Keep ESLint and Open buttons" class="flex flex-col gap-2.5 rounded-[22px] bg-surface px-4 py-3.5 shadow-[0_18px_40px_-24px_var(--hares-card-shadow)]">
          <div class="flex items-center gap-2 text-[13px] text-faint">
            <span aria-hidden="true" class="inline-flex size-4.5 items-center justify-center rounded-[5px] bg-bg"><span class="size-1.5 rounded-full bg-amber"></span></span>{{ brand }}<span class="ml-auto">now</span>
          </div>
          <div class="flex flex-col gap-0.5"><span class="text-[15.5px] font-semibold">That’s Fair is asking</span><span class="text-[15px] leading-[1.4] text-muted">How should I handle Angular template linting?</span></div>
          <div class="grid grid-cols-2 gap-1.5">
            <span class="flex min-h-10 items-center justify-center rounded-xl bg-raised text-[14.5px] font-medium">Keep ESLint</span>
            <span class="flex min-h-10 items-center justify-center rounded-xl bg-raised text-[14.5px] font-medium">Open</span>
          </div>
        </div>
        <figcaption class="text-[13.5px] leading-[1.4] text-faint">Answer buttons show where your phone supports them. Otherwise, tap to open the question.</figcaption>
      </figure>

      @if (error(); as message) { <hares-banner kind="error">{{ message }}</hares-banner> }

      <section class="flex flex-col" aria-labelledby="h-device">
        <div class="sect-head"><h2 id="h-device">This device</h2></div>
        <div class="flex items-center gap-3.5 border-b border-line py-3.5">
          <span class="flex flex-1 flex-col gap-0.75"><span class="text-base font-medium">Notifications on this device</span><span class="text-[13.5px] text-faint">{{ deviceHint() }}</span></span>
          <hares-switch label="Notifications on this device" [checked]="device.state() === 'on'" (toggled)="toggleDevice($event)" />
        </div>
        @if (device.message()) { <p class="pt-2 text-[13.5px] text-red" role="alert">{{ device.message() }}</p> }
      </section>

      <section class="flex flex-col" aria-labelledby="h-when">
        <div class="sect-head"><h2 id="h-when">Tell me when</h2></div>
        @for (event of events; track event.id) {
          <div class="flex items-center gap-3.5 border-b border-line py-3.5">
            <span class="flex flex-1 flex-col gap-0.75"><span class="text-base font-medium">{{ event.name }}</span><span class="text-[13.5px] text-faint">{{ event.hint }}</span></span>
            <hares-switch [label]="event.name" [checked]="prefs()?.events?.[event.id] ?? false" (toggled)="setEvent(event.id, $event)" />
          </div>
        }
      </section>

      <section class="flex flex-col" aria-labelledby="h-quiet">
        <div class="sect-head"><h2 id="h-quiet">Quiet hours</h2></div>
        <div class="flex items-center gap-3.5 border-b border-line py-3.5">
          <span class="flex flex-1 flex-col gap-0.75"><span class="text-base font-medium">{{ prefs()?.quietHours?.start ?? '23:00' }} to {{ prefs()?.quietHours?.end ?? '07:00' }}</span><span class="text-[13.5px] text-faint">Held notifications wait for you on Now</span></span>
          <hares-switch label="Quiet hours" [checked]="prefs()?.quietHours?.enabled ?? false" (toggled)="setQuiet($event)" />
        </div>
        @if (prefs()?.quietHours?.enabled) {
          <div class="flex items-center gap-3 py-3.5">
            <label for="quiet-start" class="text-[14.5px] text-muted">From</label>
            <input id="quiet-start" type="time" class="min-h-11 rounded-xl border border-strong bg-surface px-3 text-base text-text" [value]="prefs()!.quietHours.start" (change)="setQuietTime('start', $any($event.target).value)" />
            <label for="quiet-end" class="text-[14.5px] text-muted">to</label>
            <input id="quiet-end" type="time" class="min-h-11 rounded-xl border border-strong bg-surface px-3 text-base text-text" [value]="prefs()!.quietHours.end" (change)="setQuietTime('end', $any($event.target).value)" />
          </div>
        }
      </section>
    </main>

    <hares-sheet [open]="explaining()" heading="Turn on notifications?" (closed)="explaining.set(false)">
      <p class="px-3 pb-4 text-base leading-[1.45] text-muted">{{ explainer }}</p>
      <div class="flex gap-2 px-3">
        <button hares-button class="flex-1" type="button" (click)="explaining.set(false)">Not now</button>
        <button hares-button variant="primary" class="flex-1" type="button" autofocus [disabled]="device.busy()" (click)="turnOn()">Turn on</button>
      </div>
    </hares-sheet>
  `,
})
export class NotificationsPage {
  private readonly api = inject(ApiService);
  protected readonly device = inject(NotificationsService);
  protected readonly brand = brand;
  protected readonly events = EVENTS;
  protected readonly explainer = notificationsExplainer;
  protected readonly prefs = signal<NotificationPrefs | null>(null);
  protected readonly held = signal<HeldNotification[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly explaining = signal(false);
  protected readonly deviceHint = computed(() => {
    const state = this.device.state();
    return UNAVAILABLE[state] ?? (state === 'on' ? 'On. This device gets what you choose below.' : state === 'checking' ? 'Checking…' : 'Off. Nothing reaches this device.');
  });

  constructor() {
    this.api.notificationPrefs().then(
      (answer) => {
        this.prefs.set(answer.prefs);
        this.held.set(answer.held);
      },
      (error) => this.error.set(failureMessage(error)),
    );
  }

  protected toggleDevice(on: boolean): void {
    if (UNAVAILABLE[this.device.state()]) return;
    if (on) this.explaining.set(true);
    else void this.device.disable();
  }

  protected async turnOn(): Promise<void> {
    await this.device.enable();
    this.explaining.set(false);
  }

  protected setEvent(id: keyof NotificationEvents, on: boolean): void {
    const current = this.prefs();
    if (current) void this.save({ ...current, events: { ...current.events, [id]: on } });
  }

  protected setQuiet(on: boolean): void {
    const current = this.prefs();
    if (current) void this.save({ ...current, quietHours: { ...current.quietHours, enabled: on } });
  }

  protected setQuietTime(which: 'start' | 'end', value: string): void {
    const current = this.prefs();
    if (current && /^\d{2}:\d{2}$/.test(value)) void this.save({ ...current, quietHours: { ...current.quietHours, [which]: value } });
  }

  /** Shows the change at once and sends it; if the server refuses, the switch goes back and says why. */
  private async save(next: NotificationPrefs): Promise<void> {
    const before = this.prefs();
    this.prefs.set(next);
    this.error.set(null);
    try {
      const answer = await this.api.savePrefs(next);
      this.prefs.set(answer.prefs);
    } catch (error) {
      this.prefs.set(before);
      this.error.set(failureMessage(error));
    }
  }
}
