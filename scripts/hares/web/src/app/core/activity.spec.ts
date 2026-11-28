import type { AuditRow } from '../models';
import { groupByDay, kindOf } from './activity';

const row = (id: number, when: string, extra: Partial<AuditRow> = {}): AuditRow => ({ id, at: new Date(when).toISOString(), actor: 'a', origin: 'web', action: 'session.answer', target: '', outcome: 'ok', detail: '', ...extra });

describe('activity', () => {
  const now = new Date('2026-11-28T18:00:00').getTime();

  it('groups rows by local day, newest first, with the day named', () => {
    const days = groupByDay([row(1, '2026-11-27T09:00:00', { text: 'Older' }), row(2, '2026-11-28T10:00:00', { text: 'First' }), row(3, '2026-11-28T11:00:00', { text: 'Second' })], 'all', now);
    expect(days.map((day) => [day.name, day.items.map((item) => item.text)])).toEqual([['Today', ['Second', 'First']], ['Yesterday', ['Older']]]);
  });

  it('shows only one kind when a filter is chosen, and the server’s own words win', () => {
    const rows = [row(1, '2026-11-28T10:00:00', { kind: 'merge', text: 'Merged it' }), row(2, '2026-11-28T11:00:00', { kind: 'rule', text: 'Added a rule' })];
    expect(groupByDay(rows, 'rule', now)[0].items.map((item) => item.text)).toEqual(['Added a rule']);
  });

  it('reads the kind from the action when the server sent none', () => {
    expect(kindOf('session.answer')).toBe('answer');
    expect(kindOf('pr.merge')).toBe('merge');
    expect(kindOf('approval.always')).toBe('rule');
    expect(kindOf('ci.rerun')).toBe('ci');
    expect(kindOf('session.end')).toBe('session');
  });
});
