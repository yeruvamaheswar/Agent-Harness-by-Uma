# Routing

Read this before you fill `Model:`, `Review:`, and `Fallback:`. The tables are preferences, not entitlements. Host discovery decides what is available.

## Portfolio
These are the user's subscriptions.

| Agent | Plan | Use for | Not for |
|---|---|---|---|
| Claude | $100/mo | Lead architect. Deep reasoning. Complex cross-module work. API and database contracts. Security and migration review. Hard debugging. Final critical review | Mechanical edits |
| Codex | $20/mo | Main volume worker. Implementation from a clear spec. Bug fixes. Unit and integration tests. Repo-scoped changes. CI fixes. Parallel Codex threads in isolated worktrees for independent slices, when the host supports them | Open design questions |
| Cursor | $30/mo | Hands-on editing. Frontend and UI. Refactors. Quick fixes. Component integration. Bounded merge conflicts. Integration under a separate integration owner. Cursor may own backend slices too | Integrating slices it built |
| Grok | $30/mo, optional | Research before or beside planning. Alternatives. Assumption challenge. Optional critic in `Review:` | Building a slice. `Model:` or `Fallback:` |
| Antigravity | $20/mo, routable | By tier from `model-tiers.md`: cheap and mid work such as fact-finding, mechanical edits, docs, and code from a clear spec. A higher tier only when `model-tiers.md` lists the model there | Slices whose model has no row in `model-tiers.md` (`tier unknown`) |

- Default active stack: Claude, Codex, Cursor, and Antigravity, $170/mo. With Grok: $200/mo.
- These are subscription prices. They are not API credit and not a quota.
- No provider and no model is a default. The size of the work picks the model.
- Do not uninstall Antigravity. Do not edit its config.

## Grok
- A Grok finding counts only when it is actionable: file path, line reference where available, repro or test evidence, severity, and a concrete fix.
- An opinion without evidence is not a defect.
- Record in the plan whether Grok added value.
- A plan never depends on Grok. When Grok is unavailable or excluded, the plan is complete without it.
- Grok never appears in `Model:` or `Fallback:`. It may appear only in `Review:`, as an optional critic.
- When a slice's `Review:` is Grok, write the stand-in reviewer in Risks, for example Claude (opus/high, fresh session).
- Grok research happens before or beside planning. Record it in Existing state, not as a building slice.

## Size the slice, then pick the model
Size each slice. Then pick the cheapest model and effort in `model-tiers.md` at or above that size, from any routable provider.

For Claude, take the start from "Claude starting points" in `model-tiers.md`. The size is the floor.

| Size | Work |
|---|---|
| cheap | Fact-finding, probes, mechanical edits, docs without judgment |
| mid | Code from a clear spec with tests, multi-file docs, routine debugging |
| strong | Open design, security-critical design or auth changes, migrations, cross-platform contracts, hard debugging |

- The rubric is a judgment, not a rule. Size a slice up only when the work needs it. Say why.
- The Claude starting table gives a start by task type. For example, a major refactor, migration, or architecture starts at `Claude (fable/medium)`.
- Within a tier, prefer the lowest effort and a provider with free capacity. Write the cost as `unknown` when no host reports it.
- Cursor does hands-on UI edits and refactors at `Cursor (auto)`. Cursor does not use the tiers.
- Independent critical review: a strong-tier model in a fresh session, never the builder's session.
- Optional extra critique: `Grok (default)`, in `Review:` only.
- Claude rungs are in `model-tiers.md` and in the `html-explainer` skill. Start from "Claude starting points". Then use the lowest rung at or above the size.

## Only Cursor stays auto
- Write `Cursor (auto)` in `Model:`, `Review:`, and `Fallback:`. Do not override the Cursor model. This is the user's decision.
- In T3 Code, `auto` for Cursor means the model id `default` (Auto).
- Codex names its model and effort: `Codex (model-id/effort)`, for example `Codex (gpt-6.1-terra/low)`. The lint warns on `Codex (auto)`. Old plans that say `Codex (auto)` still parse and dispatch with no model override.
- Antigravity names its model: `Antigravity (model-id)`. The effort is part of the id.
- Write discovery results, such as the T3 model id used, in Existing state and in the Worker tracking table.

