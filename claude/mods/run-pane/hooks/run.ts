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
  const review = record(merged.review)
  return {
    sessionId,
    branch: typeof merged.branch === 'string' ? merged.branch : undefined,
    state: typeof merged.state === 'string' ? merged.state : undefined,
    worktreePath: typeof merged.worktreePath === 'string' ? merged.worktreePath : undefined,
    port: typeof merged.port === 'number' ? merged.port : null,
    prUrl: typeof merged.prUrl === 'string' ? merged.prUrl : null,
    createdAt: typeof merged.createdAt === 'string' ? merged.createdAt : undefined,
    steps: steps.map(step => ({
      step: String(step.step ?? '?'),
      outcome: String(step.outcome ?? '?'),
      durationMs: typeof step.durationMs === 'number' ? step.durationMs : undefined,
      endedAt: typeof step.endedAt === 'string' ? step.endedAt : undefined,
    })),
    verify: merged.verify as RunPaneSnapshot['verify'],
    review: merged.review
      ? { rounds: Number(review.rounds ?? 0), findings: Number(review.findings ?? 0), crossRounds: Number(record(record(review.byReviewer).cross).rounds ?? 0) }
      : undefined,
    qa: merged.qa as RunPaneSnapshot['qa'],
    triage: triage && typeof triage === 'object' ? (triage as Record<string, unknown>) : null,
  }
}

// How the pane reads a run: a headline, then the run's journey from workspace
// to pull request, each stage done, current, failed, pending or skipped.
// Derived from ibni's own record only, so a run reads the same whichever host
// started it.
export type Tone = 'success' | 'error' | 'warning' | 'claude'
export type StageState = 'done' | 'current' | 'failed' | 'pending' | 'skipped'
export type Stage = { key: string; label: string; state: StageState; detail?: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : /s$/.test(word) ? 'es' : 's'}`

export function isDelivered(run: RunPaneSnapshot | null): boolean {
  return Boolean(run && (run.prUrl || run.state === 'pr-open'))
}

export function journey(run: RunPaneSnapshot): Stage[] {
  const delivered = isDelivered(run)
  const verify = run.verify
  const lastVerify = verify?.history.at(-1)?.outcome
  const lastDelivery = [...run.steps].reverse().find(step => step.step === 'publish' || step.step === 'mark-pr')
  const ready = run.steps.some(step => (step.step === 'prepare' || step.step === 'adopt') && step.outcome === 'succeeded') || Boolean(run.worktreePath)
  const gate = (key: string, label: string, gateRun: RunPaneSnapshot['qa'], extra = ''): Stage =>
    gateRun && gateRun.rounds > 0
      ? { key, label, state: 'done', detail: `${plural(gateRun.rounds, 'pass')} · ${plural(gateRun.findings, 'finding')}${extra}` }
      : { key, label, state: delivered ? 'skipped' : 'pending', detail: delivered ? 'not run' : undefined }

  const stages: Stage[] = [
    { key: 'workspace', label: 'Workspace ready', state: ready ? 'done' : 'pending' },
    { key: 'build', label: 'Build the change', state: verify?.attempts || lastDelivery || delivered ? 'done' : 'pending' },
    verify && verify.attempts > 0
      ? {
          key: 'verify',
          label: 'Verify',
          state: lastVerify === 'pass' ? 'done' : 'failed',
          detail: `${lastVerify === 'pass' ? 'green' : 'red'} · ${verify.passed} of ${plural(verify.attempts, 'run')} passed`,
        }
      : { key: 'verify', label: 'Verify', state: 'pending' },
    gate('qa', 'Rendered QA', run.qa),
    gate('review', 'Independent review', run.review, run.review?.crossRounds ? ' · cross-family' : ''),
    run.prUrl
      ? { key: 'pr', label: 'Pull request', state: 'done', detail: `#${run.prUrl.split('/').at(-1)} open` }
      : lastDelivery && lastDelivery.outcome !== 'succeeded'
        ? { key: 'pr', label: 'Pull request', state: 'failed', detail: `${lastDelivery.step} ${lastDelivery.outcome.replace(/-/g, ' ')}` }
        : { key: 'pr', label: 'Pull request', state: delivered ? 'done' : 'pending' },
  ]
  // The first stage not yet done is the one in progress, unless one failed.
  if (stages.some(stage => stage.state === 'failed')) return stages
  const next = stages.findIndex(stage => stage.state === 'pending')
  return stages.map((stage, index) => (index === next ? { ...stage, state: 'current' } : stage))
}

