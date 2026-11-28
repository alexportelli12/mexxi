import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CiPage } from './ci-page';
import { GithubApi } from './github-api';
import { ciRepo, ciRun } from './testing';

describe('CiPage', () => {
  const repos = [
    ciRepo({ repo: 'atlas-ops', latest: ciRun({ id: 5, conclusion: 'success' }), history: ['pass'] }),
    ciRepo({ repo: 'verifika', latest: ciRun({ id: 77 }) }),
    ciRepo({ repo: 'thats-fair', latest: ciRun({ id: 9, status: 'in_progress', conclusion: null, jobsDone: 3, jobsTotal: 5 }) }),
  ];
  const api = { ci: vi.fn(async () => repos), rerun: vi.fn(async () => ({})) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [CiPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
  });

  async function render() {
    const fixture = TestBed.createComponent(CiPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    return { element, settle: async () => { fixture.detectChanges(); await fixture.whenStable(); } };
  }

  it('lists the failing repo first, then the running one, then the passing one', async () => {
    const { element } = await render();
    expect([...element.querySelectorAll('.row .name')].map((n) => n.textContent)).toEqual(['verifika', 'thats-fair', 'atlas-ops']);
  });

  it('reruns the failed jobs of the failing repo’s newest run, and only offers it there', async () => {
    const { element, settle } = await render();
    const rerun = [...element.querySelectorAll('.row button')].filter((b) => b.textContent?.includes('Rerun'));
    expect(rerun).toHaveLength(1);
    (rerun[0] as HTMLElement).click();
    await settle();
    expect(api.rerun).toHaveBeenCalledExactlyOnceWith('verifika', 77);
  });

  it('sends Fix in a session to the start screen for that repo', async () => {
    const { element } = await render();
    const fix = [...element.querySelectorAll('.row a')].find((a) => a.textContent?.includes('Fix in a session'))!;
    expect(fix.getAttribute('href')).toBe('/start?repo=verifika&ask=failing-check');
  });

  it('draws the status bar from the repo counts and describes it for a screen reader', async () => {
    const { element } = await render();
    expect(element.querySelector('.bar')?.getAttribute('aria-label')).toBe('Repos: 1 failing, 1 running, 1 passing');
  });

  it('shows how far a running run has got', async () => {
    const { element } = await render();
    expect(element.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
  });
});
