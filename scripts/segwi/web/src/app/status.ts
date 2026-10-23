import type { Run, RunStatus } from './models';

export type IconName = 'clock' | 'spinner' | 'bubble' | 'shield' | 'check' | 'cross' | 'square';

export interface StatusInfo {
  copy: string;
  icon: IconName;
  /** Tailwind text colour class, from the status tokens. */
  tone: string;
}

/** One map for every run state: its words, its icon and its tone. Colour never stands alone. */
export const STATUS: Record<RunStatus, StatusInfo> = {
  queued: { copy: 'Waiting to start', icon: 'clock', tone: 'text-muted' },
  running: { copy: 'Working', icon: 'spinner', tone: 'text-text' },
  needs_input: { copy: 'Needs your reply', icon: 'bubble', tone: 'text-needs-you' },
  needs_approval: { copy: 'Needs your OK', icon: 'shield', tone: 'text-needs-you' },
  completed: { copy: 'Done', icon: 'check', tone: 'text-done' },
  failed: { copy: 'Failed', icon: 'cross', tone: 'text-failed' },
  stopped: { copy: 'Stopped by you', icon: 'square', tone: 'text-stopped' },
  timed_out: { copy: 'Stopped: no activity', icon: 'square', tone: 'text-stopped' },
};

export const STATUSES = Object.keys(STATUS) as RunStatus[];
export const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'needs_input', 'needs_approval'];

/** Minutes of silence before a timed-out run was stopped, from the reason the server recorded. */
export function idleMinutes(reason: string | null | undefined): number | null {
  const found = /No activity for (\d+) min/.exec(reason ?? '');
  return found ? Number(found[1]) : null;
}

/** The words for a run's state; a timed-out run says how long it was quiet. */
export function statusCopy(status: RunStatus, run?: Pick<Run, 'reason'>): string {
  if (status === 'timed_out') {
    const minutes = idleMinutes(run?.reason);
    return minutes === null ? STATUS.timed_out.copy : `Stopped: no activity for ${minutes} min`;
  }
  return STATUS[status].copy;
}

export const isFinal = (status: RunStatus): boolean => !ACTIVE_STATUSES.includes(status);
