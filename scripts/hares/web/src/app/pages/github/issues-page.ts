import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IssuesPanel } from './ui/issues-panel';

/** Open issues across the configured repos, with "Start" to begin the build command on one. */
@Component({
  selector: 'hares-issues-page',
  imports: [IssuesPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="gh-page"><hares-issues-panel mode="page" /></div>`,
})
export class IssuesPage {}
