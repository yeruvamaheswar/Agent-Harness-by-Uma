# Multi-Agent Planning

`multi-agent-planning` is a harness skill. It turns a software request into a plan page with small verified slices. Each slice names its builder, model, effort, reviewer, fallback, files, and check. The skill plans only, unless you ask it to execute.

Source: `tools/agents/skills/multi-agent-planning/`. The skill reads two references when it needs them: `references/routing.md` (who does what) and `references/slice-format.md` (the slice fields, states, and templates). `references/examples.md` holds three illustrative plans.

## When it activates

| Situation | What happens |
|---|---|
| A task needs 2 or more slices, routing to agents or models, parallel agents, or a sprint plan | The agent can load the skill without being asked |
| You name the skill | It loads, also for a small fix (`quick` mode) |
| A plain plan or report | `html-explainer` handles it alone |
| Requirements are still open | `grill-me` runs first; the planner waits |

The policy line that names the skill is in `knowledge/core.md`. It is active only after you publish and install release 1.5.0. Until then, agents find the skill through its description, but only after `skills install` (or a `--repo` install in that project).

## Invoke it

| Platform | How |
|---|---|
| Claude Code | `/multi-agent-planning <request>`, or say "use the multi-agent-planning skill" |
| Codex | Say "use the multi-agent-planning skill" in the prompt |
| Cursor | Say "use the multi-agent-planning skill" in the prompt |
| T3 Code | Pick a provider (Claude, Codex, or Cursor). That provider loads the skill from its own skill folder. Then ask as above |

Add a mode word when you want one: `quick`, `standard`, `sprint`, or `deep`. Without one, the skill picks. The default is `standard`.

## Plan, then execute

1. Ask for a plan. The skill writes `plans/<slug>.md` and builds the page with `~/.agents/bin/md-view.sh`. Every slice is `PLANNED`. No worker starts. No worktree is made.
2. Read the page. Check the model matrix, the waves, and the first action.
3. Ask for execution: "execute the plan in plans/<slug>.md". The skill runs the tracer slice first, checks it, then runs parallel slices.
4. In T3 Code, the skill delegates with `delegate_task`. A worker gets a worktree only when the last commit holds its verified dependencies. Otherwise the coordinator applies the verified diffs to the shared checkout (`git apply`, no commit) and runs the next slice there. In Claude Code, it can use its own subagents for Claude slices. Where it cannot launch an agent, it prints the handoff prompt for you to paste. It says so. It never claims that a printed prompt started a worker.

## How it picks agents, models, and effort

- Claude: architecture, contracts, hard bugs, security review, final review. Effort rungs come from `html-explainer`, such as `opus/high`.
- Codex: implementation, tests, bug fixes, CI. Always `auto`: your Codex default model, no override.
- Cursor: hands-on edits, UI, refactors, integration. Always `auto`.
- Grok: optional reviewer and critic only, never a builder or fallback. Its findings count only with file paths, line numbers, a failure scenario, severity, and a fix.
- Antigravity: never used unless you ask in that task.
- The skill reads real model IDs from the host when it can (in T3 Code: `orchestrator_capabilities`). It records them in the plan's Existing state and Worker tracking table, not in `Model:`. It invents no model IDs, quotas, or costs.
- `Review:` and `Fallback:` are always different agents or sessions. Neither is the builder's session.
- When a provider fails inside the host (for example an expired login), the coordinator first runs the same agent through its own CLI on your machine (`codex exec`, `cursor-agent`, `claude -p`, `grok`). It uses the `Fallback:` agent only when the CLI fails too.

Full rules: `references/routing.md`.

## States and evidence

`PLANNED → READY → IN_PROGRESS → AGENT_FINISHED → REVIEWED → VERIFIED → INTEGRATED`. `BLOCKED` and `FAILED` are side states. A plan-only run leaves every slice `PLANNED`. Each slice gets three attempts: a bounded fix, one escalation step, then the `Fallback:` owner.

- `AGENT_FINISHED` means a worker returned work. It is a claim.
- `REVIEWED` means another session read the diff.
- `VERIFIED` means the slice's `Verify:` command ran and passed, observed by the reviewer, the coordinator, or CI. `Evidence:` quotes that output. A worker's summary is not evidence.
- A builder never reviews or merges its own work.

## Blocked workers

