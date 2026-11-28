import type { Readiness } from '../models';

/** How many checks must fail for one reason before the page says that reason once, above the list. */
const SHARED_AT = 3;

/**
 * The reason several checks failed for, when one cause (such as GitHub not being set up) explains them all,
 * so the page states it once instead of on every row. Null when no reason is shared that widely.
 */
export function sharedReason(checks: Readiness['checks']): string | null {
  const counts = new Map<string, number>();
  for (const check of checks) if (!check.pass) counts.set(check.detail, (counts.get(check.detail) ?? 0) + 1);
  let best: string | null = null;
  for (const [detail, count] of counts) if (count >= SHARED_AT && (best === null || count > counts.get(best)!)) best = detail;
  return best;
}
