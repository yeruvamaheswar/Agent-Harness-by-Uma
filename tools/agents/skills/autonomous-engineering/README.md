# autonomous-engineering

A hidden skill that executes, reviews, and recovers a plan written by `multi-agent-planning`. A small engine (`scripts/ae.ts`) records each slice's state and evidence. A slice becomes VERIFIED only when the engine ran its Verify command and saw exit 0. A manual Verify step that a person signs off becomes ACCEPTED, not VERIFIED.

The skill runs only when you name it. No agent starts it on its own.

Source: `tools/agents/skills/autonomous-engineering/` in this repo. Plan: `plans/autonomous-engineering.md`.

## How it fits
| Part | Role | Relation to this skill |
|---|---|---|
| Core policy (`knowledge/core.md`) | Rules for every task | Wins over this skill. This skill applies its tracer loop and end-of-action report |
| Rule packs | Extra category rules | Win over this skill when stricter |
| Platform adapters and controls | Install the policy; enforce permissions on Claude Code | Win over this skill. The engine guard adds no new control |
| `multi-agent-planning` | Writes the plan: slices, waves (labels only), routing, handoff format | PLAN mode loads it. This skill never writes slices |
| `grill-me`, `verify`, `continue-work` | Requirements, product acceptance, session resume | This skill calls `grill-me` when requirements are open. You run `verify` and `continue-work` yourself |
| This skill | Runs the plan: dispatch, review, verify, recover | The only writer of `State:` and `Evidence:` lines |

## Install
Current manual convention:
1. Copy the folder: `cp -R tools/agents/skills/autonomous-engineering ~/.agents/skills/`.
2. Link it for Claude Code: `ln -s ~/.agents/skills/autonomous-engineering ~/.claude/skills/autonomous-engineering`.
3. Codex reads `~/.agents/skills/` directly.

When available, `npm run harness -- skills install autonomous-engineering` replaces these steps. That installer is in progress in the planner work.

The engine needs Node 24 or later and Git. It uses Node built-ins only, so the copy needs no `npm ci`.

## Verify the install
1. Run `node --experimental-strip-types ~/.agents/skills/autonomous-engineering/scripts/ae.ts`. Expect a usage error that lists the commands.
2. Run `npm run harness -- context audit`. Confirm the skill is hidden on each platform.
3. Start a fresh session. Name the skill. Confirm it loads.

## Roll back
1. Remove the link: `mv ~/.claude/skills/autonomous-engineering .state/backups/autonomous-engineering.link`.
2. Move the copy: `mv ~/.agents/skills/autonomous-engineering .state/backups/autonomous-engineering`.

Never delete the copy. Run both commands from this repo's root, so `.state/backups/` is the harness backup folder.

## Invoke
| Platform | How |
|---|---|
| Claude Code | `/autonomous-engineering`, then the request |
| Codex | `$autonomous-engineering`, or "use the autonomous-engineering skill" |
| Cursor | Name the skill in the prompt. Not tested |
| T3 Code | Through the chosen provider, with that provider's form above |

## Examples
- Plan: `/autonomous-engineering plan the tag feature. Allow worktrees.`
- Execute: `/autonomous-engineering execute plans/tags.md`
- Review: `/autonomous-engineering review slice 3 of plans/tags.md`
- Recover: `/autonomous-engineering recover plans/tags.md`
- Sprint: `/autonomous-engineering execute plans/demo.md with the sprint profile`
- Adaptive: `/autonomous-engineering execute plans/demo.md with the adaptive profile`
- Usage handoff: `/autonomous-engineering Codex is at 88% on slice 3 of plans/tags.md; hand it over`. Claude is always the lead that picks the replacement. See "Usage handoff" in `references/engine.md`.
- Failover: `/autonomous-engineering the Codex worker on slice 3 of plans/tags.md stopped at its usage limit; recover it`. The lead records the stop with `ae interrupt`, takes the first recovery option, and hands the replacement one continuation packet. See "Recovery options" in `references/engine.md`.

The sprint profile runs up to 4 slices in parallel. The adaptive profile has no fixed number. At each `ae next`, it reads memory signals on macOS. It starts every safe normal slice while memory pressure is normal. It starts a heavy slice (`Class: heavy`) only on measured headroom, and it backs off after timeouts, memory pressure, or failures. To change the profile of a plan that runs, the lead runs `ae set-profile PLAN --profile NAME`. No profile relaxes a safety rule. See "Adaptive width" in `references/engine.md`.

## Decisions and failover
- `ae decide PLAN [N] --key K` looks a decision up: `answered`, `loop` (asked and still open), or `ask`. With `--risk`, `--status`, and the other fields, the Claude lead records one. An approval needs `--source`, the place where the user answered.
- `ae decisions PLAN [N] --active` lists the decisions in force. RECOVER mode runs it first.
- `ae lead PLAN --claim --lead-id ID --label L` claims the lead lease. Then every lead write passes `--lead-id ID`. `--takeover` and `--release` hand it on.
- `ae interrupt PLAN N --class C --lead L` records a stopped worker. It is not a failed attempt. The result ranks the recovery options.
- `ae attach PLAN N --launch-key K --thread-id T --task-id X` binds the launched worker to its attempt.
- Every command, flag, and rule is in `references/engine.md`: "Commands", "Decisions", "Lead lease and identity", "Progress capture", "Recovery options", "Loop rules", and "Known limits".

## Files
| File | Content |
|---|---|
| `SKILL.md` | The agent instructions: precedence, the modes (PLAN, EXECUTE, FAILOVER, OVERNIGHT, USAGE, REVIEW, RECOVER), stop conditions, report |
| `references/engine.md` | Commands, states, profiles and adaptive width, budget, loop rules, journal, dispatch, usage handoff, decisions, lead lease, progress capture, recovery options, known limits |
| `references/authority.md` | Authority levels, `--allow` values, enforcement, prompt injection, secrets |
| `agents/openai.yaml` | Codex flag that keeps the skill hidden |
| `scripts/` | The engine |

Tests: `tests/ae-*.test.ts`. Run `node --experimental-strip-types --test tests/ae-skill.test.ts`.

## Limits
- The engine guard checks only the commands the engine runs. Claude Code enforces `controls/controls.json`. Codex, Cursor, and Grok have no harness locks.
- Verify runs in the checkout that holds the plan. Changes in a separate worktree are not seen until they are in that checkout.
- A T3 worktree starts from the last local commit. Uncommitted files are not copied.
- The engine cannot prove who called it. `--lead`, `--lead-id`, and launch keys are strings; the lease prevents honest mistakes, not attacks.
- The lock text is now `pid:hex`. An older installed engine reads only a pid. Install all engine copies at once.
- A decision write is refused once the journal reaches 1 MiB, other growing writes above 1.5 MiB, and every write at 1.75 MiB. Then archive the journal and start a new one.
- Subscription quotas cannot be measured by the engine. The lead passes what it observed to `ae usage`; a missing number is `unknown`. `intensity` is a relative estimate.
- Adaptive width reads memory signals on macOS only. On other systems it runs like balanced, with one heavy slice at a time. The heavy RSS estimate starts at 2048 MB; measure one heavy run and set it with `ae set-profile`.
- Not tested: whether Cursor and Grok load skills from `~/.agents/skills/`.
- Not tested: whether Grok Bot on its cloud computer can run the engine.
- No commit, push, merge, or deploy happens without your approval.
