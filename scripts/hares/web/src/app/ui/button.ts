import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'quiet' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE = 'inline-flex cursor-pointer items-center justify-center gap-2 border transition-colors duration-100 disabled:cursor-not-allowed';
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-amber text-on-amber font-semibold disabled:bg-raised disabled:text-faint',
  quiet: 'border-transparent bg-raised text-text font-medium disabled:text-faint',
  outline: 'border-strong bg-transparent text-text font-medium disabled:text-faint',
  danger: 'border-transparent bg-red text-on-red font-semibold disabled:opacity-60',
  ghost: 'border-transparent bg-transparent text-muted font-medium disabled:text-faint',
};
/** Each size is at least 44 pixels tall, the smallest a thumb can hit reliably. */
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-12 min-w-11 rounded-xl px-4 text-[15px]',
  md: 'min-h-13 min-w-11 rounded-2xl px-5.5 text-base',
  lg: 'min-h-14 min-w-11 rounded-2xl px-5 text-[16.5px]',
};

/** A button or link in one of five weights and three sizes, never under 44 by 44 pixels. */
@Component({
  selector: 'button[hares-button], a[hares-button]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: '<ng-content />',
})
export class Button {
  readonly variant = input<ButtonVariant>('quiet');
  readonly size = input<ButtonSize>('md');
  protected readonly classes = computed(() => `${BASE} ${VARIANTS[this.variant()]} ${SIZES[this.size()]}`);
}
