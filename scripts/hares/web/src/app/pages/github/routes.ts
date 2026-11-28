import type { Routes } from '@angular/router';

/**
 * The GitHub screens. Mount them with a pathless parent so the paths below stay as written:
 *   { path: '', loadChildren: () => import('./pages/github/routes').then((m) => m.GITHUB_ROUTES) }
 * /prs/:repo/:n takes ?view=review to open the review sheet.
 */
export const GITHUB_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./github-layout').then((m) => m.GithubLayout),
    children: [
      { path: 'prs', title: 'Pull requests', loadComponent: () => import('./prs-page').then((m) => m.PrsPage) },
      { path: 'prs/:repo/:n', title: 'Pull request', loadComponent: () => import('./pr-detail-page').then((m) => m.PrDetailPage) },
      { path: 'issues', title: 'Issues', loadComponent: () => import('./issues-page').then((m) => m.IssuesPage) },
      { path: 'ci', title: 'CI', loadComponent: () => import('./ci-page').then((m) => m.CiPage) },
    ],
  },
];

/** The same routes under the name the app's route table imports. */
export const routes = GITHUB_ROUTES;
