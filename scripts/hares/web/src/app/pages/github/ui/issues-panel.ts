import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { now } from '../../../core/clock';
import { buildCommand } from '../../../words';
import { GithubApi } from '../github-api';
import { ISSUE_FILTERS, countIssues, filterIssues, groupByRepo, isBlocker, issueMeta, issuesSummary, type IssueFilter } from '../issue-logic';
import type { Issue } from '../models';
import { GhTabs } from './gh-tabs';

let panels = 0;

/**
 * Open issues. As a page it groups them by repo under filter chips; as the desktop column beside
 * the pull requests it is one flat list with the repo in each line.
 */
@Component({
  selector: 'hares-issues-panel',
  imports: [NgTemplateOutlet, RouterLink, GhTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [attr.aria-labelledby]="headingId">
      <div class="top">
        @if (mode() === 'page') {
          <h1 [id]="headingId" class="gh-h1">Issues</h1>
          <a class="gh-fab gh-m" routerLink="/start" aria-label="Start a session"><svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg></a>
        } @else {
          <h2 [id]="headingId" class="gh-h1">Issues</h2>
        }
      </div>

      @if (error()) {
        <div class="gh-notice" role="alert"><span>Couldn’t load issues. {{ error() }}</span><button type="button" class="gh-btn" (click)="load()">Try again</button></div>
      } @else if (issues() === null) {
        <p class="gh-empty" role="status">Loading issues</p>
      } @else {
        <p class="gh-lede">{{ summary() }}</p>
        <label class="search">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13.5 13.5L17 17"/></svg>
          <span class="gh-sr">Search issues</span>
          <input type="search" placeholder="Search every repo" [value]="query()" (input)="query.set(text($event))" />
        </label>
        @if (mode() === 'page') {
          <hares-gh-tabs class="chips" [items]="tabs()" [selected]="filter()" label="Show" panelId="issues-list" (picked)="filter.set($any($event))" />
        }
        @if (actionError()) { <p class="gh-err" role="alert">{{ actionError() }}</p> }
        <div id="issues-list" role="tabpanel" class="list" [class.page]="mode() === 'page'">
          @if (visible().length === 0) { <p class="gh-empty">No issues match.</p> }
          @if (mode() === 'page') {
            @for (group of groups(); track group.repo) {
              <section class="group">
                <div class="gh-sub"><h2 class="gh-h2">{{ group.repo }}</h2><span class="gh-faint">{{ group.issues.length }} open</span></div>
                @for (issue of group.issues; track issue.number) { <ng-container [ngTemplateOutlet]="item" [ngTemplateOutletContext]="{ issue }" /> }
              </section>
            }
          } @else {
            @for (issue of visible(); track issue.repo + '#' + issue.number) { <ng-container [ngTemplateOutlet]="item" [ngTemplateOutletContext]="{ issue }" /> }
          }
        </div>
      }
    </section>

    <ng-template #item let-issue="issue">
      <div class="item">
        <span class="text">
          <a class="name" [href]="issue.url" target="_blank" rel="noopener noreferrer">{{ issue.title }}</a>
          <span class="line" [class]="tone(issue)">@if (issue.session) { <span class="dot" aria-hidden="true"></span> }{{ meta(issue) }}</span>
        </span>
        @if (issue.session; as session) {
          <a class="gh-btn ghost watch" [routerLink]="['/s', session.id]">Open<span class="gh-sr"> the session for #{{ issue.number }}</span></a>
        } @else {
          <button type="button" class="gh-btn" [disabled]="busy() === issue.number + issue.repo" (click)="start(issue)">Start<span class="gh-sr"> /{{ build }} from #{{ issue.number }}</span></button>
        }
      </div>
    </ng-template>
  `,
})
export class IssuesPanel {
  private readonly api = inject(GithubApi);
  private readonly router = inject(Router);
  readonly mode = input<'page' | 'column'>('page');
  protected readonly build = buildCommand;
  protected readonly headingId = `issues-heading-${++panels}`;
  protected readonly issues = signal<Issue[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal<string | number | null>(null);
  protected readonly query = signal('');
  protected readonly filter = signal<IssueFilter>('all');

  protected readonly summary = computed(() => issuesSummary(this.issues() ?? []));
  protected readonly tabs = computed(() => ISSUE_FILTERS.map((f) => ({ key: f.key, label: f.label, count: countIssues(this.issues() ?? [], f.key) })));
  protected readonly visible = computed(() => filterIssues(this.issues() ?? [], this.mode() === 'page' ? this.filter() : 'all', this.query()));
  protected readonly groups = computed(() => groupByRepo(this.visible()));

  constructor() {
    void this.load();
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected meta(issue: Issue): string {
    return issueMeta(issue, now(), this.mode() === 'column');
  }

  protected tone(issue: Issue): string {
    return issue.session ? 'line live' : isBlocker(issue) ? 'line blocker' : 'line';
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      this.issues.set(await this.api.issues());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Try again.');
    }
  }

  /** Starts the build command on the issue in a new pane, then opens that session. */
  protected async start(issue: Issue): Promise<void> {
    this.actionError.set(null);
    this.busy.set(issue.number + issue.repo);
    try {
      const id = await this.api.startFromIssue(issue.repo, issue.number);
      await this.router.navigate(['/s', id]);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Could not start a session.');
    } finally {
      this.busy.set(null);
    }
  }
}
