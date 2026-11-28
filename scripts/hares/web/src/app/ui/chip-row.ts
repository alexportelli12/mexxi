import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface Chip {
  id: string;
  label: string;
}

/**
 * A row of chips that scrolls sideways instead of wrapping. As tabs (role tablist) one is selected; the
 * hit area of each is 44 pixels tall, while the pill the eye sees is 40.
 */
@Component({
  selector: 'hares-chip-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'scroll-x -mx-5 flex gap-2 px-5', role: 'tablist', '[attr.aria-label]': 'label()' },
  template: `
    @for (chip of chips(); track chip.id) {
      <button type="button" role="tab" class="inline-flex min-h-11 flex-none cursor-pointer items-center whitespace-nowrap" [attr.aria-selected]="chip.id === value()" (click)="chosen.emit(chip.id)">
        <span class="inline-flex min-h-10 items-center rounded-full px-3.5 text-[15px]"
          [class]="chip.id === value() ? 'bg-text text-bg font-semibold' : 'bg-surface text-text font-medium'">{{ chip.label }}</span>
      </button>
    }
  `,
})
export class ChipRow {
  readonly chips = input.required<Chip[]>();
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly chosen = output<string>();
}
