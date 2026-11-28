import { describe, expect, it } from 'vitest';
import { sharedReason } from './readiness';

const NOT_SET_UP = "Can't tell: The GitHub data source isn't set up.";
const failing = (name: string, detail: string) => ({ name, pass: false, detail });

describe('sharedReason', () => {
  it('names the reason three or more checks failed for, so the page says it once', () => {
    const checks = [failing('a', NOT_SET_UP), failing('b', NOT_SET_UP), failing('c', NOT_SET_UP), failing('d', 'No review round ran.')];
    expect(sharedReason(checks)).toBe(NOT_SET_UP);
  });

  it('leaves two failures with the same reason on their own rows', () => {
    expect(sharedReason([failing('a', NOT_SET_UP), failing('b', NOT_SET_UP), failing('c', 'No review round ran.')])).toBeNull();
  });

  it('never counts passing checks as a shared reason', () => {
    const passing = (name: string) => ({ name, pass: true, detail: 'Fine.' });
    expect(sharedReason([passing('a'), passing('b'), passing('c')])).toBeNull();
  });
});
