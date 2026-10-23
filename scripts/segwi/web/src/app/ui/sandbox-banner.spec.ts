import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../core/api';
import { LiveService } from '../core/live';
import { NewRunPage } from '../pages/new-run';
import { SandboxBanner } from './sandbox-banner';

const repos = [{ name: 'my-app', actions: ['build', 'ask'], defaultBranch: 'main', clean: true, onDefault: true, lastRun: null }];

describe('sandbox status', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: { repos: async () => repos } }] });
  });

  async function banner(sandbox: { available: boolean; required: boolean; problems: string[] } | null) {
    TestBed.inject(LiveService).sandbox.set(sandbox);
    const fixture = TestBed.createComponent(SandboxBanner);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('says nothing when the sandbox works, or the server does not report it', async () => {
    expect((await banner({ available: true, required: true, problems: [] })).textContent?.trim()).toBe('');
    expect((await banner(null)).textContent?.trim()).toBe('');
  });

  it('says runs cannot start when the sandbox is missing and required, with the problems', async () => {
    const element = await banner({ available: false, required: true, problems: ['bwrap was not found'] });
    const strip = element.querySelector('[data-testid="sandbox-blocked"]')!;
    expect(strip.getAttribute('role')).toBe('alert');
    expect(strip.textContent).toContain("Runs can't start until the sandbox works on the server");
    expect(strip.textContent).toContain('bwrap was not found');
  });

  it('warns that runs start without the sandbox when the server allows that', async () => {
    const element = await banner({ available: false, required: false, problems: [] });
    expect(element.querySelector('[data-testid="sandbox-skipped"]')?.textContent).toContain('Runs start without the sandbox');
  });

  it('disables Start on New run while runs cannot start', async () => {
    const live = TestBed.inject(LiveService);
    const fixture = TestBed.createComponent(NewRunPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const task = element.querySelector('textarea#task') as HTMLTextAreaElement;
    task.value = 'Do a thing';
    task.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const start = () => [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Start')!;
    expect(start().disabled).toBe(false);
    live.sandbox.set({ available: false, required: true, problems: [] });
    await fixture.whenStable();
    expect(start().disabled).toBe(true);
    expect(element.querySelector('[data-testid="sandbox-blocked"]')).not.toBeNull();
    live.sandbox.set({ available: false, required: false, problems: [] });
    await fixture.whenStable();
    expect(start().disabled).toBe(false);
  });
});
