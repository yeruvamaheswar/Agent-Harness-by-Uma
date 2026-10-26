# Slice format

The shared contract for planner output. The page builder lints it, and the held-out evals grade it. Change it only with its lint and evals.

## Plan front matter
```markdown
---
kind: plan
title: <title>
status: active
updated: YYYY-MM-DD
planner: multi-agent-planning
mode: quick | standard | sprint | deep
---
```
- `planner: multi-agent-planning` turns on the planner lint in `md-view.sh`. Without it, only the base slice lint runs. Pages written before the rename on 2026-10-26 say `planner: multi-agent-slice-planner`; the lint and the graders accept both.
- `mode` is required. It is one of the four modes, in lowercase.

## Slice fields
One `### Slice N: name` heading per slice. One field per line, in this order.

```markdown
### Slice 2: tag API
- Goal: POST /tags saves a tag and returns it
- Model: Codex (auto)
- Review: Claude (sonnet/medium)
- Fallback: Claude (opus/high)
- Wave: 2 parallel
- Depends on: slice 1
- Files: server/tags.js, server/tags.test.js
- Out of scope: web/, db/schema.sql
- Accept: a POST with {"name":"food"} returns 201 and the saved tag
- Verify: `npm test -- server/tags.test.js`
- State: PLANNED
- Evidence: none
- [ ] Write the route and its test · Codex (auto) · Verify command passes · revert the two files
```

| Field | Required | Value |
|---|---|---|
| `Goal:` | yes | One observable result: user-visible or API-visible |
| `Covers:` | contracts only | The `REQ-n` the slice delivers |
| `Model:` | yes | The builder: `Agent (model/effort)` or `Agent (auto)` |
| `Review:` | yes | The independent reviewer. Never the builder's session. `CI` is allowed for a mechanical slice. Grok is allowed only here, as an optional critic |
| `Fallback:` | yes | The new owner after the escalation step fails. Not a higher-effort rerun of the builder. A different agent or session from `Review:` |
| `Wave:` | yes | `N sequential`, `N parallel`, or `N integration` |
| `Depends on:` | yes | `none`, or the slices that must be `VERIFIED` first: `slice 1`, `slice 1, slice 2`, or `slices 1 and 2` |
| `Files:` | yes | The files or folders this slice owns. Separate with `, `. A folder ends in `/`. See "Overlap" |
| `Out of scope:` | no | Files the builder must not touch |
| `Accept:` | yes | The acceptance criterion, written so a stranger can check it |
| `Verify:` | yes | The exact command or manual step that checks `Accept:` |
| `State:` | yes | One lifecycle state, below |
| `Evidence:` | yes | `none`, or a pointer to the proof: command and result, log line, commit, review file |

### Agent names
`Claude`, `Codex`, `Cursor`, `Grok`, `user`, `CI`. Antigravity is excluded by default. The lint warns when it appears.
- Grok never appears in `Model:` or `Fallback:`. The lint warns when it does. In `Review:`, name a stand-in reviewer in Risks.

### Model values
- Claude: `Claude (haiku/medium)`, `Claude (sonnet/medium)`, `Claude (opus/high)`, and so on. The rungs are in the `html-explainer` skill.
- Codex and Cursor: always `Codex (auto)` and `Cursor (auto)` in `Model:`, `Review:`, and `Fallback:`. Write discovery results, such as the Codex config default model or the T3 model id used, in Existing state and in the Worker tracking table.
- Grok: `Grok (default)`, in `Review:` only.
- `unverified` is only for a Claude model that the host did not list. Write the rung plus `unverified`, for example `Claude (opus/high, unverified)`.
- Add `fresh session` when a reviewer must be a new session of the builder's agent, for example `Claude (opus/high, fresh session)`.

## Lifecycle
| State | Meaning | Set by |
|---|---|---|
| `PLANNED` | Written in the plan | planner |
| `READY` | Every dependency is `VERIFIED` | coordinator |
| `IN_PROGRESS` | A worker has it | coordinator |
| `AGENT_FINISHED` | The worker returned work. This is a claim | coordinator |
| `BLOCKED` | The worker wrote its blocked file | coordinator |
| `FAILED` | Its check failed and the attempt budget is spent | coordinator |
| `REVIEWED` | An independent reviewer read the diff | reviewer |
| `VERIFIED` | `Verify:` ran and passed. `Evidence:` quotes the output | coordinator, from output that the reviewer, the coordinator, or CI observed |
| `INTEGRATED` | Merged into the target branch, with approval where required | integrator |

