import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './icon';

/** The way back at the top of a screen: a chevron and where it goes, in a 44 pixel target. */
@Component({
  selector: 'hares-back-link',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `<a [routerLink]="to()" class="inline-flex min-h-11 items-center gap-1 pr-2 pl-0.5 text-base text-muted no-underline hover:text-text"><hares-icon name="back" [size]="20" />{{ label() }}</a>`,
})
export class BackLink {
  readonly to = input.required<string | string[]>();
  readonly label = input.required<string>();
}
