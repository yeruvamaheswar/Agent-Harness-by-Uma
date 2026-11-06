# Explainer drafts

Scope: the slice 7 rebuild of `docs/project-explainer.html`. This file lists every change that waits on the owner's approval, and records the Design OS runs for the build.

Status: **DRAFT, awaiting owner approval.** The page is built from the recommended defaults in [explainer-design-spec.md](explainer-design-spec.md). The approved direction stays: "The Witnessed Notebook, as a figure atlas". `PRODUCT.md` and `DESIGN.md` are not changed. The changes proposed for them are below, each with its reason.

## Draft items on the page

| ID | What | Where on the page | Options for the owner |
|---|---|---|---|
| D1 | Figure count and story: 13 numbered plates in three parts (The rules, Execution, Use it), instead of the approved nine | The whole page; the list of figures shows the three part labels | Approve (spec option A). Or merge Figs. 8 and 9 into one plate (option B, 12 plates). Or decline and move the new content into text sections (option C) |
| D2 | Hero wording: the title is kept. Only the lead line changes, so that it names the rules and the execution model | Title block, first viewport | Approve the lead as written. Or write a new title that names both layers (spec option B; the owner writes or approves the exact words) |
| D3 | Page title and description: "Agentic Harness: the project in figures" (the old title named a count of figures), and a description that names the skills and the engine | `<title>` and `<meta name="description">` | Approve, or give the exact words |
| D4 | Rail part labels in band type, which are not links | List of figures | Follows D1. If D1 is declined, the labels go |

The lead line under the title now reads: "Rules every agent reads, locks an agent cannot open, and spot checks that show whether the rules held. On top of the rules, skills and a small engine plan the work in slices, route each slice to an agent, and mark it verified only from a check that ran."

A comment at the top of the page marks it as a draft: `<!-- DRAFT (awaiting owner approval): figure count and hero wording; see docs/design/explainer-drafts.md -->`.

## Defaults taken for the spec's open questions

| Spec question | Default taken | Why |
|---|---|---|
| 1. Story amendment | Option A, 13 plates | The spec's recommended order (topic 1). It is D1 above |
| 2. Hero wording | Option A: keep the title, rewrite the lead | The smallest change to the first viewport. Copy is the owner's decision, so it is D2 |
| 3. Generated item content | The generator is **not** changed. Each item already holds the name, status, purpose, and load mode, so the page reads fully without JavaScript | The slice may change only the HTML render function. Needs, Example, and Result are not on `CatalogSkill`, so emitting them would change `catalog()` too. The facts form shows Group, Status, Loads, Call, Purpose, and the install command. Open item O3 |
| 4. Real-run evidence | Option A: each new plate opens with "Example sequence from the engine's commands, not a logged run", in pencil | No committed run log exists for orchestration, handoff, or an unattended run |
| 5. Stale `PRODUCT.md` | Proposed below as a draft; the file is not edited | The owner decided that `PRODUCT.md` changes are drafts |
| 6. Installed Impeccable | The installed skill `design-os-impeccable:impeccable` (0.3.0) was used | See "Design OS runs" |

## Proposed changes to PRODUCT.md (not applied)

| Line now | Proposed | Reason |
|---|---|---|
| "Manual: ... the four skills and the page builder are copied by hand" | "Manual: the Cursor User Rules paste after each release; the page builder is copied by hand; Codex cloud needs one sentence per task. Skills install with `npm run harness -- skills install NAME`." | The skills installer exists (`src/skills.ts`), and there are more than four skills |
| "Works today: ..." | Add: "a skills installer with status, verify, and undo, and a generated skill list that CI checks; the `ae` engine with slice states, evidence, and a command guard; checkpoint, handoff, transfer, and recover; a charter for unattended runs with a deadline and attempt caps, and no commit grant" | These are built and tested (README, `tests/ae-*.test.ts`) |
| "Daily commands: `preview`, `publish`, ..." | Add `skills install` and `skills status` | Both are documented commands in `npm run harness -- help` |
| "`evals/cases.jsonl` (17 cases: ...) and `evals/results/2026-10.jsonl` (131 logged runs)" | "`evals/cases.jsonl` and `evals/results/`, the logged runs" | Counts drift. The audit counted 22 cases and 161 runs on this branch |
| "232 automated tests; CI with a full-history secret scan." | "`npm test`, which prints its own count; CI with a type check, the catalog checks, and a full-history secret scan." | A typed test count goes stale |
| "`controls/controls.json` (6 controls, 27 rules) and the 9 frozen releases in `releases/`" | "`controls/controls.json` (6 controls, 27 rules) and every frozen release in `releases/`, listed in `releases/README.md`" | There are 15 releases today, and the number grows |
| "Not built: controls for Codex and Cursor; a remote MCP server for cloud agents." | Add: "a recorded unattended overnight run; the later slices of `thread-continuity`" | Both are named as not done in the README's known limitations |

