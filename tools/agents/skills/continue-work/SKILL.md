---
name: continue-work
description: Resume a task in a new session from the prior trail and the real repo state, then stop at the resume point. Use only when the user asks to continue work or names this skill.
disable-model-invocation: true
---

# Continue work

You own the resume point. Read the prior trail; don't redo it.

## Hard limits
- Change nothing before the user confirms the next step.
- Prior decisions and finished work are authoritative. Do not re-derive them or repeat a finished repro.
- A "done", "passing", or "works" claim is checked once against the real artifact. A self-report is not proof.
- Chat memory and auto-memory are hints. Files and command output win.
- Read only this project's trail. Never search other projects' chats or transcripts.
- No plan and no handoff: say so and ask for the goal. Do not guess.

## Steps
1. Read the project instructions (`AGENTS.md`, `CLAUDE.md`, or equivalent) and the README.
2. Find the trail: the plan, the latest handoff or progress notes, recent ADRs, and this project's last session transcript if the platform exposes one. Name the files. Summarize a long transcript in a subagent when one is available.
3. Reconstruct state: branch and worktree, `git status`, uncommitted changes, `git log --oneline -10`, `git diff` against the base branch, open todos, decisions made.
4. Run the project's checks (tests, lint, build; find them in the README, manifests, Makefile, or CI). A check you could not run is `unknown`, never `pass`.
5. Compare done with planned. Name the resume point.
6. Pick one verdict: continue the work · ship a finished result · confirm or override a prior conclusion · postmortem a failed run.
7. Stop and wait for the user.

## Reply
- Where the prior session stopped, with commit hashes and file paths.
- What you inherited, and what you re-checked (redo nothing).
- Checks run and results.
- Each mismatch between the trail and the real state.
- The resume point, the verdict, and the next step with its pass/fail check.

## During the session
- Write each decision into the plan or an ADR when it is made.
- Before you stop, add a dated handoff entry: files changed, commands run and results, open issues, next action.
