import { Injectable } from '@angular/core';
import type { CiRepo, Issue, PrDetail, PrSummary, ReviewEvent, SessionAsk } from './models';

/*
 * The server contract for the GitHub screens. Every call is same-origin JSON; a failure answers
 * { error: string } with a 4xx or 5xx status. Types are in ./models.ts. Repos are the configured
 * repo names (the path segment is URL-encoded); "n" is the pull request number.
 *
 * Reads (the read-only token):
 *   GET  /api/prs                      -> { prs: PrSummary[] }              open pull requests of every configured repo, newest first,
 *                                         each with its "groups" (review | ready | failing | bumps)
 *   GET  /api/prs/:repo/:n             -> { pr: PrDetail }                  description, threads, checks, files, readiness, linked session
 *   GET  /api/issues                   -> { issues: Issue[] }               open issues (no pull requests), newest first
 *   GET  /api/ci                       -> { repos: CiRepo[] }               newest run and run history on each repo's default branch
 *
 * Writes (a person in the web app only; each is audited, none is offered over MCP):
 *   POST /api/prs/:repo/:n/review      { event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE', body: string, startSession?: boolean }
 *                                      -> { ok: true, session?: { id: string } }   a session is started with ask "review-comments" when asked
 *   POST /api/prs/:repo/:n/merge       { headSha: string, method: 'squash' }
 *                                      -> { ok: true }        409 { error } when the head moved since the person saw headSha
 *   POST /api/prs/:repo/:n/reply       { threadId: number, body: string }   -> { ok: true }   threadId is Thread.id
 *   POST /api/prs/:repo/:n/comment     { body: string }                     -> { ok: true }   a conversation comment
 *   POST /api/ci/:repo/:runId/rerun    {}                                   -> { ok: true }   rerun failed jobs
 *   POST /api/sessions                 { kind: 'issue', repo, issue: number }
 *                                      | { kind: 'pr', repo, pr: number, ask?: SessionAsk }
 *                                      -> { session: { id: string } }       always a new herdr pane
 *
 * Timestamps are ISO 8601. HTML fields (bodyHtml) are sanitised on the server; the app still
 * renders them through Angular's sanitiser.
 */

/** A failed request: the status and the server's own words. */
export class GithubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
}

const pr = (repo: string, n: number) => `/api/prs/${encodeURIComponent(repo)}/${n}`;

@Injectable({ providedIn: 'root' })
export class GithubApi {
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GithubApiError(0, "Can’t reach the server.");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new GithubApiError(response.status, (parsed as { error?: string } | null)?.error ?? `The server answered ${response.status}.`);
    }
    return parsed as T;
  }

  async prs(): Promise<PrSummary[]> {
    return (await this.call<{ prs: PrSummary[] }>('GET', '/api/prs')).prs;
  }

  async pr(repo: string, n: number): Promise<PrDetail> {
    return (await this.call<{ pr: PrDetail }>('GET', pr(repo, n))).pr;
  }

  async issues(): Promise<Issue[]> {
    return (await this.call<{ issues: Issue[] }>('GET', '/api/issues')).issues;
  }

  async ci(): Promise<CiRepo[]> {
    return (await this.call<{ repos: CiRepo[] }>('GET', '/api/ci')).repos;
  }

  review(repo: string, n: number, input: { event: ReviewEvent; body: string; startSession: boolean }): Promise<{ session?: { id: string } }> {
    return this.call('POST', `${pr(repo, n)}/review`, input);
  }

  /** Squash-merges after the person confirmed headSha; the server refuses with 409 when the head moved. */
  merge(repo: string, n: number, headSha: string): Promise<unknown> {
    return this.call('POST', `${pr(repo, n)}/merge`, { headSha, method: 'squash' });
  }

  reply(repo: string, n: number, threadId: number, body: string): Promise<unknown> {
    return this.call('POST', `${pr(repo, n)}/reply`, { threadId, body });
  }

  comment(repo: string, n: number, body: string): Promise<unknown> {
    return this.call('POST', `${pr(repo, n)}/comment`, { body });
  }

  rerun(repo: string, runId: number): Promise<unknown> {
    return this.call('POST', `/api/ci/${encodeURIComponent(repo)}/${runId}/rerun`, {});
  }

  async startFromIssue(repo: string, issue: number): Promise<string> {
    return (await this.call<{ session: { id: string } }>('POST', '/api/sessions', { kind: 'issue', repo, issue })).session.id;
  }

  async startFromPr(repo: string, prNumber: number, ask?: SessionAsk): Promise<string> {
    return (await this.call<{ session: { id: string } }>('POST', '/api/sessions', { kind: 'pr', repo, pr: prNumber, ask })).session.id;
  }
}
