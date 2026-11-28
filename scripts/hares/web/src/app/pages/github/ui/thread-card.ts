import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { RelativeTime } from '../../../core/relative-time';
import { GithubApi } from '../github-api';
import type { Thread } from '../models';
import { Prose } from './prose';

/** One conversation: the line it is about, who said what, and a box to reply. */
@Component({
  selector: 'hares-thread-card',
  imports: [Prose, RelativeTime],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="card">
      @if (thread().path) {
        <code class="gh-code path">{{ thread().path }}@if (thread().line) {, line {{ thread().line }}}</code>
      }
      @for (comment of thread().comments; track comment.id; let first = $first) {
        <div class="comment" [class.reply]="!first">
          <span class="gh-faint"><b>{{ comment.mine ? 'You' : comment.author }}</b>, <hares-time [iso]="comment.createdAt" /></span>
          <hares-prose [body]="comment.bodyHtml" [small]="true" />
        </div>
      }
      @if (thread().resolved) {
        <span class="state tone-good">Resolved</span>
      } @else {
        @if (waiting()) { <span class="state tone-warn">No reply yet</span> }
        @if (!replying()) {
          <button type="button" class="gh-btn ghost open" (click)="replying.set(true)">Reply<span class="gh-sr"> to this thread</span></button>
        } @else {
          <label class="gh-sr" [for]="'reply-' + thread().id">Your reply</label>
          <textarea class="gh-area" [id]="'reply-' + thread().id" rows="3" [value]="draft()" (input)="draft.set(text($event))"></textarea>
          @if (error()) { <p class="gh-err" role="alert">{{ error() }}</p> }
          <div class="row">
            <button type="button" class="gh-btn ghost" (click)="cancel()">Cancel</button>
            <button type="button" class="gh-btn" [disabled]="busy() || !draft().trim()" (click)="send()">Send reply</button>
          </div>
        }
      }
    </article>
  `,
})
export class ThreadCard {
  private readonly api = inject(GithubApi);
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  readonly thread = input.required<Thread>();
  /** A reply was posted: the page reloads the pull request. */
  readonly replied = output<void>();
  protected readonly replying = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected waiting(): boolean {
    return this.thread().comments.at(-1)?.mine === true;
  }

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected cancel(): void {
    this.replying.set(false);
    this.error.set(null);
  }

  protected async send(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.reply(this.repo(), this.number(), this.thread().id, this.draft().trim());
      this.draft.set('');
      this.replying.set(false);
      this.replied.emit();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'The reply failed.');
    } finally {
      this.busy.set(false);
    }
  }
}
