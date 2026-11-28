import { productName } from '../words';

export type StartMode = 'prompt' | 'command' | 'issue' | 'pr';

export interface Draft {
  repo: string;
  mode: StartMode;
}

const KEY = `${productName}:start`;
const EMPTY: Draft = { repo: '', mode: 'prompt' };
const MODES: StartMode[] = ['prompt', 'command', 'issue', 'pr'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved choice on Start; storage that is missing, blocked or damaged gives the default. */
export function loadDraft(store: StorageLike | null = storage()): Draft {
  try {
    const value = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<Draft> | null;
    return {
      repo: typeof value?.repo === 'string' ? value.repo : '',
      mode: MODES.includes(value?.mode as StartMode) ? (value!.mode as StartMode) : 'prompt',
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Saves the repo and the way of starting that was last used. A prompt is never kept. */
export function saveDraft(draft: Draft, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Private windows and full storage are fine: the choice just is not kept.
  }
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
