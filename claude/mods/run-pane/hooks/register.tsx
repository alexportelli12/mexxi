// The run pane: a pane beside the chat that follows the ibni workspace this
// session works in, read from `ibni info` and `ibni stats` whenever a Bash
// call runs ibni and after every turn, plus a band above the prompt once the
// PR is delivered or the context window runs high (the context nudge).
// Claude Code only; ibni's metadata stays the record every host shares.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunPaneSnapshot } from '../types'
import { gateLabels, nudge, nudgePercentFrom, sessionIdFrom, snapshotFrom, stageLabel, triageRows } from './run'

const PANE = 'run-pane'
const run = atom({ plugin: 'run-pane', key: 'run' } as const, null)
const contextPercent = atom({ plugin: 'run-pane', key: 'contextPercent' } as const, null)
const nudgePercent = atom({ plugin: 'run-pane', key: 'nudgePercent' } as const, 70)
const dismissed = atom({ plugin: 'run-pane', key: 'dismissed' } as const, null)

async function ibniJson($: EngineInterface, subcommand: string, sessionId: string): Promise<unknown> {
  const { exitCode, stdout, stderr } = await $.process.run(['ibni', subcommand, '--session', sessionId])
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `ibni ${subcommand} exited ${exitCode}`)
  return JSON.parse(stdout)
}

async function refresh($: EngineInterface, sessionId: string): Promise<void> {
  let snapshot: RunPaneSnapshot
  try {
    snapshot = snapshotFrom(sessionId, await ibniJson($, 'info', sessionId), await ibniJson($, 'stats', sessionId))
  } catch (error) {
    const previous = await read($, run)
    snapshot = { ...(previous?.sessionId === sessionId ? previous : { sessionId, steps: [] }), error: String((error as Error).message ?? error) }
  }
  await update($, run, () => snapshot)
}

async function configText($: EngineInterface): Promise<string | undefined> {
  const file = (await $.env.get('MEXXI_CONFIG')) ?? `${(await $.env.get('HOME')) ?? ''}/.config/mexxi/config.json`
  try {
    return await $.fs.read(file)
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'run-pane', description: 'Show the current mexxi run: stage, gates, worktree, port and PR' })
    const text = await configText($)
    await update($, nudgePercent, () => nudgePercentFrom(text))
    return next(e)
  })

  on('command.run', { command: 'run-pane' }, async $ => {
    const current = await read($, run)
    if (current) await refresh($, current.sessionId)
    await $.ui.open({ id: PANE, title: 'mexxi run' })
    return { text: current ? `Run pane opened for ibni session ${current.sessionId}.` : 'Run pane opened; it fills once this session runs ibni.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const sessionId = sessionIdFrom(e.command, ran.text)
    if (sessionId) {
      const isNew = (await read($, run))?.sessionId !== sessionId
      await refresh($, sessionId)
      if (isNew) void $.ui.open({ id: PANE, title: 'mexxi run' })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const { context } = await $.session.usage()
    await update($, contextPercent, () => context.percent ?? null)
    const current = await read($, run)
    if (current) await refresh($, current.sessionId)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const current = await read($, run)
    if (!current) {
      return <Text dimColor>No ibni workspace in this session yet. It appears once /wettaq runs ibni prepare or adopt.</Text>
    }
    const row = (label: string, value: string) => (
      <Text>
        <Text dimColor>{label.padEnd(9)}</Text>
        {value}
      </Text>
    )
    const triage = triageRows(current)
    return (
      <Box flexDirection="column">
        <Text bold>{current.branch ?? current.sessionId}</Text>
        {row('Stage', stageLabel(current))}
        {row('Gates', gateLabels(current).join(' · '))}
        {row('Worktree', current.worktreePath ?? 'unknown')}
        {row('Port', current.port === null || current.port === undefined ? 'none' : String(current.port))}
        {current.prUrl ? (
          <Text>
            <Text dimColor>{'PR'.padEnd(9)}</Text>
            <Link href={current.prUrl}>{current.prUrl}</Link>
          </Text>
        ) : (
          row('PR', 'not opened yet')
        )}
        {triage.length > 0 && <Text dimColor>Jev triage</Text>}
        {triage.map(line => (
          <Text>{`  ${line}`}</Text>
        ))}
        {current.error && <Text color="red">{`ibni: ${current.error}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = nudge(await read($, run), await read($, contextPercent), await read($, nudgePercent))
    if (!shown || (await read($, dismissed)) === shown.key) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="yellow">{`${shown.text} `}</Text>
        <Button key="dismiss" label="Dismiss" onPress={() => update($, dismissed, () => shown.key)} />
      </Box>
    )
  })
}
