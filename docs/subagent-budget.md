# Subagent budget

`subagent-budget` is a harness skill. Load it before any child agent. It caps how many children start at once, and which model and effort they use, so one fan-out does not spend the session limit.

Source: `tools/agents/skills/subagent-budget/SKILL.md`.

## Rule

At most 3 children at a time. Fact-finding, page reading, and local probes use Sonnet or Haiku at medium effort. Opus at medium is only the final synthesis, after the notes exist. `high`, `xhigh`, `max`, and `ultrathink` apply only to the one task you name in that conversation.

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

Before a fan-out of more than one child, the agent tells you the count, the model, and the effort. After a failed check it raises one child by one rung and says why. It does not raise the others. Three attempts, then it stops and asks.
