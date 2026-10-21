// The run pane: a pane beside the chat that follows the ibni workspace this
// session works in, read from `ibni info` and `ibni stats` whenever a Bash
// call runs ibni and after every turn, plus a band above the prompt once the
// PR is delivered or the context window runs high (the context nudge).
// Claude Code only; ibni's metadata stays the record every host shares.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunPaneSnapshot } from '../types'
import type { StageState } from './run'
import { bar, confidenceTone, duration, headline, journey, lastEventAt, nudge, nudgePercentFrom, progress, sessionIdFrom, since, snapshotFrom, taskTitle, triageRanking } from './run'

const PANE = 'run-pane'

// One mark and one theme colour per stage state, so the journey reads at a
// glance in any theme: green done, accent for the stage in progress, red for
// the one that needs you, quiet for what has not happened.
const MARK: Record<StageState, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: 'success' },
  current: { glyph: '●', color: 'claude' },
  failed: { glyph: '✗', color: 'error' },
  pending: { glyph: '○', color: 'inactive' },
  skipped: { glyph: '–', color: 'inactive' },
}
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
    await $.command.register({ name: 'run-pane', description: 'Show the current mexxi run: where it is, what passed, what needs you, and its PR' })
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
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No run yet</Text>
          <Text dimColor>This pane follows a /wettaq run. It fills in once ibni prepares or adopts a workspace.</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const status = headline(current)
    const { task, repository } = taskTitle(current)
    const stages = journey(current)
    const { done, total } = progress(stages)
    const started = since(current.createdAt, now)
    const lastEvent = lastEventAt(current)
    const onCurrent = lastEvent ? duration(now - Date.parse(lastEvent)) : undefined
    const triage = triageRanking(current)
    const questionWidth = Math.max(0, ...triage.map(row => row.question.length))
    const answerWidth = Math.max(0, ...triage.map(row => row.answer.length))
    const port = current.port === null || current.port === undefined ? undefined : `port ${current.port}`
    return (
      <Box flexDirection="column" gap={1}>
        {/* The card: what a glance needs, in the colour of where the run stands. */}
        <Box borderStyle="round" borderColor={status.tone} paddingX={1} flexDirection="column">
          <Text>
            <Text backgroundColor={status.tone} color="inverseText" weight="bold">{` ${status.label} `}</Text>
            {started ? <Text dimColor>{`  started ${started}`}</Text> : null}
          </Text>
          <Text weight="bold" wrap="truncate-end">{task}</Text>
          <Text dimColor>{[repository, port].filter(Boolean).join(' · ') || ' '}</Text>
          <Text>
            {stages.map(stage => (
              <Text color={MARK[stage.state].color}>{stage.state === 'pending' || stage.state === 'skipped' ? '▱' : '▰'}</Text>
            ))}
            <Text dimColor>{`  ${done} of ${total}`}</Text>
          </Text>
        </Box>

        <Box flexDirection="column" paddingX={1}>
          {stages.map(stage => (
            <Text>
              <Text color={MARK[stage.state].color}>{MARK[stage.state].glyph}</Text>
              {' '}
              <Text
                weight={stage.state === 'current' || stage.state === 'failed' ? 'semibold' : 'regular'}
                color={stage.state === 'failed' ? 'error' : stage.state === 'current' ? 'claude' : undefined}
                dimColor={stage.state === 'pending' || stage.state === 'skipped'}
              >
                {stage.label}
              </Text>
              {stage.detail ? <Text dimColor>{`  ${stage.detail}`}</Text> : null}
              {stage.state === 'current' && onCurrent ? <Text color="claude">{`  ${onCurrent}`}</Text> : null}
            </Text>
          ))}
        </Box>

        {current.prUrl ? (
          <Box paddingX={1}>
            <Text>
              <Text color="success" weight="bold">{'↗ '}</Text>
              <Link href={current.prUrl}>{`Open PR #${current.prUrl.split('/').at(-1)}`}</Link>
            </Text>
          </Box>
        ) : null}

        {/* Jev's call, ranked by how sure it was. Shadow only: it is recorded
            beside the agent's own choices and changes nothing. */}
        {triage.length > 0 ? (
          <Box borderStyle="round" borderColor="suggestion" paddingX={1} flexDirection="column">
            <Text>
              <Text backgroundColor="suggestion" color="inverseText" weight="bold">{' JEV TRIAGE '}</Text>
              <Text dimColor>{'  shadow'}</Text>
            </Text>
            {triage.map(row => {
              const cells = bar(row.percent)
              return (
                <Text tabular>
                  <Text>{`${row.question.padEnd(questionWidth)}  `}</Text>
                  <Text weight="bold">{`${row.answer.padEnd(answerWidth)}  `}</Text>
                  <Text color={confidenceTone(row.percent)}>{cells.filled}</Text>
                  <Text dimColor>{cells.empty}</Text>
                  <Text color={confidenceTone(row.percent)}>{` ${String(row.percent).padStart(3)}%`}</Text>
                </Text>
              )
            })}
            <Text dimColor wrap="wrap">{triage.filter(row => row.question !== row.meaning).map(row => `${row.question}: ${row.meaning}`).join(' · ')}</Text>
            <Text dimColor wrap="wrap">Recorded only; changes nothing.</Text>
          </Box>
        ) : null}

        {current.error ? (
          <Box borderStyle="round" borderColor="warning" paddingX={1} flexDirection="column">
            <Text color="warning" weight="semibold">ibni didn't answer</Text>
            <Text>{current.error}</Text>
          </Box>
        ) : null}
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
        <Text color="warning">{`↻ ${shown.text} `}</Text>
        <Button key="dismiss" label="Dismiss" onPress={() => update($, dismissed, () => shown.key)} />
      </Box>
    )
  })
}
