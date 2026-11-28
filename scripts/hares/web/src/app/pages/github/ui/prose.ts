import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { prepareHtml } from '../render-html';

/**
 * Rendered Markdown from the server (a pull request body or a comment). It is bound with
 * [innerHTML], so Angular's sanitiser runs on it again; it is never marked trusted.
 */
@Component({
  selector: 'hares-prose',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="gh-prose" [class.small]="small()" [innerHTML]="html()"></div>`,
})
export class Prose {
  readonly body = input.required<string>();
  protected readonly html = computed(() => prepareHtml(this.body()));
  readonly small = input(false);
}
