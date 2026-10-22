// ibni info and ibni stats for a finished run (prepare, an answered Jev
// triage, a refused publish, a failed sync, evidence, publish, mark-pr),
// recorded from the real CLI by scripts/ibni/ibni.test.mjs's stats scenario.
// That test also checks these keys still match what ibni prints, so the pane
// is tested against its real input.
export const info = {
  "operation": "info",
  "sessionId": "2c026ea35efd82bef78e30b9",
  "worktreePath": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed",
  "evidenceDir": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed.evidence",
  "branch": "agent/timed",
  "state": "pr-open",
  "prUrl": "https://github.com/alexportelli12/example/pull/42",
  "port": 4300,
  "defaultBranch": "trunk",
  "baseSha": "0f0d0cb4d62a1627b2939e8705f0d8958b7959b9",
  "publishedSha": "dbbaed3077fe4576974b32f8e7f29db3f7cb3761",
  "evidenceTreeSha": "cc76f2831b4e0a213491dee367f201f30f6a7678",
  "evidenceRecordedAt": "2026-10-21T02:30:35.087Z",
  "createdAt": "2026-10-21T02:30:32.257Z",
  "updatedAt": "2026-10-21T02:30:36.105Z",
  "reviewTool": "ocr"
}

export const stats = {
  "operation": "stats",
  "sessionId": "2c026ea35efd82bef78e30b9",
  "branch": "agent/timed",
  "state": "pr-open",
  "prUrl": "https://github.com/alexportelli12/example/pull/42",
  "createdAt": "2026-10-21T02:30:32.257Z",
  "adoptions": [],
  "steps": [
    {
      "step": "prepare",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:31.945Z",
      "endedAt": "2026-10-21T02:30:32.265Z",
      "outcome": "succeeded",
      "durationMs": 320
    },
    {
      "step": "publish",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:34.076Z",
      "endedAt": "2026-10-21T02:30:34.428Z",
      "outcome": "requires-evidence",
      "durationMs": 352
    },
    {
      "step": "sync",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:34.582Z",
      "endedAt": "2026-10-21T02:30:34.734Z",
      "outcome": "failed",
      "error": "the implementation worktree contains uncommitted or untracked work",
      "durationMs": 152
    },
    {
      "step": "record-evidence",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:34.886Z",
      "endedAt": "2026-10-21T02:30:35.099Z",
      "outcome": "succeeded",
      "durationMs": 213
    },
    {
      "step": "publish",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:35.248Z",
      "endedAt": "2026-10-21T02:30:35.720Z",
      "outcome": "succeeded",
      "durationMs": 472
    },
    {
      "step": "mark-pr",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:36.003Z",
      "endedAt": "2026-10-21T02:30:36.111Z",
      "outcome": "succeeded",
      "durationMs": 108
    }
  ],
  "verify": {
    "attempts": 2,
    "passed": 1,
    "failed": 1,
    "history": [
      {
        "at": "2026-10-21T02:30:32.907Z",
        "outcome": "fail"
      },
      {
        "at": "2026-10-21T02:30:33.041Z",
        "outcome": "pass"
      }
    ]
  },
  "review": {
    "rounds": 2,
    "findings": 4,
    "history": [
      {
        "at": "2026-10-21T02:30:33.169Z",
        "findings": 3
      },
      {
        "at": "2026-10-21T02:30:33.484Z",
        "findings": 1
      }
    ],
    "byReviewer": {
      "same": {
        "rounds": 1,
        "findings": 3,
        "accepted": 2
      },
      "cross": {
        "rounds": 1,
        "findings": 1,
        "accepted": 1
      }
    }
  },
  "qa": {
    "rounds": 1,
    "findings": 0,
    "history": [
      {
        "at": "2026-10-21T02:30:33.333Z",
        "findings": 0
      }
    ]
  },
  "triage": {
    "status": "answered",
    "reason": null,
    "answers": {
      "existingUi": {
        "answer": "no",
        "confidence": 0.8
      },
      "userFacing": {
        "answer": "no",
        "confidence": 0.9
      },
      "oneWayDoor": {
        "answer": "no",
        "confidence": 0.95
      },
      "size": {
        "answer": "local",
        "confidence": 0.8
      },
      "reviewValue": {
        "answer": 2.4,
        "confidence": 0.6
      }
    },
    "calls": [
      {
        "at": "2026-10-21T02:30:32.458Z",
        "sessionId": "2c026ea35efd82bef78e30b9",
        "stage": "shadow",
        "outcome": "answered",
        "reason": null,
        "model": "typesafe/jev-1.14",
        "payloadBytes": 2034,
        "redacted": false,
        "redactions": 0,
        "truncated": [],
        "attempts": 1,
        "httpStatus": 200,
        "latencyMs": 76,
        "cost": 4e-05,
        "inputTokens": 900,
        "responseModel": "typesafe/jev-1.14-20261001",
        "responseId": "gen-1",
        "answers": {
          "existingUi": {
            "answer": "no",
            "confidence": 0.8,
            "probability": 0.2
          },
          "userFacing": {
            "answer": "no",
            "confidence": 0.9,
            "probability": 0.1
          },
          "oneWayDoor": {
            "answer": "no",
            "confidence": 0.95,
            "probability": 0.05
          },
          "size": {
            "answer": "local",
            "confidence": 0.8,
            "probabilities": {
              "local": 0.8,
              "feature": 0.2
            }
          },
          "reviewValue": {
            "answer": 2.4,
            "level": 2,
            "of": 3,
            "confidence": 0.6,
            "probabilities": {
              "0": 0,
              "1": 0.1,
              "2": 0.4,
              "3": 0.5
            }
          }
        }
      }
    ],
    "agreement": {
      "compared": 3,
      "agreed": 2,
      "gates": {
        "beforeShots": {
          "triage": false,
          "agent": false,
          "agree": true
        },
        "renderedQa": {
          "triage": false,
          "agent": true,
          "agree": false
        },
        "review": {
          "triage": true,
          "agent": true,
          "agree": true
        }
      }
    }
  }
}