## Proposed changes to DESIGN.md (not applied)

| Place | Proposed | Reason |
|---|---|---|
| Front matter `description`, Overview | "Numbered plates in three parts explain the project" instead of "Nine numbered plates" / "Nine numbered figures" | Follows D1. A count in the design system goes stale |
| Navigation: list of figures | Add: "Part labels in band type, on a 1px form underline, above each group of rows. They are not links. On a phone they sit inline in the strip." | New component on the page (D4) |
| Colors, Rule | Add: "`rule` is for plate borders and row separators only. Control boundaries (chips, moments, skill buttons, the text-button underline) use `form`." | `rule` is 1.48:1 (light) and 1.69:1 (dark) on paper, under the 3:1 non-text target. The build uses `form` (6.92:1, 8.57:1) |
| Components, Facts form | "Rows have .35rem top padding; the fact-lead line height is 1.3." | Answers the detector's spacing and leading findings; the fact lead can wrap |
| Components, new: Skill list | Record `.skill-catalog` and `.skill-filter`: group columns (3 at 1180px and up, 2 to 641px, 1 below), each skill a button with `aria-pressed`, a status mark plus its word, the purpose line in ink-2; a filter strip of four toggle buttons with a polite live count; an empty line and a missing-list line in pencil; with JavaScript off, a plain two-column list | New component (spec topic 6) |
| Layout, top bar | "A skip link comes first. On a phone the bar may wrap to two lines; it keeps the release, Set it up, and the theme button; GitHub moves to Read next." | Spec topics 4 and 5 |
| Shapes, diagram grammar | "A path in a node breaks only after a `/` (`<wbr>`)." | Spec topic 4 |

## Proposed changes to the surface brief (not applied)

`docs/design/explainer/.impeccable/surfaces/docs-project-explainer-html.md` keeps its approved text. If D1 is approved: THESIS "Nine numbered, interactive plates" becomes "Numbered interactive plates in three parts", and STORY gains the Execution part after "a session" (skills, one plan with many agents, checkpoint and handoff, an unattended run, then one real run). The brief now carries a short "Draft build" note that points here.

## What was built

Section order: title; **The rules**: Fig. 1 The whole system, Why it exists, Fig. 2 Advice, ask rule, lock, Fig. 3 A release is frozen, Fig. 4 Install, receipt, undo, Fig. 5 What a session loads; **Execution**: Fig. 6 The skills, Fig. 7 One plan, many agents (with the model strategy block), Fig. 8 Checkpoint, handoff, recover, Fig. 9 An unattended run and its stops, Fig. 10 One real run, step by step; **Use it**: Set it up (short path first), Fig. 11 What each platform gets, Fig. 12 Configured, tested, verified, Why it is built this way, Fig. 13 Today, and what is next, Read next.

Skills explorer: the generated block between the skill markers was moved, unchanged, from Set it up into Fig. 6. `skills catalog --write` rewrote it byte for byte and `--check` passes. The script reads only `li[data-skill]`, its `data-group`, `data-status`, and its text. It groups the items under the five group names, turns each name into a button with `aria-pressed`, adds the status mark, and fills the facts form. The filter sets `hidden` on items and on empty groups, and writes "Showing N of M skills" into a polite live region. With JavaScript off, the filter strip stays hidden and the plain list shows every skill with its purpose and load mode. If no item is found, a pencil line says "The skill list did not load. See docs/skills.md."

## Checks run on this build

