import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GithubApi } from './github-api';
import type { PrDetail } from './models';
import { PrDetailPage } from './pr-detail-page';
import { prDetail } from './testing';

const thread = { id: 501, path: 'src/a.ts', line: 84, resolved: false, comments: [
  { id: 501, author: 'alex', mine: true, createdAt: '2026-06-10T10:00:00Z', bodyHtml: '<p>Should the log rotate?</p>' },
  { id: 777, author: 'bot', mine: false, createdAt: '2026-06-10T11:00:00Z', bodyHtml: '<p>Done.</p>' },
] };

describe('PrDetailPage', () => {
  const api = { pr: vi.fn(), reply: vi.fn(async () => ({})), comment: vi.fn(async () => ({})), review: vi.fn(async () => ({ session: { id: 'sess-2' } })), startFromPr: vi.fn(async () => 'sess-3'), merge: vi.fn(async () => ({})) };

  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  });
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [PrDetailPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
  });

  async function render(pr: Partial<PrDetail> = {}, view?: string) {
    api.pr.mockResolvedValue(prDetail(pr));
    const fixture = TestBed.createComponent(PrDetailPage);
    fixture.componentRef.setInput('repo', 'eduline-ai-shop');
    fixture.componentRef.setInput('n', '231');
    fixture.componentRef.setInput('view', view);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); };
    const button = (name: string, within: ParentNode = element) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name))!;
    const reviewSheet = () => [...element.querySelectorAll('dialog')].find((d) => d.textContent?.includes('Review #'))!;
    return { element, settle, button, reviewSheet };
  }

  it('loads the pull request named in the route and shows its title and rendered description', async () => {
    const { element } = await render();
    expect(api.pr).toHaveBeenCalledWith('eduline-ai-shop', 231);
    expect(element.querySelector('h1')?.textContent).toBe('Jev view-picker spike');
    expect(element.querySelector('#panel-description h2')?.textContent).toBe('What this does');
  });

  it('opens the review sheet on the comments tab for ?view=review, and not otherwise', async () => {
    const withView = await render({}, 'review');
    expect(withView.element.querySelector('dialog[open]')).not.toBeNull();
    expect(withView.element.querySelector('#panel-comments')?.classList.contains('off')).toBe(false);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [PrDetailPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
    const without = await render();
    expect(without.element.querySelector('dialog[open]')).toBeNull();
    expect(without.element.querySelector('#panel-comments')?.classList.contains('off')).toBe(true);
  });

  it('disables Merge and says why while the readiness rules are not met, and enables it when they are', async () => {
    const blocked = await render({ readiness: { ready: false, checks: [{ name: 'ci-green', pass: false, detail: 'verify:ci has not passed' }] } });
    expect((blocked.button('Merge') as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.element.textContent).toContain('Not ready to merge: verify:ci has not passed');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [PrDetailPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
    const ready = await render();
    expect((ready.button('Merge') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no Merge on a draft or a pull request that is already merged', async () => {
    expect((await render({ draft: true })).element.textContent).not.toContain('Squash and merge');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [PrDetailPage], providers: [provideRouter([]), { provide: GithubApi, useValue: api }] });
    const merged = await render({ state: 'merged' });
    expect(merged.button('Merge')).toBeUndefined();
    expect(merged.element.textContent).toContain('This pull request is merged.');
  });

  it('replies to the thread by its first comment id, not the latest comment', async () => {
    const { element, settle, button } = await render({ threads: [thread] }, undefined);
    button('Comments', element).click();
    await settle();
    button('Reply', element).click();
    await settle();
    const area = element.querySelector('textarea[id^="reply-"]') as HTMLTextAreaElement;
    area.value = 'Thanks';
    area.dispatchEvent(new Event('input'));
    await settle();
    button('Send reply').click();
    await settle();
    expect(api.reply).toHaveBeenCalledExactlyOnceWith('eduline-ai-shop', 231, 501, 'Thanks');
  });

  it('requests changes with the text and the session choice, then opens the session the server started', async () => {
    const { settle, button, reviewSheet } = await render({}, 'review');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const sheet = reviewSheet();
    button('Request changes', sheet).click();
    await settle();
    const area = sheet.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'Include the service requests.';
    area.dispatchEvent(new Event('input'));
    await settle();
    expect((sheet.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    [...sheet.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Request changes').at(-1)!.click();
    await settle();
    expect(api.review).toHaveBeenCalledExactlyOnceWith('eduline-ai-shop', 231, { event: 'REQUEST_CHANGES', body: 'Include the service requests.', startSession: true });
    expect(navigate).toHaveBeenCalledWith(['/s', 'sess-2']);
  });

  it('refuses an empty comment review without calling the server', async () => {
    const { settle, reviewSheet } = await render({}, 'review');
    const sheet = reviewSheet();
    [...sheet.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Post comment')!.click();
    await settle();
    expect(api.review).not.toHaveBeenCalled();
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe('Write a few words first.');
  });
});
