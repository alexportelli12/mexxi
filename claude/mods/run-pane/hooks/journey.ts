// How a run reads, from ibni's own record of it: the snapshot of `ibni info`
// and `ibni stats`, its journey from workspace to pull request, the headline
// and how far along it is. Pure and free of Claude Code imports, so the run
// pane and segwi's web app (scripts/segwi/web) draw a run the same way.
// Index access uses brackets so the web app's stricter compiler accepts it.

// The same shape as RunPaneSnapshot in ../types, which must stay
// self-contained for Claude Code, so it cannot import these; TypeScript
// matches the two structurally; change them together.
export type RunStep = {
  step: string
  outcome: string
  durationMs?: number
  endedAt?: string
}

export type RunGate = {
  rounds: number
  findings: number
}

// The fields of `ibni info` and `ibni stats` a run is drawn from; triage is
// Jev's latest answers (stats' triage.answers), null until one is answered.
export type RunSnapshot = {
  sessionId: string
  branch?: string
  state?: string
  worktreePath?: string
  port?: number | null
  prUrl?: string | null
  createdAt?: string
  steps: RunStep[]
  verify?: { attempts: number; passed: number; failed: number; history: { outcome: string; at?: string }[] }
  review?: RunGate & { crossRounds?: number }
  qa?: RunGate
  triage?: Record<string, unknown> | null
  error?: string
}

type Json = Record<string, unknown>

export function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

// One snapshot from both answers; stats wins where both carry a field, since
// it is read second. Triage rows are stats' latest Jev answers, absent until
// a triage call is answered.
export function snapshotFrom(sessionId: string, info: unknown, stats: unknown): RunSnapshot {
  const merged: Json = { ...record(info), ...record(stats) }
  const steps = Array.isArray(merged['steps']) ? merged['steps'].map(record) : []
  const triage = record(record(stats)['triage'])['answers']
  const review = record(merged['review'])
  return {
    sessionId,
    branch: typeof merged['branch'] === 'string' ? merged['branch'] : undefined,
    state: typeof merged['state'] === 'string' ? merged['state'] : undefined,
    worktreePath: typeof merged['worktreePath'] === 'string' ? merged['worktreePath'] : undefined,
    port: typeof merged['port'] === 'number' ? merged['port'] : null,
    prUrl: typeof merged['prUrl'] === 'string' ? merged['prUrl'] : null,
    createdAt: typeof merged['createdAt'] === 'string' ? merged['createdAt'] : undefined,
    steps: steps.map(step => ({
      step: String(step['step'] ?? '?'),
      outcome: String(step['outcome'] ?? '?'),
      durationMs: typeof step['durationMs'] === 'number' ? step['durationMs'] : undefined,
      endedAt: typeof step['endedAt'] === 'string' ? step['endedAt'] : undefined,
    })),
    verify: merged['verify'] as RunSnapshot['verify'],
    review: merged['review']
      ? {
          rounds: Number(review['rounds'] ?? 0),
          findings: Number(review['findings'] ?? 0),
          crossRounds: Number(record(record(review['byReviewer'])['cross'])['rounds'] ?? 0),
        }
      : undefined,
    qa: merged['qa'] as RunSnapshot['qa'],
    triage: triage && typeof triage === 'object' ? (triage as Record<string, unknown>) : null,
  }
}

// How a run reads: a headline, then the run's journey from workspace to pull
// request, each stage done, current, failed, pending or skipped. Derived from
// ibni's own record only, so a run reads the same whichever host started it.
export type Tone = 'success' | 'error' | 'warning' | 'claude'
export type StageState = 'done' | 'current' | 'failed' | 'pending' | 'skipped'
export type Stage = { key: string; label: string; state: StageState; detail?: string }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : /s$/.test(word) ? 'es' : 's'}`

export function isDelivered(run: RunSnapshot | null): boolean {
  return Boolean(run && (run.prUrl || run.state === 'pr-open'))
}

export function journey(run: RunSnapshot): Stage[] {
  const delivered = isDelivered(run)
  const verify = run.verify
  const lastVerify = verify?.history.at(-1)?.outcome
  const lastDelivery = [...run.steps].reverse().find(step => step.step === 'publish' || step.step === 'mark-pr')
  const ready = run.steps.some(step => (step.step === 'prepare' || step.step === 'adopt') && step.outcome === 'succeeded') || Boolean(run.worktreePath)
  const gate = (key: string, label: string, gateRun: RunSnapshot['qa'], extra = ''): Stage =>
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

export function headline(run: RunSnapshot): { label: string; tone: Tone } {
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
export function lastEventAt(run: RunSnapshot): string | undefined {
  const times = [...run.steps.map(step => step.endedAt), ...(run.verify?.history ?? []).map(entry => entry.at)].filter(
    (at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at)),
  )
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
