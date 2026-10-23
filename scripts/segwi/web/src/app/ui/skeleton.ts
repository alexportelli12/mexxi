import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A placeholder block while data loads; it only pulses when motion is welcome. */
@Component({
  selector: 'segwi-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', class: 'block rounded-card bg-surface-raised motion-safe:animate-pulse', '[style.height]': 'height()' },
  template: '',
})
export class Skeleton {
  readonly height = input('5rem');
}
