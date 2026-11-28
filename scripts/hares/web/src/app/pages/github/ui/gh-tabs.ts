import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

/**
 * A row of choices that works as tabs (they switch a panel) or as radios (they pick a value).
 * Arrow keys, Home and End move between them, and only the chosen one is in the tab order.
 */
@Component({
  selector: 'hares-gh-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gh-tabs" [class.seg]="segmented()" [class.bleed]="!segmented()" [style.--cols]="items().length"
      [attr.role]="mode() === 'tab' ? 'tablist' : 'radiogroup'" [attr.aria-label]="label()" (keydown)="onKey($event)">
      @for (item of items(); track item.key) {
        <button type="button" class="gh-chip" [attr.role]="mode()" [tabindex]="item.key === selected() ? 0 : -1"
          [attr.aria-selected]="mode() === 'tab' ? item.key === selected() : null"
          [attr.aria-checked]="mode() === 'radio' ? item.key === selected() : null"
          [attr.aria-controls]="mode() === 'tab' ? controls(item.key) : null"
          (click)="picked.emit(item.key)"><span>{{ item.label }}</span>@if (item.count !== undefined) { <span class="gh-sr">, </span><b>{{ item.count }}</b> }</button>
      }
    </div>
  `,
})
export class GhTabs {
  readonly items = input.required<TabItem[]>();
  readonly selected = input.required<string>();
  readonly label = input.required<string>();
  readonly mode = input<'tab' | 'radio'>('tab');
  readonly segmented = input(false);
  /** The id of the one panel the tabs switch; set this or panelPrefix when mode is tab. */
  readonly panelId = input<string | null>(null);
  /** Or one panel per tab, with ids that start with this and end with the tab's key. */
  readonly panelPrefix = input<string | null>(null);
  readonly picked = output<string>();

  protected controls(key: string): string | null {
    const prefix = this.panelPrefix();
    return prefix ? prefix + key : this.panelId();
  }

  protected onKey(event: KeyboardEvent): void {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = this.items();
    const current = items.findIndex((item) => item.key === this.selected());
    const last = items.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
      : event.key === 'ArrowRight' ? (current >= last ? 0 : current + 1) : (current <= 0 ? last : current - 1);
    event.preventDefault();
    this.picked.emit(items[next].key);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button');
    buttons[next]?.focus();
  }
}
