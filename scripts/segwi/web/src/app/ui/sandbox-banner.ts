import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LiveService } from '../core/live';
import { Banner } from './banner';

/**
 * Says, where runs are started, when the server can't sandbox them: either nothing can start,
 * or runs start without the sandbox because the server's config allows it. Shows nothing otherwise.
 */
@Component({
  selector: 'segwi-sandbox-banner',
  imports: [Banner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (live.sandboxBlocked()) {
      <segwi-banner tone="error" data-testid="sandbox-blocked">
        <span class="flex flex-col gap-1">
          <span>Runs can't start until the sandbox works on the server, because every run needs it.</span>
          @for (problem of live.sandbox()!.problems; track $index) { <span class="text-sm text-muted">{{ problem }}</span> }
        </span>
      </segwi-banner>
    } @else if (live.sandboxSkipped()) {
      <segwi-banner data-testid="sandbox-skipped">
        <span class="flex flex-col gap-1">
          <span>Runs start without the sandbox: it can't start on the server, and the server is set to allow that.</span>
          @for (problem of live.sandbox()!.problems; track $index) { <span class="text-sm text-muted">{{ problem }}</span> }
        </span>
      </segwi-banner>
    }
  `,
})
export class SandboxBanner {
  protected readonly live = inject(LiveService);
}
