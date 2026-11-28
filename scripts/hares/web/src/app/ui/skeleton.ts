import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Grey bars where text will be, so a screen keeps its shape while it loads. They hold still under reduced motion. */
@Component({
  selector: 'hares-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3', role: 'status', 'aria-label': 'Loading' },
  template: `@for (row of rows(); track row) { <span class="block h-16 animate-pulse rounded-2xl bg-surface motion-reduce:animate-none"></span> }`,
})
export class Skeleton {
  readonly count = input(3);
  protected rows = () => Array.from({ length: this.count() }, (_, index) => index);
}
