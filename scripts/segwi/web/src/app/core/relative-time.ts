import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { now } from './clock';
import { absoluteTime, relativeTime } from './time';

/** A `<time>` that reads "5 minutes ago" and carries the absolute time in its title. */
@Component({
  selector: 'segwi-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<time [attr.datetime]="iso()" [title]="absolute()">{{ relative() }}</time>`,
})
export class RelativeTime {
  readonly iso = input.required<string>();
  protected readonly relative = computed(() => relativeTime(this.iso(), now()));
  protected readonly absolute = computed(() => absoluteTime(this.iso()));
}
