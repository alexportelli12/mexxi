import type { ActivityKind, AuditRow } from '../models';
import { clockTime, dayLabel } from './session-view';

export interface ActivityItem {
  id: number;
  text: string;
  where: string;
  kind: ActivityKind;
  time: string;
}

export interface ActivityDay {
  name: string;
  items: ActivityItem[];
}

export const FILTERS: { id: ActivityKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'answer', label: 'Answers' },
  { id: 'merge', label: 'Merges' },
  { id: 'session', label: 'Sessions' },
  { id: 'rule', label: 'Rules' },
  { id: 'ci', label: 'CI' },
];

/** The kind of an audit action when the server sent none, by the prefix of its name. */
export function kindOf(action: string): ActivityKind {
  if (/answer|steer|decision|approval\.(once|allowed|deny|denied)/.test(action)) return 'answer';
  if (/merge|review/.test(action)) return 'merge';
  if (/rule|always/.test(action)) return 'rule';
  if (/^ci|rerun/.test(action)) return 'ci';
  if (/session|start|end|resume|rename|launch/.test(action)) return 'session';
  return 'other';
}

/** One audit row in words. The server's own text wins; the fallback reads the action name and what it touched. */
export function describe(row: AuditRow): ActivityItem {
  const kind = row.kind ?? kindOf(row.action);
  const text = row.text ?? [row.action.replace(/[._]/g, ' '), row.target].filter(Boolean).join(' ');
  return { id: row.id, text: text.charAt(0).toUpperCase() + text.slice(1), where: row.where ?? row.detail, kind, time: clockTime(row.at) };
}

/** Rows grouped by local day, newest first, filtered to one kind when a filter is chosen. */
export function groupByDay(rows: readonly AuditRow[], filter: ActivityKind | 'all', now: number): ActivityDay[] {
  const days: ActivityDay[] = [];
  const sorted = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const row of sorted) {
    const item = describe(row);
    if (filter !== 'all' && item.kind !== filter) continue;
    const name = dayLabel(row.at, now);
    const last = days.at(-1);
    if (last?.name === name) last.items.push(item);
    else days.push({ name, items: [item] });
  }
  return days;
}
