import { loadDraft, readSetting, saveDraft, writeSetting } from './draft';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};

describe('start draft', () => {
  it('remembers the repo and the way of starting', () => {
    const store = memory();
    saveDraft({ repo: 'my-repo', mode: 'issue' }, store);
    expect(loadDraft(store)).toEqual({ repo: 'my-repo', mode: 'issue' });
  });

  it('falls back to a prompt when nothing is saved or the saved way is unknown', () => {
    const store = memory();
    expect(loadDraft(store)).toEqual({ repo: '', mode: 'prompt' });
    saveDraft({ repo: 'r', mode: 'wat' as never }, store);
    expect(loadDraft(store).mode).toBe('prompt');
  });

  it('survives storage that throws, as in a private window', () => {
    const blocked = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
    expect(loadDraft(blocked)).toEqual({ repo: '', mode: 'prompt' });
    expect(() => saveDraft({ repo: 'r', mode: 'pr' }, blocked)).not.toThrow();
  });

  it('keeps small settings under their own names and removes them on null', () => {
    const store = memory();
    writeSetting('theme', 'dark', store);
    expect(readSetting('theme', store)).toBe('dark');
    writeSetting('theme', null, store);
    expect(readSetting('theme', store)).toBeNull();
  });
});
