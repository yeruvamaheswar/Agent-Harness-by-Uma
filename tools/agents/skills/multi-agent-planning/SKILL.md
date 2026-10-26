---
name: multi-agent-planning
description: Plan software work as verified slices and route each slice to an agent, model, and effort. Use when a software task needs 2 or more slices, when the user asks to route work to agents, models, or effort levels, to run parallel agents or worktrees, or for a hackathon sprint plan, or when the user names this skill. For a small single fix, load it only when the user names it, and then plan in quick mode. Plan only unless the user asks for execution.
---

# Multi-Agent Planning

Goal: a plan page where each slice has one owner, one reviewer, one check, and one state, and parallel work cannot collide.

- The caller can be Claude Code, Codex, Cursor, or T3 Code. Do not assume that the caller is Claude.
- Output: goal, tracer bullet, vertical slices, agent, model, and effort per slice, dependency graph, safe parallel waves, independent review, verification, usage-aware allocation, and a self-contained handoff per slice.

## References
| File (relative to this folder) | Read it when |
|---|---|
| `references/slice-format.md` | Always, before you write a slice. It is the contract: fields, lifecycle, waves, overlap, handoff note, `BLOCKED.md` |
| `references/routing.md` | Before you fill `Model:`, `Review:`, or `Fallback:`, and before you delegate |
| `references/examples.md` | When you are not sure of the page shape for a mode |

## Precedence
- `grill-me` comes first when an essential requirement or a material design decision is open. Do not ask what the repo answers.
- `html-explainer` owns the page format and the build. Write `plans/<slug>.md`. Build it with `~/.agents/bin/md-view.sh`. Confirm that `--check` prints `fresh`.
- This skill owns the slices and the routing. Add `planner: multi-agent-planning` and `mode:` to the front matter.
- `verify` does independent product acceptance. `continue-work` resumes work in a new session. The user invokes both. Do not invoke them yourself. Tell the user when to use them.
- Until the user asks for execution, this skill overrides the core rule that runs each slice of a written plan. After that ask, the coordinator applies that rule.
- No recursion. Do not invoke this skill from inside a plan it made.
- A worker builds only the slice named in its handoff. It does not re-plan and does not start other slices or workers.

## Default: plan only
- Write the plan page. Start no worker.
- Start workers only when the user asks for execution or the task explicitly authorizes implementation.
- Explicit authorization means that the user asks, in this conversation, to execute, run, or implement the plan or named slices. A plain feature request, such as "add tags to notes", is a planning request.
- Planning creates no branch and no worktree. Every slice stays `PLANNED`.
- In the reply, say that nothing was launched.

## Modes
Infer the mode from the request. The default is `standard`. Once this skill is active, a small single fix is `quick`, whether or not the user named the skill.

| Mode | When | Shape |
|---|---|---|
| `quick` | A small single fix | One slice, `Wave: 1 sequential`. Targeted test and review. No `parallel` wave |
| `standard` | A feature or change with 2 or more slices | Tracer, then parallel waves where files separate, then integration |
| `sprint` | A hackathon or a fixed short deadline | Smallest demoable product first. Thin end-to-end slice. Mock only what is safe, and label each mock. 2 to 3 workers when justified. Timed integration checkpoints. Demo before polish |
| `deep` | Architecture, security, migrations, cross-platform work, or unclear contracts | The `standard` shape, plus one `sequential` architecture-review slice that reviews the tracer and the shared interfaces. Wave 2 holds only that slice; build slices start in wave 3. A session that did not write the design reviews it. Later waves start only after it is `VERIFIED`. Higher effort. Stronger tests and security review. Grok may be an extra critic, never the builder |

## Workflow
Understand → Design → Slice → Implement → Test → Review → Integrate → Verify. A plan-only run does the first three and routes the rest.
1. Understand. Read the repo instructions, code, tests, and `git status`. Separate facts, assumptions, and unknowns. Write each unknown as `unknown`.
2. Design. Pick the simplest design that reuses existing patterns. Define each shared interface (route, schema, type) before any parallel wave.
3. Slice.
   - Wave 1 is the tracer bullet: one complete happy path through every layer. Later waves start only after wave 1 is `VERIFIED`. On a plan-only turn, the tracer stays `PLANNED` and is not run.
   - Aim for about one hour of focused agent work per slice. This is a heuristic, not a rule.
   - Give each slice one observable result. Do not hide unbuilt work behind a mock. Name each mock in `Accept:` and in Risks.
   - Fill every required field in `references/slice-format.md`. Make each `Verify:` check all of its `Accept:`.
4. Route. Follow `references/routing.md`. Give a one-line reason for each assignment.

