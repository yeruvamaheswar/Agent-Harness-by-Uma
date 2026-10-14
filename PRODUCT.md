# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Public pages are static HTML, CSS, and JavaScript in one file, with no build step and no heavy dependency (the owner's brief, 2026-10-12). They must work on GitHub Pages or any static host. The harness itself is a Node 24 TypeScript CLI.

## Users
- Primary: a developer who directs two or more AI coding agents (Claude Code, Codex, Cursor) and wants them to work under the same rules. They read a public page before they read the source, to decide whether to clone and set up.
- Also: contributors who want to extend the harness, and readers with no technical background who want to understand the idea.

## Product Purpose
The Agentic Harness gives every AI coding agent on one computer the same working rules. The owner writes one policy, approves its exact text by digest, and freezes it as a numbered release. The harness installs that release where each agent reads it, with a backup, a receipt, a verify step, and an undo. It adds a few controls that the agent's own software enforces, and it runs spot checks in fresh sessions to see whether an agent follows the rules. Success: a new person can set it up after a clone and can say what each agent does with it.

## Positioning
Rules, locks, proof (confirmed by the owner, 2026-10-12).
- Rules: one rulebook, frozen as an approved release and installed in every agent.
- Locks: a few actions that the platform refuses or asks about, whatever the model decides.
- Proof: three separate levels: configured, tested, behaviorally verified. A file in the right place is never reported as proof of behavior.

## Operating Context
- The owner sets it up once. After that the agents read the policy at every session start. The harness does not run during daily work.
- Daily commands: `preview`, `publish`, `install`, `status`, `eval run`, `rules scan`, `context audit`.
- Project repos live anywhere. `repo install` puts the policy into a project for cloud agents, which see only that project.
- Plans and reports are written as `plans/<slug>.md` and built into pages by `md-view.sh`.

## Capabilities and Constraints
- Works today: digest-approved immutable releases; installs for Claude Code, Codex, Cursor (MCP entry), and a generic file; repo-scope install with full and pointer modes; enforced deny and ask rules on Claude Code only; a read-only MCP server with local keyword search; a global rules scanner with preview, apply, undo, and retire; a context audit; a behavior eval runner for Claude Code, Codex, and Cursor with a results log; a benchmark of 10 harder cases with held-out checks, repeated trials, and a release comparison; a product contract format with a warn-only lint.
- Manual: the Cursor User Rules paste after each release; the four skills and the page builder are copied by hand; Codex cloud needs one sentence per task.
- Parked (code and tests kept, no new work): Supabase semantic search, add-on rule packs, the Grok Bot export.
- Not built: controls for Codex and Cursor; a remote MCP server for cloud agents.
- Terms: policy, release, digest, install, receipt, control (lock, ask rule), eval (spot check), session.
- Instructions guide a model. They cannot force behavior. Every public statement must keep that limit visible.

## Brand Commitments
- Name: Agentic Harness.
- Visual identity: the "Witnessed Notebook" of the plan pages, recorded in `design/DESIGN.md`. Public surfaces are the same family, expanded with more space, motion, and interactive diagrams (confirmed by the owner, 2026-10-12).
- Voice: plain words and short sentences, inspired by ASD-STE100. Every claim says observed or unknown.

## Evidence on Hand
- `evals/cases.jsonl` (17 cases: 7 spot checks and 10 benchmark cases) and `evals/results/2026-10.jsonl` (131 logged runs).
- The spot-check table and the setup table in `plans/system-design.md`.
- 232 automated tests; CI with a full-history secret scan.
- `controls/controls.json` (6 controls, 27 rules) and the 9 frozen releases in `releases/`.
- Absent, never to be invented: adoption numbers, testimonials, benchmarks, comparisons with named products.

## Product Principles
- Separate advice, enforcement, and evidence, and never present one as another.
- Nothing publishes or installs without the owner's approval of the exact text.
- Every write has a backup, a receipt, and an undo.
- Keep the always-loaded core small; load detail only when a task needs it.
- State limits and unknowns next to the claims they limit.

## Accessibility & Inclusion
- Text meets WCAG AA contrast in light and dark.
- Every interaction works by keyboard. Motion respects `prefers-reduced-motion`. No content is reachable by motion or hover alone.
