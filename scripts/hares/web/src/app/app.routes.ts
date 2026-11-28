import { Routes } from '@angular/router';
import { titles } from './words';

/** Where the old links of the run-based app go: a push notification sent last week still opens something. */
export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./pages/now').then((m) => m.NowPage), title: titles.now },
  { path: 's/:id', loadComponent: () => import('./pages/session').then((m) => m.SessionPage), title: titles.session },
  { path: 's/:id/terminal', loadComponent: () => import('./pages/terminal').then((m) => m.TerminalPage), title: titles.terminal },
  { path: 'start', loadComponent: () => import('./pages/start').then((m) => m.StartPage), title: titles.start },
  { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), title: titles.settings },
  { path: 'settings/notifications', loadComponent: () => import('./pages/notifications').then((m) => m.NotificationsPage), title: titles.notifications },
  { path: 'activity', loadComponent: () => import('./pages/activity').then((m) => m.ActivityPage), title: titles.activity },
  { path: 'runs/:id', redirectTo: 's/:id' },
  { path: 'runs', redirectTo: '' },
  { path: 'approvals/:id', loadComponent: () => import('./pages/approval-redirect').then((m) => m.ApprovalRedirect) },
  { path: 'approvals', redirectTo: '' },
  // The pull request, issue and CI screens live in their own routes file.
  { path: '', loadChildren: () => import('./pages/github/routes').then((m) => m.routes) },
  { path: '**', loadComponent: () => import('./pages/not-found').then((m) => m.NotFoundPage), title: titles.notFound },
];