## Parallel rules
- Define shared interfaces before a parallel wave.
- Slices in one parallel wave own disjoint files, as "Overlap" in `references/slice-format.md` defines.
- Prefer 2 to 3 workers when there is enough independent work. Never start an agent only to fill a slot.
- Keep a dependency graph. Name the critical path.
- Give every worker the full handoff note from `references/slice-format.md`. A worker does not inherit the chat.

## Capability discovery
- Discover what the host offers before you name a Claude model. `references/routing.md` gives the method per host.
- Never invent model IDs, quotas, usage, or costs. Codex and Cursor stay `Codex (auto)` and `Cursor (auto)`. Record discovery results in Existing state, not in `Model:`.
- A subscription price is not API credit. Do not assume unlimited concurrency. Use no separately billed API without the user's authorization.

## Execution (only when authorized)
1. Validate the plan: build the page, fix its `warn:` lines, confirm `--check` prints `fresh`.
2. For a feature, confirm that `## Requirements`, `## Decisions`, and `## Evals` exist. Start no worker before they do.
3. Confirm each approval that the plan lists under "Waiting on you".
4. Run `git status` and `git worktree list`. Stop when unrelated user work is at risk.
5. Delegate the tracer to its `Model:` worker. The coordinator does not build it.
6. The `Review:` agent, in another session, reads the diff and runs `Verify:`. Set `REVIEWED` from that review.
7. Set `VERIFIED` only from `Verify:` output that the reviewer, the coordinator, or CI observed. The worker's report is not evidence.
8. Start a slice only when all its `Depends on:` slices are `VERIFIED`. Track each worker in the Worker tracking table.
9. Integrate under an owner who did not build the combined slices. Run the final checks. Record real evidence.

Worktrees (none during planning):
- Give each concurrent coding worker its own worktree. A worktree starts from the last commit, so it does not contain uncommitted work.
- Create a dependent slice's worktree only from a commit that contains its `VERIFIED` dependencies. When the user has not approved that commit, run dependent slices one at a time in the shared checkout after the coordinator applies the VERIFIED dependency diff to it (`git apply`, no commit), or ask the user.

Delegation:
- Delegate as "Delegation per host" in `references/routing.md` says.
- Launch or print a slice only when its base contains its `VERIFIED` dependencies: a worktree from a commit that holds them, or the shared checkout. Without that commit, the coordinator first applies each `VERIFIED` dependency diff to the shared checkout (`git apply`, no commit), then releases one slice at a time there, and says which handoffs are withheld.
- Without delegation, print only the handoffs released by that rule. Say plainly that nothing was launched.
- Never claim that a written prompt launched an agent.
- No auto-merge, push, or deploy.

## Lifecycle and blocked work
- States, the forward path, the attempt budget, and `BLOCKED.md` are in `references/slice-format.md`.
- A blocker does not start the fallback. When a worker writes its blocked file, set its slice to `BLOCKED` and ask the user. Exception: a provider error in the host; see "Provider error" in `references/routing.md`.
- `AGENT_FINISHED` is never `VERIFIED`. `VERIFIED` needs an `Evidence:` pointer to observed output.
- No builder reviews, approves, or merges its own work.

## Escalation after a failed check
1. Read the error. Classify the failure.
   - Implementation: follow the attempt budget in `references/routing.md`. When it is spent, set the slice to `FAILED`.
   - Specification: stop the slice. Fix the plan, or ask the user.
   - Environment: fix the setup, or write the blocked file.
2. Escalate effort or model only with a stated reason.
3. Keep the good work. Never restart the project.

## Human check
- Before a project-level merge or release, give the user exact smoke-test steps as a `user` task item.
- Never claim that a human check happened.

## Output: the plan page
After the front matter, the `Label: value` lines, and `## Loop`, write these sections in this order.

| | Section | Content |
|---|---|---|
| A | `## Goal` | Outcome, tracer bullet, out of scope |
| B | `## Existing state` | Facts, assumptions, unknowns. Mark each host capability observed or assumed |
| | `## Requirements`, `## Decisions`, `## Evals` | Required for a feature, in the `html-explainer` format. Omit them for a small bug fix |
| C | `## Design` | The design, shared interfaces, reused patterns. Mermaid for 3 or more parts |
| D | `## Model assignment` | `\| Slice \| Goal \| Agent \| Model \| Effort \| Reviewer \| Fallback \|`, then one reason per row |
| E | `## Slices` | One `### Slice N: name` per slice, with the fields of `references/slice-format.md` |
| F | `## Waves` | Waves, dependency graph, critical path. Mermaid allowed |
| G | `## Usage` | Allocation from observed host data. No invented numbers |
| H | `## Risks` | Each risk with its mitigation |
| I | `## First action` | The exact next slice and its owner |
| J | `## Execution state` | Counts: planned, running, blocked, reviewed, verified, integrated. The Worker tracking table only when execution is authorized |

Reply with the page path and a short summary, as `html-explainer` says. Do not paste the whole plan into chat.
