import { Injectable } from '@angular/core';
import type {
  Answer, AuditRow, Decision, Expect, Extension, Health, HeldNotification, NotificationPrefs,
  Pending, RepoInfo, Screen, Session, SessionDetail, StartRequest,
} from '../models';

/*
 * THE CONTRACT. Every endpoint the web app calls, with the JSON it sends and receives. The server is
 * written to match this list; types are in ../models.ts. All paths are same-origin, cookie or Tailscale
 * identity, and every POST and PUT carries a JSON body. Errors are { error: string } with the status.
 *
 * Reading
 *   GET  /api/health                      -> Health
 *   GET  /api/repos                       -> { repos: RepoInfo[] }
 *   GET  /api/extensions                  -> { extensions: Extension[] }
 *   GET  /api/sessions                    -> { sessions: Session[] }   every Claude Code session, newest activity first
 *   GET  /api/sessions/:id                -> { session: SessionDetail } :id is a session id or a launch id
 *   GET  /api/sessions/:id/screen         -> { screen: Screen }        the terminal as plain text, with the expect to send back
 *   GET  /api/questions                   -> { questions: Pending[] }  the queue: every pending question or permission, oldest first
 *   GET  /api/notifications/prefs         -> { prefs: NotificationPrefs, held: HeldNotification[] }
 *   GET  /api/audit?limit=<n>             -> { audit: AuditRow[] }     newest first, 90 days
 *   GET  /api/prs, /api/issues            the GitHub screens' own contract, in pages/github/github-api.ts; Now and Start read
 *                                         the pull requests in group "review" and the open issues from them
 *
 * Doing. A request about a session carries the expect the person saw: { terminalId, sessionId, status, seq }.
 * When the session has moved since, the server answers 409 { error, code: "stale" } and sends nothing to the
 * pane; the app shows "The session changed since you looked; check it again".
 *   POST /api/sessions                    body StartRequest      -> { session: { id: string } }   always a new herdr pane; id is the session id, or a launch id until herdr reports one
 *                                         (the GitHub screens send the same route with kind "issue" or "pr" and an optional ask)
 *   POST /api/sessions/:id/answer         body { questionId: string, expect: Expect, answers: Answer[] }
 *                                                                -> { session: Session }   one Answer per question item, in order; a "chat" answer stands alone as the only element
 *   POST /api/sessions/:id/steer          body { expect: Expect, text: string }      -> { session: Session }
 *   POST /api/sessions/:id/keys           body { expect: Expect, keys?: string[], text?: string }
 *                                         keys are herdr key names ("escape", "tab", "shift-tab", "up", "down", "enter",
 *                                         "1", "/", "ctrl-c"); text is typed first, keys after   -> { session: Session }
 *   POST /api/sessions/:id/esc            body { expect: Expect }                    -> { session: Session }
 *   POST /api/sessions/:id/end            body { confirm: true, expect: Expect }     -> { session: Session }
 *   POST /api/sessions/:id/resume         body { prompt?: string }                   -> { session: { id: string } }   a new pane running the same session
 *   POST /api/sessions/:id/rename         body { title: string }                     -> { session: Session }
 *   POST /api/approvals/:id               :id is a Pending id of kind permission, plan or trust
 *        body { decision: "once" | "always" | "deny", expect: Expect, reason?: string,
 *               rule?: string, confirm?: true }
 *        "always" is refused without confirm: true and a rule equal to the one the person saw  -> { session: Session }
 *        "deny" may carry a reason, which is typed back to Claude
 *   PUT  /api/notifications/prefs         body NotificationPrefs                     -> { prefs: NotificationPrefs, held: HeldNotification[] }
 *   POST /api/notifications/held/seen     body { ids: string[] }                     -> { held: HeldNotification[] }
 *   POST /api/push/subscriptions          body { endpoint, keys: { p256dh, auth } }  -> { id: string }
 *   DELETE /api/push/subscriptions/:id    -> 204
 *   GET  /api/push/key                    -> { publicKey: string }
 *
 * Live
 *   GET  /api/stream  (Server-Sent Events). Each event's data is JSON; the app refetches what the event names.
 *        event: session     { sessionId, at }         a session's status, title or links changed
 *        event: question    { sessionId, id, at }     a question or permission arrived or was answered
 *        event: transcript  { sessionId, seq, at }    the transcript or the screen of a session moved
 *        event: reset       {}                        too much was missed to replay: reload everything
 */

