import { clearTask, loadDraft, saveDraft } from './draft';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};
const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('full'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('draft persistence', () => {
  it('keeps the repo, action and task between loads', () => {
    const store = memory();
    saveDraft({ repo: 'my-app', action: 'build', task: 'Fix the footer' }, store);
    expect(loadDraft(store)).toEqual({ repo: 'my-app', action: 'build', task: 'Fix the footer' });
  });

  it('clears only the task after a start', () => {
    const store = memory();
    saveDraft({ repo: 'my-app', action: 'ask', task: 'Why?' }, store);
    clearTask(store);
    expect(loadDraft(store)).toEqual({ repo: 'my-app', action: 'ask', task: '' });
  });

  it('survives storage that throws, or holds rubbish', () => {
    expect(loadDraft(throwing)).toEqual({ repo: '', action: '', task: '' });
    expect(() => saveDraft({ repo: 'a', action: 'ask', task: 'b' }, throwing)).not.toThrow();
    expect(() => clearTask(throwing)).not.toThrow();
    const store = memory();
    store.setItem('x', '1');
    expect(loadDraft({ ...store, getItem: () => '{not json' })).toEqual({ repo: '', action: '', task: '' });
    expect(loadDraft({ ...store, getItem: () => JSON.stringify({ repo: 5, action: 'rm -rf', task: null }) })).toEqual({ repo: '', action: '', task: '' });
    expect(loadDraft(null)).toEqual({ repo: '', action: '', task: '' });
  });
});
