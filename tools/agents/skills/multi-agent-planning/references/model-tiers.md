# Model tiers

Read this before you fill `Model:`, `Review:`, or `Fallback:`. The lead reads this file. No code reads it.

The tiers rank capability. They do not rank price. Costs are API prices per task, not subscription usage.

## Rules
- Size the slice first: cheap, mid, or strong. The size rubric is in `routing.md`.
- Pick the cheapest listed model and the lowest effort whose tier is at or above the size. Use any routable provider. For Claude, start from "Claude starting points" below; the size is the floor.
- Use only a model that the live discovery lists, and only an effort that discovery advertises for it.
- Tier cut-offs on the AA index: cheap 25 or more, mid 31 or more, strong 48 or more. Below 25, the pair is not routable for build work.
- Anchors: Claude Haiku 5.5 medium is the cheap rung (25). Claude Sonnet 5.5 medium is the mid rung (31). Claude Opus 5.5 medium is the strong rung (48).
- A model that is not on AA, but passed probes P1 and P2 (`plans/dynamic-model-routing.probes.md`), is cheap only. A real slice check or a later probe can raise it.
- A discovered model with no row here is `tier unknown`. Route no build slice to it until the user sets its tier.
- Never guess a tier from a model name.
- Verify the numbers on artificialanalysis.ai before each release. Source: https://artificialanalysis.ai/leaderboards/models, fetched 2026-11-07 through a summarizing reader. Fable 5.2 rows were fetched the same way on 2026-11-10. Index version and date: not shown on the page.
- Cursor is not in this table. Cursor stays `Cursor (auto)`.
- Grok is not in this table. Grok reviews only.

## Plan values
| Provider | Plan line |
|---|---|
| Claude | `Claude (sonnet/medium)`. The name is the tier: haiku, sonnet, opus, fable |
| Codex | `Codex (model-id/effort)`, for example `Codex (gpt-6.1-terra/low)` |
| Antigravity | `Antigravity (model-id)`. The effort is part of the id, for example `Antigravity (gemini-3.8-flash-low)` |
| Cursor | `Cursor (auto)` |

## Claude starting points
For Claude, pick the start from this table first. The AA tier is the floor: the start must be at or above the slice size. If the table start is below the size, move up to the size.

| Situation | Start | Effort |
|---|---|---|
| Unsure, everyday engineering, multi-PR features | `Claude (opus/medium)` | medium, then high |
| Well-scoped code: bug fix, spec-driven feature | `Claude (sonnet/medium)` | medium, then high |
| Repeated agent tasks: investigation, review, drafting | `Claude (sonnet/medium)` | medium |
| Subagents that search, read logs, summarize | `Claude (haiku/medium)` or `Claude (sonnet/medium)` | medium (guide: model default) |
| Classification, routing, extraction | `Claude (haiku/medium)` | medium |
| Chat a person waits on | `Claude (sonnet/low)` or `Claude (sonnet/medium)` | low or medium |
| Computer use, vision-heavy | `Claude (opus/medium)` | medium |
| Major refactor, migration, architecture, leading many subagents, long unattended runs | `Claude (fable/medium)` | medium, then high |

Source: https://claude.dev/blog/which-claude-model-should-you-build-with/, read 2026-11-10.

