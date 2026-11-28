import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { CheckState } from '../models';
import { checksAria } from '../pr-logic';

/** One small square per check, so a row can be scanned: teal passed, red failed, amber still running. */
@Component({
  selector: 'hares-checks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="gh-sqs" role="img" [attr.aria-label]="label()">@for (state of states(); track $index) {<span class="gh-sq" [class]="state"></span>}</span>`,
})
export class CheckSquares {
  readonly states = input.required<readonly CheckState[]>();
  protected readonly label = computed(() => checksAria(this.states()));
}
