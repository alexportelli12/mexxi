import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { clearTask, loadDraft, saveDraft } from '../core/draft';
import { LiveService } from '../core/live';
import type { Repo } from '../models';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { Action, actionLabels, actionNames, titles, whatHappens } from '../words';

const ALL_ACTIONS: Action[] = ['build', 'ready', 'ask'];

/** Why a repository can't take a run right now, or null. */
export function repoProblem(repo: Repo): string | null {
  if (!repo.clean) return 'Has uncommitted changes';
  if (!repo.onDefault) return `Not on ${repo.defaultBranch}`;
  return null;
}

@Component({
  imports: [Banner, Button, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="text-2xl font-semibold">{{ title }}</h1>

    @if (error()) { <segwi-banner tone="error">{{ error() }}</segwi-banner> }

    @if (repos() === null) {
      <segwi-skeleton height="12rem" />
    } @else if (loadError()) {
      <segwi-banner tone="error">
        Couldn't load repositories. {{ loadError() }}
        <button bannerAction segwi-button type="button" (click)="loadRepos()">Retry</button>
      </segwi-banner>
    } @else if (!repos()!.length) {
      <segwi-banner>No repositories are set up yet. Add one to the server's configuration.</segwi-banner>
    } @else {
      <form class="flex flex-col gap-5" (submit)="start($event)">
        <div class="flex flex-col gap-2">
          <label for="repo" class="text-sm text-muted">Repository</label>
          <select id="repo" class="min-h-11 rounded-card border border-border-strong bg-surface-raised px-3 text-[15px]" (change)="pickRepo($any($event.target).value)">
            @for (repo of repos(); track repo.name) {
              <option [value]="repo.name" [selected]="repo.name === repoName()" [disabled]="!!problem(repo)">{{ repo.name }}{{ problem(repo) ? ' — ' + problem(repo) : '' }}</option>
            }
          </select>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-sm text-muted">What should it do?</legend>
          <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="What should it do?">
            @for (option of allowed(); track option) {
              <label class="relative flex min-h-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-card border px-2 py-2 text-center text-[15px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                [class]="action() === option ? 'border-accent bg-(--accent-soft)' : 'border-border-strong bg-surface-raised'">
                <input type="radio" name="action" class="sr-only" [value]="option" [checked]="action() === option" (change)="pickAction(option)" />
                <span class="text-[17px] font-semibold">{{ names[option] }}</span>
                <span class="text-sm text-muted">{{ labels[option] }}</span>
              </label>
            }
          </div>
        </fieldset>

        <div class="flex flex-col gap-2">
          <label for="task" class="text-sm text-muted">Task</label>
          <textarea id="task" rows="6" [maxLength]="live.limits().taskMaxChars" [value]="task()" (input)="editTask($any($event.target).value)"
            aria-describedby="task-count" placeholder="Describe what you want done"
            class="min-h-32 rounded-card border border-border-strong bg-surface-raised p-3 text-[15px] placeholder:text-muted"></textarea>
          <p id="task-count" class="text-right text-sm text-muted">{{ task().length }} / {{ live.limits().taskMaxChars }}</p>
        </div>

        @if (repoName() && action()) {
          <p class="rounded-card border border-border bg-surface px-4 py-3 text-[15px]" data-testid="what-happens">{{ whatHappens() }}</p>
        }

        <div class="sticky-bar">
          <button segwi-button variant="primary" type="submit" class="w-full" [disabled]="!canStart() || starting()">{{ starting() ? 'Starting…' : 'Start' }}</button>
        </div>
      </form>
    }
  `,
})
export class NewRunPage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly live = inject(LiveService);
  protected readonly title = titles.newRun;
  protected readonly labels = actionLabels;
  protected readonly names = actionNames;
  protected readonly repos = signal<Repo[] | null>(null);
  protected readonly loadError = signal('');
  protected readonly error = signal('');
  protected readonly starting = signal(false);

  private readonly draft = loadDraft();
  protected readonly repoName = signal(this.draft.repo);
  protected readonly action = signal<Action | ''>(this.draft.action);
  protected readonly task = signal(this.draft.task);
  /** One id per draft: a second tap on Start returns the run the first created. */
  private clientId: string = crypto.randomUUID();

  protected readonly selected = computed(() => this.repos()?.find((repo) => repo.name === this.repoName()) ?? null);
  protected readonly allowed = computed(() => ALL_ACTIONS.filter((option) => this.selected()?.actions.includes(option)));
  protected readonly canStart = computed(() => {
    const repo = this.selected();
    return !!repo && !repoProblem(repo) && this.action() !== '' && this.allowed().includes(this.action() as Action) && this.task().trim().length > 0;
  });
  protected readonly whatHappens = computed(() => (this.action() ? whatHappens(this.action() as Action, this.repoName()) : ''));

  constructor() {
    void this.loadRepos();
  }

  protected problem = repoProblem;

  protected async loadRepos(): Promise<void> {
    this.loadError.set('');
    try {
      const repos = await this.api.repos();
      this.repos.set(repos);
      // A remembered repo that is gone or busy gives way to the first one that can take a run.
      const remembered = repos.find((repo) => repo.name === this.repoName() && !repoProblem(repo));
      const chosen = remembered ?? repos.find((repo) => !repoProblem(repo)) ?? repos[0];
      if (chosen) this.pickRepo(chosen.name);
    } catch (error) {
      this.repos.set([]);
      this.loadError.set((error as Error).message);
    }
  }

  protected pickRepo(name: string): void {
    this.repoName.set(name);
    const options = this.allowed();
    if (!options.includes(this.action() as Action)) this.action.set(options[0] ?? '');
    this.persist();
  }

  protected pickAction(option: Action): void {
    this.action.set(option);
    this.persist();
  }

  protected editTask(value: string): void {
    this.task.set(value);
    this.persist();
  }

  private persist(): void {
    saveDraft({ repo: this.repoName(), action: this.action(), task: this.task() });
  }

  protected async start(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canStart() || this.starting()) return;
    this.starting.set(true);
    this.error.set('');
    try {
      const run = await this.api.startRun({ repo: this.repoName(), action: this.action() as Action, task: this.task().trim(), clientId: this.clientId });
      clearTask();
      this.task.set('');
      this.clientId = crypto.randomUUID();
      void this.live.refresh();
      await this.router.navigate(['/runs', run.id]);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : "Couldn't start the run.");
    } finally {
      this.starting.set(false);
    }
  }
}
