import type { PrSummary, Thread } from './models';
import { actionsFor, awaitingReply, checksAria, countFor, effectiveFilter, filterPrs, fixAsk, mergeNote, openedLine, statusOf, visibleFilters } from './pr-logic';

const pr = (over: Partial<PrSummary>): PrSummary => ({
  repo: 'thats-fair', number: 1, title: 't', url: 'https://github.com/x/y/pull/1', author: 'alex', bot: false, draft: false,
  createdAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 1, groups: ['review'], checks: ['pass', 'pass'], failureNote: null,
  ciRunId: null, unresolvedThreads: 0, bump: null, docsOnly: false, headSha: 'abcdef1234567', headRef: 'agent/x', baseRef: 'main',
  commits: 6, deployWorkflow: null, session: null, ...over,
});

describe('pull request groups', () => {
  const prs = [
    pr({ number: 1, groups: ['review', 'ready'] }),
    pr({ number: 2, groups: ['review'] }),
    pr({ number: 3, groups: ['failing', 'bumps'] }),
    pr({ number: 4, groups: ['bumps', 'ready'] }),
  ];

  it('lists a pull request under every group it is in, so a failing bump shows under Failing and Bumps', () => {
    expect(filterPrs(prs, 'failing').map((p) => p.number)).toEqual([3]);
    expect(filterPrs(prs, 'bumps').map((p) => p.number)).toEqual([3, 4]);
    expect(filterPrs(prs, 'ready').map((p) => p.number)).toEqual([1, 4]);
  });

  it('counts each chip from what its list shows, so a chip never promises rows that are missing', () => {
    expect(countFor(prs, 'all')).toBe(4);
    expect(countFor(prs, 'review')).toBe(2);
    expect(countFor(prs, 'bumps')).toBe(2);
  });

  it('keeps the server order inside a group', () => {
    expect(filterPrs(prs, 'all').map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });

  it('gives phones four chips without All and starts them on To review, and starts wide screens on All', () => {
    expect(visibleFilters(false).map((f) => f.label)).toEqual(['To review', 'Ready', 'Failing', 'Bumps']);
    expect(visibleFilters(true).map((f) => f.label)[0]).toBe('All');
    expect(effectiveFilter(null, false)).toBe('review');
    expect(effectiveFilter(null, true)).toBe('all');
  });

  it('does not strand a phone on a hidden All chip after the window narrows', () => {
    expect(effectiveFilter('all', false)).toBe('review');
    expect(effectiveFilter('failing', false)).toBe('failing');
  });
});

describe('the status line under a title', () => {
  it('reads checks passed for a clean pull request', () => {
    expect(statusOf(pr({}))).toEqual({ text: 'Checks passed', tone: 'good' });
  });

  it('says how many comments wait in the amber tone, with the singular right', () => {
    expect(statusOf(pr({ unresolvedThreads: 2 }))).toEqual({ text: '2 comments to address', tone: 'warn' });
    expect(statusOf(pr({ unresolvedThreads: 1 })).text).toBe('1 comment to address');
  });

  it('uses the server words for a failure and keeps their capitalisation, since check names start in lower case', () => {
    expect(statusOf(pr({ checks: ['pass', 'fail'], failureNote: 'verify:ci failed at lint' }))).toEqual({ text: 'verify:ci failed at lint', tone: 'bad' });
    expect(statusOf(pr({ checks: ['fail'] })).text).toBe('Checks failing');
  });

  it('puts the bump size first and lower-cases our own words after it', () => {
    expect(statusOf(pr({ bump: 'minor' })).text).toBe('Minor, checks passed');
    expect(statusOf(pr({ bump: 'security' })).text).toBe('Security patch, checks passed');
    expect(statusOf(pr({ bump: 'major', checks: ['fail'], failureNote: 'build failing' })).text).toBe('Major, build failing');
  });

  it('reports a pull request whose checks are still running as neutral, not as passed', () => {
    expect(statusOf(pr({ checks: ['pass', 'pending'] }))).toEqual({ text: 'Checks running', tone: 'neutral' });
  });

  it('says docs only when nothing else needs saying', () => {
    expect(statusOf(pr({ docsOnly: true })).text).toBe('Docs only');
  });

  it('describes the check squares for a screen reader, failures first', () => {
    expect(checksAria(['pass', 'fail', 'pass', 'pass'])).toBe('1 of 4 checks failed');
    expect(checksAria(['pass', 'pass'])).toBe('2 checks passed');
    expect(checksAria([])).toBe('No checks');
  });
});

describe('the buttons on a row', () => {
  it('offers Merge to a ready pull request and Review beside it', () => {
    const { main, second } = actionsFor(pr({ groups: ['review', 'ready'] }));
    expect([main.kind, main.primary, second?.kind]).toEqual(['merge', true, 'review']);
  });

  it('never offers Merge on a draft, even when the server calls it ready', () => {
    expect(actionsFor(pr({ groups: ['ready'], draft: true })).main.kind).toBe('review');
  });

  it('offers a fix first on a failing pull request, and a rerun only when there is a run to rerun', () => {
    expect(actionsFor(pr({ checks: ['fail'], groups: ['failing'] })).second).toBeNull();
    expect(actionsFor(pr({ checks: ['fail'], groups: ['failing'], ciRunId: 9 })).second?.kind).toBe('rerun');
    expect(actionsFor(pr({ checks: ['fail'], groups: ['failing', 'ready'] })).main.kind).toBe('fix');
  });

  it('offers a fix beside Review when comments wait', () => {
    expect(actionsFor(pr({ unresolvedThreads: 2 })).second?.kind).toBe('fix');
    expect(actionsFor(pr({})).second).toBeNull();
  });

  it('asks a fix session to start on the failing check before the comments', () => {
    expect(fixAsk(pr({ checks: ['fail'], unresolvedThreads: 3 }))).toBe('failing-check');
    expect(fixAsk(pr({ unresolvedThreads: 3 }))).toBe('review-comments');
    expect(fixAsk(pr({}))).toBeUndefined();
  });
});

describe('the merge sheet text', () => {
  it('names the commits and branch, and mentions the deploy only when there is one', () => {
    expect(mergeNote(pr({ deployWorkflow: 'deploy' }))).toEqual({
      before: 'Squashes 6 commits from ', branch: 'agent/x', after: ' and deletes the branch. thats-fair’s deploy workflow runs next.',
    });
    expect(mergeNote(pr({ commits: 1 })).after).toBe(' and deletes the branch.');
    expect(mergeNote(pr({ commits: 1 })).before).toBe('Squashes 1 commit from ');
  });
});

describe('conversation summaries', () => {
  const thread = (over: Partial<Thread>, lastMine: boolean): Thread => ({
    id: 1, path: null, line: null, resolved: false,
    comments: [{ id: 1, author: 'bot', mine: !lastMine, createdAt: '2026-01-01T00:00:00Z', bodyHtml: '' }, { id: 2, author: 'x', mine: lastMine, createdAt: '2026-01-01T00:00:00Z', bodyHtml: '' }],
    ...over,
  });

  it('counts only open threads you spoke last in, since a resolved or answered thread waits for nobody', () => {
    expect(awaitingReply([thread({}, true), thread({ resolved: true }, true), thread({}, false)])).toBe(1);
    expect(awaitingReply([])).toBe(0);
  });

  it('says a session opened the pull request only when a session is linked, and names the issue when known', () => {
    const session = { id: 's', title: 't', state: 'done' as const };
    expect(openedLine({ author: 'alex', session, issue: 28 }, '1 hour ago')).toBe('Opened 1 hour ago by a session from issue #28');
    expect(openedLine({ author: 'dependabot', session: null, issue: null }, '2 days ago')).toBe('Opened 2 days ago by dependabot');
  });
});
