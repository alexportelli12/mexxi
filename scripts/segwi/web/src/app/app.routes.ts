import { Routes } from '@angular/router';
import { titles } from './words';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'runs' },
  { path: 'runs', loadComponent: () => import('./pages/runs').then((m) => m.RunsPage), data: { title: titles.runs } },
  { path: 'runs/:id', loadComponent: () => import('./pages/run-detail').then((m) => m.RunDetailPage) },
  { path: 'approvals', loadComponent: () => import('./pages/approvals').then((m) => m.ApprovalsPage) },
  { path: 'approvals/:id', loadComponent: () => import('./pages/approvals').then((m) => m.ApprovalsPage) },
  { path: 'new', loadComponent: () => import('./pages/new-run').then((m) => m.NewRunPage) },
  { path: 'audit', loadComponent: () => import('./pages/audit').then((m) => m.AuditPage) },
  { path: '**', loadComponent: () => import('./pages/not-found').then((m) => m.NotFoundPage) },
];
