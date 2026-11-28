import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GhStyles } from './ui/gh-styles';

/** Loads the shared GitHub styles once for the pull request, issue and CI screens. */
@Component({
  selector: 'hares-github-layout',
  imports: [RouterOutlet, GhStyles],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<hares-gh-styles /><router-outlet />`,
})
export class GithubLayout {}
