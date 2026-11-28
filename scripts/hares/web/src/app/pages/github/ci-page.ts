import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { now } from '../../core/clock';
import { GithubApi } from './github-api';
import { historyAria, paddedHistory, progress, repoState, runLine, runWhen, sortRepos, summarise, tally } from './ci-logic';
import type { CiRepo } from './models';

/** How each repo's default branch is doing: the newest run, the history, and what to do about a red one. */
@Component({
  selector: 'hares-ci-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gh-page">
      <header>
        <h1 class="gh-h1 gh-m">CI</h1>
        <h1 class="big gh-d">{{ summary().headline }}</h1>
        @if (repos() !== null) {
          <p class="gh-lede gh-m">{{ summary().headline }}.@if (summary().running) { {{ summary().running }} }</p>
          <p class="gh-lede gh-d">{{ [summary().running, summary().others].filter(present).join(' ') }}</p>
          @if (bar().length) {
            <div class="bar" role="img" [attr.aria-label]="barLabel()">
              @for (seg of bar(); track seg.name) { <span [class]="'seg ' + seg.name"><b>{{ seg.count }}</b>{{ seg.name }}</span> }
            </div>
          }
        }
      </header>

      @if (error()) {
        <div class="gh-notice" role="alert"><span>Couldn’t load CI. {{ error() }}</span><button type="button" class="gh-btn" (click)="load()">Try again</button></div>
      }
      @if (actionNote()) { <p class="gh-faint note" role="status">{{ actionNote() }}</p> }
      @if (actionError()) { <p class="gh-err" role="alert">{{ actionError() }}</p> }

      @if (repos() === null && !error()) {
        <p class="gh-empty" role="status">Loading CI</p>
      } @else if (rows().length) {
        <div class="gh-sub gh-m top"><h2 class="gh-h2">Main branch</h2><span class="gh-faint">Last 10 runs</span></div>
        <div class="cols gh-d gh-faint"><span>Repo</span><span>Latest run on main</span><span>Last 20 runs</span><span></span></div>
        @for (row of rows(); track row.repo.repo) {
          <article class="row">
            <h2 class="name">{{ row.repo.repo }}</h2>
            <div class="latest">
              @if (row.repo.latest; as run) {
                <span class="line" [class]="'line ' + row.state"><span class="dot" aria-hidden="true"></span>{{ row.line }}</span>
                <span class="gh-faint">{{ row.when }}</span>
                @if (row.progress !== null) {
                  <progress class="prog" max="100" [value]="row.progress" [attr.aria-label]="run.jobsDone + ' of ' + run.jobsTotal + ' jobs done'"></progress>
                }
              } @else {
                <span class="line idle">No runs on the default branch yet</span>
              }
            </div>
            <span class="hist" role="img" [attr.aria-label]="row.historyAria">@for (cell of row.history; track $index) { <span [class]="cell"></span> }</span>
            <div class="acts">
              @if (row.state === 'failing' && row.repo.latest; as run) {
                <button type="button" class="gh-btn" [disabled]="busy() === run.id" (click)="rerun(row.repo.repo, run.id)"><span class="gh-m">Rerun failed jobs</span><span class="gh-d">Rerun failed</span></button>
                <a class="gh-btn primary" routerLink="/start" [queryParams]="{ repo: row.repo.repo, ask: 'failing-check' }">Fix in a session</a>
              } @else if (row.repo.latest; as run) {
                <a class="gh-d open" [href]="run.url" target="_blank" rel="noopener noreferrer">Open run<span class="gh-sr"> for {{ row.repo.repo }}</span></a>
              }
            </div>
          </article>
        }
      } @else if (repos() !== null) {
        <p class="gh-empty">No repos are configured. Add some in config.json.</p>
      }
    </div>
  `,
})
export class CiPage {
  private readonly api = inject(GithubApi);
  protected readonly repos = signal<CiRepo[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly actionNote = signal<string | null>(null);
  protected readonly busy = signal<number | null>(null);

  protected readonly summary = computed(() => summarise(this.repos() ?? []));
  protected readonly bar = computed(() => {
    const counts = tally(this.repos() ?? []);
    return [
      { name: 'failing', count: counts.failing },
      { name: 'running', count: counts.running },
      { name: 'passing', count: counts.passing },
    ].filter((s) => s.count > 0);
  });
  protected readonly barLabel = computed(() => `Repos: ${this.bar().map((s) => `${s.count} ${s.name}`).join(', ')}`);
  protected readonly rows = computed(() => {
    const at = now();
    return sortRepos(this.repos() ?? []).map((repo) => ({
      repo,
      state: repoState(repo),
      line: repo.latest ? runLine(repo.latest) : '',
      when: repo.latest ? runWhen(repo.latest, at) : '',
      progress: repo.latest ? progress(repo.latest) : null,
      history: paddedHistory(repo.history, 20),
      historyAria: historyAria(repo.history),
    }));
  });
  protected readonly present = (text: string | null): boolean => !!text;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      this.repos.set(await this.api.ci());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Try again.');
    }
  }

  protected async rerun(repo: string, runId: number): Promise<void> {
    this.actionError.set(null);
    this.actionNote.set(null);
    this.busy.set(runId);
    try {
      await this.api.rerun(repo, runId);
      this.actionNote.set(`Rerunning the failed jobs on ${repo}.`);
      await this.load();
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Could not rerun.');
    } finally {
      this.busy.set(null);
    }
  }
}
