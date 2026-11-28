import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GithubApi } from '../github-api';
import { issue } from '../testing';
import { IssuesPanel } from './issues-panel';

describe('IssuesPanel', () => {
  const api = {
    issues: vi.fn(async () => [issue({ number: 19 }), issue({ number: 52, title: 'Price per m2', labels: [], session: { id: 'sess-1', title: 'x', state: 'working' as const } }), issue({ repo: 'my-repo', number: 91, title: 'Rename segwi', labels: [] })]),
    startFromIssue: vi.fn(async () => 'sess-5'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [IssuesPanel], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
  });

  async function render(mode: 'page' | 'column' = 'page') {
    const fixture = TestBed.createComponent(IssuesPanel);
    fixture.componentRef.setInput('mode', mode);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    return { element, settle };
  }

  it('starts the build command on the issue whose Start was pressed, then opens the new session', async () => {
    const { element, settle } = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    ([...element.querySelectorAll('button')].find((b) => b.textContent?.includes('Start') && b.textContent.includes('#91')) as HTMLElement).click();
    await settle();
    expect(api.startFromIssue).toHaveBeenCalledExactlyOnceWith('my-repo', 91);
    expect(navigate).toHaveBeenCalledWith(['/s', 'sess-5']);
  });

  it('offers Open instead of Start on an issue a session is already working on, so it is not started twice', async () => {
    const { element } = await render();
    const start = [...element.querySelectorAll('button')].filter((b) => b.textContent?.includes('Start')).map((b) => b.textContent);
    expect(start.some((t) => t?.includes('#52'))).toBe(false);
    expect(start.some((t) => t?.includes('#19'))).toBe(true);
    expect(element.querySelector('a[href="/s/sess-1"]')?.textContent).toContain('Open');
  });

  it('groups by repo on the page and lists flat, with the repo in each line, in the desktop column', async () => {
    const page = await render('page');
    expect([...page.element.querySelectorAll('.group h2')].map((h) => h.textContent)).toEqual(['thats-fair', 'my-repo']);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [IssuesPanel], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
    const column = await render('column');
    expect(column.element.querySelector('.group')).toBeNull();
    expect(column.element.textContent).toContain('my-repo #91');
  });

  it('narrows the list as you type in the search box', async () => {
    const { element, settle } = await render();
    const input = element.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'segwi';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect([...element.querySelectorAll('.item .name')].map((n) => n.textContent)).toEqual(['Rename segwi']);
  });
});
