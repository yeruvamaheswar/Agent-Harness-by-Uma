# Workflows

Seven workflows, from setting up a project to an overnight run. Each one has a label:

- `runnable`: every command in its shell blocks ran in a clean clone, with a temporary home and no tokens, and exited 0.
- `concept`: the workflow needs a live agent session or a provider. The page says what could not be run and why. Concept blocks are plain text, not shell blocks.

Run the runnable blocks in order, from the root of your clone, after `npm ci` and `activate` (see the [README](../README.md#install)). They share one scratch project in `${TMPDIR:-/tmp}/harness-demo`, and they use only a throwaway plan. To keep your real settings untouched, run `export HOME=$(mktemp -d)` first.

Not released, so not shown: thread-continuity slices 2 to 6, Supabase semantic search, add-on packs, and the Grok export.

## 1. Set up a new project

Label: `runnable`.

Install the policy and one skill into a new project folder, so a cloud agent that opens only that repo gets the rules. Then write a small file that the later workflows source.

```bash
npm run harness -- activate 1.5.5
DEMO="${TMPDIR:-/tmp}/harness-demo"
mkdir "$DEMO"
git -C "$DEMO" init -q
npm run harness -- repo install "$DEMO"
npm run harness -- skills install grill-me --repo "$DEMO"
npm run harness -- repo verify "$DEMO"
npm run harness -- skills verify grill-me --repo "$DEMO"
printf 'DEMO=%s\nCLONE=%s\nae() { node --experimental-strip-types "$CLONE/tools/agents/skills/autonomous-engineering/scripts/ae.ts" "$@"; }\n' "$DEMO" "$PWD" > "$DEMO/env.sh"
ls -a "$DEMO"
```

Expect `repo verify` and `skills verify` to print `"configurationVerified": true`. `AGENTS.md` and `CLAUDE.md` appear in the project. `mkdir` fails if the folder already exists: pick another `TMPDIR` or remove the folder yourself.

Not run: opening the project in a cloud agent. That needs a live agent session.

## 2. Use several coding agents

Label: `concept`.

The plan assigns each slice to an agent. Claude plans and reviews, Codex builds with `auto`, Cursor builds UI work with `auto`, and Grok may only review. The reviewer is never the builder's session. `ae dispatch` prints the routing for a slice (see workflow 3), and `ae handoff` prints the note you give the worker.

What you would do:

```text
1. Install the policy into every agent:  npm run harness -- install codex  (and claude, cursor-files)
2. In Claude Code, ask: "Plan <your task> with multi-agent-planning" -> plans/<slug>.md
3. Ask: "Execute the plan" -> the lead starts one worker per slice and reviews each result
```

Not run: steps 2 and 3. They need a live Claude Code session and sessions in Codex or Cursor. The install in step 1 is covered by the README. [docs/multi-agent-planning.md](multi-agent-planning.md) describes the routing rules.

## 3. Choose a model by task complexity

Label: `runnable`.

The plan names a model and effort for each slice: a mechanical edit goes to a Codex or Cursor `auto` builder, and design-heavy work goes to Claude at a higher effort. The engine turns those lines into a target and an escalation path. This block writes a throwaway plan, starts the engine, and shows the dispatch for slice 1. It then fails an attempt and shows how the escalation plan changes.

```bash
. "${TMPDIR:-/tmp}/harness-demo/env.sh"
mkdir "$DEMO/plans"
cat > "$DEMO/plans/demo.md" <<'PLAN'
---
kind: plan
title: Demo plan
status: active
updated: 2026-11-05
planner: multi-agent-planning
mode: standard
---

# Demo plan

### Slice 1: write the notes file
- Goal: notes.txt says ready
- Model: Codex (auto)
- Review: Claude (sonnet/medium)
- Fallback: Claude (opus/high)
- Wave: 1 sequential
- Depends on: none
- Files: notes.txt
- Out of scope: everything else
- Accept: notes.txt contains the word ready
- Verify: `grep -q ready notes.txt`
- State: PLANNED
- Evidence: none
- [ ] Write notes.txt · Codex (auto) · Verify passes · delete the file

### Slice 2: design the summary
- Goal: summary.txt says done
- Model: Claude (opus/high)
- Review: Claude (sonnet/medium, fresh session)
- Fallback: Cursor (auto)
- Wave: 2 sequential
- Depends on: slice 1
- Files: summary.txt
- Out of scope: everything else
- Accept: summary.txt contains the word done
- Verify: `grep -q done summary.txt`
- State: PLANNED
- Evidence: none
- [ ] Write summary.txt · Claude (opus/high) · Verify passes · delete the file
PLAN
git -C "$DEMO" add -A
git -C "$DEMO" -c user.name=Demo -c user.email=demo@example.invalid commit -q -m "demo plan"
cd "$DEMO"
ae init plans/demo.md
ae next plans/demo.md
ae dispatch plans/demo.md 1
ae start plans/demo.md 1 --provider codex --model auto --task-id demo-builder-1
ae fail plans/demo.md 1 --reason "demo: first attempt failed"
ae dispatch plans/demo.md 1
```

Read the two `dispatch` results. With host `other` (the default) the engine cannot launch an agent, so every target is a `handoff` to the agent named in `Model:`. The `chain` lists the order it tried: `Model:`, then `Fallback:`. The `failures` count rises from 0 to 1, and `escalateWhen` says what happens next: the next failure escalates one level, failure 3 uses the `Fallback:` agent, and failure 4 sets `FAILED`. Effort rises one step at a time for Claude (low, medium, high, xhigh) and never reaches `max`. The reference is `tools/agents/skills/autonomous-engineering/references/engine.md`, section "Dispatch and escalation".

Not run: dispatch with `--host t3`, which needs a T3 capabilities file from a live host.

## 4. Recover from a usage limit

Label: `runnable`.

When an agent nears its limit, the lead writes a usage snapshot from numbers it saw, and the engine ranks replacements. The engine never reads a provider's usage. This block uses an invented snapshot, which stands in for a number you would read from your provider. It then moves slice 1 to the `Fallback:` agent with a checkpoint.

```bash
. "${TMPDIR:-/tmp}/harness-demo/env.sh"
cd "$DEMO"
ae start plans/demo.md 1 --provider codex --model auto --task-id demo-builder-2
echo '{"agents": {"Codex": {"limits": [{"kind": "quota", "usedPct": 88, "source": "demo snapshot"}]}}}' > usage.json
ae usage plans/demo.md 1 --snapshot usage.json --remaining 30
ae prepare plans/demo.md 1 --to "Claude (opus/high)" --lead "Claude (opus/high)" --reason "demo: Codex quota 88 percent"
ae checkpoint plans/demo.md 1 --done "plan read" --next "write notes.txt" --by demo-builder-2
ae transfer plans/demo.md 1 --lead "Claude (opus/high)"
ae handoff plans/demo.md 1
```

Expect `usage` to report a risk level above `normal` and list candidates, and `handoff` to print a continuation note with the checkpoint. The snapshot file is invented for this demo; no real quota was read. Not run: stopping the old worker and delegating to the new one. Those steps need a live host (T3 `task_cancel` and `delegate_task`).

## 5. Continue in a fresh session

Label: `runnable` for the engine part, `concept` for the skill.

A fresh session has no memory of the old one. State is in the plan and the journal. `ae recover` reads them and the repo, and reports what to do next. Run this block as if you had just opened a new session.

```bash
. "${TMPDIR:-/tmp}/harness-demo/env.sh"
cd "$DEMO"
ae recover plans/demo.md
ae status plans/demo.md
git status --short
```

Expect `recover` to list the unfinished handoff and its next step, `status` to show slice 1 `IN_PROGRESS`, and `git status` to show the plan and journal files.

Concept part: the `continue-work` skill does the same from an agent session. Type `/continue-work` in Claude Code, or `$continue-work` in Codex. It reads the prior trail, compares it with the real repo, and stops at the resume point. It needs a live session, so it was not run here.

## 6. Run a validated overnight autonomous workflow

This workflow has two parts with different labels.

### 6a. The engine on a throwaway plan

Label: `runnable`.

This block finishes the throwaway plan with the engine. You play the builder: you write the file yourself. It shows evidence-based states, the charter, the command guard, and the morning report.

```bash
. "${TMPDIR:-/tmp}/harness-demo/env.sh"
cd "$DEMO"
echo ready > notes.txt
ae finish plans/demo.md 1 --summary "wrote notes.txt"
ae review plans/demo.md 1 --by demo-reviewer --note "notes.txt says ready"
ae verify plans/demo.md 1
ae next plans/demo.md
ae start plans/demo.md 2 --provider claude --model opus --task-id demo-builder-3
echo done > summary.txt
ae finish plans/demo.md 2 --summary "wrote summary.txt"
ae review plans/demo.md 2 --by demo-reviewer --note "summary.txt says done"
ae verify plans/demo.md 2
echo "APPROVED: run the demo plan overnight" > approval.txt
ae charter plans/demo.md --approval approval.txt:1 --deadline 2099-01-01T08:00:00-06:00 --cap codex/auto/unknown=3 --branch overnight-demo
ae check plans/demo.md -- git status
ae report plans/demo.md
```

Expect each `verify` to print `"state": "VERIFIED"` with an `exitCode` of 0 in its evidence, and `report` to list both slices under "Verified with engine evidence". `ae check ... -- git status` prints `"decision": "allow"`.

The guard also refuses commands. A push to `main` is `ask`, and the process exits 2, so this example is plain text:

```text
$ ae check plans/demo.md -- git push origin main
{ "decision": "ask", "level": "C", "rule": "controls:ask-push-main", ... }   (exit 2)
```

The charter has no commit grant. `ae charter PLAN --grant commit` fails with `unknown flag --grant`.

### 6b. The unattended overnight run

Label: `concept`.

The rules for a run while you are away are in `tools/agents/skills/autonomous-engineering/references/overnight.md`: a preflight that clears every first-use permission prompt, a charter (your typed approval, a deadline, attempt caps, a run branch), waits that never poll, and a morning report from `ae report`. The lead is a Claude session, and workers are delegated tasks. None of this can run without a live host and providers, and no unattended run was observed for this page. Do not read 6a as proof of one.

## 7. Apply Design OS to a frontend project

Label: `concept`.

Design OS is a separate project, `designOS-by-Uma`, with its own plugin and skills (`design-os:brief`, `design-os:direction`, `design-os:specification`, `design-os:visual-review`, `design-os:handoff`). This repository does not install it. The repo shows two contact points:

- `repo install` keeps a Design OS block in a project's `AGENTS.md` intact, through install, upgrade, and uninstall. `tests/repo.test.ts` covers this.
- [design/explainer-design-spec.md](design/explainer-design-spec.md) records a Design OS consultation for this repo's explainer page, including a skill that failed to run.

What you would do in a frontend project:

```text
1. Install Design OS from its own repository (not part of this harness).
2. Install the harness policy:  npm run harness -- repo install <your-project>
3. In a session, run the Design OS skills in order: brief, direction, specification, then visual-review on the rendered page.
```

Not run: steps 1 and 3. They need the Design OS plugin and a live agent session.
