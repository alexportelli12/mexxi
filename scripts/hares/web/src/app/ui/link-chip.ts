import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from './icon';

/**
 * A small pill that names what a session is linked to: its issue, branch or pull request. As a link its tap
 * area is 44 pixels tall around a 32 pixel pill; without an address it is plain text.
 */
@Component({
  selector: 'hares-link-chip',
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    @if (href(); as address) {
      <a [href]="address" target="_blank" rel="noopener" class="inline-flex min-h-11 items-center text-text no-underline" [attr.aria-label]="label() + ', opens in a new tab'"><ng-container *ngTemplateOutlet="pill" /></a>
    } @else {
      <span class="inline-flex min-h-11 items-center"><ng-container *ngTemplateOutlet="pill" /></span>
    }
    <ng-template #pill>
      <span class="inline-flex min-h-8 items-center gap-1.5 rounded-[10px] bg-surface pr-2.5 pl-2 text-[13.5px] font-medium">
        <span class="inline-flex text-faint"><hares-icon [name]="icon()" [size]="15" /></span>{{ label() }}
      </span>
    </ng-template>
  `,
})
export class LinkChip {
  readonly icon = input.required<IconName>();
  readonly label = input.required<string>();
  readonly href = input<string | null>(null);
}
