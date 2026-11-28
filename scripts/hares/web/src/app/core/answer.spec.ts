import type { QuestionItem } from '../models';
import { isComplete, isPicked, pickLabel, tapOption, toAnswers } from './answer';

const single: QuestionItem = { question: 'Which?', multiSelect: false, options: [{ n: 1, label: 'Keep' }, { n: 2, label: 'Drop' }] };
const multi: QuestionItem = { question: 'Which ones?', multiSelect: true, options: [{ n: 1, label: 'A' }, { n: 2, label: 'B' }, { n: 3, label: 'C' }] };

describe('answering', () => {
  it('keeps one pick for a single-select question and swaps it when another is tapped', () => {
    const first = tapOption(single, undefined, 1);
    expect(first).toEqual({ kind: 'option', n: 1 });
    expect(tapOption(single, first, 2)).toEqual({ kind: 'option', n: 2 });
    expect(isPicked(first, 1)).toBe(true);
    expect(isPicked(first, 2)).toBe(false);
  });

  it('toggles picks of a multi-select question and sends them in order', () => {
    let pick = tapOption(multi, undefined, 3);
    pick = tapOption(multi, pick, 1);
    expect(pick).toEqual({ kind: 'options', ns: [1, 3] });
    expect(tapOption(multi, pick, 3)).toEqual({ kind: 'options', ns: [1] });
    expect(tapOption(multi, tapOption(multi, undefined, 2), 2)).toBeUndefined();
  });

  it('is complete only when every question of a call has an answer, and typed text is not blank', () => {
    expect(isComplete([single, multi], [{ kind: 'option', n: 1 }, undefined])).toBe(false);
    expect(isComplete([single, multi], [{ kind: 'option', n: 1 }, { kind: 'options', ns: [2] }])).toBe(true);
    expect(isComplete([single], [{ kind: 'text', text: '   ' }])).toBe(false);
  });

  it('builds one answer per question in order and refuses to build with one missing', () => {
    expect(toAnswers([single, multi], [{ kind: 'option', n: 2 }, { kind: 'options', ns: [1, 2] }])).toEqual([{ kind: 'option', n: 2 }, { kind: 'options', ns: [1, 2] }]);
    expect(toAnswers([single], [{ kind: 'text', text: ' my own ' }])).toEqual([{ kind: 'text', text: 'my own' }]);
    expect(() => toAnswers([single, multi], [{ kind: 'option', n: 1 }])).toThrow(/Question 2/);
  });

  it('words a choice by its labels for the line that says what was answered', () => {
    expect(pickLabel(multi, { kind: 'options', ns: [1, 3] })).toBe('A, C');
    expect(pickLabel(single, { kind: 'option', n: 2 })).toBe('Drop');
  });
});
