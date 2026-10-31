---
name: subagent-budget
description: Cap subagent count, model, and effort before any fan-out so a session limit is not spent in one burst. Use before delegate_task, the Agent tool, parallel research, or any child agent, and whenever the user says ultrathink, high effort, budget, quota, or session limit. Use it even when the parent is already on a strong model.
---

# Subagent budget

Load this skill before you start a child agent. Then apply the rule. Do not start the children first.

## Rule

Subagents: at most 3 at a time. Fact-finding uses Sonnet or Haiku at medium effort. Opus only for the final synthesis, at medium. Do not use high, xhigh, max, or ultrathink unless I name that one task.

The sentence above is the user's rule. Do not weaken it because the parent prompt says "ultrathink" or because a catalog default is high.

## What T3 does

Checked 2026-10-26 against `delegate_task` and `orchestrator_capabilities`.

- A child inherits the parent provider and model unless `target` sets them.
- Options inherit only when the child uses the same provider instance and the same model. Pass `options: []` or `options: {}` to clear them. Set `effort` (or that model's advertised effort key) on the child you actually start.
- Claude Opus 5.5 defaults to medium. Claude Sonnet 5.5, Claude Opus 5, and Claude Opus 4.8 default to high. Claude Opus 4.7 defaults to xhigh. Do not treat "default" as cheap.
- There is no environment preference that caps child effort. This skill is the cap.
- `ultrathink` is an effort value. A blanket "ultrathink" in the parent brief is not permission to set it on every child.
- Parallel children share one session window. Eleven high-effort Opus runs can empty it before a synthesis exists.

## Before each launch

1. Count the children you will start now. Stop at 3. Queue the rest.
2. Classify each child.
   - Fact-finding, page reading, or a local probe: Sonnet or Haiku, effort medium.
   - The one synthesis after the notes exist: Opus, effort medium.
   - high, xhigh, max, or ultrathink: only the single task the user named in this conversation.
3. On T3, set `target.model` and `target.options` on that child. Do not leave effort to inheritance.
4. On Claude Code, pass that model and effort on the Agent tool. Do not spawn a matching Opus child for every topic.
5. Codex and Cursor stay `auto`. Do not override their model. This rule still caps how many run at once.
6. Tell the user the count, the model, and the effort before a fan-out of more than one child.

## After a failed check

Raise one child by one rung, and say why. Do not raise the others. Three attempts, then stop and ask.
