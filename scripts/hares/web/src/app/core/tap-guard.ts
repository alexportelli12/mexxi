import { Injectable, computed, effect, inject } from '@angular/core';
import { LiveService } from './live';

/** How long taps are ignored after the question cards move. */
export const SETTLE_MS = 500;

/**
 * Remembers when the cards last moved, so a tap aimed at one question can't land on the Send button of
 * another that slid under the finger. Pure, with the clock passed in.
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

/** The shape of the queue: a change in membership or order moves the cards. */
export const listShape = (ids: readonly string[]): string => ids.join('\n');

/**
 * One guard for every question card on screen. The queue changing marks a move here; the queue's own
 * previous and next buttons report theirs, since they swap the card under the finger.
 */
@Injectable({ providedIn: 'root' })
export class QueueTapGuard {
  private readonly guard = new MoveGuard();
  private readonly live = inject(LiveService);
  private readonly shape = computed(() => listShape(this.live.questions().map((entry) => entry.id)));

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
   * Whether a click may act. Keyboard activation (a click with `detail` 0) always may: the focused
   * button can't move away from a key press the way a card slides under a finger.
   */
  accepts(event: MouseEvent | null): boolean {
    if (!event || event.detail === 0) return true;
    return this.guard.accepts(performance.now());
  }
}
