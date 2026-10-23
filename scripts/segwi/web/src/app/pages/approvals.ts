import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { LiveService } from '../core/live';
import { ApprovalCard } from '../ui/approval-card';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Skeleton } from '../ui/skeleton';
import { titles } from '../words';

@Component({
  imports: [ApprovalCard, Banner, Button, EmptyState, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold">{{ title }}</h1>
    @if (!live.loaded()) {
      <segwi-skeleton height="14rem" />
    } @else if (live.loadError() && !live.shownApprovals().length) {
      <segwi-banner tone="error">
        Couldn't load approvals. {{ live.loadError() }}
        <button bannerAction segwi-button type="button" (click)="live.refresh()">Retry</button>
      </segwi-banner>
    } @else if (!live.shownApprovals().length) {
      <segwi-empty-state title="Nothing needs your OK" hint="When a run wants to do something it isn't pre-approved for, it waits here." />
    } @else {
      @for (entry of live.shownApprovals(); track entry.approval.id; let first = $first) {
        <segwi-approval-card [approval]="entry.approval" [result]="entry.result" [focusDeny]="entry.approval.id === targetId ? true : (!targetId && first)" />
      }
    }
  `,
})
export class ApprovalsPage {
  protected readonly live = inject(LiveService);
  protected readonly title = titles.approvals;
  /** The approval a deep link points at; its card scrolls into view and takes focus. */
  protected readonly targetId = inject(ActivatedRoute).snapshot.paramMap.get('id');
}
