import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ApprovalContent as Content } from '../models';
import { VisibleText } from './visible-text';

const BLOCK = 'font-code max-h-80 overflow-auto rounded-card border bg-bg p-3 text-sm whitespace-pre-wrap break-words';

/**
 * What an Edit, Write or NotebookEdit call would put in the file, so the person approves the
 * change and not just a path. Shown whole in scrolling boxes, with hidden characters marked.
 */
@Component({
  selector: 'segwi-approval-content',
  imports: [VisibleText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  template: `
    @switch (content().kind) {
      @case ('write') {
        <h3 class="text-sm text-muted">New file content</h3>
        <pre [class]="blockClass + ' border-border'" tabindex="0" aria-label="New file content" data-testid="content-write"><segwi-visible-text [text]="write().text" /></pre>
      }
      @case ('edit') {
        @if (edit().replaceAll) { <p class="text-sm text-needs-you" data-testid="replace-all">Replaces every match in the file, not just one.</p> }
        <div class="flex flex-col gap-1">
          <h3 class="text-sm text-failed"><span aria-hidden="true">− </span>Removes</h3>
          <pre [class]="blockClass + ' border-failed'" tabindex="0" aria-label="Text the edit removes" data-testid="content-old"><segwi-visible-text [text]="edit().oldText" /></pre>
        </div>
        <div class="flex flex-col gap-1">
          <h3 class="text-sm text-done"><span aria-hidden="true">+ </span>Adds</h3>
          <pre [class]="blockClass + ' border-done'" tabindex="0" aria-label="Text the edit adds" data-testid="content-new"><segwi-visible-text [text]="edit().newText" /></pre>
        </div>
      }
      @case ('notebook') {
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="content-cell">
          <dt class="text-muted">Cell</dt><dd class="font-code break-all">{{ notebook().cellId ?? 'new cell' }}</dd>
          <dt class="text-muted">Change</dt><dd>{{ notebook().editMode ?? 'replace' }}</dd>
          <dt class="text-muted">Type</dt><dd>{{ notebook().cellType ?? 'unchanged' }}</dd>
        </dl>
        @if (notebook().editMode !== 'delete') {
          <h3 class="text-sm text-muted">New cell source</h3>
          <pre [class]="blockClass + ' border-border'" tabindex="0" aria-label="New cell source" data-testid="content-notebook"><segwi-visible-text [text]="notebook().text" /></pre>
        }
      }
    }
  `,
})
export class ApprovalContent {
  readonly content = input.required<Content>();
  protected readonly blockClass = BLOCK;
  protected write = () => this.content() as Extract<Content, { kind: 'write' }>;
  protected edit = () => this.content() as Extract<Content, { kind: 'edit' }>;
  protected notebook = () => this.content() as Extract<Content, { kind: 'notebook' }>;
}
