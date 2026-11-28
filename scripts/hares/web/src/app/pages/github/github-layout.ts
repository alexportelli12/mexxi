import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** The shell the pull request, issue and CI screens share. Their styles are in github.css, in the global build, because the CSP refuses styles Angular injects. */
@Component({
  selector: 'hares-github-layout',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class GithubLayout {}
