# Explainer design specification

Scope: `docs/project-explainer.html`, the public explainer. This file is the design-to-code handoff for the next rebuild of that page. It records a Design OS consultation on the owner's design brief (mission brief, section 8) and gives one rule set per brief topic.

Status: recommendation. The verdict below is **keep**, so the approved direction stays. One amendment to the approved story and plate count is a **DRAFT** that waits on the owner's approval (see "Open questions for the user").

Labels used in this file:
- **[Design OS]**: the recommendation comes from a Design OS skill run recorded in the consultation log, or from a Design OS document that the run loaded (principles, UX domain, UI acceptance gates, typography guide).
- **[Critique]**: the finding comes from the Impeccable `critique` run (Assessment A: design review, or Assessment B: detector and browser evidence).
- **[derived]**: my own derivation from the brief, the repo, and the evidence above. It is not a Design OS output.

Sources in this repo: `docs/design/explainer/PRODUCT.md`, `docs/design/explainer/DESIGN.md`, `docs/design/explainer/.impeccable/surfaces/docs-project-explainer-html.md`, `docs/project-explainer.html`, `tools/agents/skills/`, `src/skills.ts`, `src/cli.ts`.

## Consultation log

Design OS here is the `design-os` plugin (Design OS repo `designOS-by-Uma`). The Impeccable skill lives in a separate plugin of that repo, `design-os-impeccable`. State when the runs happened: only `design-os` 0.2.0 and `design-os-media` were installed. `design-os-impeccable` 0.3.0 was installed afterwards (installed 2026-11-05, 21:43 local time). Its registered skill name is `design-os-impeccable:impeccable`, not `design-os:impeccable`. `design-os` 0.2.0 also bundles an older copy under `skills/impeccable`. All runs were read-only. No run wrote to this repo, except this file.

| Skill | Input given | Result summary or exact error |
|---|---|---|
| `design-os:brief` | The section 8 brief, verbatim. Facts: one static file, no build step; the approved direction; 10 skills; the stale facts. | Ran. The skill routes UI work to Impeccable `init` and `shape` when Impeccable is installed. Impeccable was not installed at run time (next rows; it has been installed since), so the brief steps applied. Output: audience, task, success measure, constraints. These are recorded under "1. Information architecture". Step 5 ("update PRODUCT.md") was **not done**, because this slice may not edit `PRODUCT.md`. The stale `PRODUCT.md` facts are listed as an open item. |
| `design-os:impeccable` (as named in the slice brief) | `critique docs/project-explainer.html` | **Failed.** Exact error: `Unknown skill: design-os:impeccable`. Cause, as observed at run time: the installed plugins were `design-os` and `design-os-media`, and `design-os-impeccable` was not installed. Two facts found afterwards: the skill name was wrong for the plugin that provides it (`design-os-impeccable:impeccable`), and `design-os-impeccable` 0.3.0 has since been installed (2026-11-05, 21:43 local). So this failure is stale: the skill is now available under its own name. |
| Impeccable `context` (launcher from the Impeccable plugin source; the exact path was not recorded) | `context --target docs/project-explainer.html` | Ran, exit 0. The engine was already cached, so nothing was downloaded or installed. It loaded `PRODUCT.md`, the surface brief (mode: **Read**), and a pointer to read `DESIGN.md` in full. `git status` stayed clean. |
| Impeccable `critique` (playbook `reference/critique.md`, followed from the plugin source) | Target `docs/project-explainer.html`. Assessment A and Assessment B ran as two isolated sub-agents, as the playbook requires. | Ran, method: dual-agent. Agent IDs are kept out of this public file. **A (design review):** rendered at 1280 and 390 px. Nielsen total 27/40 ("acceptable"). Design specificity: strongly authored, not generic. Direction defect: **no**. Priority issues: P1 the brief's content is missing (skills, orchestration, model strategy, continuity, unattended runs); P1 stale facts; P2 setup has no quick path; P2 hard-coded "nine figures" and a narrow hero; P3 paths break mid-token in Fig. 1 nodes. **B (detector and browser evidence):** `impeccable detect --json` exit 2, 13 findings (9 `cramped-padding` on `<dt>`, 4 `tight-leading` at line-height 1.2), all with `line: 0`. No page-level horizontal overflow at 360, 768, 1440 px. All text token pairs pass AA in both themes. The `rule` token is 1.48:1 (light) and 1.69:1 (dark) against paper. **Skipped steps:** the live-server overlay injection (read-only run); the snapshot write to `.impeccable/critique/` (out of this slice's write scope); the closing question to the user (moved to "Open questions for the user"). **The scores and counts in this row (27/40, 13 findings, the page height) are as reported by the sub-agents. Their output was not kept and a reviewer could not re-run them; read them as unverified.** The contrast figures were recomputed by a reviewer from the CSS tokens and match. |
| `design-os:direction` | The current approved direction and DESIGN.md, judged against the brief, with the critique evidence. | Ran. The skill also routes UI to Impeccable when it is installed; it was not installed at run time, so the steps applied. Result: **keep**. Each defect is fixable with existing tokens and components (see the verdict). Step 5 ("save the direction in DESIGN.md") was **not done**, because this slice may not edit `DESIGN.md`. The routing index rule applies: a changed decision is a draft until the owner approves it. Typography guide loaded: keep the current families; no new font. |
| `design-os:specification` | The kept direction, the 12 brief topics, the 10 content areas, the generated skill block, the states, and the widths. | Ran. Output: this file. Its acceptance test is "an implementer can build and verify the slice without guessing". Every topic below therefore ends in a testable rule. No pixel fidelity is claimed. No rendered comparison of the new design exists yet. |
| `design-os:visual-review` | Not run in this slice. | Not run. It needs the rebuilt page. The build slice runs it on the rendered output (see "Acceptance checks"). |
| `design-os:handoff` | Not run in this slice. | Not run. This file and the slice report act as the handoff. Run it after the build. |

