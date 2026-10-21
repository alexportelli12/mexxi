// ibni info and ibni stats for a finished run (prepare, a refused publish, a
// failed sync, evidence, publish, mark-pr), recorded from the real CLI by
// scripts/ibni/ibni.test.mjs's stats scenario. That test also checks these keys
// still match what ibni prints, so the pane is tested against its real input.
export const info = {
  "operation": "info",
  "sessionId": "3b3a79258b002e4f99e8a6a1",
  "worktreePath": "/tmp/implementation-workspace-test-CL2F9C/worktrees/control-0d80cee26e/timed",
  "evidenceDir": "/tmp/implementation-workspace-test-CL2F9C/worktrees/control-0d80cee26e/timed.evidence",
  "branch": "agent/timed",
  "state": "pr-open",
  "prUrl": "https://github.com/alexportelli12/example/pull/42",
  "port": 4300,
  "defaultBranch": "trunk",
  "baseSha": "42c27e562904e3fa0e6abd9d3f88170ddd493929",
  "publishedSha": "f678bdb74a9fd6660e496a57e0f70b90bc70bd37",
  "evidenceTreeSha": "cc76f2831b4e0a213491dee367f201f30f6a7678",
  "evidenceRecordedAt": "2026-10-21T01:36:44.006Z",
  "createdAt": "2026-10-21T01:36:42.835Z",
  "updatedAt": "2026-10-21T01:36:44.548Z"
}

export const stats = {
  "operation": "stats",
  "sessionId": "3b3a79258b002e4f99e8a6a1",
  "branch": "agent/timed",
  "state": "pr-open",
  "prUrl": "https://github.com/alexportelli12/example/pull/42",
  "createdAt": "2026-10-21T01:36:42.835Z",
  "adoptions": [],
  "steps": [
    {
      "step": "prepare",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:42.715Z",
      "endedAt": "2026-10-21T01:36:42.839Z",
      "outcome": "succeeded",
      "durationMs": 124
    },
    {
      "step": "publish",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:43.536Z",
      "endedAt": "2026-10-21T01:36:43.712Z",
      "outcome": "requires-evidence",
      "durationMs": 176
    },
    {
      "step": "sync",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:43.779Z",
      "endedAt": "2026-10-21T01:36:43.842Z",
      "outcome": "failed",
      "error": "the implementation worktree contains uncommitted or untracked work",
      "durationMs": 63
    },
    {
      "step": "record-evidence",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:43.911Z",
      "endedAt": "2026-10-21T01:36:44.009Z",
      "outcome": "succeeded",
      "durationMs": 98
    },
    {
      "step": "publish",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:44.088Z",
      "endedAt": "2026-10-21T01:36:44.306Z",
      "outcome": "succeeded",
      "durationMs": 218
    },
    {
      "step": "mark-pr",
      "sessionId": "3b3a79258b002e4f99e8a6a1",
      "startedAt": "2026-10-21T01:36:44.469Z",
      "endedAt": "2026-10-21T01:36:44.550Z",
      "outcome": "succeeded",
      "durationMs": 81
    }
  ],
  "verify": {
    "attempts": 2,
    "passed": 1,
    "failed": 1,
    "history": [
      {
        "at": "2026-10-21T01:36:42.922Z",
        "outcome": "fail"
      },
      {
        "at": "2026-10-21T01:36:43.002Z",
        "outcome": "pass"
      }
    ]
  },
  "review": {
    "rounds": 2,
    "findings": 4,
    "history": [
      {
        "at": "2026-10-21T01:36:43.083Z",
        "findings": 3
      },
      {
        "at": "2026-10-21T01:36:43.236Z",
        "findings": 1
      }
    ]
  },
  "qa": {
    "rounds": 1,
    "findings": 0,
    "history": [
      {
        "at": "2026-10-21T01:36:43.159Z",
        "findings": 0
      }
    ]
  }
}
