import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NotificationsService, type NotificationState } from '../core/notifications';
import { iosHomeScreenHint, notificationsExplainer } from '../words';
import { Button } from './button';
import { Sheet } from './sheet';

/** Why the switch can't be used, short enough for the header, and in full for screen readers and hover. */
const UNAVAILABLE: Partial<Record<NotificationState, { short: string; full: string }>> = {
  denied: { short: 'Blocked', full: "Your browser blocks notifications for this site. Allow them in the browser's site settings, then reload this page." },
  'needs-home-screen': { short: 'Add to Home Screen', full: iosHomeScreenHint },
  unsupported: { short: 'Not supported', full: "This browser can't show notifications." },
  'not-set-up': { short: 'Not set up', full: "Push isn't set up on the server yet, so it can't send notifications." },
};

/**
 * The notifications switch in the header. Nothing is asked of the browser until "Turn on" in the
 * explainer is tapped; turning off needs no confirmation. When notifications can't work here the
 * switch is disabled and a short hint says why.
 */
@Component({
  selector: 'segwi-notifications-toggle',
  imports: [Button, Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center gap-1' },
  template: `
    @if (unavailable(); as reason) {
      <!-- A tap shows the full reason: a phone has no hover for a title, and the iPhone one is a set of steps. -->
      <button type="button" id="notifications-hint" class="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center px-1 text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-text"
        [attr.aria-label]="reason.short + ': why notifications are off'" (click)="whyOpen.set(true)">{{ reason.short }}</button>
    } @else if (service.message()) {
      <span id="notifications-hint" class="max-w-40 truncate text-xs text-failed" role="alert" [title]="service.message()">{{ service.message() }}</span>
    }
    <button type="button" role="switch" aria-label="Notifications" [attr.aria-checked]="on()"
      [attr.aria-describedby]="unavailable() || service.message() ? 'notifications-hint' : null" [title]="title()"
      [disabled]="disabled()" (click)="tap()"
      class="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-card px-1.5 text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50">
      <svg class="size-5" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z" /><path d="M10 19a2 2 0 0 0 4 0" />
        @if (unavailable()) { <path d="M4 4l16 16" /> }
      </svg>
      <span class="relative inline-flex h-6 w-10 items-center rounded-full border transition-colors duration-100" aria-hidden="true"
        [class]="on() ? 'border-accent bg-accent' : 'border-border-strong bg-surface-raised'">
        <span class="absolute left-0.5 size-4.5 rounded-full transition-transform duration-100" [class]="on() ? 'translate-x-4 bg-on-accent' : 'bg-muted'"></span>
      </span>
    </button>

    <segwi-sheet [open]="whyOpen()" heading="Notifications are off" (closed)="whyOpen.set(false)">
      <p class="text-muted">{{ unavailable()?.full }}</p>
      <div class="flex justify-end"><button segwi-button type="button" autofocus (click)="whyOpen.set(false)">OK</button></div>
    </segwi-sheet>

    <segwi-sheet [open]="explaining()" heading="Turn on notifications?" (closed)="explaining.set(false)">
      <p class="text-muted">{{ explainer }}</p>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button segwi-button type="button" (click)="explaining.set(false)">Not now</button>
        <button segwi-button variant="primary" type="button" autofocus [disabled]="service.busy()" (click)="turnOn()">Turn on</button>
      </div>
    </segwi-sheet>
  `,
})
export class NotificationsToggle {
  protected readonly service = inject(NotificationsService);
  protected readonly explaining = signal(false);
  protected readonly whyOpen = signal(false);
  protected readonly explainer = notificationsExplainer;
  protected readonly on = computed(() => this.service.state() === 'on');
  protected readonly unavailable = computed(() => UNAVAILABLE[this.service.state()] ?? null);
  protected readonly disabled = computed(() => {
    const state = this.service.state();
    return this.service.busy() || (state !== 'on' && state !== 'off');
  });
  protected readonly title = computed(() => this.unavailable()?.full ?? (this.on() ? 'Notifications are on' : 'Notifications are off'));

  protected tap(): void {
    if (this.on()) void this.service.disable();
    else this.explaining.set(true);
  }

  protected async turnOn(): Promise<void> {
    await this.service.enable();
    this.explaining.set(false);
  }
}
