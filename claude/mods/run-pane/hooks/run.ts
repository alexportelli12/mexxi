// What the run pane reads from ibni and how it words it, apart from the hooks
// so tests can feed recorded `ibni info` / `ibni stats` answers directly.
import type { RunPaneSnapshot } from '../types'

const IBNI = /(?:^|[\s;&|(/])(?:ibni|implementation-workspace)\s+([a-z-]+)/

// The ibni session a Bash command worked on: its --session argument, or the
// sessionId `prepare` and `adopt` print when they create or take one over.
export function sessionIdFrom(command: string, output: string | undefined): string | null {
  const match = IBNI.exec(command)
  if (!match) return null
  const flag = /--session(?:=|\s+)['"]?([A-Za-z0-9_-]+)/.exec(command)
  if (flag?.[1]) return flag[1]
  if (match[1] !== 'prepare' && match[1] !== 'adopt') return null
  return /"sessionId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(output ?? '')?.[1] ?? null
}

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

// One snapshot from both answers; stats wins where both carry a field, since
// it is read second. Triage rows are stats' latest Jev answers, absent until
// a triage call is answered.
export function snapshotFrom(sessionId: string, info: unknown, stats: unknown): RunPaneSnapshot {
  const merged: Json = { ...record(info), ...record(stats) }
  const steps = Array.isArray(merged.steps) ? merged.steps.map(record) : []
  const triage = record(record(stats).triage).answers
  return {
    sessionId,
    branch: typeof merged.branch === 'string' ? merged.branch : undefined,
    state: typeof merged.state === 'string' ? merged.state : undefined,
    worktreePath: typeof merged.worktreePath === 'string' ? merged.worktreePath : undefined,
    port: typeof merged.port === 'number' ? merged.port : null,
    prUrl: typeof merged.prUrl === 'string' ? merged.prUrl : null,
    steps: steps.map(step => ({
      step: String(step.step ?? '?'),
      outcome: String(step.outcome ?? '?'),
      durationMs: typeof step.durationMs === 'number' ? step.durationMs : undefined,
    })),
    verify: merged.verify as RunPaneSnapshot['verify'],
    review: merged.review as RunPaneSnapshot['review'],
    qa: merged.qa as RunPaneSnapshot['qa'],
    triage: triage && typeof triage === 'object' ? (triage as Record<string, unknown>) : null,
  }
}

const STATES: Record<string, string> = {
  active: 'implementing',
  published: 'branch published',
  'pr-open': 'PR open',
}

export function stageLabel(run: RunPaneSnapshot): string {
  const state = run.state ? STATES[run.state] ?? run.state : 'unknown'
  const last = run.steps.at(-1)
  return last ? `${state} · last step ${last.step} ${last.outcome}` : state
}

export function gateLabels(run: RunPaneSnapshot): string[] {
  const verify = run.verify
  const lastVerify = verify?.history.at(-1)?.outcome
  const rounds = (name: string, gate: RunPaneSnapshot['review']) =>
    gate && gate.rounds > 0
      ? `${name} ${gate.rounds} ${gate.rounds === 1 ? 'round' : 'rounds'}, ${gate.findings} ${gate.findings === 1 ? 'finding' : 'findings'}`
      : `${name} not run`
  return [
    verify && verify.attempts > 0
      ? `verify ${lastVerify === 'pass' ? 'passed' : 'failed'} (${verify.passed} of ${verify.attempts} green)`
      : 'verify not recorded',
    rounds('QA', run.qa),
    rounds('review', run.review),
  ]
}

function answer(value: unknown): string {
  const item = record(value)
  if ('answer' in item) {
    const confidence = typeof item.confidence === 'number' ? ` (${Math.round(item.confidence * 100)}%)` : ''
    return `${String(item.answer)}${confidence}`
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function triageRows(run: RunPaneSnapshot): string[] {
  return Object.entries(run.triage ?? {}).map(([question, value]) => `${question}: ${answer(value)}`)
}

export function isDelivered(run: RunPaneSnapshot | null): boolean {
  return Boolean(run && (run.prUrl || run.state === 'pr-open'))
}

// Why the band suggests a fresh session, or null. The key changes with the
// reason, so dismissing one does not silence the next.
export function nudge(run: RunPaneSnapshot | null, percent: number | null, threshold: number): { key: string; text: string } | null {
  const adopt = run?.prUrl ? `ibni adopt --pr ${run.prUrl}` : 'ibni adopt --pr <url>'
  if (run && isDelivered(run)) {
    return { key: `delivered:${run.sessionId}`, text: `PR delivered. Start a fresh session for follow-ups and take the workspace over with ${adopt}.` }
  }
  if (percent !== null && percent >= threshold) {
    return { key: `context:${threshold}`, text: `Context is ${percent}% full. Start a fresh session soon; a run in progress continues there with ${adopt}.` }
  }
  return null
}

// claude.contextNudgePercent from the mexxi config.json text, or the default.
export function nudgePercentFrom(configText: string | undefined, fallback = 70): number {
  try {
    const value = record(record(JSON.parse(configText ?? '{}')).claude).contextNudgePercent
    return typeof value === 'number' && value >= 1 && value <= 100 ? value : fallback
  } catch {
    return fallback
  }
}
