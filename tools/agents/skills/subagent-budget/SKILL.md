---
name: subagent-budget
description: Decide how many subagents to start, which provider and model each gets, and at what effort, so usage is spent where it pays and no provider sits idle. Use before delegate_task, the Agent tool, parallel research, or any child agent, and whenever the user says ultrathink, high effort, budget, quota, or session limit. Use it even when the parent is already on a strong model.
---

# Subagent budget

Load this skill before you start a child agent. Then apply the rules. Do not start the children first.

## Rule

There is no fixed cap on subagent count. The parent decides how many to run. The goal is verified progress per unit of limited usage, not agent count and not token volume.

Start a child only when all of these hold:
- The work is independent: it does not wait on another child's result.
- The files it edits do not overlap with any running child.
- Its dependencies are ready and verified.
- Running it in parallel saves real time or lowers a real risk.

Do not start a child when one agent can finish the work in a few steps, when the work is a speculative duplicate, or when the same fact is already known.

## Choose the cheapest capable model for each child

Pick provider, model, and effort per child. Do not copy one choice across the fan-out.

- Spread work across providers by fit. Do not leave a capable provider idle while another carries several children. Do not invent a task to use a provider.
- Assign the cheapest model and the lowest effort that can meet the slice goal and pass its check. Cheapest means the least usage spent for a correct result. For Claude, the start comes from "Claude starting points" in `model-tiers.md`; the size is the floor.
- Move up one rung only after a failed check. State the reason. Do not move up on a guess that the task is hard.
- Use a small model (Haiku, or any cheap tier) only where a mistake is cheap to spot: finding files, running tests, reading logs, summarizing.
- Give a cheap-tier child a code edit only when a deterministic check (test, build, lint) catches its errors. Other code edits and judgment calls stay on the lead's model or a mid or strong child.
- Keep the lead's context lean. Cheap children do the verbose reading. The lead keeps the decisions.
- For a Claude child, take the start from "Claude starting points" in `multi-agent-planning/references/model-tiers.md`. For example, a major refactor, migration, or architecture starts at `fable/medium`.
- The size is the floor. Size the work with the rubric in the `multi-agent-planning` skill (`references/routing.md`): cheap, mid, or strong. Size it up only when you judge that the work needs it. Say why.
- Batch work (eval runs, probes, repeated reviews): run every item at the lowest routable effort first, often `low`. For a Claude child, that is the effort in "Claude starting points", for example `sonnet/medium` for repeated reviews. Then rerun only the failures one level higher.
- After a second failed attempt, move up. Say why.
- Do not use high, xhigh, max, or ultrathink unless the user named that task, or a specific failure justifies one step up. A blanket "ultrathink" in a parent brief is not permission for every child.
- A reviewer must be a different session from the builder. Prefer a different model family.
- Fallback order when a provider fails through T3 (limit, 401, expired login): first run the same task through that provider's own CLI from the terminal (`codex exec`, `cursor-agent -p`, `grok`), in the background with a log file; then, if the CLI also fails, move to the cheapest provider and model that can meet the goal, per the rules above. Claude has no fixed rank in this choice. Do not retry the same route in a loop. A task run through a CLI still follows the same file ownership, no-commit, and independent-review rules.
- Prefer a deterministic test over another model review when a test can prove the result.
- Only Cursor children use `auto` and keep their own model. Name the model and effort of every Codex and Antigravity child, from `multi-agent-planning/references/model-tiers.md`.
  - Exception: pstack panels in Cursor (arena, architect, interrogate, and the arena cross-judge pool) use the named models in `~/.cursor/rules/pstack-models.mdc`. A cross-family judge needs named models.

## What T3 does

Checked 2026-10-26 against `delegate_task` and `orchestrator_capabilities`.

- A child inherits the parent provider and model unless `target` sets them.
- Options inherit only when the child uses the same provider instance and the same model. Pass `options: []` or `options: {}` to clear them. Set `effort` (or that model's advertised effort key) on every child you start.
- Read each model's default effort from `orchestrator_capabilities` at the start of the task. Do not rely on a dated list. Do not treat "default" as cheap.
- T3 does not show remaining usage for any provider. Label usage unknown. Do not invent numbers.
- Child agents differ in tools. Claude children have Supabase tools. Grok and Cursor children have a shell and browser preview but no Supabase tools. Check before you assign a task that needs a tool.
- Parallel children share each provider's usage window. Many high-effort runs on one provider can empty it before the work is integrated.

## Before each launch

1. List the children you will start now. For each, state the task, provider, model, effort, owned files, and reviewer.
2. Check overlap: no two running children edit the same file.
3. Check balance: no provider is overloaded while a suitable one is idle.
4. On T3, set `target.model` and `target.options` on every child. Do not leave effort to inheritance. Choose the cheapest model and effort that can meet the goal.
5. On Claude Code, pass the model and effort on the Agent tool.
6. Tell the user the count, models, and efforts before a fan-out of more than one child.

## After a failed check

Follow the attempt ladder: the first failure gets one bounded fix by the builder; the second gets the escalation step (one level up, per the escalation table in `multi-agent-planning/references/routing.md`, or the next-best provider); the third goes to the `Fallback:` owner. The next failure sets FAILED. Say why at each step. Do not raise the other children.

An interruption is not a failed attempt. A quota stop, a provider error, a host restart, or a lost session does not use the budget. Checkpoint the work and hand it to a replacement. Three interruptions in a row with no fingerprint progress set BLOCKED.

Ask the user only when no fallback is left. Report the missing fact once, with your recommended answer.
