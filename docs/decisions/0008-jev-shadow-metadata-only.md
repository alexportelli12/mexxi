---
status: Accepted
date: 2026-10-21
---

# 0008. Jev triage runs in shadow, from metadata only

## Context

Each `/wettaq` run makes proportionality calls in prose: whether the change alters existing UI, needs rendered QA, deserves an independent review, or touches a one-way door. Different models make those calls differently. Jev, TypeSafe's decision model, returns typed answers with probabilities through OpenRouter's Decisions API, which could make the calls consistent and easy to audit. But there was no evidence yet that the agents' calls were wrong, and sending task details to a third party has a privacy cost.

## Decision

- `ibni triage` asks Jev one batch of questions after the task contract is set. It sends only the request text, the contract, changed file paths and diff line counts, never file contents, diffs, logs or environment files.
- The payload is redacted for secret-shaped strings before it is sent, kept under 32 KB, and given a 5-second timeout.
- Triage is off by default. It runs only for repositories the config lists, owned by accounts the config lists, so repositories that belong to other organisations are skipped.
- The model is pinned (`typesafe/jev-1.14`), the endpoint must use HTTPS, and zero data retention is requested by default.
- Every failure is recorded and the run carries on as if triage were off.
- The only stage is shadow: answers are recorded beside the agent's own choices and change nothing. Letting triage add a gate, or later skip one, needs shadow data showing agreement and a new decision.

## Consequences

- Jev can't make a run worse, faster or slower until the data justifies it.
- `/irrifletti` can report how often Jev agreed with the agent, which is the evidence for any later stage.
- Each call costs a fraction of a cent and adds a short wait to every run with triage on.
- Jev only sees metadata, so it can't judge code quality, and it is never asked to.

## Alternatives considered

- **Letting Jev drive the gates immediately:** faster to pay off, but untested against how the agents decide today.
- **Sending the diff for better answers:** more accurate, but it would send code to a third party for every task.