- Forward path: `PLANNED` → `READY` → `IN_PROGRESS` → `AGENT_FINISHED` → `REVIEWED` → `VERIFIED` → `INTEGRATED`.
- `BLOCKED` and `FAILED` are side states. `BLOCKED` returns to `IN_PROGRESS` only after the user unblocks it. Exception: a provider error in the host; see "Provider error" in `routing.md`.
- A plan-only run leaves every slice `PLANNED`.
- Attempt budget: three. First, one bounded fix by the builder. Second, the escalation step. Third, the `Fallback:` owner. The next failure sets `FAILED`.
- `AGENT_FINISHED` is never `VERIFIED`.
- `Evidence:` for `VERIFIED` quotes `Verify:` output that the reviewer, the coordinator, or CI observed. The worker's summary is not evidence.
- `VERIFIED` and `INTEGRATED` need an `Evidence:` pointer.

## Waves
- Wave 1 is the tracer bullet: one `sequential` slice through every layer.
- Slices in one `parallel` wave own disjoint files. See "Overlap".
- A slice never depends on a slice in its own wave.
- An `integration` slice combines reviewed slices. It has one owner, who is not a builder of those slices.
- A later wave may own a file that an earlier wave owned. Its worktree then needs a commit that contains the earlier work. See "Worktrees" in `SKILL.md`.
- In `quick` mode: exactly one slice, `Wave: 1 sequential`, and no `parallel` wave. The lint warns on a second slice, on a `parallel` wave, and on any other wave value.
- In `deep` mode: wave 2 holds only the architecture-review slice, `sequential`, which reviews the tracer and the shared interfaces. Build slices start in wave 3. The lint warns otherwise.
- When the user cuts a slice, delete it, and remove it from each dependent slice's `Depends on:`, and rewrite each dependent slice's `Goal:`, `Accept:`, `Verify:`, the critical path, and the evals to the work that remains.

### Overlap
- The owned paths of the slices in one `parallel` wave are disjoint.
- A folder that ends in `/` owns every path under it.
- So `server/` overlaps `server/routes.js`, and two slices in one parallel wave cannot own them.

## Worker tracking
Use this table on the plan page when execution is authorized. Do not create worktrees during planning.

| Slice | Agent | Model/effort | Branch | Worktree | State | Review | Evidence |
|---|---|---|---|---|---|---|---|

## Handoff note
Give every worker exactly this. A delegated worker does not inherit the coordinator's chat.

```text
Plan: <absolute path to plans/<slug>.md>. Read it first. Your slice: Slice N.
Scope: <Goal>. Own only: <Files>. Do not touch: <Out of scope>.
Do only this slice. Do not launch workers. The core rule that runs every slice of a written plan belongs to the coordinator, not to you.
Verified state: <what is VERIFIED, with evidence>.
Constraints: no commit, push, merge, deploy, or package install without approval. Follow the repo's AGENTS.md or CLAUDE.md.
Acceptance: <Accept>. Run: <Verify>. Report the command output.
Model and effort: <Model>.
When done: report the changed files, the check output, and anything unverified. Do not mark the slice VERIFIED.
When truly blocked: write BLOCKED.md in your worktree root (template below) and stop. In a shared checkout, write BLOCKED-slice-N.md in the repo root.
```

## BLOCKED.md
Write it only for missing authorization, missing credentials, an unresolved contract, or an external dependency. Diagnose and fix routine errors yourself.

```markdown
# BLOCKED: Slice N
- Issue: <one line>
- Tried: <what you did>
- Error: <exact error text or command output>
- Files: <paths involved>
- Decision needed: <the question, with your recommended answer>
- Next action: <what unblocks it>
- Safe work done: <what is finished and checked>
```
- In a worktree: write `BLOCKED.md` in the worktree root.
- In a shared checkout: write `BLOCKED-slice-N.md` in the repo root, so workers never overwrite each other's file.
- A blocker does not start the fallback. The coordinator sets `BLOCKED` and asks the user. Exception: a provider error in the host; see "Provider error" in `routing.md`.
