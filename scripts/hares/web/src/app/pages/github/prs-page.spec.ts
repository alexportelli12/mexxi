import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GithubApi } from './github-api';
import { PrsPage } from './prs-page';
import { prSummary } from './testing';

const prs = [
  prSummary({ number: 1, title: 'Ready one', groups: ['review', 'ready'] }),
  prSummary({ number: 2, title: 'Needs a look', groups: ['review'], unresolvedThreads: 2 }),
  prSummary({ number: 3, title: 'Broken one', groups: ['failing'], checks: ['pass', 'fail'], failureNote: 'verify:ci failed at lint' }),
  prSummary({ number: 4, title: 'Bump vite', groups: ['bumps', 'ready'], bot: true, bump: 'minor' }),
];

describe('PrsPage', () => {
  const api = { prs: vi.fn(async () => prs), merge: vi.fn(async () => ({})), startFromPr: vi.fn(async () => 'sess-9'), rerun: vi.fn(async () => ({})) };

  beforeAll(() => {
    // jsdom has no modal dialogs; the sheet only needs open state to be visible to the test.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  });
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [PrsPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
  });

  async function render() {
    const fixture = TestBed.createComponent(PrsPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    const button = (name: string) => [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
    const titles = () => [...element.querySelectorAll('.row .title')].map((t) => t.textContent?.trim());
    return { element, settle, button, titles };
  }

  it('starts a phone on To review, with four chips and a count on each', async () => {
    const { element, titles } = await render();
    const chips = [...element.querySelectorAll('[role="tab"]')].map((c) => c.textContent?.trim());
    expect(chips).toEqual(['To review, 2', 'Ready, 2', 'Failing, 1', 'Bumps, 1']);
    expect(titles()).toEqual(['Ready one', 'Needs a look']);
  });

  it('shows the group a chip names when it is tapped', async () => {
    const { element, settle, titles } = await render();
    (element.querySelectorAll('[role="tab"]')[2] as HTMLElement).click();
    await settle();
    expect(titles()).toEqual(['Broken one']);
    expect(element.querySelector('.row')?.textContent).toContain('verify:ci failed at lint');
  });

  it('confirms a merge against the head commit shown, and sends the full sha it showed', async () => {
    const { element, settle, button } = await render();
    button('Merge').click();
    await settle();
    expect(element.querySelector('[data-testid="head-sha"]')?.textContent).toBe('3f2c1a0');
    expect(api.merge).not.toHaveBeenCalled();
    button('Squash and merge').click();
    await settle();
    expect(api.merge).toHaveBeenCalledExactlyOnceWith('eduline-ai-shop', 1, '3f2c1a09b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3');
  });

  it('starts a fix session on the failing check and opens it', async () => {
    const { element, settle } = await render();
    (element.querySelectorAll('[role="tab"]')[2] as HTMLElement).click();
    await settle();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    ([...element.querySelectorAll('.row button')].find((b) => b.textContent?.trim() === 'Fix in a session') as HTMLElement).click();
    await settle();
    expect(api.startFromPr).toHaveBeenCalledWith('eduline-ai-shop', 3, 'failing-check');
    expect(navigate).toHaveBeenCalledWith(['/s', 'sess-9']);
  });

  it('says so, with a retry, when the pull requests cannot be loaded instead of showing an empty list', async () => {
    api.prs.mockRejectedValueOnce(new Error('GitHub says no.'));
    const { element, button } = await render();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('GitHub says no.');
    expect(button('Try again')).toBeTruthy();
  });
});
