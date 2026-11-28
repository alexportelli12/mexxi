import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, failureMessage } from '../core/api';
import { loadDraft, saveDraft, type StartMode } from '../core/draft';
import type { RepoInfo, StartBody, StartRequest } from '../models';
import { GithubApi } from './github/github-api';
import type { Issue, PrSummary } from './github/models';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { buildCommand, startCommands, workflowName } from '../words';

const TABS: { id: StartMode; label: string }[] = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'command', label: workflowName },
  { id: 'issue', label: 'Issue' },
  { id: 'pr', label: 'PR' },
];

const PREVIEW_CHARS = 56;

/**
 * Start a session, four ways: a plain prompt in a repo, one of the workflow's commands with arguments, a build
 * from an issue, or a fix from a pull request. Each opens a new herdr pane; nothing is started in an existing one.
 * What it will run is shown in full before the button, as the command line it becomes.
 */
@Component({
  imports: [Banner, Button, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1' },
  template: `
    <header class="flex items-center justify-between pt-3 pr-3 pl-5">
      <h1 class="text-[28px] leading-[1.1] font-semibold tracking-[-0.024em]">Start a session</h1>
      <a routerLink="/" class="inline-flex min-h-11 items-center px-2 text-base text-muted no-underline">Cancel</a>
    </header>

    <div class="flex flex-1 flex-col gap-8 px-5 pt-6 pb-8">
      <div role="tablist" aria-label="How to start" class="grid grid-cols-4 gap-0.5 rounded-2xl bg-surface p-1">
        @for (tab of tabs; track tab.id) {
          <button type="button" role="tab" class="min-h-11 cursor-pointer rounded-xl border-0 text-[15px]" [attr.aria-selected]="mode() === tab.id"
            [class]="mode() === tab.id ? 'bg-raised font-semibold text-text shadow-[0_1px_0_var(--line)]' : 'bg-transparent font-medium text-muted'" (click)="setMode(tab.id)">{{ tab.label }}</button>
        }
      </div>

      <section class="flex flex-col gap-3">
        <span id="repo-label" class="text-[14.5px] leading-[1.3] font-medium text-muted">Repo</span>
        <div role="radiogroup" aria-labelledby="repo-label" class="flex flex-wrap gap-2">
          @for (repo of repos(); track repo.name) {
            <button type="button" role="radio" class="inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-[15px] font-medium" [attr.aria-checked]="repo.name === chosenRepo()"
              [class]="repo.name === chosenRepo() ? 'border-amber bg-amber text-on-amber' : 'border-strong bg-transparent text-text'" (click)="chooseRepo(repo.name)">{{ repo.name }}</button>
          }
        </div>
        @if (reposError()) { <hares-banner kind="error">{{ reposError() }}</hares-banner> }
      </section>

      @switch (mode()) {
        @case ('prompt') {
          <section class="flex flex-col gap-3">
            <label for="prompt" class="text-[14.5px] leading-[1.3] font-medium text-muted">What should Claude do?</label>
            <textarea id="prompt" rows="5" class="resize-none rounded-[20px] border border-strong bg-surface p-4 text-[16.5px] leading-[1.5] text-text" [value]="prompt()" (input)="prompt.set($any($event.target).value)"></textarea>
          </section>
        }
        @case ('command') {
          <section class="flex flex-col gap-3">
            <span id="command-label" class="text-[14.5px] leading-[1.3] font-medium text-muted">Command</span>
            <div role="radiogroup" aria-labelledby="command-label" class="flex flex-col rounded-[20px] bg-surface p-1">
              @for (command of commands; track command.name) {
                <button type="button" role="radio" class="flex min-h-15.5 cursor-pointer items-center justify-between gap-3 rounded-2xl border-0 pr-3.5 pl-4 text-left text-text" [attr.aria-checked]="command.name === commandName()"
                  [class]="command.name === commandName() ? 'bg-raised' : 'bg-transparent'" (click)="commandName.set(command.name)">
                  <span class="flex flex-col gap-0.75"><span class="text-base leading-[1.25] font-semibold">/{{ command.name }}</span><span class="text-sm leading-[1.3] text-muted">{{ command.what }}</span></span>
                  <span aria-hidden="true" class="box-border inline-flex size-5.5 flex-none items-center justify-center rounded-full border-2 text-[13px] font-bold text-on-amber" [class]="command.name === commandName() ? 'border-amber bg-amber' : 'border-strong bg-transparent'">{{ command.name === commandName() ? '✓' : '' }}</span>
                </button>
              }
            </div>
          </section>
          <section class="flex flex-col gap-3">
            <label for="args" class="text-[14.5px] leading-[1.3] font-medium text-muted">For</label>
            <input id="args" class="min-h-13 rounded-2xl border border-strong bg-surface px-4 text-base text-text" autocomplete="off" placeholder="An issue number or a few words" [value]="args()" (input)="args.set($any($event.target).value)" />
          </section>
        }
        @case ('issue') {
          <section class="flex flex-col">
            <span id="issue-label" class="pb-1 text-[14.5px] leading-[1.3] font-medium text-muted">Issue</span>
            <div role="radiogroup" aria-labelledby="issue-label">
              @for (issue of issues(); track issue.number) {
                <button type="button" role="radio" class="flex w-full cursor-pointer items-center gap-3.5 border-0 border-b border-line bg-transparent py-3.5 text-left text-text" [attr.aria-checked]="issue.number === issueNumber()" (click)="issueNumber.set(issue.number)">
                  <span class="flex flex-1 flex-col gap-1"><span class="text-base leading-[1.3] font-medium">{{ issue.title }}</span><span class="text-[13.5px]" [class]="issueUrgent(issue) ? 'text-red' : 'text-faint'">#{{ issue.number }}{{ issue.labels.length ? ', ' + issue.labels.join(', ') : '' }}</span></span>
                  <span aria-hidden="true" class="box-border inline-flex size-5.5 flex-none items-center justify-center rounded-full border-2 text-[13px] font-bold text-on-amber" [class]="issue.number === issueNumber() ? 'border-amber bg-amber' : 'border-strong bg-transparent'">{{ issue.number === issueNumber() ? '✓' : '' }}</span>
                </button>
              }
              @if (!issues().length) { <p class="py-3 text-[14.5px] text-muted">{{ listNote() }}</p> }
            </div>
          </section>
        }
        @case ('pr') {
          <section class="flex flex-col">
            <span id="pr-label" class="pb-1 text-[14.5px] leading-[1.3] font-medium text-muted">Pull request</span>
            <div role="radiogroup" aria-labelledby="pr-label">
              @for (pr of prs(); track pr.number) {
                <button type="button" role="radio" class="flex w-full cursor-pointer items-center gap-3.5 border-0 border-b border-line bg-transparent py-3.5 text-left text-text" [attr.aria-checked]="pr.number === prNumber()" (click)="pickPr(pr)">
                  <span class="flex flex-1 flex-col gap-1"><span class="text-base leading-[1.3] font-medium">{{ pr.title }}</span>
                    <span class="text-[13.5px] text-faint">#{{ pr.number }}@if (pr.unresolvedThreads) {, {{ pr.unresolvedThreads }} unresolved {{ pr.unresolvedThreads === 1 ? 'thread' : 'threads' }}}@if (pr.failureNote) {, <span class="text-red">{{ pr.failureNote }}</span>}</span></span>
                  <span aria-hidden="true" class="box-border inline-flex size-5.5 flex-none items-center justify-center rounded-full border-2 text-[13px] font-bold text-on-amber" [class]="pr.number === prNumber() ? 'border-amber bg-amber' : 'border-strong bg-transparent'">{{ pr.number === prNumber() ? '✓' : '' }}</span>
                </button>
              }
              @if (!prs().length) { <p class="py-3 text-[14.5px] text-muted">{{ listNote() }}</p> }
            </div>
          </section>
          @if (selectedPr(); as pr) {
            <section class="flex flex-col gap-3">
              <span id="task-label" class="text-[14.5px] leading-[1.3] font-medium text-muted">Ask the session to</span>
              <div role="radiogroup" aria-labelledby="task-label" class="flex flex-col gap-1">
                @for (option of prTasks(); track option.id) {
                  <button type="button" role="radio" class="min-h-14 cursor-pointer rounded-2xl border px-4 text-left text-base font-medium text-text" [attr.aria-checked]="option.id === prTask()"
                    [class]="option.id === prTask() ? 'border-amber bg-glow' : 'border-transparent bg-raised'" (click)="prTask.set(option.id)">{{ option.label }}</button>
                }
              </div>
            </section>
          }
        }
      }

      @if (failure(); as message) { <hares-banner kind="error">{{ message }}</hares-banner> }
    </div>

    <div class="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-line bg-bg px-5 pt-4 pb-[calc(1.75rem+env(safe-area-inset-bottom))]">
      <div class="flex flex-col gap-1">
        <span class="text-[13.5px] text-faint">Opens a new herdr pane in {{ chosenRepo() || 'a repo' }}</span>
        <code class="truncate font-mono text-[13.5px] text-text">{{ preview() }}</code>
      </div>
      <button hares-button variant="primary" size="lg" class="w-full text-[17px]" type="button" [disabled]="!request() || busy()" (click)="start()">Start session</button>
    </div>
  `,
})
export class StartPage {
  private readonly api = inject(ApiService);
  private readonly github = inject(GithubApi);
  private readonly router = inject(Router);
  /** From a link: Now and the pull request screens open Start with these filled in. */
  readonly repo = input<string>();
  readonly command = input<string>();
  readonly issue = input<string>();
  readonly pr = input<string>();

  protected readonly tabs = TABS;
  protected readonly commands = startCommands;
  private readonly saved = loadDraft();
  protected readonly mode = signal<StartMode>(this.saved.mode);
  protected readonly repos = signal<RepoInfo[]>([]);
  protected readonly reposError = signal<string | null>(null);
  protected readonly chosenRepo = signal(this.saved.repo);
  protected readonly prompt = signal('');
  protected readonly commandName = signal(startCommands[0].name);
  protected readonly args = signal('');
  protected readonly issues = signal<Issue[]>([]);
  protected readonly issueNumber = signal<number | null>(null);
  protected readonly prs = signal<PrSummary[]>([]);
  protected readonly prNumber = signal<number | null>(null);
  protected readonly prTask = signal<'review-comments' | 'failing-check'>('review-comments');
  protected readonly listNote = signal('Nothing to show.');
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly selectedPr = computed(() => this.prs().find((entry) => entry.number === this.prNumber()) ?? null);
  protected readonly prTasks = computed(() => {
    const pr = this.selectedPr();
    const options: { id: 'review-comments' | 'failing-check'; label: string }[] = [{ id: 'review-comments', label: 'Address the review comments' }];
    if (pr?.groups.includes('failing')) options.push({ id: 'failing-check', label: 'Fix the failing checks' });
    return options;
  });

  /** What will be sent, or null while something is missing. */
  protected readonly request = computed<StartBody | null>(() => {
    const repo = this.chosenRepo();
    if (!repo) return null;
    switch (this.mode()) {
      case 'prompt': return this.prompt().trim() ? { repo, kind: 'prompt', prompt: this.prompt().trim() } : null;
      case 'command': return { repo, kind: 'command', command: this.commandName(), args: this.args().trim() };
      case 'issue': return this.issueNumber() === null ? null : { repo, kind: 'issue', issue: this.issueNumber()! };
      case 'pr': return this.prNumber() === null ? null : { repo, kind: 'pr', pr: this.prNumber()!, ask: this.prTasks().some((option) => option.id === this.prTask()) ? this.prTask() : 'review-comments' };
    }
  });

  /** The command line the request becomes, so nothing is a surprise. */
  protected readonly preview = computed(() => {
    const request = this.request();
    switch (this.mode()) {
      case 'prompt': {
        const text = this.prompt().trim();
        return `claude "${text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text || '…'}"`;
      }
      case 'command': return `claude "/${this.commandName()}${this.args().trim() ? ' ' + this.args().trim() : ''}"`;
      case 'issue': return `claude "/${buildCommand} ${this.issueNumber() === null ? '#…' : '#' + this.issueNumber()}"`;
      case 'pr': {
        if (request?.kind !== 'pr') return 'claude "…"';
        return request.ask === 'failing-check' ? `claude "Fix the failing checks on #${request.pr}"` : `claude "Address the review comments on #${request.pr}"`;
      }
    }
  });

  constructor() {
    this.api.repos().then(
      (repos) => {
        this.repos.set(repos);
        const wanted = this.repo() ?? this.chosenRepo();
        this.chosenRepo.set(repos.some((entry) => entry.name === wanted) ? wanted : (repos[0]?.name ?? ''));
      },
      (error) => this.reposError.set(failureMessage(error)),
    );
    effect(() => {
      const command = this.command();
      const issue = this.issue();
      const pr = this.pr();
      untracked(() => {
        if (command) {
          this.mode.set('command');
          if (startCommands.some((entry) => entry.name === command)) this.commandName.set(command);
        } else if (issue) {
          this.mode.set('issue');
          this.issueNumber.set(Number(issue) || null);
        } else if (pr) {
          this.mode.set('pr');
          this.prNumber.set(Number(pr) || null);
        }
      });
    });
    // The lists follow the repo and the way of starting; they are only read when they are shown.
    effect(() => {
      const repo = this.chosenRepo();
      const mode = this.mode();
      if (!repo) return;
      untracked(() => {
        if (mode === 'issue') this.load(() => this.github.issues().then((all) => all.filter((issue) => issue.repo === repo)), (list) => this.issues.set(list), () => this.issueNumber.set(null), this.issueNumber());
        if (mode === 'pr') this.load(() => this.github.prs().then((all) => all.filter((pr) => pr.repo === repo)), (list) => this.prs.set(list), () => this.prNumber.set(null), this.prNumber());
      });
    });
  }

  private load<T extends { number: number }>(read: () => Promise<T[]>, set: (list: T[]) => void, clear: () => void, keep: number | null): void {
    read().then(
      (list) => {
        set(list);
        if (keep === null || !list.some((entry) => entry.number === keep)) clear();
        this.listNote.set(list.length ? '' : 'Nothing open in this repo.');
      },
      () => {
        set([]);
        clear();
        this.listNote.set('This list isn’t available. GitHub may not be set up for this repo yet.');
      },
    );
  }

  protected setMode(mode: StartMode): void {
    this.mode.set(mode);
    this.failure.set(null);
  }

  protected chooseRepo(name: string): void {
    this.chosenRepo.set(name);
    this.issueNumber.set(null);
    this.prNumber.set(null);
  }

  protected pickPr(pr: PrSummary): void {
    this.prNumber.set(pr.number);
    this.prTask.set(pr.unresolvedThreads || !pr.groups.includes('failing') ? 'review-comments' : 'failing-check');
  }

  protected issueUrgent = (issue: Issue): boolean => issue.labels.some((label) => /blocker|urgent/i.test(label));

  protected async start(): Promise<void> {
    const request = this.request();
    if (!request || this.busy()) return;
    this.busy.set(true);
    this.failure.set(null);
    try {
      saveDraft({ repo: request.repo, mode: this.mode() });
      const started = await this.api.start({ ...request, clientId: crypto.randomUUID() } as StartRequest);
      await this.router.navigate(['/s', started.session.id]);
    } catch (error) {
      this.failure.set(failureMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
