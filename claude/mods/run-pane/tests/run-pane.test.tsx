import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { info, stats } from './recorded.mjs'

const SESSION = info.sessionId
const PANE = {
  plugin: 'run-pane',
  component: 'Pane',
  requestId: 'run-pane',
  props: {
    title: 'mexxi run',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'run-pane',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Answers = { info: unknown; stats: unknown }

// Stands for the engine beneath the mod: ibni answers with the recording, the
// Bash tool with prepare's output, and the session with a context fill.
function engine(on: On, answers: Answers, percent = 20) {
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const [, subcommand] = e.argv
    const json = subcommand === 'info' ? answers.info : answers.stats
    return { value: { exitCode: 0, stdout: JSON.stringify(json), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: JSON.stringify({ operation: 'prepare', sessionId: SESSION }) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'run-pane' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: percent * 2000, percent }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return calls
}

test('a finished run shows its stage, gates, worktree, port and PR link', async ($, on) => {
  const calls = engine(on, { info, stats })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ibni prepare --slug timed' })
  expect(calls).toContainEqual(['ibni', 'info', '--session', SESSION])
  expect(calls).toContainEqual(['ibni', 'stats', '--session', SESSION])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text
    expect(await text(/agent\/timed/)).toBe('agent/timed')
    expect(await text(/^Stage/)).toMatch(/PR open · last step mark-pr succeeded/)
    expect(await text(/^Gates/)).toMatch(/verify passed \(1 of 2 green\) · QA 1 round, 0 findings · review 2 rounds, 4 findings/)
    expect(await text(/^Worktree/)).toContain(info.worktreePath)
    expect(await text(/^Port/)).toMatch(/4300/)
    expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'https://github.com/alexportelli12/example/pull/42' } })
    expect(await text(/Jev triage/)).toBeDefined()
    expect(await text(/userFacing/)).toBe('  userFacing: no (90%)')
    expect(await text(/reviewValue/)).toBe('  reviewValue: 2.4 (60%)')
    await ui.unmount()
  }
})

test('Jev triage is absent until a triage call is answered', async ($, on) => {
  const skipped = { ...stats.triage, status: 'skipped', reason: 'jev.enabled is false', answers: null }
  engine(on, { info, stats: { ...stats, triage: skipped } })
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Jev triage/ })).toBeUndefined()
  await ui.unmount()
})

test('the band suggests a fresh session and adopt once the PR is delivered, and can be dismissed', async ($, on) => {
  engine(on, { info, stats })
  await $.tool.call({ tool: 'Bash', command: `ibni stats --session ${SESSION}` })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /PR delivered/ }))?.text).toContain('ibni adopt --pr https://github.com/alexportelli12/example/pull/42')
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /PR delivered/ })).toBeUndefined()
  await ui.unmount()
})

test('the band suggests a fresh session when context runs high', async ($, on) => {
  const active = { ...stats, state: 'active', prUrl: null }
  engine(on, { info: { ...info, state: 'active', prUrl: null }, stats: active }, 82)
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Context is 82% full/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('the band stays away while context is below claude.contextNudgePercent', async ($, on) => {
  engine(on, { info: { ...info, state: 'active', prUrl: null }, stats: { ...stats, state: 'active', prUrl: null } }, 69)
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Context is/ })).toBeUndefined()
  await ui.unmount()
})

test('without an ibni run the pane says so and the band draws nothing of its own', async ($, on) => {
  engine(on, { info, stats })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /No ibni workspace/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /fresh session/ })).toBeUndefined()
  await band.unmount()
})