## Verdict on the approved direction: keep

Verdict: **keep** "The Witnessed Notebook, as a figure atlas". [Design OS: direction run; Critique A: "Direction defect: no"]

Per the mission plan's Decision 4 (keep the direction unless Design OS finds a concrete defect), this needs no approval. The concrete defects found, and why none of them is a defect of the direction:

| Defect (evidence) | Cause | Fix inside the direction |
|---|---|---|
| Most of the brief's content is missing: no skills explorer, orchestration, model strategy, continuity, or unattended runs. The only skill content is a manual copy note (HTML line 734). [Critique A, P1] | Content and IA. The page was written before these features existed. | New plates in the same grammar. The lanes, steps, moments, and facts form already exist as components. |
| Stale facts: "Release 1.4.3" (lines 385, 432, 934 and others); "four skills" (746, 872); "No harness command installs them yet" (734); "9 releases" (558); "232 automated tests" (793, 894); "nine figures" (7, 416); Fig. 9 lists the skill installer as not built (883). [Critique A and B] | Hard-coded facts with no check. | Correct the facts. Remove counts that can drift, or generate and check them. |
| Interactive chips `.act` (Fig. 2), `.mo` (Fig. 5) and the `.pick` underline use the `rule` token: 1.48:1 light, 1.69:1 dark. This is under the 3:1 non-text target. [Critique B; line numbers 123, 166, 205] | One token used outside its role. DESIGN.md gives `rule` to plate borders and row separators. | Use `form` (6.92:1 light, 8.57:1 dark) or the owner ink for interactive boundaries. No new token. |
| The phone top bar hides "Set it up" (observed at 390 px). [Critique A] | Responsive rule. | Keep "Set it up" in the phone top bar. |
| Paths break mid-token in Fig. 1 nodes ("CLAU DE.md"). [Critique A, P3] | Line-break rule. | Break paths only at `/`. |
| Detector: `tight-leading` (line-height 1.2 at lines 41, 93, 104, 196) and `cramped-padding` on `<dt>`. [Critique B; `line: 0`, so the match to these lines is probable, not confirmed] | Type and spacing details. | Rules in topics 2 and 3. Single-line labels are exempt. |

The two strongest reasons to keep:
1. **The grammar already fits the new content.** Owner inks name who acts, and lanes with steps show a sequence. A facts form states what is selected, and pencil marks what is unknown. Orchestration and handoffs are "who acts, in what order, with what evidence". That is what this grammar shows. A new direction would rebuild these components and lose the approved identity. [Critique A; derived]
2. **The measured base is sound.** Every text token pair passes WCAG AA in both themes (lowest: pencil 4.98:1, light). There is no page overflow at 360, 768, or 1440 px. Reduced-motion rules exist (line 281). There are no gradients, glow, shadows, or hero metric. Every defect above is content, staleness, or one misused token. [Critique B]

**DRAFT, needs the owner's approval:** the approved surface brief fixes "nine numbered plates" and a STORY order. DESIGN.md says "Nine numbered figures". Adding the brief's content means more plates and a longer story. This change is an amendment of approved content, not a change of direction. Under the Design OS precedence rule 2 (writes are drafts), it stays a draft until the owner approves it. The build slice may not change the surface brief or DESIGN.md without that approval. See "Open questions for the user", question 1.

## Content areas mapped to page sections

The 10 content areas from brief section 9, mapped to the current page. "Fig." numbers on the left are current. The proposed order is in topic 1. [derived, from Critique A coverage findings]

| # | Content area (brief section 9) | Current section | State | Work |
|---|---|---|---|---|
| 1 | Hero | Title block (line 414): "One rulebook for every AI coding agent." | Exists, needs rework | The lead names rules only. Add the execution model. Remove "Explained in nine figures". |
| 2 | How it works | Fig. 1 The whole system; Why it exists; Fig. 2 Advice, ask rule, lock; Fig. 3 A release is frozen; Fig. 4 Install, receipt, undo; Fig. 5 What a session loads | Exists, needs rework | Fig. 1 gains a skills node and a run-engine node. Facts move to the active release. Fig. 4 notes that `harness skills install` uses the same backup, receipt, and undo. |
| 3 | Skills explorer | Only "Skills: one manual step" (line 733) | **New** | A new plate driven by the generated block. See topic 6. |
| 4 | Agent orchestration | None | **New** | A new plate: one plan, slices routed to agents, an independent reviewer, a verify step. See topic 7. |
| 5 | Model strategy | None | **New**, merged into area 4 | The orchestration plate's facts form, plus one short text block. It shows what is implemented: per-slice model and effort, auto mode for Codex and Cursor, and no fixed subagent cap. |
| 6 | Context and continuity | Fig. 5 shows the session start only | **New** | A new plate: checkpoint, handoff, recover, and usage handoff, as a timeline. |
| 7 | Autonomous execution | None | **New** | A new plate: the charter, the stops (deadline, cap, block), the report, and what the engine refuses. |
| 8 | Examples | Fig. 6 One real run, step by step | Exists, needs rework | Keep the logged run. Label its release (1.4.2 to 1.4.3) as a historical record with its date. Add one workflow example per new plate only if a committed, real artifact exists (topic 8). |
| 9 | Getting started | Set it up (line 674) | Exists, needs rework | Add a short path first. Replace the manual skill copy with `harness skills install`. Keep "You should see". |
| 10 | Developer resources | Read next (line 902); What is in the repo (line 738) | Exists, needs rework | Add links to the README, `docs/skills.md`, the skill folders, CONTRIBUTING.md, and SECURITY.md. |

