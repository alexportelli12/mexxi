import type { Expect, Phase, Session, SessionStatus } from '../models';
import { brand, numberWord, sessionsPhrase } from '../words';

/** Which of the three groups a status counts in: only blocked waits on you. */
export const phaseOf = (status: SessionStatus): Phase => (status === 'blocked' ? 'waiting' : status === 'working' ? 'working' : 'idle');

export interface Counts {
  waiting: number;
  working: number;
  idle: number;
}

export function countPhases(sessions: readonly Pick<Session, 'status' | 'alive'>[]): Counts {
  const counts: Counts = { waiting: 0, working: 0, idle: 0 };
  for (const session of sessions) counts[phaseOf(session.status)] += 1;
  return counts;
}

export interface BarSegment {
  phase: Phase | 'neutral';
  /** The count; empty for the offline bar, which carries only words. */
  n: string;
  word: string;
  /** Relative width. A lone session still gets room for its words. */
  flex: number;
}

/** The status bar: one segment per group that has sessions, or one neutral segment when atlas can't be seen. */
export function barSegments(counts: Counts, offline: { lastSeen: string } | null): BarSegment[] {
  if (offline) return [{ phase: 'neutral', n: '', word: `Last seen at ${offline.lastSeen}`, flex: 1 }];
  const groups: [Phase, number][] = [['waiting', counts.waiting], ['working', counts.working], ['idle', counts.idle]];
  return groups.filter(([, n]) => n > 0).map(([phase, n]) => ({ phase, n: String(n), word: phase, flex: Math.max(n, 1.3) }));
}

/** "Sessions: 1 waiting, 2 working, 1 idle", for screen readers; colour never carries the count alone. */
export function barLabel(counts: Counts, offline: { lastSeen: string } | null, host = 'atlas'): string {
  if (offline) return `${host} offline, last seen at ${offline.lastSeen}`;
  const parts = (['waiting', 'working', 'idle'] as const).filter((phase) => counts[phase] > 0).map((phase) => `${counts[phase]} ${phase}`);
  return parts.length ? `Sessions: ${parts.join(', ')}` : 'No sessions';
}

export interface Heading {
  title: string;
  sub: string;
}

/** What the top of Now says. `toReview` is the number of pull requests waiting for you, when it is known. */
export function heading(counts: Counts, options: { offline: boolean; toReview: number | null; desktop?: boolean; host?: string }): Heading {
  const total = counts.waiting + counts.working + counts.idle;
  const host = options.host ?? 'atlas';
  if (options.offline) return { title: `Can’t see ${host} right now`, sub: `Your sessions keep running in herdr. ${brand} reconnects on its own.` };
  if (counts.waiting >= 2) {
    return { title: `${sessionsPhrase(counts.waiting, { sentence: true })} are waiting for you`, sub: 'Answer them in any order. Each one picks up again as soon as you reply.' };
  }
  if (counts.waiting === 1) {
    const phrase = sessionsPhrase(total, { sentence: true });
    const reviews = options.toReview ? `${numberWord(options.toReview)} pull request${options.toReview === 1 ? '' : 's'}` : '';
    const sub = options.desktop
      ? `${phrase} on ${host}${reviews ? `, ${reviews} to review` : ''}.`
      : `${phrase} ${total === 1 ? 'is' : 'are'} running on ${host}${reviews ? `, and ${reviews} need${options.toReview === 1 ? 's' : ''} your review` : ''}.`;
    return { title: 'One session is waiting for you', sub };
  }
  if (counts.working > 0) {
    return { title: 'Nothing needs you right now', sub: `${sessionsPhrase(counts.working, { sentence: true })} ${counts.working === 1 ? 'is' : 'are'} working. You’ll get a notification the moment one asks you something.` };
  }
  return { title: 'Nothing needs you right now', sub: total ? 'Every session is idle. Start one with the plus button.' : 'No sessions are running. Start one with the plus button.' };
}

/** "41m", "2h", "3d": how long ago, for a list row. */
export function shortAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "41 min", "2 h", "3 days": the same, spelled out for a session's header. */
export function longAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** The one word under a session's title. Colour comes with it, never instead of it. */
/** What a request about a session says the person saw: sent back so the server can refuse if it moved. */
export const expectOf = (session: Pick<Session, 'id' | 'terminalId' | 'status' | 'seq'>): Expect => ({ terminalId: session.terminalId, sessionId: session.id, status: session.status, seq: session.seq });

export function stateWord(session: Pick<Session, 'status' | 'alive' | 'waitingOn'>): string {
  if (!session.alive) return 'Finished';
  switch (session.status) {
    case 'blocked': return session.waitingOn === 'permission' ? 'Needs your approval' : 'Waiting for you';
    case 'working': return 'Working';
    case 'done': return 'Finished';
    case 'idle': return 'Idle';
    default: return 'Unknown';
  }
}

/** Waiting first, then working, then the rest; inside a group the newest activity leads. */
export function sortSessions<T extends Pick<Session, 'status' | 'lastActivityAt'>>(sessions: readonly T[]): T[] {
  const rank: Record<Phase, number> = { waiting: 0, working: 1, idle: 2 };
  return [...sessions].sort((a, b) => rank[phaseOf(a.status)] - rank[phaseOf(b.status)] || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** "17:21", in the viewer's own time. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** The heading of a day group on Activity: Today, Yesterday, then the date. */
export function dayLabel(iso: string, now: number): string {
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const diff = Math.round((day(now) - day(Date.parse(iso))) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
