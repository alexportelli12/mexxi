import type { Issue } from './models';

export type IssueFilter = 'all' | 'blockers' | 'nosession';

export const ISSUE_FILTERS: { key: IssueFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'blockers', label: 'Launch blockers' },
  { key: 'nosession', label: 'No session yet' },
];

const BLOCKER_LABEL = 'launch blocker';
const DAY = 86_400_000;

export const isBlocker = (issue: Issue): boolean => issue.labels.some((l) => l.toLowerCase() === BLOCKER_LABEL);

function matches(issue: Issue, filter: IssueFilter): boolean {
  if (filter === 'blockers') return isBlocker(issue);
  if (filter === 'nosession') return issue.session === null;
  return true;
}

/** Applies a chip and the search box; the search looks at the repo, number, title and labels. */
export function filterIssues(issues: readonly Issue[], filter: IssueFilter, query: string): Issue[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return issues.filter((issue) => {
    if (!matches(issue, filter)) return false;
    const haystack = `${issue.repo} #${issue.number} ${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export function countIssues(issues: readonly Issue[], filter: IssueFilter): number {
  return issues.filter((i) => matches(i, filter)).length;
}

export interface IssueGroup {
  repo: string;
  issues: Issue[];
}

/** One group per repo, in the order each repo first appears, so the server's newest-first order decides. */
export function groupByRepo(issues: readonly Issue[]): IssueGroup[] {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) groups.set(issue.repo, [...(groups.get(issue.repo) ?? []), issue]);
  return [...groups].map(([repo, list]) => ({ repo, issues: list }));
}

/** "opened today" or "opened 3 days ago" for a recent issue; null once it is a week old. */
export function openedText(createdAt: string, now: number): string | null {
  const age = now - Date.parse(createdAt);
  if (Number.isNaN(age) || age >= 7 * DAY) return null;
  const days = Math.floor(age / DAY);
  if (days < 1) return 'opened today';
  return days === 1 ? 'opened yesterday' : `opened ${days} days ago`;
}

/** "#46, ux, opened 3 days ago": number first, then what is worth knowing. With a repo for flat lists. */
export function issueMeta(issue: Issue, now: number, withRepo: boolean): string {
  const parts = [withRepo ? `${issue.repo} #${issue.number}` : `#${issue.number}`];
  if (isBlocker(issue)) parts.push('launch blocker');
  if (issue.session) parts.push('a session is working on it');
  else {
    const labels = issue.labels.filter((l) => l.toLowerCase() !== BLOCKER_LABEL);
    if (labels.length) parts.push(labels.join(', '));
    const opened = openedText(issue.createdAt, now);
    if (opened) parts.push(opened);
  }
  return parts.join(', ');
}

/** The sentence under the heading: "23 open across 6 repos. 2 are launch blockers." */
export function issuesSummary(issues: readonly Issue[]): string {
  const repos = new Set(issues.map((i) => i.repo)).size;
  const blockers = issues.filter(isBlocker).length;
  const open = `${issues.length} open across ${repos} ${repos === 1 ? 'repo' : 'repos'}.`;
  if (blockers === 0) return open;
  return `${open} ${blockers === 1 ? '1 is a launch blocker' : `${blockers} are launch blockers`}.`;
}
