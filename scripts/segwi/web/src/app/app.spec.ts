import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { LiveService } from './core/live';
import { productName } from './words';

describe('App shell', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([])] }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture;
  }

  it('shows the wordmark, a skip link and the main navigation', async () => {
    const page = (await render()).nativeElement as HTMLElement;
    expect(page.querySelector('header')?.textContent).toContain(productName);
    expect(page.querySelector('a[href="#main"]')?.textContent).toContain('Skip to content');
    expect(page.querySelectorAll('nav[aria-label="Main"]').length).toBe(2);
  });

  it('puts the count of what needs you in the page title', async () => {
    const fixture = await render();
    const live = TestBed.inject(LiveService);
    live.approvals.set([{ id: 'a', runId: 'r' } as never, { id: 'b', runId: 'r' } as never]);
    await fixture.whenStable();
    expect(TestBed.inject(Title).getTitle()).toBe(`(2) ${productName}`);
    live.approvals.set([]);
    await fixture.whenStable();
    expect(TestBed.inject(Title).getTitle()).toBe(productName);
  });

  it('shows the reconnecting banner politely', async () => {
    const fixture = await render();
    TestBed.inject(LiveService).connection.set('reconnecting');
    await fixture.whenStable();
    const banner = (fixture.nativeElement as HTMLElement).querySelector('segwi-banner');
    expect(banner?.textContent).toContain('Reconnecting…');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
  });
});
