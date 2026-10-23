import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../core/api';
import { ApprovalTapGuard, SETTLE_MS } from '../core/tap-guard';
import type { Approval } from '../models';
import { ApprovalCard } from './approval-card';

const base: Approval = {
  id: 'ap1', runId: 'run1', repo: 'my-app', tool: 'Bash', exact: 'curl https://example.com', cwd: '/w/my-app', why: 'Fetch the page',
  risk: 'network', riskLabel: 'Reaches the internet', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: 'pending',
};

describe('ApprovalCard', () => {
  let clock = 0;
  const decide = vi.fn(async () => undefined);

  beforeEach(() => {
    clock = 50_000;
    decide.mockClear();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    TestBed.configureTestingModule({ imports: [ApprovalCard], providers: [provideRouter([]), { provide: ApiService, useValue: { decide } }] });
  });
  afterEach(() => vi.restoreAllMocks());

  async function render(approval: Partial<Approval> = {}, result: string | null = null) {
    const fixture = TestBed.createComponent(ApprovalCard);
    fixture.componentRef.setInput('approval', { ...base, ...approval });
    fixture.componentRef.setInput('result', result);
    await fixture.whenStable();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  const button = (element: HTMLElement, name: string) => [...element.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name)!;

  it('keeps the controls in place, hidden, once answered, so the card keeps its height', async () => {
    const { element } = await render({}, 'allowed');
    const controls = element.querySelector('[data-testid="approval-controls"]')!;
    expect(controls.classList).toContain('invisible');
    expect(controls.getAttribute('aria-hidden')).toBe('true');
    expect(button(element, 'Approve').disabled).toBe(true);
    expect(element.querySelector('p[role="status"]')?.textContent).toContain('Allowed');
  });

  it('ignores a tap on Approve that lands just after the cards moved, and takes one once they settle', async () => {
    const { element } = await render();
    TestBed.inject(ApprovalTapGuard).moved();
    button(element, 'Approve').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    expect(decide).not.toHaveBeenCalled();
    clock += SETTLE_MS;
    button(element, 'Approve').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    expect(decide).toHaveBeenCalledWith('ap1', 'allow');
  });

  it('never ignores the keyboard', async () => {
    const { element } = await render();
    TestBed.inject(ApprovalTapGuard).moved();
    button(element, 'Deny').dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
    expect(decide).toHaveBeenCalledWith('ap1', 'deny');
  });

  it('shows exact and why whole, with hidden characters as chips, and copies the raw string', async () => {
    const opaque = 'x'.repeat(3000);
    const exact = `printf "\u001b[2K" \u202Etxt.exe TOKEN=${opaque}`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { element } = await render({ exact, why: 'Check\u200B it' });
    const block = element.querySelector('[data-testid="approval-exact"]')!;
    expect([...block.querySelectorAll('[data-escape]')].map((chip) => chip.textContent)).toEqual(['\\x1b', 'U+202E']);
    expect(block.textContent).toBe(`printf "\\x1b[2K" U+202Etxt.exe TOKEN=${opaque}`);
    expect(element.querySelector('[data-testid="approval-why"] [data-escape]')?.textContent).toBe('U+200B');
    expect(element.querySelector('[data-testid="hidden-characters"]')?.textContent).toContain('3 hidden or control characters');
    button(element, 'Copy').click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(exact);
  });

  it('names what exact is for each tool', async () => {
    expect((await render({ tool: 'Bash' })).element.querySelector('h2')?.textContent).toBe('Command');
    expect((await render({ tool: 'Write', exact: '/w/a.ts' })).element.querySelector('h2')?.textContent).toBe('File');
    expect((await render({ tool: 'WebFetch' })).element.querySelector('h2')?.textContent).toBe('URL');
    expect((await render({ tool: 'mcp__x__y' })).element.querySelector('h2')?.textContent).toBe('Call');
  });
});
