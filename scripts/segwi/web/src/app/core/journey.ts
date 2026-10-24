import { duration, headline, journey, lastEventAt, progress, snapshotFrom } from '../../../../../../claude/mods/run-pane/hooks/journey';
import type { Stage, StageState, Tone } from '../../../../../../claude/mods/run-pane/hooks/journey';
import type { IbniSnapshot } from '../models';

export type { Stage, StageState };
export { duration };

export interface JourneyView {
  headline: { label: string; tone: Tone };
  stages: Stage[];
  done: number;
  total: number;
  /** "4m on Verify": how long the stage in progress has gone on, while one is. */
  onStage: string | null;
}

/** Each tone of the run pane as a status token class, so colour means the same thing everywhere. */
export const TONE_CLASS: Record<Tone, string> = { success: 'text-done', error: 'text-failed', warning: 'text-muted', claude: 'text-accent' };

/** The run's journey, read from its workspace snapshot with the run pane's own functions; null before the run has a workspace. */
export function journeyView(runId: string, stored: IbniSnapshot | null | undefined, now: number): JourneyView | null {
  if (!stored) return null;
  const snapshot = { ...snapshotFrom(runId, stored, null), error: stored.error };
  const stages = journey(snapshot);
  const { done, total } = progress(stages);
  const current = stages.find((stage) => stage.state === 'current');
  const since = lastEventAt(snapshot);
  const onStage = current && since ? `${duration(now - Date.parse(since))} on ${current.label}` : null;
  return { headline: headline(snapshot), stages, done, total, onStage };
}
