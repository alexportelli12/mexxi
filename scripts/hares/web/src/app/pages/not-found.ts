import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { titles } from '../words';

@Component({
  imports: [RouterLink, Button, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="sr-only">{{ title }}</h1>
    <hares-empty-state [title]="title" hint="The link may be old, or the run may have been removed.">
      <a hares-button variant="primary" routerLink="/runs">Go to Runs</a>
    </hares-empty-state>
  `,
})
export class NotFoundPage {
  protected readonly title = titles.notFound;
}
