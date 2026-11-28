import { Injectable, computed, effect, inject } from '@angular/core';
import { LiveService } from './live';

/** How long taps are ignored after approval cards move. */
export const SETTLE_MS = 500;

/**
 * Remembers when the approval cards last moved, so a tap aimed at one card can't land on the
 * Approve button of another that slid under the finger. Pure, with the clock passed in.
 */
export class MoveGuard {
  private movedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly settleMs = SETTLE_MS) {}

  moved(at: number): void {
    this.movedAt = at;
  }

  /** True once the cards have been still for the settle time. */
  accepts(at: number): boolean {
    return at - this.movedAt >= this.settleMs;
  }
}

/** The shape of the approvals list: a change in membership or order moves the cards. */
export const listShape = (ids: readonly string[]): string => ids.join('\n');

/**
 * One guard for every approval card on screen. The list changing marks a move here; each
 * card reports its own height changes, since a taller card above pushes the rest down.
 */
@Injectable({ providedIn: 'root' })
export class ApprovalTapGuard {
  private readonly guard = new MoveGuard();
  private readonly live = inject(LiveService);
  private readonly shape = computed(() => listShape(this.live.shownApprovals().map((entry) => entry.approval.id)));

  constructor() {
    effect(() => {
      this.shape();
      this.moved();
    });
  }

  moved(): void {
    this.guard.moved(performance.now());
  }

  /**
   * Whether a click may act. Keyboard activation (a click with `detail` 0) always may: the
   * focused button can't move away from a key press the way a card slides under a finger.
   */
  accepts(event: MouseEvent | null): boolean {
    if (!event || event.detail === 0) return true;
    return this.guard.accepts(performance.now());
  }
}