// The capsule at the top: one or two words a person reads at a glance, in
// the colour of where the run stands. Uppercase, like a status line segment.
const DOING: Record<string, string> = {
  workspace: 'PREPARING',
  build: 'BUILDING',
  verify: 'VERIFYING',
  qa: 'TESTING UI',
  review: 'IN REVIEW',
  pr: 'PUBLISHING',
}

export function headline(run: RunPaneSnapshot): { label: string; tone: Tone } {
  if (run.error) return { label: 'IBNI OFFLINE', tone: 'warning' }
  const stages = journey(run)
  if (stages.some(stage => stage.state === 'failed')) return { label: 'NEEDS ATTENTION', tone: 'error' }
  if (isDelivered(run)) return { label: 'PR OPEN', tone: 'success' }
  if (run.state === 'published') return { label: 'PUBLISHED', tone: 'success' }
  const current = stages.find(stage => stage.state === 'current')
  return { label: current ? DOING[current.key] ?? 'IN PROGRESS' : 'IN PROGRESS', tone: 'claude' }
}

// How far along the run is: stages done or skipped, out of all of them.
export function progress(stages: Stage[]): { done: number; total: number } {
  return { done: stages.filter(stage => stage.state === 'done' || stage.state === 'skipped').length, total: stages.length }
}

// When ibni last recorded anything for the run: the stage in progress has
// been running since then.
export function lastEventAt(run: RunPaneSnapshot): string | undefined {
  const times = [
    ...run.steps.map(step => step.endedAt),
    ...(run.verify?.history ?? []).map(entry => (entry as { at?: string }).at),
  ].filter((at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
  return times.sort().at(-1) ?? run.createdAt
}

// A duration the way a status line shows one: 45s, 12m, 1h 05m.
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// The task's short name and the repository it runs in, read from the branch
// and the worktree path (<root>/<repository>-<hash>/<slug>).
export function taskTitle(run: RunPaneSnapshot): { task: string; repository?: string } {
  const task = (run.branch ?? run.sessionId).replace(/^agent\//, '')
  const folder = run.worktreePath?.split('/').at(-2)
  return { task, repository: folder?.replace(/-[0-9a-f]{10}$/, '') }
}

// "started 12m ago", from the workspace's createdAt.
export function since(iso: string | undefined, now: number): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(at)) return undefined
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m ago` : `${Math.floor(hours / 24)}d ago`
}

// Jev's answers, most confident first, each with the question asked in plain
// words and its confidence as a percentage. Questions Jev did not answer, or
// answered without a confidence, are left out.
// Each question as a short label, so the panel stays narrow.
const QUESTIONS: Record<string, string> = {
  oneWayDoor: '1-way',
  userFacing: 'users',
  existingUi: 'UI',
  size: 'size',
  reviewValue: 'review',
}

export type TriageRow = { key: string; question: string; answer: string; percent: number }

export function triageRanking(run: RunPaneSnapshot): TriageRow[] {
  const answers = run.triage ?? {}
  return Object.entries(answers)
    .map(([key, value]) => {
      const item = record(value)
      const confidence = Number(item.confidence)
      if (!('answer' in item) || !Number.isFinite(confidence)) return null
      return { key, question: QUESTIONS[key] ?? key, answer: String(item.answer), percent: Math.round(Math.min(1, Math.max(0, confidence)) * 100) }
    })
    .filter((row): row is TriageRow => row !== null)
    .sort((a, b) => b.percent - a.percent || a.question.localeCompare(b.question))
}

// A ten-cell bar for a percentage: filled cells, then empty ones.
export function bar(percent: number, width = 10): { filled: string; empty: string } {
  const cells = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return { filled: '▰'.repeat(cells), empty: '▱'.repeat(width - cells) }
}

// How sure Jev was, as a theme colour: green when sure, accent when fairly
// sure, amber when it was close to guessing.
export function confidenceTone(percent: number): Tone {
  return percent >= 80 ? 'success' : percent >= 60 ? 'claude' : 'warning'
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
