import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError, ApiService } from '../core/api';
import { LiveService } from '../core/live';
import type { Pending } from '../models';
import { QuestionCard } from './question-card';

const expectOf = { terminalId: 't1', sessionId: 's1', status: 'blocked' as const, seq: 41 };
const pending = (id: string, extra: Partial<Pending> = {}): Pending => ({
  id, sessionId: 's1', kind: 'question', asker: 'My repo', askedAt: new Date().toISOString(), freeText: true, chat: true, expect: expectOf, answerable: true, reason: null,
  items: [{ question: `Question ${id}`, multiSelect: false, options: [{ n: 1, label: 'Keep' }, { n: 2, label: 'Drop' }] }], ...extra,
});

function mount(initial: Pending, answer = vi.fn().mockResolvedValue({})) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: { answer } }, { provide: LiveService, useValue: { refresh, questions: signal([]) } }] });
  const fixture = TestBed.createComponent(QuestionCard);
  fixture.componentRef.setInput('pending', initial);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: RegExp) => [...el.querySelectorAll('button')].find((entry) => name.test(entry.textContent ?? '')) as HTMLButtonElement;
  return { fixture, el, answer, refresh, button };
}

describe('QuestionCard', () => {
  it('sends the picked option with the question id and the status and sequence the person saw', async () => {
    const { fixture, answer, button } = mount(pending('q1'));
    expect(button(/Send answer/).disabled).toBe(true);
    button(/Drop/).click();
    fixture.detectChanges();
    button(/Send answer/).click();
    await fixture.whenStable();
    expect(answer).toHaveBeenCalledWith('s1', { questionId: 'q1', expect: expectOf, answers: [{ kind: 'option', n: 2 }] });
  });

  it('starts clean when the card shows a different question, so one pick never answers another', async () => {
    const { fixture, answer, button } = mount(pending('q1'));
    button(/Keep/).click();
    fixture.detectChanges();
    fixture.componentRef.setInput('pending', pending('q2'));
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    expect(button(/Send answer/).disabled).toBe(true);
    expect(answer).not.toHaveBeenCalled();
  });

  it('keeps what was picked when a reload brings the same question again', () => {
    const { fixture, button } = mount(pending('q1'));
    button(/Keep/).click();
    fixture.detectChanges();
    fixture.componentRef.setInput('pending', { ...pending('q1'), askedAt: new Date().toISOString() });
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    expect(button(/Send answer/).disabled).toBe(false);
  });

  it('says the session changed when the server refuses, and checks again on request', async () => {
    const answer = vi.fn().mockRejectedValue(new ApiError(409, 'seq moved', 'stale'));
    const { fixture, el, refresh, button } = mount(pending('q1'), answer);
    button(/Keep/).click();
    fixture.detectChanges();
    button(/Send answer/).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('The session changed since you looked; check it again');
    refresh.mockClear();
    button(/Check again/).click();
    expect(refresh).toHaveBeenCalled();
  });

  it('takes several questions of one call one after another and sends them together at the end', async () => {
    const two = pending('q1', { items: [
      { question: 'First?', multiSelect: false, options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] },
      { question: 'Which?', multiSelect: true, options: [{ n: 1, label: 'A' }, { n: 2, label: 'B' }] },
    ] });
    const { fixture, el, answer, button } = mount(two);
    button(/Yes/).click();
    fixture.detectChanges();
    button(/Next question/).click();
    fixture.detectChanges();
    expect(answer).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Which?');
    button(/^\s*1\s*A/).click();
    button(/^\s*2\s*B/).click();
    fixture.detectChanges();
    button(/Send answer/).click();
    await fixture.whenStable();
    expect(answer.mock.calls[0][1].answers).toEqual([{ kind: 'option', n: 1 }, { kind: 'options', ns: [1, 2] }]);
  });

  it('offers no options when only the terminal can answer, and points there', () => {
    const { el, button } = mount(pending('q1', { answerable: false, reason: 'This menu has no numbers.' }));
    expect(el.textContent).toContain('This menu has no numbers.');
    expect(el.textContent).toContain('Answer in the terminal');
    expect(button(/Keep/)).toBeUndefined();
  });
});
