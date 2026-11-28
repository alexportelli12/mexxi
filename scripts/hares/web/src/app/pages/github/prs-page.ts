import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { now } from '../../core/clock';
import { relativeTime } from '../../core/time';
import { GithubApi } from './github-api';
import type { PrSummary } from './models';
import { actionsFor, countFor, effectiveFilter, filterPrs, fixAsk, statusOf, visibleFilters, type PrAction, type PrFilter } from './pr-logic';
import { CheckSquares } from './ui/check-squares';
import { GhTabs } from './ui/gh-tabs';
import { IssuesPanel } from './ui/issues-panel';
import { MergeSheet } from './ui/merge-sheet';
import { desktopSignal } from './ui/viewport';

/** Open pull requests across the configured repos: to review, ready, failing and bumps. */
@Component({
  selector: 'hares-prs-page',
  imports: [NgTemplateOutlet, RouterLink, CheckSquares, GhTabs, IssuesPanel, MergeSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gh-page">
      <div class="layout">
        <section class="prs" aria-labelledby="prs-title">
          <div class="head">
            <h1 id="prs-title" class="gh-h1">Pull requests</h1>
            <a class="gh-fab gh-m" routerLink="/start" aria-label="Start a session"><svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg></a>
            <hares-gh-tabs [items]="tabs()" [selected]="filter()" label="Show" panelId="prs-list" (picked)="chosen.set($any($event))" />
          </div>

          @if (error()) {
            <div class="gh-notice" role="alert"><span>Couldn’t load pull requests. {{ error() }}</span><button type="button" class="gh-btn" (click)="load()">Try again</button></div>
          }
          @if (actionError()) { <p class="gh-err" role="alert">{{ actionError() }}</p> }

          <div id="prs-list" role="tabpanel" class="prs-list">
            @if (prs() === null && !error()) {
              <p class="gh-empty" role="status">Loading pull requests</p>
            } @else if (prs() !== null && rows().length === 0) {
              <p class="gh-empty">Nothing in this group right now.</p>
            }
            @for (row of rows(); track row.pr.repo + '#' + row.pr.number) {
              <article class="row">
                <div class="info">
                  <div class="meta gh-faint">
                    @if (row.pr.bot) { <span class="bot" role="img" aria-label="Opened by a bot"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="12" height="9" rx="3"/><path d="M10 7V4.5M7.5 11h.01M12.5 11h.01"/></svg></span> }
                    <span>{{ row.pr.repo }} #{{ row.pr.number }}, {{ row.age }}</span>
                    <span class="gh-d stat"><span class="gh-add">+{{ row.pr.additions }}</span> <span class="gh-del">−{{ row.pr.deletions }}</span></span>
                  </div>
                  <h2 class="title"><a [routerLink]="['/prs', row.pr.repo, row.pr.number]">{{ row.pr.title }}</a></h2>
                </div>
                <div class="state">
                  <hares-checks [states]="row.pr.checks" />
                  <span [class]="'tone-' + row.status.tone">{{ row.status.text }}</span>
                  <span class="gh-m stat gh-faint"><span class="gh-add">+{{ row.pr.additions }}</span> <span class="gh-del">−{{ row.pr.deletions }}</span></span>
                </div>
                <div class="acts">
                  @if (row.actions.second; as second) { <span class="second gh-m"><ng-container [ngTemplateOutlet]="act" [ngTemplateOutletContext]="{ pr: row.pr, action: second, ghost: true }" /></span> }
                  <ng-container [ngTemplateOutlet]="act" [ngTemplateOutletContext]="{ pr: row.pr, action: row.actions.main, ghost: false }" />
                </div>
              </article>
            }
          </div>
        </section>

        @if (desktop()) {
          <hares-issues-panel mode="column" class="issues" />
        }
      </div>
    </div>

    <ng-template #act let-pr="pr" let-action="action" let-ghost="ghost">
      @if (action.kind === 'review') {
        <a class="gh-btn" [class.ghost]="ghost" [routerLink]="['/prs', pr.repo, pr.number]" [queryParams]="{ view: 'review' }">{{ action.label }}</a>
      } @else {
        <button type="button" class="gh-btn" [class.primary]="action.primary" [class.ghost]="ghost" [disabled]="busyKey() === key(pr)" (click)="run(pr, action)">{{ action.label }}</button>
      }
    </ng-template>

    <hares-gh-merge-sheet [pr]="merging()" (dismissed)="merging.set(null)" (merged)="merged()" />
  `,
})
export class PrsPage {
  private readonly api = inject(GithubApi);
  private readonly router = inject(Router);
  protected readonly desktop = desktopSignal();
  protected readonly prs = signal<PrSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly chosen = signal<PrFilter | null>(null);
  protected readonly merging = signal<PrSummary | null>(null);
  protected readonly busyKey = signal<string | null>(null);

  protected readonly filter = computed(() => effectiveFilter(this.chosen(), this.desktop()));
  protected readonly tabs = computed(() => visibleFilters(this.desktop()).map((f) => ({ key: f.key, label: f.label, count: countFor(this.prs() ?? [], f.key) })));
  protected readonly rows = computed(() => {
    const at = now();
    return filterPrs(this.prs() ?? [], this.filter()).map((pr) => ({
      pr, age: relativeTime(pr.createdAt, at), status: statusOf(pr), actions: actionsFor(pr),
    }));
  });

  constructor() {
    void this.load();
  }

  protected key(pr: PrSummary): string {
    return `${pr.repo}#${pr.number}`;
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      this.prs.set(await this.api.prs());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Try again.');
    }
  }

  protected async run(pr: PrSummary, action: PrAction): Promise<void> {
    this.actionError.set(null);
    if (action.kind === 'merge') {
      this.merging.set(pr);
      return;
    }
    this.busyKey.set(this.key(pr));
    try {
      if (action.kind === 'fix') {
        const id = await this.api.startFromPr(pr.repo, pr.number, fixAsk(pr));
        await this.router.navigate(['/s', id]);
      } else if (action.kind === 'rerun' && pr.ciRunId !== null) {
        await this.api.rerun(pr.repo, pr.ciRunId);
        await this.load();
      }
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      this.busyKey.set(null);
    }
  }

  protected merged(): void {
    this.merging.set(null);
    void this.load();
  }
}