Sections that stay as they are, apart from fact fixes: Fig. 7 What each platform gets; Fig. 8 Configured, tested, verified; Why it is built this way; Fig. 9 Today, and what is next.

Not to be shown as released, anywhere on the page: thread-continuity slices 2 to 6 (only the tracer exists, marked "Not installed"); Supabase semantic search, add-on rule packs, and the Grok Bot export (parked); Codex and Cursor controls and a remote MCP server (not built). These stay in the "Today, and what is next" figure under "Parked" or "Not built", in pencil.

## 1. Information architecture and content hierarchy

**Brief run output** [Design OS: brief]
- Audience: a developer who directs two or more AI coding agents and meets the harness for the first time. Also contributors, and readers with no technical background.
- Primary task: understand what the harness is, how its skills work, how agents coordinate, and why the execution model is worth it. Then decide whether to clone it.
- Success measure: after one read, the reader can name the two layers (rules, and execution) and say what each agent does. They can also start the setup without the source.
- Medium and scope: one static HTML file, Read mode, phone to desktop, light and dark.
- Facts, assumptions, unknowns: the facts are in the repo. One assumption: first-time readers scan the rail before they read. One unknown: the public page URL (it is still open in the surface brief).

**Recommendation.** Keep the figure-atlas story: see the whole system first, then each part, then set it up. Insert an "Execution" part after Fig. 5, because "What a session loads" leads straight into "skills load by description". Proposed order (DRAFT, see open question 1) [derived]:

| Part | Sections, in order |
|---|---|
| The rules | Title block; Fig. 1 The whole system; Why it exists; Fig. 2 Advice, ask rule, lock; Fig. 3 A release is frozen; Fig. 4 Install, receipt, undo; Fig. 5 What a session loads |
| Execution | Fig. 6 The skills; Fig. 7 One plan, many agents; Fig. 8 Checkpoint, handoff, recover; Fig. 9 An unattended run and its stops; Fig. 10 One real run, step by step |
| Use it | Set it up; Fig. 11 What each platform gets; Fig. 12 Configured, tested, verified; Why it is built this way; Fig. 13 Today, and what is next; Read next |

**Why.** Clarity and hierarchy: the brief's value claim ("why its execution model is valuable") needs a named place in the contents. Three parts break the long rail into chunks. Critique A counted 13 rail rows; there will be 19. Restraint: model strategy merges into Fig. 7 and gets no plate of its own.

**Keep:** the folded "Fig. N." heading; text sections without a plate; limits next to claims.
**Change:** add the three part labels to the rail; add four plates; rework the hero and Fig. 1.

**Testable rules.**
- The rail shows exactly 3 part labels in band type. Each part holds 5 to 7 rows.
- No text states the number of figures. Test: `grep -niE 'nine figures|[0-9]+ figures' docs/project-explainer.html` returns nothing.
- Each plate has exactly one `h2` with a `.figno`. The figure numbers run 1 to N with no gap.
- The page has one `h1`. The heading levels skip no level.

## 2. Visual direction and typography

**Recommendation.** Keep the type system and every colour token in DESIGN.md unchanged. Archivo (condensed) serves display, headlines, labels, and lanes. The system-ui stack serves reading text. ui-monospace serves code, paths, and digests. [Design OS: direction, typography guide: "start with one family; add another when a distinct role benefits"; the current pairing assigns a fixed job to each family]

**Why.** Consistency and restraint. The brief asks for no AI-landing aesthetics. The current direction already has no gradients, glow, or shadows (DESIGN.md "Flat Paper Rule"). Apple stays a reference for care and legibility, not a visual template. [Design OS: principles]

**Keep:** all tokens; the Owner Ink Rule (3 owner inks, no fourth); the Pencil Rule; the Flat Paper Rule; the No Margin Rule.
**Change:** [Critique B; derived]
- Multi-line text uses line-height of at least 1.3. Single-line uppercase labels and buttons (`.label`, `.btn`) may stay at 1.2. Record them as detector false positives after you confirm each is single-line at 360 px.
- `.detail dd.big` (line 196) can wrap, so it moves to 1.3 or more.
- New agents in the orchestration plate (Codex, Cursor, Grok) all take `agent` cobalt. Their lane label tells them apart, not a new colour.