| Check | Result |
|---|---|
| `npm run harness -- skills catalog --check` | exit 0, "ok (10 skills)" |
| `node --experimental-strip-types --test tests/skills-catalog.test.ts` | 40 pass, 0 fail |
| `env -u FORCE_COLOR -u NO_COLOR npm test` | 612 tests: 611 pass, 0 fail, 1 skipped (the Design OS sibling test, known) |
| Overflow, headless Chrome, 360, 390, 768, 1024, 1440 px, light and dark | `scrollWidth == clientWidth` in all 10; no element past the viewport |
| Console after load and after using every control once | 0 errors in all 10 |
| Skills filter | All 10 of 10, Stable 5, Beta 4, Experimental 1; the empty line stays hidden |
| Reduced motion | no travelling mark after each Follow and Play button |
| Keyboard | Skip link is the first stop; arrow keys move inside the skills group; every focused control has an outline |
| Contrast of control borders | `.act`, `.mo`, skill buttons, `.pick` underline: 6.92:1 light, 8.57:1 dark; pencil text 4.98:1 light, 6.91:1 dark |
| Target size | no control under 24 px at any width (the top-bar links were 23 px; fixed to 28 px) |
| No JavaScript | every skill shows with its purpose and load mode; the filter strip stays hidden (a `.ctl` display rule first overrode `hidden`; fixed with a global `[hidden]` rule and re-checked) |
| Browser cache | the final runs disabled the cache and used a fresh profile, so they read the final file |
| Links | same-page anchors resolve. External: 200 for every link except 4 that 404 on `main` today: `docs/skills.md`, `docs/workflows.md`, `docs/multi-agent-planning.md`, `docs/subagent-budget.md`. Those files exist on this branch; the links resolve after it merges (open item O1) |
| Stale-fact grep | hits only in Fig. 12's dated October 2026 record (the release 1.4.2 against 1.4.3 benchmark table and the spot-check data); `PRODUCT.md` lines 33 and 47 (not edited, proposed above) |
| Private-path grep (home-folder paths and T3 thread links) on the page and this file | no hits |

Not checked: 200 percent zoom at 1440 px as a separate run (the 768 and 390 px runs cover the same CSS width); a real screen reader; touch on a physical device.

## Detector findings (`impeccable detect --json docs/project-explainer.html`, exit 2, 15 warnings on the final page)

| Finding | Count | Disposition |
|---|---|---|
| `cramped-padding` on `<dt>`, "flush against border-bottom" | 9 | Probable false positive. The only `dt` elements with a bottom border are the 9 rows of "What is in the repo" (`.map`), and they have 11.2px bottom padding. The detector reports `line: 0`, so the match is inferred from the count, not confirmed |
| `tight-leading` (below 1.3) | 5 | Four are single-line uppercase labels, buttons, lane names, and line labels at 1.2 (`.label`, `.btn`, `.lane`, `.elab`); the spec exempts them. The fifth appeared when the new plate headings wrapped to two lines; it is probably the headline token (1.15, approved in DESIGN.md). Not confirmed: the detector reports `line: 0` |
| `aphoristic-cadence` | 1 | Its snippet quotes "Load only by name." (generated from the skill front matter) and "No skill has this status." (the empty state the spec requires). Not changed |

## Design OS runs

| Skill | Result |
|---|---|
| `design-os-impeccable:impeccable` (plugin 0.3.0) | Loaded. `impeccable context --target docs/project-explainer.html` ran, exit 0: it loaded `PRODUCT.md`, the surface brief (mode Read), and pointed to `DESIGN.md`, which was read in full. `reference/craft-floor.md` was read before the edits. The autonomy check was answered from the owner's 2026-11-06 decision (build from the defaults), so no interview was asked |
| Impeccable `detect` | Ran once on the finished page. Results above |
| Impeccable `critique` | Assessment A ran as an isolated sub-agent (design review). Assessment B (detector and browser evidence) was run by the builder, not by a second isolated sub-agent, so this is a partly degraded run. Results: see "Critique, Assessment A" below |
| `design-os:visual-review` | Ran. It routed to Impeccable `critique` (above) and `audit`. The audit checks were the measured runs in "Checks run on this build". Findings and readiness: see "Visual review record" |
| `design-os:handoff` | See "Handoff" below |

### Critique, Assessment A

Run by an isolated sub-agent (a different model from the builder), from the screenshots and the source. It did not see the detector output.

- Design specificity: authored, not interchangeable. The new plates keep the atlas grammar.
- Nielsen: 25 of 36 (heuristic 5, error prevention, is n/a for a read-only page). Lowest: 2 to 9 at 3; help and documentation at 4.
- Cognitive load: 3 of 8 checks fail. Figs. 1, 7, and 8 show more than 4 parts at once; "charter", "journal", and `ae` were defined only in captions.
- Factual honesty: no error found against `ae.ts`, `usage.ts`, `run.ts`, `overnight.md`, and `multi-agent-planning/SKILL.md`. Nothing unreleased is shown as released.
- It could not check keyboard, screen reader, live regions, or reduced motion (static images only). The builder's measured runs cover those.

