import type { Issue } from './models';
import { countIssues, filterIssues, groupByRepo, issueMeta, issuesSummary, openedText } from './issue-logic';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const issue = (over: Partial<Issue>): Issue => ({
  repo: 'thats-fair', number: 1, title: 'Title', url: 'https://github.com/x/y/issues/1', labels: [], createdAt: '2026-01-01T00:00:00Z', session: null, ...over,
});
const working = { id: 's1', title: 'x', state: 'working' as const };

describe('issue filters', () => {
  const issues = [
    issue({ number: 19, labels: ['Launch blocker'] }),
    issue({ number: 52, session: working }),
    issue({ number: 46, repo: 'my-repo', title: 'Map pins overlap on phones', labels: ['ux'] }),
  ];

  it('treats the launch blocker label as a blocker whatever its capitalisation', () => {
    expect(filterIssues(issues, 'blockers', '').map((i) => i.number)).toEqual([19]);
  });

  it('keeps issues with a session out of No session yet, and counts match the lists', () => {
    expect(filterIssues(issues, 'nosession', '').map((i) => i.number)).toEqual([19, 46]);
    expect(countIssues(issues, 'nosession')).toBe(2);
    expect(countIssues(issues, 'all')).toBe(3);
  });

  it('searches every repo by title, label, repo name and number, and needs every word to match', () => {
    expect(filterIssues(issues, 'all', 'map pins').map((i) => i.number)).toEqual([46]);
    expect(filterIssues(issues, 'all', 'UX').map((i) => i.number)).toEqual([46]);
    expect(filterIssues(issues, 'all', 'my-repo #46').map((i) => i.number)).toEqual([46]);
    expect(filterIssues(issues, 'all', 'map zzz')).toEqual([]);
  });

  it('combines a chip with the search', () => {
    expect(filterIssues(issues, 'blockers', 'map')).toEqual([]);
  });
});

describe('issue groups and copy', () => {
  it('groups by repo in the order repos first appear', () => {
    const groups = groupByRepo([issue({ repo: 'b', number: 1 }), issue({ repo: 'a', number: 2 }), issue({ repo: 'b', number: 3 })]);
    expect(groups.map((g) => [g.repo, g.issues.map((i) => i.number)])).toEqual([['b', [1, 3]], ['a', [2]]]);
  });

  it('says opened today or N days ago for a recent issue and nothing for an old one', () => {
    expect(openedText('2026-06-10T01:00:00Z', NOW)).toBe('opened today');
    expect(openedText('2026-06-09T01:00:00Z', NOW)).toBe('opened yesterday');
    expect(openedText('2026-06-07T01:00:00Z', NOW)).toBe('opened 3 days ago');
    expect(openedText('2026-06-03T01:00:00Z', NOW)).toBeNull();
  });

  it('writes the meta line as number, blocker, labels, age', () => {
    expect(issueMeta(issue({ number: 19, labels: ['launch blocker'], createdAt: '2026-01-01T00:00:00Z' }), NOW, false)).toBe('#19, launch blocker');
    expect(issueMeta(issue({ number: 46, labels: ['ux'], createdAt: '2026-06-07T01:00:00Z' }), NOW, false)).toBe('#46, ux, opened 3 days ago');
    expect(issueMeta(issue({ number: 91, repo: 'my-repo', createdAt: '2026-06-10T09:00:00Z' }), NOW, true)).toBe('my-repo #91, opened today');
  });

  it('says a session is working on it instead of listing labels', () => {
    expect(issueMeta(issue({ number: 52, labels: ['ux'], session: working }), NOW, false)).toBe('#52, a session is working on it');
  });

  it('summarises the open count, repos and blockers with singulars right', () => {
    expect(issuesSummary([issue({}), issue({ repo: 'b', labels: ['launch blocker'] })])).toBe('2 open across 2 repos. 1 is a launch blocker.');
    expect(issuesSummary([issue({ labels: ['launch blocker'] }), issue({ number: 2, labels: ['launch blocker'] })])).toBe('2 open across 1 repo. 2 are launch blockers.');
    expect(issuesSummary([issue({})])).toBe('1 open across 1 repo.');
  });
});