/** A failed request: the status, the server's own words and its machine code when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

export const STALE_MESSAGE = 'The session changed since you looked; check it again';

/** True for the server's refusal to send anything because the session moved after the person looked. */
export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && (error.code === 'stale' || error.code === null);

/** The words to show for a failed action: the stale refusal always reads the same. */
export const failureMessage = (error: unknown): string => {
  if (isStale(error)) return STALE_MESSAGE;
  return error instanceof Error ? error.message : 'Something went wrong.';
};

@Injectable({ providedIn: 'root' })
export class ApiService {
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
      throw new ApiError(0, 'Can’t reach the server.');
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const failure = parsed as { error?: string; code?: string } | null;
      throw new ApiError(response.status, failure?.error ?? `The server answered ${response.status}.`, failure?.code ?? null);
    }
    return parsed as T;
  }

  private static id = (id: string): string => encodeURIComponent(id);

  health(): Promise<Health> {
    return this.call<Health>('GET', '/api/health');
  }

  async repos(): Promise<RepoInfo[]> {
    return (await this.call<{ repos: RepoInfo[] }>('GET', '/api/repos')).repos;
  }

  async extensions(): Promise<Extension[]> {
    return (await this.call<{ extensions: Extension[] }>('GET', '/api/extensions')).extensions;
  }

  async sessions(): Promise<Session[]> {
    return (await this.call<{ sessions: Session[] }>('GET', '/api/sessions')).sessions;
  }

  async session(id: string): Promise<SessionDetail> {
    return (await this.call<{ session: SessionDetail }>('GET', `/api/sessions/${ApiService.id(id)}`)).session;
  }

  async screen(id: string): Promise<Screen> {
    return (await this.call<{ screen: Screen }>('GET', `/api/sessions/${ApiService.id(id)}/screen`)).screen;
  }

  async questions(): Promise<Pending[]> {
    return (await this.call<{ questions: Pending[] }>('GET', '/api/questions')).questions;
  }

  start(request: StartRequest): Promise<{ session: { id: string } }> {
    return this.call('POST', '/api/sessions', request);
  }

  answer(sessionId: string, input: { questionId: string; expect: Expect; answers: Answer[] }): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/answer`, input);
  }

  steer(sessionId: string, expect: Expect, text: string): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/steer`, { expect, text });
  }

  keys(sessionId: string, expect: Expect, input: { keys?: string[]; text?: string }): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/keys`, { expect, ...input });
  }

  esc(sessionId: string, expect: Expect): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/esc`, { expect });
  }

  end(sessionId: string, expect: Expect): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/end`, { confirm: true, expect });
  }

  resume(sessionId: string, prompt?: string): Promise<{ session: { id: string } }> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/resume`, prompt ? { prompt } : {});
  }

  rename(sessionId: string, title: string): Promise<unknown> {
    return this.call('POST', `/api/sessions/${ApiService.id(sessionId)}/rename`, { title });
  }

  /** Approve once, deny, or always allow; "always" must carry confirm and the rule text the person saw. */
  decide(pendingId: string, input: { decision: Decision; expect: Expect; reason?: string; rule?: string }): Promise<unknown> {
    const confirm = input.decision === 'always' ? { confirm: true } : {};
    return this.call('POST', `/api/approvals/${ApiService.id(pendingId)}`, { ...input, ...confirm });
  }

  async notificationPrefs(): Promise<{ prefs: NotificationPrefs; held: HeldNotification[] }> {
    return this.call('GET', '/api/notifications/prefs');
  }

  savePrefs(prefs: NotificationPrefs): Promise<{ prefs: NotificationPrefs; held: HeldNotification[] }> {
    return this.call('PUT', '/api/notifications/prefs', prefs);
  }

  async heldSeen(ids: string[]): Promise<HeldNotification[]> {
    return (await this.call<{ held: HeldNotification[] }>('POST', '/api/notifications/held/seen', { ids })).held;
  }

  async audit(limit: number): Promise<AuditRow[]> {
    return (await this.call<{ audit: AuditRow[] }>('GET', `/api/audit?limit=${limit}`)).audit;
  }

  async pushKey(): Promise<string> {
    return (await this.call<{ publicKey: string }>('GET', '/api/push/key')).publicKey;
  }

  async subscribe(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<string> {
    return (await this.call<{ id: string }>('POST', '/api/push/subscriptions', subscription)).id;
  }

  unsubscribe(id: string): Promise<void> {
    return this.call('DELETE', `/api/push/subscriptions/${ApiService.id(id)}`);
  }
}
