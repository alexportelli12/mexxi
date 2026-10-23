import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BASE = 'inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-card px-4 py-2 text-[15px] font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50';
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-(--accent-hover) active:bg-(--accent-pressed)',
  secondary: 'border border-border-strong bg-surface-raised text-text hover:border-muted',
  danger: 'bg-failed text-on-accent hover:opacity-90',
  ghost: 'text-muted hover:text-text',
};

/** A button or link that is at least 44 by 44 pixels, in one of four weights. */
@Component({
  selector: 'button[segwi-button], a[segwi-button]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: '<ng-content />',
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');
  protected readonly classes = computed(() => `${BASE} ${VARIANTS[this.variant()]}`);
}