A worker that lacks authorization, credentials, a settled contract, or an external dependency writes `BLOCKED.md` in its own worktree (in a shared checkout: `BLOCKED-slice-N.md`) and stops. The template is in `references/slice-format.md`. The coordinator sets the slice to `BLOCKED` and asks you the decision. A provider error in the host, such as an expired login, is not a blocker: the coordinator tries the agent's CLI, then the `Fallback:` agent, and tells you what to fix.

## Review and integration

1. The reviewer reads the actual diff, not the builder's summary.
2. The coordinator runs the slice's `Verify:` command and records the output.
3. The integrator, who did not build the slice, applies the reviewed change to the target branch.
4. Before a merge or a release, you run the smoke test that the plan lists. Only you can mark it done.

## The page lint

`md-view.sh` checks planner pages when the front matter has `planner: multi-agent-planning`. It warns on a missing, blank, or repeated field, an unknown state, `VERIFIED` without evidence, a reviewer equal to the builder, Antigravity, Grok as builder or fallback, a bad `Wave:` value, overlapping files in a parallel wave (a folder ending in `/` owns everything under it; `./` and `a,b` are normalized), a path outside the repo, a dependency inside one wave, a missing or unknown mode, in quick mode any wave other than `1 sequential` or more than one slice, and in deep mode a wave 2 that holds more than the architecture review. Warnings never stop the build.

## Install

The harness installs skills with receipts and backups. Run these from the harness folder.

```sh
npm run harness -- skills status                                   # read-only: every harness skill and its install state
npm run harness -- skills install multi-agent-planning        # copy to ~/.agents/skills/, link from ~/.claude/skills/
npm run harness -- skills verify multi-agent-planning         # configurationVerified: true
npm run harness -- skills uninstall multi-agent-planning      # moves the copy into .state/backups/
```

- One copy in `~/.agents/skills/<name>/` serves Codex (observed). The link in `~/.claude/skills/<name>` serves Claude Code and Cursor: Cursor CLI lists `~/.claude/skills` as a skill root and not `~/.agents/skills` (observed 2026-10-26). T3 Code uses the same folders through its providers.
- Install refuses a copy that differs from its receipt, or that has no receipt and differs from the source. Compare the two, then add `--replace`. The old copy goes to `.state/backups/skills/` first.
- A stale copy (unchanged since the harness installed it, while the source moved on) is updated after a backup, with no flag.
- Uninstall never deletes. It moves the files into `.state/backups/skills/`.
- The page lint needs the page builder from this repo. Copy `tools/agents/bin/md-view.sh` to `~/.agents/bin/` after you back up the old copy.

### Another machine
1. Clone the harness, then run `npm ci`.
2. Run `npm run harness -- skills install multi-agent-planning`.
3. Copy the page builder as above.
4. Start a fresh session and ask "which skills can you load?". Expect `multi-agent-planning`.

### Remote and cloud agents
A cloud agent sees only the project. Global installs do not reach it.

```sh
npm run harness -- skills install multi-agent-planning --repo PATH
```

This writes `PATH/.agents/skills/multi-agent-planning/` and a relative link `PATH/.claude/skills/multi-agent-planning`. Commit both in that project yourself. In a work repo, ask the owner first.

## Automated and manual

| Step | Automated | Manual |
|---|---|---|
| Install, verify, uninstall the skill | `harness skills` | you approve and run it |
| Plan page build and lint | `md-view.sh` | copy the builder to `~/.agents/bin/` |
| Policy line | prepared in `knowledge/core.md` | you publish 1.5.0, install it, paste it into Cursor User Rules |
| Delegation | T3 `delegate_task`; Claude Code subagents | paste handoff prompts where no delegation exists |
| Commit, merge, push, deploy | never | you |

## Behavior checks
- `npm run harness -- eval run --platform claude --case planner-quick` and `--case planner-feature` run the skill in a fresh session on a scratch repo. The fixtures carry the skill at project scope, so no global install is needed. Each run spends subscription usage.
- Held-out graders check the plan page against `references/slice-format.md`. They do not judge plan quality.

## Limits
- A skill guides an agent. It cannot force behavior.
- Cursor CLI reads `~/.claude/skills/`, not `~/.agents/skills/` (observed 2026-10-26), so the Claude link is what makes the skill visible to Cursor.
- Cloud agents need the repo-scope install. A relative `.claude/skills` link in a cloud checkout is untested.
- The skill cannot see subscription usage. It plans with the agents you have, not with quotas.
