import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { GithubApi, GithubApiError } from '../github-api';
import type { PrSummary } from '../models';
import { mergeNote, shortSha } from '../pr-logic';
import { GhSheet } from './gh-sheet';

/**
 * The confirmation before a merge. It shows the head commit the person is looking at and sends it
 * with the request: if the branch moved since, the server refuses and nothing merges.
 */
@Component({
  selector: 'hares-gh-merge-sheet',
  imports: [GhSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hares-gh-sheet [open]="pr() !== null" [heading]="heading()" (closed)="dismissed.emit()">
      @if (pr(); as p) {
        <p class="note">{{ note().before }}<code class="gh-code">{{ note().branch }}</code>{{ note().after }}</p>
        <p class="sha">Head commit <code class="gh-code" data-testid="head-sha">{{ short() }}</code>. If someone pushes before you confirm, nothing is merged.</p>
        @if (error()) { <p class="gh-err" role="alert">{{ error() }}</p> }
        <button type="button" class="gh-btn primary big" [disabled]="busy()" (click)="confirm(p)">{{ busy() ? 'Merging' : 'Squash and merge' }}</button>
        <button type="button" class="gh-btn ghost big" (click)="dismissed.emit()">Not yet</button>
      }
    </hares-gh-sheet>
  `,
})
export class MergeSheet {
  private readonly api = inject(GithubApi);
  readonly pr = input.required<PrSummary | null>();
  readonly dismissed = output<void>();
  readonly merged = output<void>();
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly heading = computed(() => {
    const p = this.pr();
    return p ? `Merge #${p.number} into ${p.baseRef}?` : 'Merge';
  });
  protected readonly note = computed(() => mergeNote(this.pr() ?? { commits: 0, headRef: '', repo: '', deployWorkflow: null }));
  protected readonly short = computed(() => shortSha(this.pr()?.headSha ?? ''));

  protected async confirm(pr: PrSummary): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.merge(pr.repo, pr.number, pr.headSha);
      this.merged.emit();
    } catch (error) {
      this.error.set(
        error instanceof GithubApiError && error.status === 409
          ? 'The branch changed after you opened this. Close the sheet and look at the new commit first.'
          : error instanceof Error ? error.message : 'The merge failed.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
