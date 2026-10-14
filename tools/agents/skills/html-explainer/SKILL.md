---
name: html-explainer
description: Use whenever the user asks to build, write, make, or update a plan, audit, review, report, or comparison, in any repo, and as the running explainer of a nontrivial build. Always write plans/<slug>.md in the plan-page format and build plans/<slug>.html with ~/.agents/bin/md-view.sh. Reply with the page path and a short summary, not the whole plan in chat. The page template is fixed, so do not load a design skill to build the page.
---

# HTML explainer

`<slug>.md` is the source for agents. `<slug>.html` is the generated page for the user. Every repo uses the same template, and the repo name shows at the top.

## Rules
- One page per task. During a nontrivial build, update its steps after each slice.
- Put pages in `plans/` at the repo root unless the user names a place. Slug: short kebab-case topic name.
- Read and edit only the `.md`. Never read the `.html` to learn the plan. Never edit the `.html`.
- The page is for the user. If `~/.agents/bin/md-view.sh` is missing (a cloud agent or another machine), write only the `.md`, skip the build, and say so.
- Do not load impeccable or any design skill to build or rebuild. The template is fixed.
- For a design review of a product, use the project's own design review skill for the method. This skill only formats the result as the page.
- Template changes only when the user asks. Build them as `~/.agents/bin/md-view.template.sample.html` (impeccable allowed then). Promote only after the user approves.
- Show the user: the goal, what waits on them, progress, how each step is checked, and what is still unknown.
- Hide nothing. Record failed checks and skipped steps. For a done step, write the observed result in the check field.
- Use tables for comparisons. Use a ```mermaid block for 3+ interacting parts. No images or video unless the user asks.

## Commands
```bash
~/.agents/bin/md-view.sh plans/<slug>.md          # build after every .md edit
~/.agents/bin/md-view.sh --check plans/<slug>.md  # prints fresh, else exits 1
```
Needs `python3` and `shasum`. The page loads marked.js and mermaid (cdnjs) and the Archivo font (Google Fonts).

## Format
```markdown
---
kind: plan
title: <title>
status: active
updated: YYYY-MM-DD
---
Summary: <one plain sentence>
Goal: <one line>
Rules: <rule> · <rule>

## Loop
1. Edit the .md · agent
2. Approve · user

## Work
### Always loaded
- <item>
### On demand
- <item>
### Steps
- [x] <step> · <owner> · <observed result> · <rollback>
- [ ] <step> · user · <how the user checks> · <rollback>
### Open
- <question>: unknown
```
- `kind`: plan, audit, review, report, comparison, or explainer.
- `Label: value` lines before the first `##` render as a fact table. A value split by ` · ` renders as a list. Extra front matter keys render there too.
- `## Loop` items `N. Step · owner` render as owner lanes. Owners: `Claude`, `user`, or an agent name such as `Codex` or `Cursor`.
- Each Claude step names its subagent's model and effort in the owner field, e.g. `Claude (opus/high)`. Codex and Cursor steps say `Codex (auto)` or `Cursor (auto)`.
- Pick the lowest rung that fits: `haiku/medium` mechanical · `sonnet/medium` code, config, docs with tests · `opus/low` short judgment · `opus/medium` plans, multi-file docs · `opus/high` security, permissions, installers, cross-platform · `opus/xhigh` long multi-step work across repos · `opus/max` only with a written reason.
- Each slice lists `Depends on:` and `Files:` so independent slices can run in parallel.
- Task items `- [ ] text · owner · check · rollback` from every section form one progress board. Separator: space, middle dot, space. Open `user` steps also list under "Waiting on you".
- `### Always loaded` and `### On demand` in one section render side by side.
- Write unconfirmed facts as `unknown` (lowercase). They list under "Not yet confirmed".
- Keep it compact: lists, tables, short lines. No prose paragraphs.

## Contract (product-size work)
- A bug fix needs no contract.
- A feature puts `## Requirements` and `## Evals` in its normal plan page.
- A product gets `plans/<product>.contract.md`, built by the same builder.
- Use the normal front matter and `Label: value` lines. Add `Intent:` (one line, the user's words) and `Not wanted:` (a ` · ` list).

| Section | Columns or content |
|---|---|
| `## Requirements` | `\| ID \| Requirement \| Source \|`. IDs: `REQ-n` wanted, `NOT-n` must not have. Source: the user or the agent. An agent row is a suggestion until the user confirms it. A behavior requirement reads "When CONDITION, the app does BEHAVIOR", one behavior per row. |
| `## Decisions` | `\| ID \| Decision \| By \|`. IDs: `DEC-n`. |
| `## Evals` | `\| ID \| REQ \| Check \| Method \| Result \|`. IDs: `EVAL-n`. REQ names one or more `REQ-n` or `NOT-n`. Method: unit, integration, browser, verifier diff, human. Result: `not run`, or `pass` or `fail` with the date and a pointer to evidence (test name, log line, screenshot path). "Implemented" is not a result. |
| `## Infrastructure` | `\| Resource \| Defined in \| Applied by \| Secrets \|`. Every resource the app needs has a file in the repo. A resource made by hand is `manual` in "Defined in" and is a gap. List secrets by name, never by value. No infrastructure: one row with the resource `none`. |
| `## Observability` | `\| Signal \| Seen in \| Eval \|`. One row or more for errors, health, and key user events. The Eval cell names the `EVAL-n` that proves the signal fires. |
| `## Slices` | `### Slice N: name` with `- Covers:` (the `REQ-n` it delivers), `- Model:`, `- Depends on:`, `- Files:`, and task items. |
| `## Changes` | `\| ID \| Date \| Change \| Affects \| Approved \|`. IDs: `CR-n`. |

Skeleton:
```markdown
Intent: <the user's words>
Not wanted: <item> · <item>

## Requirements
| ID | Requirement | Source |
## Decisions
| ID | Decision | By |
## Evals
| ID | REQ | Check | Method | Result |
## Infrastructure
| Resource | Defined in | Applied by | Secrets |
## Observability
| Signal | Seen in | Eval |
## Slices
### Slice 1: <name>
- Covers: REQ-1
## Changes
| ID | Date | Change | Affects | Approved |
```
- Write the evals from the requirements before any code.
- After the user approves the contract, change a requirement, a NOT, or an eval only through a `## Changes` row that the user approves.
- A slice is done when its evals have a result with evidence.
- The builder warns about gaps (`warn:` on stderr). A warning does not stop the build.

## Review with Lavish (only when the user wants to annotate the page)
1. Run `lavish-axi plans/<slug>.html`. Then `lavish-axi poll plans/<slug>.html` for the user's notes.
2. Apply each note to the `.md`, rebuild, and tell the user to reload.
3. Run `lavish-axi end plans/<slug>.html` when the user is done. Do not reopen a session the user ended.
4. Never run `lavish-axi share`. It publishes to a third-party host.

## After each edit
1. Run the build command.
2. Run `--check`. Confirm it prints `fresh`.
