import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { visibleSegments } from '../core/visible-text';

/**
 * Shows text exactly, with every control, bidi or invisible character as a chip such as
 * `\x1b` or `U+202E`, so nothing can be reordered or hidden. Place it in an element that
 * keeps whitespace (`whitespace-pre-wrap`); the template has no whitespace of its own.
 */
@Component({
  selector: 'segwi-visible-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Isolated, so the direction of the text around it can't reorder it.
  host: { class: '[unicode-bidi:isolate]' },
  template: `@for (segment of segments(); track $index) {@if (segment.kind === 'text') {<span>{{ segment.text }}</span>} @else {<span class="mx-px rounded border border-border-strong bg-surface-raised px-1 font-code text-[0.85em] text-needs-you" [title]="segment.title" data-escape>{{ segment.label }}</span>}}`,
})
export class VisibleText {
  readonly text = input.required<string>();
  protected readonly segments = computed(() => visibleSegments(this.text()));
}
