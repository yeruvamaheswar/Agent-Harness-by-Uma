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

## Choose the best model for each child

Pick provider, model, and effort per child. Do not copy one choice across the fan-out.

- Spread work across providers by fit. Do not leave a capable provider idle while another carries several children. Do not invent a task to use a provider.
- Pick the model and effort that best fit the task. Judge them in this order: accuracy to the goal, speed, then efficiency of usage. Do not pick above the need (wasted usage) or below it (wrong result, rework). Do not overstate or understate what a model can do.
- Typical fits: fact-finding, probes, and mechanical edits suit Haiku, Sonnet, or a fast model at low or medium effort.
- Use a stronger model (for example Opus) when it materially improves correctness: architecture, security, hard integration, or a second failed attempt. Say why.
- Do not use high, xhigh, max, or ultrathink unless the user named that task, or a specific failure justifies one step up. A blanket "ultrathink" in a parent brief is not permission for every child.
- A reviewer must be a different session from the builder. Prefer a different model family.
- Fallback order when a provider fails through T3 (limit, 401, expired login): first run the same task through that provider's own CLI from the terminal (`codex exec`, `cursor-agent -p`, `grok`), in the background with a log file; then, if the CLI also fails, move to the provider and model that best fit the task, by the same order: accuracy, speed, efficiency. Claude has no fixed rank in this order. Do not retry the same route in a loop. A task run through a CLI still follows the same file ownership, no-commit, and independent-review rules.
- Prefer a deterministic test over another model review when a test can prove the result.
- Codex and Cursor children use `auto` and keep their own model.
  - Exception: pstack panels in Cursor (arena, architect, interrogate, and the arena cross-judge pool) use the named models in `~/.cursor/rules/pstack-models.mdc`. A cross-family judge needs named models.

## What T3 does

Checked 2026-10-26 against `delegate_task` and `orchestrator_capabilities`.

- A child inherits the parent provider and model unless `target` sets them.
- Options inherit only when the child uses the same provider instance and the same model. Pass `options: []` or `options: {}` to clear them. Set `effort` (or that model's advertised effort key) on every child you start.
- Claude Opus 5.5 defaults to medium. Claude Sonnet 5.5, Claude Opus 5, and Claude Opus 4.8 default to high. Claude Opus 4.7 defaults to xhigh. Do not treat "default" as cheap.
- T3 does not show remaining usage for any provider. Label usage unknown. Do not invent numbers.
- Child agents differ in tools. Claude children have Supabase tools. Grok and Cursor children have a shell and browser preview but no Supabase tools. Check before you assign a task that needs a tool.
- Parallel children share each provider's usage window. Many high-effort runs on one provider can empty it before the work is integrated.

## Before each launch

1. List the children you will start now. For each, state the task, provider, model, effort, owned files, and reviewer.
2. Check overlap: no two running children edit the same file.
3. Check balance: no provider is overloaded while a suitable one is idle.
4. On T3, set `target.model` and `target.options` on every child. Do not leave effort to inheritance. Choose the model that best fits the task for accuracy, speed, and efficiency. Do not overpromise or underpromise on the choice.
5. On Claude Code, pass the model and effort on the Agent tool.
6. Tell the user the count, models, and efforts before a fan-out of more than one child.

## After a failed check

Raise one child by one rung, or switch it to the next-best provider, and say why. Do not raise the others. After three failed attempts on one task, stop and ask.
