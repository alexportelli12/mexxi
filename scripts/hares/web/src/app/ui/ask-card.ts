import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from './icon';

export type AskVariant = 'card' | 'sheet' | 'cockpit';

const HOST: Record<AskVariant, string> = {
  card: 'flex flex-col rounded-3xl border border-amber bg-surface px-2 pt-5 pb-2 shadow-[0_24px_60px_-32px_var(--amber)]',
  cockpit: 'flex flex-col rounded-3xl border border-amber bg-surface p-6 shadow-[0_24px_64px_-36px_var(--amber)]',
  sheet: 'sticky bottom-0 z-30 flex max-h-[88dvh] flex-col overflow-y-auto rounded-t-[28px] border-t border-amber bg-surface px-3 pt-2 pb-[calc(1.75rem+env(safe-area-inset-bottom))] shadow-[0_-24px_60px_-34px_var(--amber)] lg:static lg:max-h-none lg:rounded-3xl lg:border lg:p-6',
};

/**
 * The one raised surface of a screen: an amber-edged card that holds whatever waits on you. On Now and in the
 * cockpit it sits in the page; on a session it docks to the bottom edge of a phone. It says who asks and,
 * when several wait, which one this is, with previous and next.
 */
@Component({
  selector: 'hares-ask-card',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'hostClass()', '[attr.role]': "variant() === 'sheet' ? 'dialog' : 'article'", '[attr.aria-labelledby]': 'labelledBy()', 'data-raised': '' },
  template: `
    @if (variant() === 'sheet') { <span aria-hidden="true" class="mb-4 h-1.25 w-9 self-center rounded-sm bg-strong lg:hidden"></span> }
    @if (lead() || queue()) {
    <div class="flex min-h-7 items-center justify-between gap-2" [class]="variant() === 'card' ? 'pr-2 pl-4' : variant() === 'sheet' ? 'px-3 lg:px-0' : ''">
      <span class="text-[14.5px] font-semibold text-amber-text">{{ lead() }}</span>
      @if (queue(); as position) {
        <span class="flex items-center gap-0.5">
          <button type="button" class="inline-flex size-11 cursor-pointer items-center justify-center rounded-full text-muted hover:text-text" aria-label="Previous question" (click)="previous.emit()"><span class="inline-flex -scale-x-100"><hares-icon name="chevron" [size]="18" /></span></button>
          <span class="tnum min-w-10.5 text-center text-[13.5px] font-semibold text-muted">{{ position.index + 1 }} of {{ position.total }}</span>
          <button type="button" class="inline-flex size-11 cursor-pointer items-center justify-center rounded-full text-muted hover:text-text" aria-label="Next question" (click)="next.emit()"><hares-icon name="chevron" [size]="18" /></button>
        </span>
      } @else if (age()) {
        <span class="pr-2 text-[13.5px] text-faint">{{ age() }}</span>
      }
    </div>
    }
    <ng-content />
  `,
})
export class AskCard {
  readonly variant = input<AskVariant>('card');
  /** "That’s Fair is asking": who, and what they do. */
  readonly lead = input<string | null>(null);
  readonly labelledBy = input.required<string>();
  readonly queue = input<{ index: number; total: number } | null>(null);
  readonly age = input<string | null>(null);
  readonly previous = output<void>();
  readonly next = output<void>();
  protected readonly hostClass = computed(() => HOST[this.variant()]);
}
