import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input } from '@angular/core';
import { prepareHtml } from '../render-html';

/**
 * Rendered Markdown from the server (a pull request body or a comment). It is bound with
 * [innerHTML], so Angular's sanitiser runs on it again; it is never marked trusted.
 */
@Component({
  selector: 'hares-prose',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `<div class="gh-prose" [class.small]="small()" [innerHTML]="html()"></div>`,
  styles: `
    .gh-prose{font-size:16px;line-height:1.62;overflow-wrap:anywhere}
    .gh-prose.small{font-size:15.5px;line-height:1.5}
    .gh-prose>:first-child{margin-top:0}
    .gh-prose p,.gh-prose ul,.gh-prose ol,.gh-prose pre,.gh-prose blockquote,.gh-prose details{margin:12px 0 0}
    .gh-prose :where(h2,h3,h4,h5,h6){margin:28px 0 0;font-size:19px;line-height:1.25;font-weight:600;letter-spacing:-.012em}
    .gh-prose :where(h4,h5,h6){font-size:16px}
    .gh-prose :where(ul,ol){padding-left:22px}
    .gh-prose li+li{margin-top:6px}
    .gh-prose li.task-list-item{list-style:none;display:flex;gap:10px;align-items:flex-start;margin-left:-22px}
    .gh-prose ul:has(>li.task-list-item){padding-left:22px}
    .gh-task{position:relative;flex:none;width:18px;height:18px;margin-top:3px;border-radius:5px;border:2px solid var(--strong);box-sizing:border-box;display:inline-block}
    .gh-task-on{background:var(--teal);border-color:var(--teal)}
    .gh-task-on::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid var(--on-teal);border-width:0 2px 2px 0;transform:rotate(45deg)}
    .gh-prose a{color:var(--text);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--strong)}
    .gh-prose a.anchor{display:none}
    .gh-prose code{font-family:var(--mono);font-size:.88em;padding:2px 6px;border-radius:6px;background:var(--raised)}
    .gh-prose pre{padding:14px 16px;border-radius:14px;background:var(--bg);border:1px solid var(--line);overflow-x:auto;font-family:var(--mono);font-size:13.5px;line-height:1.6}
    .gh-prose pre code,.gh-prose .highlight pre code{padding:0;background:none;font-size:inherit}
    .gh-prose blockquote{margin-left:0;padding:2px 0 2px 16px;border-left:3px solid var(--amber);color:var(--muted);font-size:15.5px;line-height:1.55}
    .gh-table{margin:12px 0 0;overflow-x:auto;border-radius:14px;border:1px solid var(--line)}
    .gh-prose table{margin:0;border-collapse:collapse;font-size:15px;width:100%}
    .gh-prose th{text-align:left;padding:10px 14px;font-weight:600;background:var(--surface)}
    .gh-prose td{padding:10px 14px;border-top:1px solid var(--line)}
    .gh-prose img{max-width:100%;height:auto;border-radius:14px;border:1px solid var(--line)}
    .gh-prose hr{border:0;border-top:1px solid var(--line);margin:24px 0}
  `,
})
export class Prose {
  readonly body = input.required<string>();
  protected readonly html = computed(() => prepareHtml(this.body()));
  readonly small = input(false);
}