## Tiers
| Provider | Model id | Effort | AA index | Tier | Cost per task | Source |
|---|---|---|---|---|---|---|
| Codex | gpt-6.1-sol | low | 35 | mid | $0.16 | AA 2026-11-07 |
| Codex | gpt-6.1-sol | medium | 46 | mid | $0.36 | AA 2026-11-07 |
| Codex | gpt-6.1-sol | high | 50 | strong | $0.59 | AA 2026-11-07 |
| Codex | gpt-6.1-sol | xhigh | 52 | strong | $0.76 | AA 2026-11-07 |
| Codex | gpt-6.1-sol | max | 55 | strong | $1.27 | AA 2026-11-07 |
| Codex | gpt-6-astra | low | 43 | mid | $1.42 | AA 2026-11-07 |
| Codex | gpt-6-astra | medium | 52 | strong | $2.73 | AA 2026-11-07 |
| Codex | gpt-6-astra | high | 55 | strong | $3.24 | AA 2026-11-07 |
| Codex | gpt-6-astra | xhigh | 55 | strong | $3.66 | AA 2026-11-07 |
| Codex | gpt-6-astra | max | 57 | strong | $6.24 | AA 2026-11-07 |
| Codex | gpt-6.1-terra | low | 29 | cheap | $0.07 | AA 2026-11-07 |
| Codex | gpt-6.1-terra | medium | 38 | mid | $0.17 | AA 2026-11-07 |
| Codex | gpt-6.1-terra | high | 42 | mid | $0.26 | AA 2026-11-07 |
| Codex | gpt-6.1-terra | xhigh | 45 | mid | $0.40 | AA 2026-11-07 |
| Codex | gpt-6.1-terra | max | 51 | strong | $0.96 | AA 2026-11-07 |
| Codex | gpt-6-luna | low | 10 | not routable | $0.01 | AA 2026-11-07 |
| Codex | gpt-6-luna | medium | 18 | not routable | $0.04 | AA 2026-11-07 |
| Codex | gpt-6-luna | high | 21 | not routable | $0.07 | AA 2026-11-07 |
| Codex | gpt-6-luna | xhigh | 23 | not routable | $0.10 | AA 2026-11-07 |
| Codex | gpt-6-luna | max | 28 | cheap | $0.15 | AA 2026-11-07 |
| Codex | gpt-6-sol | any | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Codex | gpt-5.6-sol | any | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Codex | gpt-5.6-terra | any | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Codex | gpt-5.6-luna | any | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Antigravity | gemini-3.8-flash-low | in the id | 23 | not routable | not shown | AA 2026-11-07 |
| Antigravity | gemini-3.8-flash-medium | in the id | 30 | cheap | $6.26, looks wrong; verify | AA 2026-11-07 |
| Antigravity | gemini-3.8-flash-high | in the id | 31 | mid | $7.77, looks wrong; verify | AA 2026-11-07 |
| Antigravity | gpt-oss-120b-medium | in the id | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Antigravity | claude-sonnet-4-6 | in the id | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Antigravity | claude-opus-4-6-thinking | in the id | not on AA | cheap only | unknown | probes P1, P2 pass, 2026-11-07 |
| Claude | claude-haiku-5-5 | low | 19 | not routable | $0.04 | AA 2026-11-07 |
| Claude | claude-haiku-5-5 | medium | 25 | cheap | $0.09 | AA 2026-11-07 |
| Claude | claude-haiku-5-5 | high | 30 | cheap | $0.16 | AA 2026-11-07 |
| Claude | claude-haiku-5-5 | xhigh | 35 | mid | $0.25 | AA 2026-11-07 |
| Claude | claude-haiku-5-5 | max | 36 | mid | $0.41 | AA 2026-11-07 |
| Claude | claude-sonnet-5-5 | low | 26 | cheap | $0.51 | AA 2026-11-07 |
| Claude | claude-sonnet-5-5 | medium | 31 | mid | $0.78 | AA 2026-11-07 |
| Claude | claude-sonnet-5-5 | high | 42 | mid | $1.64 | AA 2026-11-07 |
| Claude | claude-sonnet-5-5 | xhigh | 50 | strong | $4.09 | AA 2026-11-07 |
| Claude | claude-sonnet-5-5 | max | 55 | strong | $10.02 | AA 2026-11-07 |
| Claude | claude-opus-5-5 | low | 35 | mid | $0.98 | AA 2026-11-07 |
| Claude | claude-opus-5-5 | medium | 48 | strong | $2.45 | AA 2026-11-07 |
| Claude | claude-opus-5-5 | high | 52 | strong | $3.46 | AA 2026-11-07 |
| Claude | claude-opus-5-5 | xhigh | 57 | strong | $6.05 | AA 2026-11-07 |
| Claude | claude-opus-5-5 | max | 59 | strong | $10.04 | AA 2026-11-07 |
| Claude | claude-fable-5-2 | low | 54 | strong | $3.10 | AA 2026-11-10 |
| Claude | claude-fable-5-2 | medium | 56 | strong | $3.80 | AA 2026-11-10 |
| Claude | claude-fable-5-2 | high | 62 | strong | $9.08 | AA 2026-11-10 |
| Claude | claude-fable-5-2 | xhigh | 62 | strong | $14.83 | AA 2026-11-10 |
| Claude | claude-fable-5-2 | max | 65 | strong | $26.54 | AA 2026-11-10 |
| Claude | claude-fable-5-1 | low | 39 | mid | $4.47 | AA 2026-11-07 |
| Claude | claude-fable-5-1 | medium | 43 | mid | $5.56 | AA 2026-11-07 |
| Claude | claude-fable-5-1 | high | 47 | mid | $7.54 | AA 2026-11-07 |
| Claude | claude-fable-5-1 | xhigh | 50 | strong | $10.85 | AA 2026-11-07 |
| Claude | claude-fable-5-1 | max | 49 | strong | $12.99 | AA 2026-11-07 |

## Notes
- Fable 5.2 supersedes Fable 5.1 for routing. The 5.1 rows stay as history. Route no new slice to 5.1 when 5.2 is listed.
- Escalation never reaches `max` (see "Fallback and escalation" in `routing.md`). Rows at `max` show the capability of the model, not a routing target.
- The probe set is a smoke test, not a ranking. Terra low (AA 29) failed probe P3. Sol low (AA 35) passed it. Luna low (AA 10) passed P1 and P2. Gemini Flash low (AA 23) passed all three, which AA does not support. AA is the tier source.
- The Gemini Flash costs came from a small summarizing reader and look wrong. Do not use them for a decision.
- The user approved these tiers on 2026-11-07 (DEC-9, tiers v2). A later failed slice check can lower a tier.
