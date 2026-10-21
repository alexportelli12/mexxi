// The run pane: a pane beside the chat that follows the ibni workspace this
// session works in, read from `ibni info` and `ibni stats` whenever a Bash
// call runs ibni and after every turn, plus a band above the prompt once the
// PR is delivered or the context window runs high (the context nudge).
// Claude Code only; ibni's metadata stays the record every host shares.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunPaneSnapshot } from '../types'
import type { StageState } from './run'
import { headline, journey, nudge, nudgePercentFrom, sessionIdFrom, since, snapshotFrom, taskTitle, triageRows } from './run'

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
    const status = headline(current)
    const { task, repository } = taskTitle(current)
    const started = since(current.createdAt, await $.clock.now())
    const triage = triageRows(current)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text backgroundColor={status.tone} color="inverseText" weight="semibold">{` ${status.label} `}</Text>
          </Text>
          <Text size="heading" weight="semibold" wrap="truncate-end">{task}</Text>
          <Text dimColor>{[repository, started && `started ${started}`].filter(Boolean).join(' · ')}</Text>
        </Box>

        <Box flexDirection="column">
          {journey(current).map(stage => (
            <Text>
              <Text color={MARK[stage.state].color}>{MARK[stage.state].glyph}</Text>
              {' '}
              <Text
                weight={stage.state === 'current' || stage.state === 'failed' ? 'semibold' : 'regular'}
                color={stage.state === 'failed' ? 'error' : undefined}
                dimColor={stage.state === 'pending' || stage.state === 'skipped'}
              >
                {stage.label}
              </Text>
              {stage.detail ? <Text dimColor>{`  ${stage.detail}`}</Text> : null}
            </Text>
          ))}
        </Box>

        {current.prUrl ? (
          <Text>
            <Text color="success">{'→ '}</Text>
            <Link href={current.prUrl}>{`Open pull request #${current.prUrl.split('/').at(-1)}`}</Link>
          </Text>
        ) : null}

        {triage.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>Jev triage · shadow, changes nothing</Text>
            {triage.map(row => (
              <Text>
                <Text dimColor>{`${row.question} `}</Text>
                {row.answer}
                {row.confidence === undefined ? null : <Text dimColor>{` · ${row.confidence}%`}</Text>}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="column">
          <Text dimColor wrap="truncate-start">{current.worktreePath ?? 'worktree unknown'}</Text>
          <Text dimColor>{current.port === null || current.port === undefined ? 'no dev-server port' : `dev server on port ${current.port}`}</Text>
        </Box>

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
