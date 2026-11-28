import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Phase } from '../models';

/**
 * A session's state as a dot: amber and breathing while it waits on you, teal while it works, a hollow ring
 * while it is idle. It is never the only sign: the word always sits beside it. The breathing stops under
 * reduced motion (styles.css).
 */
@Component({
  selector: 'hares-lantern',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[class]': 'classes()' },
  template: '',
})
export class Lantern {
  readonly phase = input.required<Phase>();
  readonly size = input<'sm' | 'md'>('md');
  protected readonly classes = computed(() => {
    const phase = this.phase();
    const size = this.size() === 'md' ? 'size-2.5' : 'size-2';
    const look = phase === 'waiting' ? 'bg-amber lantern' : phase === 'working' ? 'bg-teal' : 'border-2 border-strong';
    return `inline-block shrink-0 rounded-full box-border ${size} ${look}`;
  });
}
