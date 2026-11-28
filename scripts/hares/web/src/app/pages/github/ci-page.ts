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
              @for (seg of bar(); track seg.name) { <span [class]="'seg ' + seg.name" [style.flex-grow]="seg.grow"><b>{{ seg.count }}</b>{{ seg.name }}</span> }
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
                  <span class="prog" role="progressbar" [attr.aria-label]="run.jobsDone + ' of ' + run.jobsTotal + ' jobs done'" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="row.progress"><span [style.width.%]="row.progress"></span></span>
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
  styles: `
    header{display:flex;flex-direction:column}
    h1.gh-h1{min-height:48px;display:flex;align-items:center}
    .big{margin:0;font-size:34px;line-height:1.08;font-weight:600;letter-spacing:-.03em}
    header .gh-lede{max-width:32ch}
    .bar{display:flex;gap:3px;height:48px;margin-top:24px}
    .seg{flex:1 1 0;border-radius:4px;display:flex;align-items:center;gap:5px;padding:0 14px;font-size:14.5px;white-space:nowrap;background:var(--raised);color:var(--muted)}
    .seg:first-child{border-radius:14px 4px 4px 14px}
    .seg:last-child{border-radius:4px 14px 14px 4px}
    .seg:only-child{border-radius:14px}
    .seg.failing{background:var(--red);color:var(--on-red)}
    .seg.running{background:var(--teal);color:var(--on-teal)}
    .top{margin-top:32px}
    .cols,.row{display:grid;grid-template-areas:'name hist' 'latest latest' 'acts acts';grid-template-columns:minmax(0,1fr) auto;gap:8px 12px}
    .cols{display:none}
    .row{padding:16px 0;border-bottom:1px solid var(--line);align-items:center}
    .name{grid-area:name;margin:0;font-size:16px;font-weight:600}
    .latest{grid-area:latest;min-width:0;display:flex;flex-direction:column;gap:8px}
    .hist{grid-area:hist;display:inline-flex;gap:2px}
    .hist span{width:7px;height:14px;border-radius:2px;background:var(--raised)}
    .hist .pass{background:var(--teal)}
    .hist .fail{background:var(--red)}
    .hist .running{background:var(--amber)}
    .hist span:nth-child(-n+10){display:none}
    .acts{grid-area:acts;display:flex;gap:8px}
    .acts .gh-btn{flex:1 1 0;min-width:0;padding:0 10px}
    .line{display:flex;align-items:center;gap:8px;font-size:14.5px;color:var(--muted)}
    .dot{width:8px;height:8px;border-radius:4px;box-sizing:border-box;flex:none;border:2px solid currentColor}
    .line.failing{color:var(--red)}
    .line.running{color:var(--teal)}
    .line.failing .dot,.line.running .dot{background:currentColor}
    .prog{display:block;height:4px;border-radius:2px;background:var(--raised);margin-top:4px}
    .prog span{display:block;height:4px;border-radius:2px;background:var(--teal)}
    .note{margin:16px 0 0}
    .open{font-size:14.5px;color:var(--muted);text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
    @media (min-width:1024px){
      header{display:block}
      .bar{height:44px;margin-top:0;flex:0 1 460px}
      header{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,460px);gap:12px 32px;align-items:end}
      header .gh-lede{grid-column:1;margin-top:0;max-width:none}
      header .big{grid-column:1}
      header .bar{grid-column:2;grid-row:1 / span 2}
      .cols{display:grid;margin-top:40px;padding-bottom:10px;border-bottom:1px solid var(--line);font-size:13.5px}
      .cols,.row{grid-template-areas:'name latest hist acts';grid-template-columns:200px minmax(0,1fr) 150px 300px;gap:24px}
      .row{padding:18px 0}
      .hist span{width:5px;height:16px}
      .hist span:nth-child(-n+10){display:block}
      .acts{justify-content:flex-end}
      .acts .gh-btn{flex:none;padding:0 14px}
    }
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
      { name: 'failing', count: counts.failing, grow: 1.4 },
      { name: 'running', count: counts.running, grow: 1.4 },
      { name: 'passing', count: counts.passing, grow: 3 },
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
