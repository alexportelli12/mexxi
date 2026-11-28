import { DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import type { SessionDetail } from '../models';
import { ApiError, ApiService } from './api';
import { LiveService } from './live';

/**
 * Follows one session's detail: loads it, and loads it again when the stream says that session moved or
 * when events may have been missed. Call it in a component's constructor with a function that gives the
 * session id; the id changing starts again. A launch id is accepted until herdr reports the session id.
 */
export function trackSession(id: () => string | null) {
  const api = inject(ApiService);
  const live = inject(LiveService);
  const destroyRef = inject(DestroyRef);
  const detail = signal<SessionDetail | null>(null);
  const error = signal<string | null>(null);
  const missing = signal(false);
  let latest = 0;

  async function load(): Promise<void> {
    const wanted = id();
    if (!wanted) return;
    const mine = ++latest;
    try {
      const loaded = await api.session(wanted);
      if (mine !== latest) return;
      detail.set(loaded);
      error.set(null);
      missing.set(false);
    } catch (failure) {
      if (mine !== latest) return;
      missing.set(failure instanceof ApiError && failure.status === 404);
      error.set((failure as Error).message);
    }
  }

  effect(() => {
    id();
    untracked(() => {
      detail.set(null);
      missing.set(false);
      void load();
    });
  });
  const moved = live.events.subscribe((event) => {
    if (event.sessionId === id() || event.sessionId === detail()?.id) void load();
  });
  const reloaded = live.reloads.subscribe(() => void load());
  destroyRef.onDestroy(() => {
    moved.unsubscribe();
    reloaded.unsubscribe();
  });
  return { detail, error, missing, reload: load };
}
