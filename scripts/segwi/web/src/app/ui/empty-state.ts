import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'segwi-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-6 py-12 text-center' },
  template: `
    <svg class="size-8 text-muted" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="5" fill="none" stroke="currentColor" stroke-width="2" /><path d="M10 16h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    <h2 class="text-lg font-semibold text-text">{{ title() }}</h2>
    @if (hint()) { <p class="max-w-sm text-muted">{{ hint() }}</p> }
    <ng-content />
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly hint = input('');
}