## Scoring a slice
Weigh these factors for each slice:
- Task fit
- Reasoning depth
- Tools the slice needs
- Repo context already loaded
- Observable remaining usage
- Latency
- Handoff overhead
- Risk
- Need for independent verification

Rules:
- Give a one-line reason for each assignment.
- Do not switch providers only because another one is available.
- Do not spend premium effort on trivial edits.
- Use only usage that the host shows. Otherwise write `unknown`.

## Reviewer rule
- The reviewer works in a different session from the builder.
- For a critical slice, prefer a different model family.
- `CI` may review a mechanical slice.
- Codex reviews only mechanical slices.
- A Claude-built cross-layer tracer is reviewed by `Claude (opus/high, fresh session)`, not by Codex.
- The reviewer reads the actual diff and runs `Verify:`. A summary is not a diff.
- The reviewer never weakens a test or a requirement to make a slice pass.
- The reviewer reports findings. The builder fixes them.

## Fallback and escalation
- `Fallback:` is the new owner after the escalation step fails.
- A rerun of the same agent at a higher effort, or for Claude on the next model up, is the escalation step. Do not write it in `Fallback:`.
- Before you raise effort or model, check that the slice can verify its own work: a test, a build, or a script.
- `Review:` and `Fallback:` name different agents or sessions.
- When the fallback takes over, the reviewer is a session that did not apply the fix.
- The fallback of an `integration` slice did not build the combined slices. When every other agent built one of them, the fallback is a new session of the integrator at the same rung, for example `Claude (sonnet/medium, fresh session)`.

| Builder | Escalation step | Typical `Fallback:` |
|---|---|---|
| Codex (model-id/effort) | The same model at the next effort, within the efforts the host advertises. With no step left, go to `Fallback:` | A model in another family at or above the slice size, or Claude at the rung the risk needs |
| Antigravity (model-id) | None. The effort is in the id, so go straight to `Fallback:` | A model in another family at or above the slice size |
| Cursor (auto) | Cursor rerun with the failing output and the review findings | Codex (model-id/effort), or Claude at the rung the risk needs |
| Claude (rung) | Raise effort one level, up to `high`. Past `high`, go to the next model up at `medium`: haiku/high to sonnet/medium, sonnet/high to opus/medium, opus/high to fable/medium. Past fable/high, go to `Fallback:` | A model at or above the slice size from another provider, or a new Claude session when the slice needs Claude judgment |

### Attempt budget
- Three attempts per slice. First, one bounded fix by the builder. Second, the escalation step. Third, the `Fallback:` owner.
- The next failure sets `FAILED`.
- Take one step per failed check. This is "rerun one level higher" in the core policy.
- Keep the good work at each step.
- A blocker is not a failed check. It does not start the fallback. The coordinator sets `BLOCKED` and asks the user.
- A provider error or a usage limit is not a failed check either. See "Provider error".

### Provider error
A worker stopped because of the host or the provider: an expired login, an outage, a rate or usage limit, a full context window, or a refusal. The worker does not write `BLOCKED.md` for it. Only the Claude lead handles it, in the `autonomous-engineering` FAILOVER mode. It records an interruption, not an attempt, and the attempt budget does not move.

The lead takes the first option that applies. The numbers are the recovery options in `autonomous-engineering/references/engine.md`: 1 wait for the reset, 2 resume the same thread, 3 the same agent's CLI, 4 the same thread on another provider, 5 a new child (a fresh session of the same agent first where that helps, then `Fallback:`, then the approved pool).

