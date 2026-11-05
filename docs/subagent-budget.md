# Subagent budget

`subagent-budget` is a harness skill. Load it before any child agent. There is no fixed cap. The parent decides how many children to run, and which model and effort best fit each one, so usage goes where it pays.

Source: `tools/agents/skills/subagent-budget/SKILL.md`.

## Rule

There is no fixed cap on subagent count. The parent decides how many to run. Pick the model and effort that best fit each child. Use `high`, `xhigh`, `max`, or `ultrathink` only when you name that task, or when a failure justifies one step up.

A blanket "ultrathink" in the parent brief is not permission to set that effort on every child. A catalog default of high is not a cheap default.

## When it activates

The policy line in `knowledge/core.md` names the skill. It is active after you publish and install release 1.5.1. The agent should load the skill before `delegate_task`, the Agent tool, parallel research, or any other child, and when you say ultrathink, high effort, budget, quota, or session limit.

`multi-agent-planning` also loads this skill before it starts workers.

## Install

```sh
npm run harness -- skills install subagent-budget
npm run harness -- skills verify subagent-budget
```

`skills install` copies the skill to `~/.agents/skills/subagent-budget/` and links it from `~/.claude/skills/subagent-budget`. Codex reads the first path. Claude Code and the Cursor CLI read the link.

Before a fan-out of more than one child, the agent tells you the count, the models, and the efforts. After a failed check it raises one child by one rung, or switches that child to the next-best provider, and says why. It does not raise the others. After three failed attempts on one task, it stops and asks.
