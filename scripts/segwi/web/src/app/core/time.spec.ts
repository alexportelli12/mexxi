import { relativeTime, untilTime } from './time';

describe('time', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('reads relative times in plain words', () => {
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2025-12-31T12:00:00Z', now)).toBe('yesterday');
  });

  it('counts down to an expiry', () => {
    expect(untilTime('2026-01-01T12:42:00Z', now)).toBe('42 min');
    expect(untilTime('2026-01-01T13:05:00Z', now)).toBe('1 h 5 min');
    expect(untilTime('2026-01-01T11:00:00Z', now)).toBe('0 min');
  });
});
