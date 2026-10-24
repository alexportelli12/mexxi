import type { Step } from '../models';

export const RECENT_SHOWN = 3;

/** What the agent is doing now (its latest message or step) and the few before it, newest first. Your replies are left out. */
export function latestActivity(steps: Step[]): { now: Step | null; recent: Step[] } {
  const agent = steps.filter((step) => step.from !== 'you');
  return { now: agent.at(-1) ?? null, recent: agent.slice(-1 - RECENT_SHOWN, -1).reverse() };
}
