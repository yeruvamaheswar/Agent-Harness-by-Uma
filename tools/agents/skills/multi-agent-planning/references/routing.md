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
| Antigravity | $20/mo, excluded | Nothing by default | Any slice, unless the user asks for it in this task |

- Default active stack: Claude, Codex, and Cursor, $150/mo. With Grok: $180/mo.
- These are subscription prices. They are not API credit and not a quota.
- Antigravity: never route to it unless the user asks in this task. Do not uninstall it. Do not edit its config.

## Grok
- A Grok finding counts only when it is actionable: file path, line reference where available, repro or test evidence, severity, and a concrete fix.
- An opinion without evidence is not a defect.
- Record in the plan whether Grok added value.
- A plan never depends on Grok. When Grok is unavailable or excluded, the plan is complete with Claude, Codex, and Cursor.
- Grok never appears in `Model:` or `Fallback:`. It may appear only in `Review:`, as an optional critic.
- When a slice's `Review:` is Grok, write the stand-in reviewer in Risks, for example Claude (opus/high, fresh session).
- Grok research happens before or beside planning. Record it in Existing state, not as a building slice.

## Default routing
| Work | Agent |
|---|---|
| Major architecture | Claude (opus/high) |
| Hard cross-platform reasoning | Claude (opus/high), or Claude (opus/xhigh) for long multi-step work |
| Complex or critical bug | Claude (opus/high) |
| Ordinary implementation | Codex (auto) |
| Tests | Codex (auto) |
| Routine edits and frontend iteration | Cursor (auto) |
| Mechanical docs | Claude (haiku/medium) or Claude (sonnet/medium) |
| Independent critical review | Claude (opus/high), in a fresh session, never the builder's session |
| Optional extra critique | Grok (default), in `Review:` only |

- Claude rungs are in the `html-explainer` skill. Pick the lowest rung that fits.

## Codex and Cursor stay auto
- Always write `Codex (auto)` and `Cursor (auto)` in `Model:`, `Review:`, and `Fallback:`. Do not override the model. This is the user's decision.
- In T3 Code, `auto` for Codex means the Codex config default model.
- In T3 Code, `auto` for Cursor means the model id `default` (Auto).
- Write discovery results, such as the Codex config default model or the T3 model id used, in Existing state and in the Worker tracking table. Never in `Model:`.

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
- A higher-effort rerun of the same agent is the escalation step. Do not write it in `Fallback:`.
- `Review:` and `Fallback:` name different agents or sessions.
- When the fallback takes over, the reviewer is a session that did not apply the fix.
- The fallback of an `integration` slice did not build the combined slices. When every other agent built one of them, the fallback is a new session of the integrator at the same rung, for example `Claude (sonnet/medium, fresh session)`.

| Builder | Escalation step | Typical `Fallback:` |
|---|---|---|
| Codex (auto) | Codex with higher reasoning effort, when the host exposes it. Else a rerun with the failing output | Claude (opus/high) |
| Cursor (auto) | Cursor rerun with the failing output and the review findings | Codex (auto), or Claude at the rung the risk needs |
| Claude (rung) | One rung up the `html-explainer` list. `opus/max` only with a written reason | Codex (auto), or a new Claude session when the slice needs Claude judgment |

### Attempt budget
- Three attempts per slice. First, one bounded fix by the builder. Second, the escalation step. Third, the `Fallback:` owner.
- The next failure sets `FAILED`.
- Take one step per failed check. This is "rerun one level higher" in the core policy.
- Keep the good work at each step.
- A blocker is not a failed check. It does not start the fallback. The coordinator sets `BLOCKED` and asks the user.
- Provider error in the host (expired login, outage). The worker does not write `BLOCKED.md` for it; the coordinator handles it. First reach the same agent through its own CLI on the machine, such as `codex exec`, `cursor-agent`, `claude -p`, or `grok`. Probe it with a one-line read-only prompt. When it answers, run the slice's handoff through it in the slice's workspace, with no model override. Keep the slice with its planned agent.
- When the CLI also fails and the `Fallback:` agent is available, mark the builder's Worker tracking row `BLOCKED` with the error, keep the slice `IN_PROGRESS` under the `Fallback:` owner with any partial work, and tell the user what to fix. Do not count it as an attempt.

## Delegation per host
| Host | Delegation |
|---|---|
| T3 Code | `delegate_task` with a target from `orchestrator_capabilities`. Keep each `taskId`. Use `isolation: "worktree"` only when the last local commit contains every `VERIFIED` dependency of the slice; uncommitted files are not copied. Otherwise apply the `VERIFIED` dependency diffs to the shared checkout first (`git apply`, no commit), then use the shared checkout, one slice at a time. Give the plan's absolute path. Before you hand a slice to another worker, `task_cancel` the old task and tell the user: a retry of the old child from the T3 UI runs in the same workspace |
| Claude Code | The Agent tool, with the slice's model. A worktree for a concurrent coding worker, under the same commit rule as T3 Code |
| Other hosts | None known. Print the released handoff notes only (see "Delegation" in `SKILL.md`) |

- When delegation to a slice's agent is unavailable, print its handoff note for the user to paste only when the slice is released by the commit rule. Say plainly that nothing was launched.
- Record the model id that the host actually used in the Worker tracking table.

## Discovery
| Host | How | Record as |
|---|---|---|
| T3 Code | Call the `orchestrator_capabilities` tool. It lists provider instances, model ids, option descriptors (such as `effort` or `reasoningEffort`), and `canRunChildTask`. Pass `search` to find a model outside the short list | observed |
| Claude Code | The model list of the Agent tool | observed |
| Codex | `grep -E '^model *=' ~/.codex/config.toml`. Read no other key | observed, else `unknown` |
| Cursor | `cursor-agent --list-models`, when the command exists | observed, else `unknown` |
| Any other host | None | the tier, `auto`, or `unverified` |

- In `## Existing state`, mark each capability as observed or assumed. Discovery results go there, not in `Model:`.
- Never invent model IDs, quotas, usage, or costs.
