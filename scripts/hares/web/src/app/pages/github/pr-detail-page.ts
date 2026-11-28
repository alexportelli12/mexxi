import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, signal, untracked, effect } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { now } from '../../core/clock';
import { relativeTime } from '../../core/time';
import { GithubApi } from './github-api';
import type { PrDetail, ReviewEvent } from './models';
import { awaitingReply, fixAsk, openedLine, statusOf } from './pr-logic';
import { CheckSquares } from './ui/check-squares';
import { GhTabs } from './ui/gh-tabs';
import { MergeSheet } from './ui/merge-sheet';
import { Prose } from './ui/prose';
import { ReviewSheet } from './ui/review-sheet';
import { ThreadCard } from './ui/thread-card';

type TabKey = 'description' | 'comments' | 'files' | 'checks';

/** One pull request: description, conversation, checks, readiness and files, with merge and review. */
@Component({
  selector: 'hares-pr-detail-page',
  imports: [RouterLink, CheckSquares, GhTabs, MergeSheet, Prose, ReviewSheet, ThreadCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gh-page">
      @if (error()) {
        <div class="gh-notice" role="alert"><span>Couldn’t load this pull request. {{ error() }}</span><button type="button" class="gh-btn" (click)="reload()">Try again</button></div>
        <p><a class="back" routerLink="/prs"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>Pull requests</a></p>
      } @else if (pr(); as p) {
        <header class="topbar">
          <a class="back" routerLink="/prs"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l-6 6 6 6"/></svg>Pull requests</a>
          <a class="out" [href]="p.url" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        </header>

        <section class="intro" aria-labelledby="pr-title">
          <span class="gh-faint gh-m">{{ p.repo }} #{{ p.number }}</span>
          <span class="meta gh-d">{{ p.repo }} #{{ p.number }}, {{ opened().toLowerCase() }}</span>
          <h1 id="pr-title">{{ p.title }}</h1>
          <div class="status gh-m">
            <hares-checks [states]="states()" />
            <span [class]="'tone-' + status().tone">{{ status().text }}</span>
            <span class="gh-faint"><span class="gh-add">+{{ p.additions }}</span> <span class="gh-del">−{{ p.deletions }}</span></span>
          </div>
          <p class="opened gh-m">{{ opened() }}</p>
          @if (p.state !== 'open') { <p class="opened">This pull request is {{ p.state }}.</p> }
          @if (p.draft) { <p class="opened">It is a draft.</p> }
          @if (p.session; as session) {
            <a class="session" [routerLink]="['/s', session.id]"><span class="dot" [class]="session.state" aria-hidden="true"></span>Session: {{ session.title }}</a>
          }
        </section>

        <hares-gh-tabs class="gh-m seg-wrap" [items]="tabs()" [selected]="tab()" label="Pull request" [segmented]="true" panelPrefix="panel-" (picked)="tab.set($any($event))" />

        @if (actionError()) { <p class="gh-err" role="alert">{{ actionError() }}</p> }

        <div class="grid">
          <div class="main">
            <section id="panel-description" role="tabpanel" aria-label="Pull request description" class="panel" [class.off]="tab() !== 'description'">
              @if (p.bodyHtml.trim()) { <hares-prose [body]="p.bodyHtml" /> } @else { <p class="gh-empty">No description.</p> }
            </section>

            <section id="panel-comments" role="tabpanel" aria-labelledby="comments-title" class="panel" [class.off]="tab() !== 'comments'">
              <div class="gh-sub heading">
                <h2 id="comments-title" class="gh-h2">Comments</h2>
                @if (waiting() > 0) { <span class="gh-faint tone-warn">{{ waiting() }} waiting for a reply</span> }
              </div>
              <div class="threads">
                @for (thread of p.threads; track thread.id) { <hares-thread-card [repo]="p.repo" [number]="p.number" [thread]="thread" (replied)="reload()" /> }
                @if (p.threads.length === 0) { <p class="gh-empty none">No comments yet.</p> }
              </div>
              <form class="compose" (submit)="postComment($event)">
                <label class="gh-sr" for="new-comment">Write a comment</label>
                <input id="new-comment" class="gh-input" placeholder="Write a comment" [value]="draft()" (input)="draft.set(text($event))" />
                <button type="submit" class="gh-btn" [disabled]="commenting() || !draft().trim()">Comment</button>
              </form>
            </section>
          </div>

          <aside class="aside">
            <div class="actions gh-d">
              @if (canMerge()) { <button type="button" class="gh-btn primary merge" [disabled]="!p.readiness.ready" (click)="merging.set(true)">Squash and merge</button> }
              @if (!p.readiness.ready && canMerge()) { <p class="gh-faint">{{ notReady() }}</p> }
              <div class="pair">
                <button type="button" class="gh-btn" (click)="openReview('REQUEST_CHANGES')">Request changes</button>
                <button type="button" class="gh-btn" [disabled]="starting()" (click)="fix()">Fix in a session</button>
              </div>
              @if (p.previewUrl) { <a class="out" [href]="p.previewUrl" target="_blank" rel="noopener noreferrer">Open the preview deploy</a> }
            </div>

            <section id="panel-checks" role="tabpanel" aria-labelledby="checks-title" class="panel" [class.off]="tab() !== 'checks'">
              <div class="gh-sub"><h2 id="checks-title" class="side-h">Checks</h2><span [class]="'gh-faint tone-' + checkTone()">{{ checkSummary() }}</span></div>
              @for (check of p.checkRuns; track check.name) {
                @if (check.url) {
                  <a class="line link" [href]="check.url" target="_blank" rel="noopener noreferrer"><span class="gh-sq" [class]="check.state" aria-hidden="true"></span><span class="grow">{{ check.name }}<span class="gh-sr">, {{ check.state === 'pass' ? 'passed' : check.state === 'fail' ? 'failed' : 'running' }}</span></span><span class="gh-faint">{{ check.duration }}</span></a>
                } @else {
                  <div class="line"><span class="gh-sq" [class]="check.state" aria-hidden="true"></span><span class="grow">{{ check.name }}<span class="gh-sr">, {{ check.state === 'pass' ? 'passed' : check.state === 'fail' ? 'failed' : 'running' }}</span></span><span class="gh-faint">{{ check.duration }}</span></div>
                }
              }
              @if (p.checkRuns.length === 0) { <p class="gh-empty none">No checks ran.</p> }

              <div class="gh-sub ready"><h2 class="side-h">Merge readiness</h2><span [class]="'gh-faint ' + (p.readiness.ready ? 'tone-good' : 'tone-warn')">{{ p.readiness.ready ? 'Ready' : 'Not ready' }}</span></div>
              @for (rule of p.readiness.checks; track rule.name) {
                <div class="line"><span class="gh-sq" [class.fail]="!rule.pass" aria-hidden="true"></span><span class="grow">{{ rule.name }}<span class="gh-sr">, {{ rule.pass ? 'met' : 'not met' }}</span><span class="detail gh-faint">{{ rule.detail }}</span></span></div>
              }
            </section>

            <section id="panel-files" role="tabpanel" aria-labelledby="files-title" class="panel" [class.off]="tab() !== 'files'">
              <div class="gh-sub"><h2 id="files-title" class="side-h">Files</h2><span class="gh-faint"><span class="gh-add">+{{ p.additions }}</span> <span class="gh-del">−{{ p.deletions }}</span> in {{ p.changedFiles }} {{ p.changedFiles === 1 ? 'file' : 'files' }}</span></div>
              @for (file of p.files; track file.path) {
                <a class="line link" [href]="p.url + '/files'" target="_blank" rel="noopener noreferrer"><code class="gh-code file-path">{{ file.path }}</code><span class="gh-faint stat"><span class="gh-add">+{{ file.additions }}</span> <span class="gh-del">−{{ file.deletions }}</span></span></a>
              }
              @if (p.changedFiles > p.files.length) { <a class="out more" [href]="p.url + '/files'" target="_blank" rel="noopener noreferrer">See all {{ p.changedFiles }} files on GitHub</a> }
            </section>
          </aside>
        </div>

        <div class="barfix gh-m">
          @if (canMerge() && !p.readiness.ready) { <p class="gh-faint">{{ notReady() }}</p> }
          <div class="row">
            <button type="button" class="gh-btn bar-big" (click)="openReview('COMMENT')">Review</button>
            @if (fixable()) { <button type="button" class="gh-btn bar-big" [disabled]="starting()" (click)="fix()">Fix in a session</button> }
            @if (canMerge()) { <button type="button" class="gh-btn primary bar-big grow2" [disabled]="!p.readiness.ready" (click)="merging.set(true)">Merge</button> }
          </div>
        </div>

        <hares-gh-merge-sheet [pr]="merging() ? p : null" (dismissed)="merging.set(false)" (merged)="merged()" />
        <hares-gh-review-sheet [open]="reviewOpen()" [repo]="p.repo" [number]="p.number" [preset]="reviewKind()" (dismissed)="closeReview()" (posted)="reviewPosted()" />
      } @else {
        <p class="gh-empty" role="status">Loading pull request</p>
      }
    </div>
  `,
})
export class PrDetailPage {
  private readonly api = inject(GithubApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Route parameters and ?view=review, bound by the router. */
  readonly repo = input.required<string>();
  readonly n = input.required<string>();
  readonly view = input<string | undefined>(undefined);

  protected readonly pr = signal<PrDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly tab = linkedSignal<TabKey>(() => (this.view() === 'review' ? 'comments' : 'description'));
  protected readonly reviewOpen = linkedSignal(() => this.view() === 'review');
  protected readonly reviewKind = signal<ReviewEvent>('COMMENT');
  protected readonly merging = signal(false);
  protected readonly starting = signal(false);
  protected readonly draft = signal('');
  protected readonly commenting = signal(false);

  protected readonly states = computed(() => this.pr()?.checkRuns.map((c) => c.state) ?? []);
  protected readonly status = computed(() => {
    const p = this.pr();
    return statusOf({ checks: this.states(), failureNote: p?.failureNote ?? null, unresolvedThreads: p?.unresolvedThreads ?? 0, bump: p?.bump ?? null, docsOnly: p?.docsOnly ?? false });
  });
  protected readonly opened = computed(() => {
    const p = this.pr();
    return p ? openedLine(p, relativeTime(p.createdAt, now())) : '';
  });
  protected readonly waiting = computed(() => awaitingReply(this.pr()?.threads ?? []));
  protected readonly tabs = computed(() => {
    const p = this.pr();
    return [
      { key: 'description', label: 'Description' },
      { key: 'comments', label: 'Comments', count: p?.threads.length ?? 0 },
      { key: 'files', label: 'Files', count: p?.changedFiles ?? 0 },
      { key: 'checks', label: 'Checks', count: p?.checkRuns.length ?? 0 },
    ];
  });
  protected readonly canMerge = computed(() => {
    const p = this.pr();
    return !!p && p.state === 'open' && !p.draft;
  });
  protected readonly fixable = computed(() => {
    const p = this.pr();
    return !!p && p.state === 'open' && fixAsk({ checks: this.states(), unresolvedThreads: p.unresolvedThreads }) !== undefined;
  });
  protected readonly notReady = computed(() => {
    const rule = this.pr()?.readiness.checks.find((c) => !c.pass);
    return rule ? `Not ready to merge: ${rule.detail}` : 'Not ready to merge.';
  });
  protected readonly checkTone = computed(() => {
    const states = this.states();
    return states.includes('fail') ? 'bad' : states.includes('pending') ? 'neutral' : 'good';
  });
  protected readonly checkSummary = computed(() => {
    const states = this.states();
    const failed = states.filter((s) => s === 'fail').length;
    const pending = states.filter((s) => s === 'pending').length;
    if (failed) return `${failed} failed`;
    if (pending) return `${pending} running`;
    return `${states.length} passed`;
  });

  private loads = 0;

  constructor() {
    effect(() => {
      const repo = this.repo();
      const n = Number(this.n());
      untracked(() => void this.fetch(repo, n));
    });
  }

  protected reload(): void {
    void this.fetch(this.repo(), Number(this.n()));
  }

  private async fetch(repo: string, n: number): Promise<void> {
    const load = ++this.loads;
    this.error.set(null);
    try {
      const pr = await this.api.pr(repo, n);
      if (load === this.loads) this.pr.set(pr);
    } catch (error) {
      if (load === this.loads) this.error.set(error instanceof Error ? error.message : 'Try again.');
    }
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected openReview(kind: ReviewEvent): void {
    this.reviewKind.set(kind);
    this.reviewOpen.set(true);
  }

  protected closeReview(): void {
    this.reviewOpen.set(false);
    if (this.view() !== undefined) void this.router.navigate([], { relativeTo: this.route, queryParams: { view: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected reviewPosted(): void {
    this.closeReview();
    this.reload();
  }

  protected merged(): void {
    this.merging.set(false);
    this.reload();
  }

  protected async fix(): Promise<void> {
    const p = this.pr();
    if (!p) return;
    this.actionError.set(null);
    this.starting.set(true);
    try {
      const id = await this.api.startFromPr(p.repo, p.number, fixAsk({ checks: this.states(), unresolvedThreads: p.unresolvedThreads }));
      await this.router.navigate(['/s', id]);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Could not start a session.');
    } finally {
      this.starting.set(false);
    }
  }

  protected async postComment(event: Event): Promise<void> {
    event.preventDefault();
    const p = this.pr();
    const body = this.draft().trim();
    if (!p || !body) return;
    this.commenting.set(true);
    this.actionError.set(null);
    try {
      await this.api.comment(p.repo, p.number, body);
      this.draft.set('');
      this.reload();
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Could not post the comment.');
    } finally {
      this.commenting.set(false);
    }
  }
}