| Issue | Disposition |
|---|---|
| P1 Phone top bar wraps inside each control | Fixed before the review ended: the bar wraps to two lines and each control stays on one line. The reviewer saw the older screenshots |
| P2 Fig. 9 columns start at four heights | Kept. It is the strength stair of Fig. 2, on purpose. A note now says so |
| P2 Skill names and source paths break mid-token | Fixed. Skill names never split; the status drops below when narrow. Paths in caption notes break only after `/` |
| P2 Fig. 8 moments show no command | Declined. Each command is in the facts form. A mono sub-line on eight small boxes would crowd them. Owner may decide |
| P3 Hero lead is long on a phone | Left for the owner: it is draft D2 |
| Jargon without a gloss | Fixed: "Journal" and "Charter" added to "Words used here" (with "Slice" and "Engine") |
| Question: is the reviewer always Claude? | The lane now reads "Claude reviewer", as in the example plan. The README says Grok may also review; the example does not use it |

### Visual review record

- Artifact: `docs/project-explainer.html`, uncommitted, on a branch from 6c2064a. Served from 127.0.0.1 for the checks only.
- Evidence: headless Chrome at 360, 390, 768, 1024, and 1440 px, light and dark; the runs in "Checks run on this build"; the detector; Assessment A. Screenshots are kept outside the repo and listed in the slice report.

| UI gate | Result |
|---|---|
| Hierarchy | Pass. One h1; each plate one h2 with its figure number, 1 to 13 with no gap; the rail shows three parts |
| Spacing and type | Pass. Existing tokens only; no new colour token or font |
| Layout resilience | Pass at the five widths. 200 percent zoom: not run separately (unknown) |
| Consistency and recovery | Pass. Every plate uses select-a-part plus a facts form; Back and Next on the step plates |
| Restraint | Pass. No gradient, glow, or shadow with blur; motion starts only from a button |
| Complete flow | Pass. Filter states, the empty line, the missing-list line, and the no-JavaScript list exist. The empty and missing states were checked in code, not by removing items in a test copy (unknown) |
| Purposeful details | Pass, with the declined Fig. 8 item above |
| Appearance | Pass. Light and dark both inspected; contrast measured in both |
| Accessibility | Pass on the measured items (contrast, focus, keyboard order, target size, reduced motion, live regions). Screen reader: unknown |
| Anti-generic rationale | Pass (Assessment A) |

Technical readiness: no blocking verified defect remains in scope. Human approval: **not given**. D1 to D4 and the proposed file changes wait on the owner.

### Handoff

- Scope: slice 7, "Explainer", of the production-readiness plan.
- Changed files (uncommitted): `docs/project-explainer.html`; `docs/design/explainer/.impeccable/surfaces/docs-project-explainer-html.md` (a draft note only); this file. Not changed: `src/skills-catalog.ts` and `tests/skills-catalog.test.ts` (the generator already emits what the page needs), `PRODUCT.md`, `DESIGN.md`, `README.md`.
- Inputs: [PRODUCT.md](explainer/PRODUCT.md), [DESIGN.md](explainer/DESIGN.md), the surface brief, [explainer-design-spec.md](explainer-design-spec.md).
- Approved: the direction (owner, 2026-10-12 and 2026-10-13), and "build from the spec defaults" (owner, 2026-11-06). Not approved: D1 to D4 and every proposed change above.
- Reproduce: serve `docs/` on 127.0.0.1 and open `project-explainer.html`. Run `npm run harness -- skills catalog --check`, `npm test`, and `impeccable detect --json docs/project-explainer.html`.
- Installation and behavior: this is a static page. Nothing is installed. "Configured" and "verified" claims on the page come from the repo, not from this build.
- Next bounded action: the owner decides D1 to D4. If D1 is approved, apply the DESIGN.md and surface-brief wording above. Then a fresh reviewer runs the acceptance checks in the spec on the merged page.
- Dependencies and licence: no new dependency. One web font (Archivo, Google Fonts), as before. MIT.

## Open items

| ID | Item | Who |
|---|---|---|
| O1 | Four "Read next" links 404 until this branch merges to `main` | Resolves on merge |
| O2 | Approve or decline D1 to D4 and the proposed `PRODUCT.md`, `DESIGN.md`, and surface-brief changes | The owner |
| O3 | If the facts form should show Needs, Example, and Result: carry them on `CatalogSkill` in `catalog()` and emit them in the HTML block | A later slice; it touches more than the render function |
| O4 | The Fig. 12 tables are a dated October 2026 record on releases 1.4.1 to 1.4.3. No spot check or benchmark of 1.5.5 is on the page | Needs new eval runs |
