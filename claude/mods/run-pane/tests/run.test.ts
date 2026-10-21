import { expect, test } from 'claude-code/testing'

import { nudgePercentFrom, sessionIdFrom } from '../hooks/run'

test('finds the ibni session a command worked on', () => {
  expect(sessionIdFrom('ibni record --session abc123 --verify pass', '')).toBe('abc123')
  expect(sessionIdFrom('cd ~ && ibni info --session=abc123', '')).toBe('abc123')
  expect(sessionIdFrom('implementation-workspace publish --session abc123', '')).toBe('abc123')
  expect(sessionIdFrom('ibni prepare --slug x', '{"operation":"prepare","sessionId":"f00d"}')).toBe('f00d')
  expect(sessionIdFrom('ibni list', '{"sessionId":"f00d"}')).toBeNull()
  expect(sessionIdFrom('git status', '')).toBeNull()
})

test('reads claude.contextNudgePercent from config.json, defaulting to 70', () => {
  expect(nudgePercentFrom('{"claude":{"contextNudgePercent":55}}')).toBe(55)
  expect(nudgePercentFrom('{}')).toBe(70)
  expect(nudgePercentFrom(undefined)).toBe(70)
  expect(nudgePercentFrom('not json')).toBe(70)
})
