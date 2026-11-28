import type { BumpKind, CheckState, PrGroup, PrSummary, SessionAsk, Thread } from './models';

export type PrFilter = 'all' | PrGroup;

export const PR_FILTERS: { key: PrFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'To review' },
  { key: 'ready', label: 'Ready' },
  { key: 'failing', label: 'Failing' },
  { key: 'bumps', label: 'Bumps' },
];

/** Phones show the four groups; the desktop list adds All. */
export function visibleFilters(desktop: boolean) {
  return desktop ? PR_FILTERS : PR_FILTERS.filter((f) => f.key !== 'all');
}

export function filterPrs(prs: readonly PrSummary[], filter: PrFilter): PrSummary[] {
  return filter === 'all' ? [...prs] : prs.filter((p) => p.groups.includes(filter));
}

export function countFor(prs: readonly PrSummary[], filter: PrFilter): number {
  return filterPrs(prs, filter).length;
}

/** Phones start on To review and have no All chip, so an All choice made on a wide screen falls back to it. */
export function effectiveFilter(chosen: PrFilter | null, desktop: boolean): PrFilter {
  if (chosen === null) return desktop ? 'all' : 'review';
  return chosen === 'all' && !desktop ? 'review' : chosen;
}

export type Tone = 'good' | 'bad' | 'warn' | 'neutral';

const BUMP_LABEL: Record<BumpKind, string> = { major: 'Major', minor: 'Minor', patch: 'Patch', security: 'Security patch' };

interface StatusInput {
  checks: readonly CheckState[];
  failureNote: string | null;
  unresolvedThreads: number;
  bump: BumpKind | null;
  docsOnly: boolean;
}

/** The line under a title, such as "Minor, checks passed" or "verify:ci failed at lint", and how to colour it. */
export function statusOf(pr: StatusInput): { text: string; tone: Tone } {
  const failed = pr.checks.filter((c) => c === 'fail').length;
  const pending = pr.checks.filter((c) => c === 'pending').length;
  let phrase: string;
  let tone: Tone = 'good';
  let own = false; // the server's own words keep their capitalisation
  if (failed > 0) {
    tone = 'bad';
    own = pr.failureNote !== null;
    phrase = pr.failureNote ?? 'Checks failing';
  } else if (pending > 0) {
    tone = 'neutral';
    phrase = 'Checks running';
  } else if (pr.unresolvedThreads > 0) {
    tone = 'warn';
    phrase = `${pr.unresolvedThreads} ${pr.unresolvedThreads === 1 ? 'comment' : 'comments'} to address`;
  } else {
    phrase = pr.docsOnly ? 'Docs only' : 'Checks passed';
  }
  if (!pr.bump) return { text: phrase, tone };
  const lead = own ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1);
  return { text: `${BUMP_LABEL[pr.bump]}, ${lead}`, tone };
}

/** What a screen reader hears for the row of check squares. */
export function checksAria(checks: readonly CheckState[]): string {
  const count = (state: CheckState) => checks.filter((c) => c === state).length;
  if (checks.length === 0) return 'No checks';
  if (count('fail')) return `${count('fail')} of ${checks.length} checks failed`;
  if (count('pending')) return `${count('pending')} of ${checks.length} checks running`;
  return `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`;
}

export type PrActionKind = 'merge' | 'review' | 'fix' | 'rerun';
export interface PrAction {
  kind: PrActionKind;
  label: string;
  primary: boolean;
}

/** The ask a "fix in a session" starts with: the failing check first, else the open comments. */
export function fixAsk(pr: Pick<PrSummary, 'checks' | 'unresolvedThreads'>): SessionAsk | undefined {
  if (pr.checks.includes('fail')) return 'failing-check';
  return pr.unresolvedThreads > 0 ? 'review-comments' : undefined;
}

/** The buttons on a row: a main one, and at most one smaller one. */
export function actionsFor(pr: PrSummary): { main: PrAction; second: PrAction | null } {
  if (pr.checks.includes('fail')) {
    return {
      main: { kind: 'fix', label: 'Fix in a session', primary: false },
      second: pr.ciRunId === null ? null : { kind: 'rerun', label: 'Rerun checks', primary: false },
    };
  }
  if (pr.groups.includes('ready') && !pr.draft) {
    return { main: { kind: 'merge', label: 'Merge', primary: true }, second: { kind: 'review', label: 'Review', primary: false } };
  }
  return {
    main: { kind: 'review', label: 'Review', primary: false },
    second: pr.unresolvedThreads > 0 ? { kind: 'fix', label: 'Fix in a session', primary: false } : null,
  };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The sentence under the merge sheet's title, split so the branch can be set in code type. */
export function mergeNote(pr: Pick<PrSummary, 'commits' | 'headRef' | 'repo' | 'deployWorkflow'>): { before: string; branch: string; after: string } {
  const commits = `${pr.commits} ${pr.commits === 1 ? 'commit' : 'commits'}`;
  const deploy = pr.deployWorkflow ? ` ${pr.repo}’s ${pr.deployWorkflow} workflow runs next.` : '';
  return { before: `Squashes ${commits} from `, branch: pr.headRef, after: ` and deletes the branch.${deploy}` };
}

/** Open threads whose last word is yours: the ones still waiting for somebody to answer. */
export function awaitingReply(threads: readonly Thread[]): number {
  return threads.filter((t) => !t.resolved && t.comments.at(-1)?.mine === true).length;
}

/** "Opened 1 hour ago by a session from issue #28": says who opened it when the session link is known. */
export function openedLine(pr: Pick<PrSummary, 'author' | 'session'> & { issue: number | null }, age: string): string {
  const who = pr.session ? 'a session' : pr.author;
  return `Opened ${age} by ${who}${pr.issue === null ? '' : ` from issue #${pr.issue}`}`;
}
