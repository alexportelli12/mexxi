import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { GithubApi } from '../github-api';
import type { ReviewEvent } from '../models';
import { GhSheet } from './gh-sheet';
import { GhTabs, type TabItem } from './gh-tabs';

const KINDS: TabItem[] = [
  { key: 'COMMENT', label: 'Comment' },
  { key: 'REQUEST_CHANGES', label: 'Request changes' },
  { key: 'APPROVE', label: 'Approve' },
];
const CTA: Record<ReviewEvent, string> = { COMMENT: 'Post comment', REQUEST_CHANGES: 'Request changes', APPROVE: 'Approve' };

/** Comment, request changes or approve, and optionally start a session that works on what you wrote. */
@Component({
  selector: 'hares-gh-review-sheet',
  imports: [GhSheet, GhTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hares-gh-sheet [open]="open()" [heading]="'Review #' + number()" (closed)="dismissed.emit()">
      <hares-gh-tabs class="kinds" [items]="kinds" [selected]="kind()" label="Review type" mode="radio" [segmented]="true" (picked)="pick($event)" />
      <label class="gh-sr" for="review-body">Your review</label>
      <textarea id="review-body" class="gh-area" rows="4" [value]="body()" (input)="body.set(area($event))"
        [attr.placeholder]="kind() === 'APPROVE' ? 'Add a note (optional)' : 'What should change?'"></textarea>
      @if (kind() !== 'APPROVE') {
        <label class="check"><input type="checkbox" [checked]="startSession()" (change)="startSession.set(!startSession())">Start a session to address it</label>
      }
      @if (error()) { <p class="gh-err" role="alert">{{ error() }}</p> }
      <button type="button" class="gh-btn primary go" [disabled]="busy()" (click)="submit()">{{ cta() }}</button>
    </hares-gh-sheet>
  `,
  styles: `
    .kinds{display:block;margin-top:16px}
    textarea{display:block;width:100%;box-sizing:border-box;margin-top:12px}
    .check{margin-top:12px;display:flex;align-items:center;gap:12px;min-height:44px;font-size:15px}
    .check input{width:20px;height:20px;accent-color:var(--amber)}
    .go{width:100%;margin-top:16px;min-height:56px;border-radius:16px;font-size:16.5px}
  `,
})
export class ReviewSheet {
  private readonly api = inject(GithubApi);
  private readonly router = inject(Router);
  readonly open = input.required<boolean>();
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  /** The kind chosen each time the sheet opens. */
  readonly preset = input<ReviewEvent>('COMMENT');
  readonly dismissed = output<void>();
  /** The review went through and no session was started. */
  readonly posted = output<void>();
  protected readonly kinds = KINDS;
  protected readonly kind = signal<ReviewEvent>('COMMENT');
  protected readonly body = signal('');
  protected readonly startSession = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => this.pick(this.preset()));
    });
  }

  protected cta(): string {
    return CTA[this.kind()];
  }

  protected area(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  /** Asking for changes usually means you want them made, so that choice ticks the box; you can untick it. */
  protected pick(key: string): void {
    const kind = key as ReviewEvent;
    this.kind.set(kind);
    this.startSession.set(kind === 'REQUEST_CHANGES');
  }

  protected async submit(): Promise<void> {
    const kind = this.kind();
    const body = this.body().trim();
    if (kind !== 'APPROVE' && !body) {
      this.error.set('Write a few words first.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.api.review(this.repo(), this.number(), { event: kind, body, startSession: kind !== 'APPROVE' && this.startSession() });
      this.body.set('');
      if (result?.session?.id) await this.router.navigate(['/s', result.session.id]);
      else this.posted.emit();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'The review failed.');
    } finally {
      this.busy.set(false);
    }
  }
}
