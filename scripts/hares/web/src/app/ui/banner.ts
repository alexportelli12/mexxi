import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from './icon';

export type BannerTone = 'error' | 'ok' | 'info';
const TONES: Record<BannerTone, { box: string; icon: string; name: IconName }> = {
  error: { box: 'bg-red-soft', icon: 'text-red', name: 'offline' },
  ok: { box: 'bg-teal-soft', icon: 'text-teal', name: 'check' },
  info: { box: 'bg-raised', icon: 'text-muted', name: 'bell' },
};

/** A one-line notice: red when something is wrong, teal when something worked. Put a button in [action]. */
@Component({
  selector: 'hares-banner',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', class: 'flex items-center gap-3 rounded-2xl py-3 pr-3 pl-4 text-[14.5px] leading-[1.4]', '[class]': 'tone().box' },
  template: `
    <span [class]="tone().icon" class="inline-flex"><hares-icon [name]="tone().name" [size]="20" /></span>
    <span class="flex-1"><ng-content /></span>
    <ng-content select="[action]" />
  `,
})
export class Banner {
  readonly kind = input<BannerTone>('error');
  protected tone = () => TONES[this.kind()];
}