| Class | Options in order | Rule |
|---|---|---|
| api, auth | 2, 3, 5 | Resume the same thread first. Then reach the same agent through its own CLI on the machine, such as `codex exec`, `cursor-agent`, or `claude -p`, before another provider |
| quota | 1, 4, 5 | Wait when the observed reset is 60 minutes or less away. The same agent's CLI shares the account limit |
| rate | 2, 4, 5 | The same agent's CLI shares the account limit |
| context | 5 | A fresh session of the same agent first |
| process, tool, unknown | 2, 5 | Resume the same thread first. Then a fresh session of the same agent (process, tool), or another agent only (unknown, which may be an account limit) |
| refusal | none | `BLOCKED`. Another provider only after the user approves a `provider-change` decision for the slice |

- Option 3: probe the CLI with a one-line read-only prompt. When it answers, run the slice's continuation packet through it in the slice's workspace, with no model override. The slice stays with its planned agent.
- When the CLI also fails, option 5 moves the slice to the `Fallback:` owner with the partial work. The slice stays `IN_PROGRESS`; mark the builder's Worker tracking row `BLOCKED` with the error, and tell the user what to fix.
- Nothing switches back by itself. A later return to the planned agent is a new handoff by the Claude lead.

## Model change and new threads
- A model change mid-thread loses the prompt cache and may drop thinking.
- Change the model only in a fresh session (a new thread or a child) that starts from a written handoff, or after `/compact` in Claude Code. Exception: option 4 in "Provider error".
- A new thread picks its model from "Claude starting points" in `model-tiers.md`. A chat a person waits on starts at `Claude (sonnet/low)` or `Claude (sonnet/medium)`.

## Delegation per host
| Host | Delegation |
|---|---|
| T3 Code | `delegate_task` with a target from `orchestrator_capabilities`. Keep each `taskId`. Use `isolation: "worktree"` only when the last local commit contains every `VERIFIED` or `ACCEPTED` dependency of the slice; uncommitted files are not copied. Otherwise apply the `VERIFIED` dependency diffs to the shared checkout first (`git apply`, no commit), then use the shared checkout, one slice at a time. Give the plan's absolute path. Before you hand a slice to another worker, `task_cancel` the old task and tell the user: a retry of the old child from the T3 UI runs in the same workspace |
| Claude Code | The Agent tool, with the slice's model. A worktree for a concurrent coding worker, under the same commit rule as T3 Code |
| Other hosts | None known. Print the released handoff notes only (see "Delegation" in `SKILL.md`) |

- When delegation to a slice's agent is unavailable, print its handoff note for the user to paste only when the slice is released by the commit rule. Say plainly that nothing was launched.
- Record the model id that the host actually used in the Worker tracking table.

## Discovery
| Host | How | Record as |
|---|---|---|
| T3 Code | Call the `orchestrator_capabilities` tool. It lists provider instances, model ids, option descriptors (such as `effort` or `reasoningEffort`), and `canRunChildTask`. Pass `search` to find a model outside the short list | observed |
| Claude Code | The model list of the Agent tool | observed |
| Codex | In T3 Code, the `codex` provider in `orchestrator_capabilities`, with each model's effort options. Else `grep -E '^model *=' ~/.codex/config.toml`. Read no other key | observed, else `unknown` |
| Cursor | `cursor-agent --list-models`, when the command exists | observed, else `unknown` |
| Antigravity | The `antigravity` provider in `orchestrator_capabilities`. The effort is in the model id | observed, else `unknown` |
| Any other host | None | the tier, `auto`, or `unverified` |

- Discover again at every plan start. Do not reuse an old list.
- In `## Existing state`, list every provider with its status (routable, review only, or disabled), its model ids, and the date. Mark each capability as observed or assumed. Discovery results go there, not in `Model:`.
- A discovered model with no row in `model-tiers.md` is `tier unknown`. Route no build slice to it until a probe or the user sets its tier.
- A slice may launch only on a model that the current discovery lists. When it is not listed, the model is unavailable and the slice goes to `Fallback:`.
- Never invent model IDs, quotas, usage, costs, or tiers. Never guess a tier from a model name.
