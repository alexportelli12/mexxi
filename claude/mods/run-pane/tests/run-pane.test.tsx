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
  on('clock.now', () => ({ value: Date.parse(info.createdAt) + 12 * 60000 }))
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

test('a finished run reads as a card with a status capsule and progress, then the journey, the PR link and the ranked Jev answers', async ($, on) => {
  const calls = engine(on, { info, stats })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ibni prepare --slug timed' })
  expect(calls).toContainEqual(['ibni', 'info', '--session', SESSION])
  expect(calls).toContainEqual(['ibni', 'stats', '--session', SESSION])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text
    expect(await text(/^ PR OPEN /)).toBe(' PR OPEN   started 12m ago')
    expect(await text(/^timed$/)).toBe('timed')
    expect(await text(/^control · /)).toBe('control · port 4300')
    expect(await text(/ of 6$/)).toBe('▰▰▰▰▰▰  6 of 6')
    expect(await text(/Workspace ready/)).toBe('✓ Workspace ready')
    expect(await text(/Build the change/)).toBe('✓ Build the change')
    expect(await text(/Verify/)).toBe('✓ Verify  green · 1 of 2 runs passed')
    expect(await text(/Rendered QA/)).toBe('✓ Rendered QA  1 pass · 0 findings')
    expect(await text(/Independent review/)).toBe('✓ Independent review  2 passes · 4 findings · cross-family')
    expect(await text(/^✓ Pull request/)).toBe('✓ Pull request  #42 open')
    expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'https://github.com/alexportelli12/example/pull/42' } })
    expect(await text(/JEV TRIAGE/)).toBe(' JEV TRIAGE   shadow')
    const rows = (await ui.findAll({ type: 'Text', text: /^\S.*%$/ })).map(row => row.text)
    expect(rows).toEqual([
      '1-way   no     ▰▰▰▰▰▰▰▰▰▰  95%',
      'users   no     ▰▰▰▰▰▰▰▰▰▱  90%',
      'size    local  ▰▰▰▰▰▰▰▰▱▱  80%',
      'UI      no     ▰▰▰▰▰▰▰▰▱▱  80%',
      'review  2.4    ▰▰▰▰▰▰▱▱▱▱  60%',
    ])
    expect(await text(/^1-way: /)).toBeUndefined()
    expect(await text(/^Recorded only/)).toBeDefined()
    expect(await text(/worktrees\/control/)).toBeUndefined()
    await ui.unmount()
  }
})

test('a run in progress names what it is doing and times the current stage', async ($, on) => {
  const active = { ...info, state: 'active', prUrl: null }
  const early = { ...stats, state: 'active', prUrl: null, steps: [stats.steps[0]], verify: undefined, qa: undefined, review: undefined }
  engine(on, { info: active, stats: early })
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text
  expect(await text(/^ BUILDING /)).toBe(' BUILDING   started 12m ago')
  expect(await text(/ of 6$/)).toBe('▰▰▱▱▱▱  1 of 6')
  expect(await text(/Build the change/)).toBe('● Build the change  12m')
  expect(await text(/Verify/)).toBe('○ Verify')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()
})

test('a red verify is the headline and its stage is marked failed', async ($, on) => {
  const active = { ...info, state: 'active', prUrl: null }
  const red = { ...stats, state: 'active', prUrl: null, steps: [stats.steps[0]], verify: { attempts: 1, passed: 0, failed: 1, history: [{ at: stats.verify.history[0].at, outcome: 'fail' }] } }
  engine(on, { info: active, stats: red })
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text
  expect(await text(/NEEDS ATTENTION/)).toBe(' NEEDS ATTENTION   started 12m ago')
  expect(await text(/^✗ Verify/)).toBe('✗ Verify  red · 0 of 1 run passed')
  await ui.unmount()
})

test('Jev triage is absent until a triage call is answered', async ($, on) => {
  const skipped = { ...stats.triage, status: 'skipped', reason: 'jev.enabled is false', answers: null }
  engine(on, { info, stats: { ...stats, triage: skipped } })
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /JEV TRIAGE/ })).toBeUndefined()
  await ui.unmount()
})

test('the band says the PR is delivered and where follow-ups go, and can be dismissed', async ($, on) => {
  engine(on, { info, stats })
  await $.tool.call({ tool: 'Bash', command: `ibni stats --session ${SESSION}` })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /delivered/ }))?.text).toBe(' ✓ PR #42 delivered   Follow-ups go in a fresh session: give /wettaq the PR link.')
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /delivered/ })).toBeUndefined()
  await ui.unmount()
})

test('the band stays out of the way while Claude is working', async ($, on) => {
  engine(on, { info, stats })
  await $.tool.call({ tool: 'Bash', command: `ibni stats --session ${SESSION}` })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /delivered/ })).toBeUndefined()
  await ui.unmount()
})

test('the band suggests a fresh session when context runs high', async ($, on) => {
  const active = { ...stats, state: 'active', prUrl: null }
  engine(on, { info: { ...info, state: 'active', prUrl: null }, stats: active }, 82)
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /82% context/ }))?.text).toBe(' 82% context   Finish this run here, then start the next task in a fresh session.')
  await ui.unmount()
})

test('the band stays away while context is below claude.contextNudgePercent', async ($, on) => {
  engine(on, { info: { ...info, state: 'active', prUrl: null }, stats: { ...stats, state: 'active', prUrl: null } }, 69)
  await $.tool.call({ tool: 'Bash', command: `ibni info --session ${SESSION}` })
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /% context/ })).toBeUndefined()
  await ui.unmount()
})

test('without an ibni run the pane says so and the band draws nothing of its own', async ($, on) => {
  engine(on, { info, stats })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /No run yet/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /fresh session/ })).toBeUndefined()
  await band.unmount()
})
