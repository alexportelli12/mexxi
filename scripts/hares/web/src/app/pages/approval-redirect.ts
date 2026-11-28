import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { LiveService } from '../core/live';

/**
 * An old push link to an approval. The approval is now a pending prompt on its session: open that session
 * with the prompt selected, or Now when it has been answered since.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'gap-4 px-5 pt-12 text-muted lg:px-0' },
  template: `<p role="status">Opening the session…</p>`,
})
export class ApprovalRedirect {
  readonly id = input.required<string>();
  private readonly live = inject(LiveService);
  private readonly router = inject(Router);

  constructor() {
    effect(() => {
      if (!this.live.loaded()) return;
      const pending = this.live.questions().find((entry) => entry.id === this.id());
      void this.router.navigate(pending ? ['/s', pending.sessionId] : ['/'], { queryParams: pending ? { q: pending.id } : {}, replaceUrl: true });
    });
  }
}
