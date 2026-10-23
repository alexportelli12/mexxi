import { BACKOFF_MS, backoffFor } from './live';

describe('reconnect backoff', () => {
  it('waits 1 s, 2 s, 5 s, 10 s, then 10 s every time', () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 5000, 10_000]);
    expect([0, 1, 2, 3, 4, 20].map(backoffFor)).toEqual([1000, 2000, 5000, 10_000, 10_000, 10_000]);
  });
});