**Testable rules.**
- 0 new colour tokens. 0 new font families. Test: the set of `--*` custom properties on `:root` equals the DESIGN.md token list.
- 1 primary accent (`form`). Owner inks appear only on node borders, lane labels, and "You do by hand" marks.
- No `linear-gradient`, `radial-gradient`, `box-shadow` with a blur over 0, `filter: blur`, or `text-shadow`. Test: grep the CSS for these returns nothing, except the existing inset rings (blur 0).
- Prose measure is at most 44rem (the `measure` token).

## 3. Spacing and layout principles

**Recommendation.** Keep the frame, rail, spread, caption column, and rhythm tokens. [Design OS: UX gate "Spacing and type: repeated spacing uses named tokens"]

**Why.** Consistency: the new plates reuse the spread (plate plus a caption column). They then read as part of the same atlas.

**Keep:** `max-width` 90rem; `page-x` 3rem, 1.5rem, and 1rem; rail 14.75rem; caption column 16.375rem; section rhythm 7rem and 5rem; `frame-gap` and `spread-gap`.
**Change:** [Critique B; derived]
- The facts form rows (`dt`, `dd`) get block padding of at least .35rem, so text never touches the row rule. This answers the 9 `cramped-padding` findings.
- New plates use the existing spread. A new plate never takes a third column.

**Testable rules.**
- Every margin, padding, and gap on a new component uses a DESIGN.md spacing token or a value already used by an existing component of the same kind.
- No text node touches a border. A `dt` or `dd` has 5.6px or more of padding on the bordered side.
- Section spacing between sections is 7rem above 900 px and 5rem at or below 900 px.

## 4. Desktop, tablet and mobile behavior

