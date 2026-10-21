// What the run pane keeps for the session: the ibni workspace it follows, the
// last `ibni info` and `ibni stats` answers, the context window's fill, and
// which band the person dismissed.

export type RunPaneStep = {
  step: string
  outcome: string
  durationMs?: number
  endedAt?: string
}

export type RunPaneGate = {
  rounds: number
  findings: number
}

// The fields of `ibni info` and `ibni stats` the pane draws; triage is Jev's
// latest answers (stats' triage.answers), null until a triage call is answered.
export type RunPaneSnapshot = {
  sessionId: string
  branch?: string
  state?: string
  worktreePath?: string
  port?: number | null
  prUrl?: string | null
  createdAt?: string
  steps: RunPaneStep[]
  verify?: { attempts: number; passed: number; failed: number; history: { outcome: string }[] }
  review?: RunPaneGate & { crossRounds?: number }
  qa?: RunPaneGate
  triage?: Record<string, unknown> | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'run-pane': {
      run: RunPaneSnapshot | null
      contextPercent: number | null
      nudgePercent: number
      dismissed: string | null
    }
  }
}
