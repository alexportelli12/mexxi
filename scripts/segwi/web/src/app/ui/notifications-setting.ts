import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NotificationsService } from '../core/notifications';
import { iosHomeScreenHint, notificationsExplainer } from '../words';
import { Button } from './button';
import { Sheet } from './sheet';

/** The Notifications row. Nothing is asked of the browser until "Turn on" in the explainer is tapped. */
@Component({
  selector: 'segwi-notifications-setting',
  imports: [Button, Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-2">
      <p class="text-[15px]"><span class="text-muted">Notifications:</span> <strong class="font-medium">{{ label() }}</strong></p>
      @switch (service.state()) {
        @case ('off') { <button segwi-button type="button" (click)="explaining.set(true)">Turn on</button> }
        @case ('on') { <button segwi-button type="button" [disabled]="service.busy()" (click)="service.disable()">Turn off</button> }
      }
    </div>
    @switch (service.state()) {
      @case ('denied') { <p class="mt-2 text-sm text-muted">Notifications are blocked for this site. To turn them on, allow notifications in your browser's site settings, then come back.</p> }
      @case ('needs-home-screen') { <p class="mt-2 text-sm text-muted">{{ homeScreenHint }}</p> }
      @case ('unsupported') { <p class="mt-2 text-sm text-muted">This browser can't show notifications.</p> }
    }
    @if (service.message()) { <p class="mt-2 text-sm text-failed" role="alert">{{ service.message() }}</p> }

    <segwi-sheet [open]="explaining()" heading="Turn on notifications?" (closed)="explaining.set(false)">
      <p class="text-muted">{{ explainer }}</p>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button segwi-button type="button" (click)="explaining.set(false)">Not now</button>
        <button segwi-button variant="primary" type="button" autofocus [disabled]="service.busy()" (click)="turnOn()">Turn on</button>
      </div>
    </segwi-sheet>
  `,
})
export class NotificationsSetting {
  protected readonly service = inject(NotificationsService);
  protected readonly explaining = signal(false);
  protected readonly explainer = notificationsExplainer;
  protected readonly homeScreenHint = iosHomeScreenHint;

  protected label(): string {
    const state = this.service.state();
    if (state === 'on') return 'On';
    if (state === 'checking') return '…';
    return state === 'off' ? 'Off' : 'Unavailable';
  }

  protected async turnOn(): Promise<void> {
    await this.service.enable();
    this.explaining.set(false);
  }
}
