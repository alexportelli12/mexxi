import type { Answer, QuestionItem } from '../models';

/** What the person has chosen for one question item so far. */
export type Pick = { kind: 'option'; n: number } | { kind: 'options'; ns: number[] } | { kind: 'text'; text: string };

/** Taps an option: a single-select item keeps one, a multi-select item toggles it. */
export function tapOption(item: QuestionItem, current: Pick | undefined, n: number): Pick | undefined {
  if (!item.multiSelect) return { kind: 'option', n };
  const had = current?.kind === 'options' ? current.ns : [];
  const ns = had.includes(n) ? had.filter((value) => value !== n) : [...had, n].sort((a, b) => a - b);
  return ns.length ? { kind: 'options', ns } : undefined;
}

export function isPicked(pick: Pick | undefined, n: number): boolean {
  return pick?.kind === 'option' ? pick.n === n : pick?.kind === 'options' ? pick.ns.includes(n) : false;
}

/** True once every item has a choice, and typed text is not blank. */
export function isComplete(items: readonly QuestionItem[], picks: readonly (Pick | undefined)[]): boolean {
  return items.every((_, index) => {
    const pick = picks[index];
    return pick !== undefined && (pick.kind !== 'text' || pick.text.trim().length > 0);
  });
}

/** The request body's answers, one per item in order; throws when one is missing, so nothing half-sent goes out. */
export function toAnswers(items: readonly QuestionItem[], picks: readonly (Pick | undefined)[]): Answer[] {
  return items.map((_, index) => {
    const pick = picks[index];
    if (!pick) throw new Error(`Question ${index + 1} has no answer.`);
    return pick.kind === 'text' ? { kind: 'text', text: pick.text.trim() } : pick;
  });
}

/** The words of a choice, for "You answered ..." lines. */
export function pickLabel(item: QuestionItem, pick: Pick): string {
  if (pick.kind === 'text') return pick.text.trim();
  const ns = pick.kind === 'option' ? [pick.n] : pick.ns;
  return ns.map((n) => item.options.find((option) => option.n === n)?.label ?? String(n)).join(', ');
}
