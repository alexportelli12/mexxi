---
status: Accepted
date: 2026-11-14
---

# 0023. Runs decide reversible choices and record them

Extends [0007](0007-implementers-implement-reviewers-judge.md).

## Context

`/wettaq` split runs into attended and unattended ones. An unattended run took the most reasonable reading and listed it as an assumption. An attended run could stop to ask, and did. Across 88 runs, 16 stops were permission asks or menus of options, such as "shall I go ahead?" or "option A or B?". Each one pulled the person back in for a choice the pull request could have reversed cheaply.

Another 13 turns ended with "I'll carry on when the check finishes". The background job then finished with nobody listening, and the run sat idle until the person noticed.

## Decision

- **Every run decides reversible choices itself.** Attended or not, a run takes the most reasonable reading from the repository and its product principles, and carries on. It lists the choice in the pull request under **Decisions and assumptions**, worded so the reviewer can reverse it cheaply.
- **Only two kinds of question stop a run:**
  - a one-way door: a destructive or irreversible data change, a security or privacy decision, a public API or schema break, or anything the pull request cannot undo;
  - product direction: what the product should do, when neither the request nor the repository's principles say.
- **A permission ask is never a question.** A run does not ask whether to go ahead with work the request already asked for.
- **A run waits inside its turn.** It never ends its turn while one of its own background jobs is still running. It waits for the job's completion inside the turn, then carries on.

## Consequences

- The person is asked fewer, weightier questions, and the pull request carries the rest as decisions to check.
- A wrong reversible choice costs a follow-up request rather than a stalled run.
- A long wait now keeps the turn open, so a run that waits on a slow check holds its session for that time.

## Alternatives considered

- **Keep the attended mode, with a stricter list of allowed questions:** the menus came from attended runs with good intentions, and a list would still invite them.
- **Ask in the pull request instead of in the run:** for a one-way door that is too late, since the run may already have built on the answer.
