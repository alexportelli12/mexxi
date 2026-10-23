import type { Action } from '../words';
import { productName } from '../words';

export interface Draft {
  repo: string;
  action: Action | '';
  task: string;
}

const KEY = `${productName}:new-run`;
const EMPTY: Draft = { repo: '', action: '', task: '' };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved draft; storage that is missing, blocked or damaged gives an empty one. */
export function loadDraft(store: StorageLike | null = storage()): Draft {
  try {
    const value = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<Draft> | null;
    return {
      repo: typeof value?.repo === 'string' ? value.repo : '',
      action: value?.action === 'build' || value?.action === 'ready' || value?.action === 'ask' ? value.action : '',
      task: typeof value?.task === 'string' ? value.task : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Saves the draft; the repo and action stay after a start, the task does not. */
export function saveDraft(draft: Draft, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Private windows and full storage are fine: the draft just is not kept.
  }
}

export function clearTask(store: StorageLike | null = storage()): void {
  saveDraft({ ...loadDraft(store), task: '' }, store);
}

/** A small key-value helper for other per-viewer conveniences, with the same safety. */
export function readSetting(name: string, store: StorageLike | null = storage()): string | null {
  try {
    return store?.getItem(`${productName}:${name}`) ?? null;
  } catch {
    return null;
  }
}

export function writeSetting(name: string, value: string | null, store: StorageLike | null = storage()): void {
  try {
    if (value === null) store?.removeItem(`${productName}:${name}`);
    else store?.setItem(`${productName}:${name}`, value);
  } catch {
    // Not kept.
  }
}
