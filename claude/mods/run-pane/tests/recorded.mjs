// ibni info and ibni stats for a finished run (prepare, a refused publish, a
// failed sync, evidence, publish, mark-pr),
// recorded from the real CLI by scripts/ibni/ibni.test.mjs's stats scenario.
// That test also checks these keys still match what ibni prints, so the pane
// is tested against its real input. setup and verification were added by hand,
// in that scenario's shape, when ibni began running setup and verify itself;
// ports and portEnv likewise when workspaces got port blocks, and
// verification.queuedMs when runs began waiting for a slot, and its scope
// fields when runs moved into systemd scopes (unscoped in that scenario).
// review.accepted replaced the same/cross split by hand when that was retired.
// The ci-wait step and ci were added by hand, in that scenario's shape, when
// ibni began waiting on CI (decision 0026).
export const info = {
  "operation": "info",
  "sessionId": "2c026ea35efd82bef78e30b9",
  "worktreePath": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed",
  "evidenceDir": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed.evidence",
  "branch": "agent/timed",
  "state": "pr-open",
  "prUrl": "https://github.com/alexportelli12/example/pull/42",
  "port": 4300,
  "ports": { "first": 4300, "size": 10, "last": 4309 },
  "verifyCommand": "npm run verify",
  "defaultBranch": "trunk",
  "baseSha": "0f0d0cb4d62a1627b2939e8705f0d8958b7959b9",
  "publishedSha": "dbbaed3077fe4576974b32f8e7f29db3f7cb3761",
  "setup": {
    "ran": false,
    "command": null,
    "reason": "no lockfile and no setup in .mexxi.json; nothing was installed"
  },
  "verification": {
    "treeSha": "cc76f2831b4e0a213491dee367f201f30f6a7678",
    "headSha": "dbbaed3077fe4576974b32f8e7f29db3f7cb3761",
    "passed": true,
    "exitCode": 0,
    "durationMs": 204,
    "queuedMs": 0,
    "scope": null,
    "scopeReason": "workflow.scope.enabled is false",
    "resources": null,
    "logPath": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed.evidence/verify-cc76f2831b4e.log",
    "ranAt": "2026-10-21T02:30:34.880Z",
    "command": "npm run verify",
    "commandSource": "default-branch"
  },
  "evidenceTreeSha": "cc76f2831b4e0a213491dee367f201f30f6a7678",
  "evidenceRecordedAt": "2026-10-21T02:30:35.087Z",
  "createdAt": "2026-10-21T02:30:32.257Z",
  "updatedAt": "2026-10-21T02:30:36.105Z",
  "portEnv": {
    "PORT": "4300",
    "MEXXI_PORT_0": "4300",
    "MEXXI_PORT_1": "4301",
    "MEXXI_PORT_2": "4302",
    "MEXXI_PORT_3": "4303",
    "MEXXI_PORT_4": "4304",
    "MEXXI_PORT_5": "4305",
    "MEXXI_PORT_6": "4306",
    "MEXXI_PORT_7": "4307",
    "MEXXI_PORT_8": "4308",
    "MEXXI_PORT_9": "4309"
  },
  "forge": "github",
  "forgeReason": null,
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
    },
    {
      "step": "ci-wait",
      "sessionId": "2c026ea35efd82bef78e30b9",
      "startedAt": "2026-10-21T02:30:36.260Z",
      "endedAt": "2026-10-21T02:36:12.402Z",
      "outcome": "succeeded",
      "durationMs": 336142
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
        "outcome": "pass",
        "durationMs": 204,
        "queuedMs": 0
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
    "accepted": 2
  },
  "setup": {
    "ran": false,
    "command": null,
    "reason": "no lockfile and no setup in .mexxi.json; nothing was installed"
  },
  "verification": {
    "treeSha": "cc76f2831b4e0a213491dee367f201f30f6a7678",
    "headSha": "dbbaed3077fe4576974b32f8e7f29db3f7cb3761",
    "passed": true,
    "exitCode": 0,
    "durationMs": 204,
    "queuedMs": 0,
    "scope": null,
    "scopeReason": "workflow.scope.enabled is false",
    "resources": null,
    "logPath": "/tmp/implementation-workspace-test-CEZwIv/worktrees/control-d7a4ed7796/timed.evidence/verify-cc76f2831b4e.log",
    "ranAt": "2026-10-21T02:30:34.880Z",
    "command": "npm run verify",
    "commandSource": "default-branch"
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
  "ci": {
    "waits": 1,
    "rounds": 0,
    "state": "green",
    "history": [
      {
        "at": "2026-10-21T02:36:12.390Z",
        "state": "green",
        "headSha": "dbbaed3077fe4576974b32f8e7f29db3f7cb3761",
        "failed": 0,
        "durationMs": 336130
      }
    ]
  }
}
