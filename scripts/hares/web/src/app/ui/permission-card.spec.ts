import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../core/api';
import { LiveService } from '../core/live';
import type { Pending } from '../models';
import { PermissionCard } from './permission-card';

const expectOf = { terminalId: 't1', sessionId: 's1', status: 'blocked' as const, seq: 7 };
const pending = (tooLong = false): Pending => ({
  id: 'p1', sessionId: 's1', kind: 'permission', asker: 'my-repo', askedAt: new Date().toISOString(), items: [], freeText: false, chat: false, expect: expectOf, answerable: true, reason: null,
  permission: { tool: 'Bash', verb: 'run a command', exact: 'pnpm add @openrouter/sdk', risk: 'low', riskLabel: 'Installs', why: '', tooLong, always: { text: 'Bash(pnpm add:*)', scope: 'rule' } },
});

function mount(initial: Pending) {
  const decide = vi.fn().mockResolvedValue({});
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: { decide } }, { provide: LiveService, useValue: { refresh: vi.fn().mockResolvedValue(undefined), questions: signal([]) } }] });
  const fixture = TestBed.createComponent(PermissionCard);
  fixture.componentRef.setInput('pending', initial);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: RegExp) => [...el.querySelectorAll('button')].find((entry) => name.test(entry.textContent ?? '')) as HTMLButtonElement;
  return { fixture, el, decide, button };
}

describe('PermissionCard', () => {
  it('shows the exact rule and sends nothing until the second tap on Add the rule', async () => {
    const { fixture, el, decide, button } = mount(pending());
    button(/Always allow in this repo/).click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Bash(pnpm add:*)');
    expect(decide).not.toHaveBeenCalled();
    button(/Keep asking/).click();
    fixture.detectChanges();
    expect(button(/Add the rule/)).toBeUndefined();
    button(/Always allow in this repo/).click();
    fixture.detectChanges();
    button(/Add the rule/).click();
    await fixture.whenStable();
    expect(decide).toHaveBeenCalledWith('p1', { decision: 'always', expect: expectOf, rule: 'Bash(pnpm add:*)' });
  });

  it('keeps the confirm step open when a reload brings the same prompt again', () => {
    const { fixture, el, button } = mount(pending());
    button(/Always allow in this repo/).click();
    fixture.detectChanges();
    fixture.componentRef.setInput('pending', { ...pending() });
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    expect(el.textContent).toContain('Bash(pnpm add:*)');
  });

  it('approves once without a rule, and denies with the reason typed', async () => {
    const { fixture, el, decide, button } = mount(pending());
    button(/Run once/).click();
    await fixture.whenStable();
    expect(decide).toHaveBeenLastCalledWith('p1', { decision: 'once', expect: expectOf });
    const reason = el.querySelector('input') as HTMLInputElement;
    reason.value = 'Use npm instead';
    reason.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(/Don’t run/).click();
    await fixture.whenStable();
    expect(decide).toHaveBeenLastCalledWith('p1', { decision: 'deny', expect: expectOf, reason: 'Use npm instead' });
  });

  it('offers no allow button for a prompt too long to show whole, only the terminal', () => {
    const { el, button } = mount(pending(true));
    expect(button(/Run once/)).toBeUndefined();
    expect(button(/Always allow/)).toBeUndefined();
    expect(el.textContent).toContain('Answer in the terminal');
  });
});
