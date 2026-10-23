import { Injectable } from '@angular/core';
import type { Action } from '../words';
import type { Approval, Health, AuditRow, Repo, Run, RunDetail } from '../models';

/** A failed request: the status and the server's own words. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

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
      throw new ApiError(0, "Can't reach the server.");
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
      const message = (parsed as { error?: string } | null)?.error ?? `The server answered ${response.status}.`;
      throw new ApiError(response.status, message);
    }
    return parsed as T;
  }

  async runs(): Promise<Run[]> {
    return (await this.call<{ runs: Run[] }>('GET', '/api/runs?limit=50')).runs;
  }

  async run(id: string): Promise<RunDetail> {
    return (await this.call<{ run: RunDetail }>('GET', `/api/runs/${encodeURIComponent(id)}`)).run;
  }

  health(): Promise<Health> {
    return this.call<Health>('GET', '/api/health');
  }

  async approvals(): Promise<Approval[]> {
    return (await this.call<{ approvals: Approval[] }>('GET', '/api/approvals?status=pending')).approvals;
  }

  async repos(): Promise<Repo[]> {
    return (await this.call<{ repos: Repo[] }>('GET', '/api/repos')).repos;
  }

  async audit(limit: number): Promise<AuditRow[]> {
    return (await this.call<{ audit: AuditRow[] }>('GET', `/api/audit?limit=${limit}`)).audit;
  }

  async startRun(input: { repo: string; action: Action; task: string; clientId: string }): Promise<Run> {
    return (await this.call<{ run: Run }>('POST', '/api/runs', input)).run;
  }

  reply(id: string, text: string): Promise<unknown> {
    return this.call('POST', `/api/runs/${encodeURIComponent(id)}/input`, { text });
  }

  stop(id: string): Promise<unknown> {
    return this.call('POST', `/api/runs/${encodeURIComponent(id)}/stop`, { confirm: true });
  }

  decide(id: string, decision: 'allow' | 'deny'): Promise<unknown> {
    return this.call('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision });
  }

  async pushKey(): Promise<string> {
    return (await this.call<{ publicKey: string }>('GET', '/api/push/key')).publicKey;
  }

  async subscribe(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<string> {
    return (await this.call<{ id: string }>('POST', '/api/push/subscriptions', subscription)).id;
  }

  unsubscribe(id: string): Promise<void> {
    return this.call('DELETE', `/api/push/subscriptions/${encodeURIComponent(id)}`);
  }
}