**Recommendation.** Keep the three breakpoints: 73.75rem (1180 px), 56.25rem (900 px), and 40rem (640 px). Test at 360, 390, 768, 1024, and 1440 px. [Design OS: UX domain "inspect desktop and mobile sizes and one intermediate width"; derived widths from the mission plan's requirement 7 (no overflow, console errors, or stale facts at 360 to 1440 px, light and dark)]

**Why.** Smooth behavior: the reader keeps their place at every width. The phone page is already about 25,000 px tall (Critique A, B). The new plates must stay compact on a phone.

**Keep:** at 1180 px and below, the caption stacks (heading, plate, body). At 900 px and below, the rail becomes a sticky strip. At 640 px and below, plates go to one or two columns, tables stack, and targets are 2.75rem.
**Change:** [Critique A; derived]
- At 640 px and below, the top bar keeps "Set it up", the release, and the theme button. "GitHub" moves to "Read next".
- Skills explorer: three group columns at 1180 px and above; two at 641 to 1179 px; one at 640 px and below.
- Orchestration lanes: at 640 px and below, the lanes turn into one ordered list of steps. Each step keeps its owner-ink border and lane name.
- Paths in nodes may break only at `/`: insert `<wbr>` after each `/`. Never use `word-break: break-all`.

**Testable rules.**
- `document.documentElement.scrollWidth <= clientWidth` at 360, 390, 768, 1024, and 1440 px, in light and dark.
- No element's right edge goes past the viewport, except inside an element that scrolls on purpose (command boxes, wide tables), and each of those is keyboard reachable.
- At 200 percent zoom at 1440 px, no text is clipped and no control is hidden. [Design OS: UX gate "Layout resilience"]

## 5. Navigation and interaction patterns

**Recommendation.** Keep the list of figures as the contents, the "select a part, read its facts" pattern, and one tab stop per figure. [Design OS: UX domain; DESIGN.md "Diagram node: Keyboard"]

**Why.** Thoughtful interaction: one pattern across the whole page means the reader learns it once (consistency). The new plates use the same pattern.

**Keep:** sticky rail with the current entry in form; arrival tint; roving tab stop; `aria-pressed` on selected parts; facts form as a polite live region; "Follow one rule" and "Play" buttons that start motion only when pressed.
**Change:** [derived]
- Add a "Skip to content" link as the first focusable element. It targets `main`. Today the rail's 13 links come before `main`, and there is no skip link.
- The rail gets the three part labels (topic 1). The labels are not links.
- Each new plate opens with its first part selected. Its facts form is filled, so the plate is never empty.

**Testable rules.**
- Tab from the top reaches "Skip to content" first. Enter moves focus into `main`.
- In each interactive figure, Tab enters once. Arrow keys, Home, and End move between parts. The selected part holds the tab stop. Enter and Space select.
- The current rail entry has `aria-current="true"` and changes as the reader scrolls.
- No content or control appears only on hover. [PRODUCT.md "Accessibility & Inclusion"]

## 6. Displaying the skills catalog

**Recommendation.** A new plate, "Fig. 6. The skills". It shows all 10 skills from the generated block, grouped, with a status filter and a facts form for the selected skill. [derived, from the plan's shared interface and Critique A, P1]

**Why.** It answers "how its skills work" for a first-time reader. It must never disagree with the repo, so it reads one source only (see "Canonical skill source").

**Layout.**
- Groups appear as headed columns in this order: Planning, Execution, Quality, Communication, Platform. This order follows a piece of work from plan, to run, to check, to report, to deploy.
- Each skill item shows: its name in mono, a status mark with its word, and its purpose sentence.
- The item is a button with `aria-pressed`. It works like the existing `.act` chip, with a `form` border (topic 10).
- The caption column's facts form shows the selected skill: Group, Status, Loads ("by description" or "by name only"), and Purpose. When the generated item carries them, it also shows Needs, Example, and Result.
- Status marks reuse the existing symbols: stable = Done (filled square); beta = Open (outlined square); experimental = Unknown (dashed circle, pencil). The word is always shown next to the mark, so status is never shown by colour or shape alone.

**Filter.**
- One control strip with four toggle buttons: All, Stable, Beta, Experimental. Four options stays within the cognitive-load limit; a group filter would add six. [Critique A: decision points with more than 4 options]
- The filter hides items with the `hidden` attribute. It does not animate the layout.
- A group with no matching item hides its heading.
- If no skill matches, a pencil line says "No skill has this status." This is the empty state.
- A short live note gives the count, for example "Showing 4 of 10 skills". The page computes the count from the list. It is never typed in.

**States.**
- No JavaScript: every item and its details are visible as a plain grouped list. The filter strip is hidden. The plate still reads fully.
- Error: if the generated block is missing or empty, the plate shows one pencil line: "The skill list did not load. See docs/skills.md." It never shows an empty grid.

**Keep:** the existing "load by description" versus "load by name" truth from the skill front matter (`disable-model-invocation`).
**Change:** replace the "Skills: one manual step" text (line 733) with a two-line note and the command `npm run harness -- skills install NAME`.

**Testable rules.**
- The plate shows exactly as many items as there are folders under `tools/agents/skills/` (today 10). Test: the number of `li[data-skill]` equals the folder count.
- Every `data-status` value is one of `stable`, `beta`, `experimental`. Every `data-group` value is one of the five group names in "Skill groups for docs/skills.md".
- Each filter button, after a click, leaves 0 console errors and the right count.
- `thread-continuity` shows "experimental" and "Not installed". No text implies its later slices exist.

## 7. Visualizing model orchestration and handoffs

**Recommendation.** A new plate, "Fig. 7. One plan, many agents". It reuses the lanes and steps component of the current Fig. 6 (`.lanes`, `.st`). [derived]

**Layout.**
- Lanes: You (user green), the Claude lead (claude clay), and the worker agents (agent cobalt, one lane each, named Codex, Cursor, or Grok as the plan names them).
- Steps follow one slice: plan, then route (agent, model, and effort), then build, then independent review in a different lane, then verify, then checkpoint.
- A handoff is a line between lanes. A step only the user can do (approval) is a dashed form line. An unknown, such as remaining usage, is a dashed pencil line with the word "unknown".
- The facts form for a selected step shows: Step, Who, Model and effort as the plan writes it (for example `Codex (auto)`), Evidence (the `ae` command or the verify line), and the Source file.
- "Follow one slice" moves the travelling mark along the lines, one hop per step.

**Model strategy content (area 5), as implemented.** Each line below names its source file.
- A plan gives each slice an agent, a model, and an effort (`tools/agents/skills/multi-agent-planning/SKILL.md`).
- Codex and Cursor stay in auto mode. The lead discovers what the host offers before it names a Claude model. Model IDs, quotas, and costs are never invented.
- There is no fixed subagent cap. A child starts only for independent work. Its model is chosen by accuracy, then speed, then usage (`tools/agents/skills/subagent-budget/SKILL.md`).
- The reviewer is a different session from the builder. After a failed check, effort or model goes up one step, with a stated reason.
- Limit note, in pencil: "These are instructions to the agents. The `ae` engine records state and evidence. It does not choose models."

**Why.** "How agents coordinate" is a sequence of owners, so lanes are the honest form. The page must keep advice, enforcement, and evidence apart (PRODUCT.md principle). The limit note keeps that line visible.

**Testable rules.**
- 0 new owner inks. Every worker lane uses `agent`.
- Every model or effort label on the plate appears in a committed skill file or a committed example. Nothing names a model ID that the repo does not contain.
- Under reduced motion, "Follow one slice" changes the selected step in place, with no travelling mark.

## 8. Demonstrating real workflows

**Recommendation.** Show only workflows that ran, with their source. Label every illustration as an illustration. [Design OS: principles: "challenge invented statistics and placeholder content presented as facts"; PRODUCT.md "Absent, never to be invented"]

**Plates.**
- **Fig. 8, "Checkpoint, handoff, recover".** It reuses the session-moments component of Fig. 5 (`.moments`, `.mo`). The moments, from `tools/agents/skills/autonomous-engineering/scripts/ae.ts`, are:
  - `ae checkpoint` (done, next)
  - a usage warning
  - `ae usage`, with a decision of continue, prepare, transfer, or block
  - `ae prepare` and `ae transfer` (ownership moves before the replacement starts)
  - `ae handoff` (the note the new worker gets)
  - `ae recover`
  - a new session (the `continue-work` skill)
- **Fig. 9, "An unattended run and its stops".** It shows:
  - the charter: deadline, caps, run branch, and the user's approval line, with nothing running before it
  - `ae next`, which stops on the deadline or a cap
  - a block, which reports to the user and never buys usage
  - `ae report`
  - the boundaries: no commit, push, merge, or deploy. The commit grant was removed, and the charter refuses it.
  - Locks appear as the lock mark of Fig. 2. Instructions appear as advice. The two are never confused.
- **Fig. 10, "One real run, step by step"** (the current Fig. 6). Keep it. Add the date and the releases it compared, and label it "a logged run".

**Evidence rule.** Each plate names its source in its note: a test (for example `tests/ae-skill.test.ts`, `tests/ae-overnight-skill.test.ts`), a skill file, or a committed log. If no committed run log exists for a plate, its first line says "Example sequence from the engine's commands, not a logged run", in pencil. The mission plan and its journal stay local and are never cited on the public page.

**Testable rules.**
- Every command shown on a plate exists in `ae.ts`'s command list or in `npm run harness -- help`.
- Every plate has a source note that names a file in this repo.
- No plate shows a count, duration, or success rate that no committed file contains.

## 9. Motion and animation

**Recommendation.** Keep the current motion grammar. Motion explains a path or confirms a state; it never decorates. [Design OS: principles "motion must have a reason"; surface brief "Signature interaction and motion grammar"]

**Keep:**
- State changes on background colour, 200 to 250 ms, `cubic-bezier(.16,1,.3,1)`.
- One travelling mark per plate, 380 to 640 ms per hop, exponential ease-out.
- The arrival tint, 1.4 s.
- The reduced-motion block (line 281).

**Change:** [derived]
- The skills filter shows and hides items at once. There is no animated reflow.
- No new plate plays motion by itself. Motion starts only from a button ("Follow", "Play") or a selection.

**Testable rules.**
- No `transition` longer than 250 ms. No `animation` other than `land` (0.6 s) and `arrive` (1.4 s). Travel hops are 640 ms or less.
- No scroll-linked animation, parallax, autoplay, or looping motion. Test: no `IntersectionObserver`-started animation and no `animation-iteration-count: infinite`.
- With `prefers-reduced-motion: reduce`, no element changes `transform` or position over time. Measure two `getBoundingClientRect` reads 300 ms apart after pressing each Play or Follow button. Travel is replaced by in-place steps.
- Nothing moves behind text.

## 10. Accessibility and contrast

**Recommendation.** WCAG 2.2 AA, verified with evidence (see "Accessibility targets"). [Design OS: UX domain and UX gate "Accessibility"; PRODUCT.md]

**Why.** It is a stated product commitment. A page about proof must pass its own checks.

**Keep:** the token contrast; the focus ring (2px `agent`, 2px offset); the live regions; group labels; `aria-pressed`; stacked tables with cell labels.
**Change:** [Critique B; derived]
- The interactive boundaries of `.act`, `.mo`, the new skill items, and the `.pick` underline use `form` instead of `rule`. `rule` stays only on decorative plate borders and row separators.
- Add the skip link (topic 5).
- Check that the sticky top bar and the phone rail strip never cover a focused element. WCAG 2.2 criterion 2.4.11 (focus not obscured) applies. `scroll-padding-top` is 4.5rem today, and 4rem at 900 px and below.

**Testable rules.** Every row of "Accessibility targets" passes at the five widths in both themes.

## 11. Component reuse and responsive behavior

**Recommendation.** Build the new plates from existing components. Add only the skill list and its filter. [Design OS: specification step 3, "reuse existing components and tokens"]

| Need | Reuse | New? |
|---|---|---|
| Skills explorer item | `.act` chip pattern (button, `aria-pressed`, tint and inset ring) | Class `.skill-catalog` and its `li` only |
| Skills filter | Plate control strip with `.btn[aria-pressed]` | No |
| Orchestration lanes | `.lanes`, `.st`, measured wires, travelling mark | No |
| Continuity timeline | `.moments`, `.mo` | No |
| Unattended-run stops | `.scale` (Fig. 2) for refuse, ask, advise; the lock mark | No |
| Per-part facts | Facts form `dl.facts` with `aria-live` | No |
| Commands | Command box with a copy button | No |
| Limits | Limit note (pencil, dashed top rule) | No |
| Status words | Marks: Done, Open, Unknown, Parked | No |

**Responsive:** each reused component keeps its existing breakpoint behavior. See topic 4 for the two new rules (skill columns; lanes become a list).

**Testable rules.**
- New CSS adds at most two new component class roots (`.skill-catalog`, `.skill-filter`). Every other selector reuses an existing class.
- No library and no build step. The page stays one static file with one web font. [PRODUCT.md "Stack"]

## 12. Screenshot and code-example presentation

**Recommendation.** Show text output as text, not as images. Use a raster screenshot only where a live figure or real text cannot show the thing. Two examples: a page built by `md-view.sh`, or a T3 view. [derived; Design OS: UX gate "Restraint"]

**Code examples.**
- Use the command box with a copy button. Show only commands that ran in a clean clone (mission plan requirement 4). After each command, add a "You should see" line with the real output.
- The copied text has no `$` prompt and no output lines.
- Long lines scroll inside the box. A box that scrolls is focusable (`tabindex="0"`), has `role="region"`, and has an `aria-label`. Paths in prose break at `/` only.

**Screenshots** (if any are used on the page):
- Files live under `docs/assets/screenshots/` and are under 400 KB each.
- Each has `width`, `height`, and an `alt` text that states what it shows.
- A caption names the command or page, the date, and the theme.
- The frame is a 1px `rule` border. No device mockup, shadow, tilt, or crop that hides context.
- A screenshot is never the only place a fact appears.

**Testable rules.**
- Every `<img>` has a non-empty `alt`, plus `width` and `height`, and loads with status 200.
- Every shell command in a command box matches a line in the clean-clone command log.
- `grep -n '<pre' docs/project-explainer.html` shows no `$ ` prompt at the start of a copyable line.

## Skill groups for docs/skills.md

Recommendation: keep the provisional set. **It does not change.** [derived]

| Group | Skills | Why this group |
|---|---|---|
| Planning | `grill-me`, `multi-agent-planning`, `subagent-budget` | They decide what to build, how to slice it, and which agent, model, and effort run each part |
| Execution | `autonomous-engineering`, `continue-work`, `thread-continuity` | They run, hand off, and resume work |
| Quality | `make-it-verifiable`, `verify` | They define and run the proof |
| Communication | `html-explainer` | It writes plans, audits, and reports as pages |
| Platform | `render-rules` | It holds platform-specific deploy rules |

- Group order on the page: Planning, Execution, Quality, Communication, Platform. This follows a piece of work from start to finish.
- Communication and Platform hold one skill each. That is acceptable: the names are clear, and merging them would join two unrelated jobs.
- Status per the mission plan's Decision 9 (skill status):

| Status | Skills |
|---|---|
| stable | `grill-me`, `html-explainer`, `multi-agent-planning`, `subagent-budget`, `render-rules` |
| beta | `autonomous-engineering`, `make-it-verifiable`, `continue-work`, `verify` |
| experimental | `thread-continuity` |

  The audit slice may correct these with evidence. The page shows whatever the generated block holds.

## Canonical skill source

- The generated block `<!-- BEGIN GENERATED: skills -->` ... `<!-- END GENERATED: skills -->` in `docs/project-explainer.html` is the **only** source of skill data on the page.
- It is a `<ul class="skill-catalog">`. Each `<li>` carries `data-skill`, `data-group`, and `data-status`.
- The command `npm run harness -- skills catalog --write` writes the block from `tools/agents/skills/<name>/SKILL.md` and `docs/skills.md`. `--check` fails when the block and the folders differ.
- All filtering, grouping, counts, and detail views are done by CSS and JS over that list. JS reads the `li` elements and their content. It never holds a second, hand-written list, array, or JSON copy of the skills.
- No other part of the page names the skill count as a typed number. Fig. 1, Set it up, and Fig. 13 refer to "the skills" or read the count from the list.
- Required item content, so that the page works without JS: the skill name, the purpose sentence, the load mode, and (when available) Needs, Example, and Result from `docs/skills.md`. If the generator emits only the name and the attributes, see open question 3.
- Test: `npm run harness -- skills catalog --check` exits 0. A grep for each skill name outside the block finds no list of skills, only prose mentions.

## Accessibility targets

Target: WCAG 2.2 level AA, in light and dark, at 360 to 1440 px. [Design OS: UX domain; numbers measured in Critique B]

| Area | Target | Current evidence |
|---|---|---|
| Text contrast | 4.5:1 or more for all text; 3:1 or more for text 24px and up (or bold text 18.66px and up) | Pass in both themes. Light: ink 15.49, ink-2 7.35, form 6.92, pencil 4.98, agent 7.33, claude 5.02, user 5.50. Dark: ink 14.89, ink-2 8.39, form 8.57, pencil 6.91, agent 8.32, claude 8.05, user 9.60 |
| Non-text contrast (WCAG criterion 1.4.11) | 3:1 or more for boundaries that identify a control, for focus rings, and for diagram lines that carry meaning | **Fail risk:** `rule` is 1.48 light and 1.69 dark, and is used on `.act`, `.mo`, and the `.pick` underline. Fix: use `form`. The focus ring `agent` passes (7.33 / 8.32) |
| Focus | Visible on every focusable element; 2px solid `agent` outline at 2px offset; never removed | Present (line 33). Check every new control |
| Focus not obscured (2.4.11) | A focused element is never fully hidden by the sticky top bar or the phone rail strip | Unknown. Test by tabbing at 390 and 1440 px |
| Target size (2.5.8) | Every target is at least 24×24 CSS px; on a phone, buttons are 44px (`touch` token 2.75rem) | `.btn` 36px desktop, 44px phone; copy button 30px desktop, 44px phone. Check skill items and `.pick` |
| Keyboard map | Tab and Shift+Tab move between controls and figures. Arrow keys, Home, and End move inside a figure group. Enter and Space select or press. "Skip to content" comes first. No keyboard trap | Roving groups exist. The skip link is missing |
| Status and colour | Status, owner, and state are never shown by colour alone: a word or a mark always goes with them | Marks and words are used today. Keep for skill status |
| Live updates | Facts forms and the filter count use `aria-live="polite"` | Present on facts forms |
| Reduced motion | With `prefers-reduced-motion: reduce`: no travel, no arrival fade, transitions 0.01 ms, smooth scroll off | Present (line 281). Check the new plates |
| Themes | Follows `prefers-color-scheme`; `data-theme` overrides it; both inspected | Present. Dark was not tested in Critique A |
| Widths | No horizontal overflow at 360, 390, 768, 1024, and 1440 px | Pass at 360, 768, and 1440 (Critique B). 390 was checked by Critique A. 1024 is unknown |
| Zoom | Usable at 200 percent; text spacing overrides do not clip text | Unknown |
| No-JS | All text and tables read without JS; the figures say they need JS | Present (`noscript` in the footer) |

## Acceptance checks

The build slice must pass every check below. Run them at 360, 390, 768, 1024, and 1440 px, in light and in dark (10 combinations), on the rebuilt page served from 127.0.0.1. Record each result in the run's explainer-checks record, with the width, theme, browser, and page revision. [Design OS: UX domain "record viewport, browser, revision"; mission plan requirement 7 and its browser eval]

| # | Check | Pass condition |
|---|---|---|
| 1 | Overflow | `document.documentElement.scrollWidth <= document.documentElement.clientWidth`. No element extends past the viewport, except declared scroll regions |
| 2 | Console | 0 errors and 0 unhandled rejections after load, and again after using each control once. Controls: theme button, every Follow or Play button, Back and Next, the digest demo, the install demo, each skill filter button, a click on each skill item, and each copy button |
| 3 | Keyboard reach | Every control is reachable by Tab, or by arrow keys inside its group. Each focus state is visible, with a ring of 3:1 or more, and not hidden by a sticky bar. The skip link comes first |
| 4 | Reduced motion | With reduced motion emulated, no element moves after you press each Play or Follow button (two position reads 300 ms apart are equal) |
| 5 | Contrast | Every text node is 4.5:1 or more against its background (3:1 for large text). Every control boundary and the focus ring are 3:1 or more |
| 6 | Links | Every `href` resolves: same-page anchors find their `id`; relative links find a file; external links return 2xx or 3xx |
| 7 | Skills integrity | `npm run harness -- skills catalog --check` exits 0. The `li[data-skill]` count equals the skill folder count |
| 8 | Stale facts | `grep -nE '1\.4\.3|four skills|No harness command installs|232 automated|nine figures|9 releases'` on the page returns nothing, except inside labeled historical records: the logged run (Fig. 10) and the release 1.4.2 to 1.4.3 benchmark table (Fig. 12). Each of those carries its date |
| 9 | Not-released features | No text presents thread-continuity slices 2 to 6, Supabase search, packs, or the Grok export as working |
| 10 | Empty and error states | The skills filter shows the empty line when it matches nothing (test by removing items in a test copy). The block-missing message shows in a test copy without the block |
| 11 | Visual review | Run `design-os:visual-review` on the rendered page, which in turn runs Impeccable `critique` and `audit`. It reports no blocking verified defect. Owner approval is recorded apart from technical readiness |
| 12 | Detector | Run `impeccable detect --json` on the page. Every remaining finding is fixed or recorded as a false positive with a reason |

## Open questions for the user

1. **Approve the story amendment? (DRAFT)** The approved surface brief says "nine numbered plates" in a fixed story order. DESIGN.md says "Nine numbered figures".
   - What it changes: about 13 plates, in three parts (The rules, Execution, Use it), with execution inserted after "What a session loads". Topic 1 shows the order. The build slice would update the surface brief and DESIGN.md to say "numbered plates", with no count.
   - Option A, approve: build as specified.
   - Option B, approve a shorter form: merge continuity and unattended runs into one plate (12 plates).
   - Option C, decline: keep nine plates and put the new content into text sections. This covers the brief less well.
2. **Hero wording.** The title "One rulebook for every AI coding agent." names only the rules layer.
   - What it changes: the first thing a new reader sees.
   - Option A: keep the title and rewrite only the lead, so it names the rules and the execution model.
   - Option B: a new title that names both layers. The owner writes or approves the exact words, because copy is the owner's decision.
3. **Generated item content.** The plan's shared interface calls the block "a plain list" with three data attributes.
   - What it changes: whether the skills plate can show the purpose, load mode, Needs, and Example without JS and without a second source.
   - Option A, recommended: the generator also writes those fields inside each `li`, from the SKILL.md front matter and `docs/skills.md`.
   - Option B: show the name, group, and status only, and link each item to `docs/skills.md`.
4. **Real-run evidence for the new plates.** No committed run log exists yet for orchestration, handoff, or an overnight run.
   - What it changes: whether Figs. 7 to 9 show a logged run or a labeled example sequence.
   - Option A: use labeled example sequences built from the engine's commands and tests.
   - Option B: commit one redacted run report first, then show it as a logged run.
5. **Stale PRODUCT.md.** `PRODUCT.md` still says "four skills ... copied by hand", "232 automated tests", and "9 frozen releases". The Design OS brief skill would update it, but this slice may not.
   - What it changes: the Impeccable context that the build slice loads.
   - Recommendation: the build slice, which owns PRODUCT.md, corrects these facts as a draft, and the owner approves it.
6. **Re-run the critique with the installed Impeccable skill?** `design-os-impeccable` 0.3.0 was installed after this run, under the name `design-os-impeccable:impeccable`. This run followed the plugin's source playbook instead, so the critique numbers come from that playbook, not from the installed skill. Recommended: the build slice uses the installed skill for `visual-review`, `handoff` and a re-run of the critique on the rebuilt page. The old critique numbers then need no further proof.
   - What it changes: whether the build and review slices can call Impeccable as a skill, and whether its edit hooks run.
   - Option A: install it before the build slice.
   - Option B: keep following the source playbook by path, as this run did.
