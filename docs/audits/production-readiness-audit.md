# Production readiness audit

- Date: 2026-11-06
- Branch: mission branch `harness/production-readiness` at commit f4eb3ec (slices 1 to 11 and 13 to 16 of the mission plan are VERIFIED; slice 12, gates and PR, is in progress).
- Status: FINAL. The draft was written at commit 2526e19 (before most slices landed) and was refitted to the final branch on 2026-11-06.
- How to read it: each claim has a repo path, a commit, or a command with its observed output. "Checked" means the auditor or the mission coordinator ran it on 2026-11-05 or 2026-11-06. A claim taken from the mission run folder (the coordinator's local notes, not in the repository) names the note file. Nothing here is proof of behavior that was not run.

## Executive summary

**Already implemented (and checked)**
- Policy releases 1.0.0 to 1.5.5 in `releases/`. `verify claude`, `verify codex`, and `verify cursor-files` report version 1.5.5 with `configurationVerified: true`.
- 10 skill folders in `tools/agents/skills/`. One skill source now feeds README.md, the explainer, and `docs/skills.md`: `skills catalog --check` prints `skills catalog: ok (10 skills)`, and CI runs it (`.github/workflows/checks.yml:22`, commit 1af7086).
- The `ae` engine (`tools/agents/skills/autonomous-engineering/scripts/ae.ts`) ran this whole mission: 16 slices, 15 VERIFIED only after a Verify exit 0 that it observed. ACCEPTED state, `ae report`, overnight mode, and `ae charter` are on the branch, with the commit grant removed (af7c1ff).
- The 2 redaction gaps are closed (81629eb, tests `R1-11a` and `R1-11b`). The usage-continuity fix had a fresh review with verdict accept (85b6058); its finding, a parse error that echoed file content, is fixed (9412ee0).
- README.md and docs are rewritten from verified behavior (7a26171, f4eb3ec); each shell block ran with exit 0 in a clean clone (`readme-commands.log`). The explainer is rebuilt (c77c6a5) and passes 60 of 60 browser checks; 6 real screenshots are in `docs/assets/screenshots/` (b769275).
- Gates on the final branch: clean install, typecheck, 616 of 616 tests (0 skipped), pack catalog, skill catalog, public plan page, explainer, and gitleaks (no leaks over remote refs plus `HEAD`) all exit 0.

**Implemented but not fully verified**
- Fresh-session behavior of the 1.5.5 policy in Codex and Cursor. The install-refresh probes checked skill loading only (`docs/audits/install-refresh.md`), not the policy release line.
- The explainer content: the new page is built and checked, but its drafts (figure count, hero wording, labels, design-context proposals in `docs/design/explainer-drafts.md`) wait for the owner's approval.
- The Design OS boundary: this repo keeps a contract test with a fixture block (`tests/repo.test.ts`, cd899c3). The real-installer test lives on an open, unmerged pull request in `designOS-by-Uma` (PR #9, `docs/audits/designos-test-move.md`).
- Cross-repo reuse (`repo install`): ran with exit 0 in a throwaway demo folder (`docs/workflows.md` workflow 1); not run against a real second project.
- Usage-aware handoff: reviewed and tested, but no live provider usage source exists.

**Actually missing**
- Fresh-session checks of the release 1.5.5 policy line in Codex and Cursor.
- A lint step. README.md states that typecheck is the only static gate.
- An ignore rule for backup files (57 untracked `.bak` files in the main checkout at audit time).
- Written production-readiness criteria. README.md "Known limitations" and this audit state the scope; no section names readiness gates.

**Broken**
- `npm audit --omit=dev --audit-level=high` exits 1 on this branch: "7 vulnerabilities (5 moderate, 2 high)". Pre-existing; the lockfile equals `origin/main`. The fix is PR #9 (lockfile plus `.gitleaksignore`): checks SUCCESS, mergeable, not merged.
- CI "Harness checks" on `main` stays red on the gitleaks step until `.gitleaksignore` reaches `main` (through PR #9 or the mission PR). On this branch, the local CI-style gitleaks scan prints `no leaks found`.
- `ae report` can list a manually ACCEPTED, then INTEGRATED, slice under "Verified with engine evidence" (finding F1, report filter; `tools/agents/skills/autonomous-engineering/scripts/report.ts:87` filters by state only).
- The public plan page `plans/system-design.md` still states release 1.4.3 (line 12; finding F25).

**Intentionally out of scope**
- Supabase search, packs, and Grok export (parked; now stated in README.md:195 and `docs/workflows.md:10`). Thread-continuity slices 2 to 6. Live eval campaigns. A policy release. Merging any PR. Cursor User Rules, which only the owner can paste.

**Documented production-readiness criteria**
- The repository still documents no production-readiness criteria as such. The CI gate it does define (`.github/workflows/checks.yml`) passes locally on this branch, step by step (see Gate results). The mission PR's CI run was pending at writing time.

## Verdict

Functionally complete but awaiting specific validation.

The three strongest reasons:
- Every local gate passes on the final branch except `npm audit`, which is pre-existing and has a ready fix (PR #9).
- The skill list cannot drift silently any more: `skills catalog --check` runs in tests and in CI.
- The engine ran this mission end to end, and every VERIFIED slice has engine-observed evidence in the journal.

What still blocks the next, higher verdict level:
- PR #9 is not merged, so `npm audit` still fails on this branch and `main` CI stays red on gitleaks.
- The mission PR's CI was pending at writing time.
- The behavior of release 1.5.5 is not verified in fresh Codex and Cursor sessions.
- Cursor User Rules at 1.5.5 are not pasted (owner only).
- The explainer drafts wait for the owner's approval.
- F1 (`ae report` files manual evidence as engine evidence) is open.
- No written readiness criteria.

## Traceability register

Dispositions changed from the draft: W4, W5, W10, W12, W15, W16, W17, W28, W29, W34. Rows W37 to W39 are new. Evidence was re-checked on f4eb3ec unless the row says otherwise.

| ID | Workstream | Disposition | Evidence | Open work |
|---|---|---|---|---|
| W1 | Policy releases and platform installs | Implemented but incomplete | `releases/` holds 1.0.0 to 1.5.5. `verify claude`, `verify codex`, `verify cursor-files` print version 1.5.5, `configurationVerified: true`, `behaviorVerified: false`. This Claude Code session loaded "Harness release 1.5.5". `origin/main` has releases up to 1.4.3 only | Fresh-session checks in Codex and Cursor (W21). Merge the 1.5.x releases to `main` through the mission PR |
| W2 | Claude controls (6) | Implemented but incomplete | `controls/controls.json` defines 6 controls. `controls verify claude` from a worktree (draft run, not re-run): 27 rules, `configurationVerified: false`, 2 missing no-self-edit rules that name the checkout that ran `controls install` | The self-edit rules protect one checkout only. Decide if that is intended; document it in `docs/platforms.md` |
| W3 | Skills installer | Implemented but incomplete | `src/skills.ts`, `tests/skills.test.ts` pass. Slice 11 ran `skills install --replace` for 5 skills and `skills verify` (exit 0) for real (`docs/audits/install-refresh.md`, b29271c) | F24: a replace over a receipt without a backup writes `backup: null`, so `skills uninstall` cannot restore. `skills uninstall` not run for real |
| W4 | multi-agent-planning | Implemented and verified | F5 fixed by the owner's wording (6c2064a). Installed copy refreshed and `current` (`docs/audits/install-refresh.md`). A fresh Codex session quoted the new line exactly (probe b) | none |
| W5 | subagent-budget | Implemented and verified | Source restored (2526e19): "There is no fixed cap on subagent count." Installed copy refreshed (b29271c). A fresh Cursor session quoted that rule (probe c, re-run). README.md:66 says "There is no fixed cap" | none |
| W6 | autonomous-engineering core | Implemented but incomplete | 81629eb closes the 2 redaction gaps; tests `R1-11a` (`tests/ae-guard.test.ts:280`) and `R1-11b` (`:306`, plus a 200 KB performance test at `:350`) pass. Round 3 review: accept (findings-slice8-round3.md) | Open notes F19 (medium: header value that starts with an escaped quote leaks), F20 to F22 (low) |
| W7 | Usage-aware handoff | Implemented but incomplete | Fresh review with verdict accept: `docs/audits/reviews/usage-continuity-s1.md` (85b6058). Its F1, a parse-error echo of file content, is fixed with tests for all 3 flags (9412ee0, `tests/ae-usage.test.ts`) | No live provider usage source; `usage` needs a snapshot file. Low findings F2 to F4 of that review |
| W8 | ACCEPTED state | Implemented but incomplete | Commit defd1eb; `ae integrate` accepts VERIFIED or ACCEPTED (`tools/agents/skills/autonomous-engineering/references/engine.md:26`); tests pass | F1 (report filter, open: `report.ts:87`), F3 (conditional assertion, `tests/ae-engine.test.ts:569`) |
| W9 | Overnight mode | Implemented but incomplete | Commits bd88a09, 96fbf58, a4be884, af7c1ff; `tools/agents/skills/autonomous-engineering/references/overnight.md`; "charter refuses --grant commit" test passes | No unattended run under `ae charter` is recorded in this audit. Not on `main` |
| W10 | thread-continuity and drift checks | Superseded or intentionally deferred | `tools/agents/skills/thread-continuity/SKILL.md` (T3 only); not installed by decision (`docs/audits/install-refresh.md`). README.md "Known limitations" calls it experimental, later slices not released | Slices 2 to 6 stay out of scope |
| W11 | make-it-verifiable | Implemented but incomplete | `tools/agents/skills/make-it-verifiable/`; installed `current` with receipt; eval case `verifiable-change` at `evals/cases.jsonl:22` | No result for `verifiable-change` in `evals/results/2026-10.jsonl` |
| W12 | grill-me and html-explainer | Implemented and verified | Both installed copies replaced and `current`; `skills verify` exit 0 and `diff -rq` clean (`docs/audits/install-refresh.md`). F13 fixed: the html-explainer description now starts with its purpose (9412ee0). Fresh Claude Code and Cursor sessions quoted the new description (probes a and c, re-run) | none |
| W13 | render-rules, verify, continue-work | Unable to verify | `skills status` (draft run): all 3 `current`, no receipt | Run each once in a fresh session and record the result |
| W14 | Evals (22 cases, live only) | Implemented but incomplete | `evals/cases.jsonl` holds 22 cases; `evals/results/2026-10.jsonl` holds 161 runs from 2026-10-12 to 2026-10-26 | No eval ran in this mission. No offline eval gate in CI |
| W15 | Explainer content | Implemented but incomplete | Rebuilt from the Design OS spec (c77c6a5). `docs/project-explainer.html:429` "Release 1.5.5"; skill list generated by `skills catalog`. `tools/explainer.ts check`: 60 of 60 pass (overflow, console, keyboard, motion, contrast, links; 10 each) | Drafts wait for the owner (`docs/design/explainer-drafts.md`) |
| W16 | README and docs | Implemented and verified | Rewritten (7a26171) and polished (f4eb3ec). 13 shell blocks from README.md and docs ran with exit 0 in a clean clone (`readme-commands.log`). Relative links: 103 found, 0 missing over all tracked `.md` files outside `plans/` plus the explainer (auditor's link script, 2026-11-06) | none (the README line that called this audit a draft is fixed in the final commit) |
| W17 | Skill-list drift guard | Implemented and verified | `src/skills-catalog.ts`, `docs/skills.md`, `tests/skills-catalog.test.ts` (1af7086). CI step `.github/workflows/checks.yml:22`. Gate run: `skills catalog: ok (10 skills)`, exit 0 | F8 (cascade noise) open, low |
| W18 | Design OS integration | Implemented but incomplete | Design OS consulted and spec written (9cdc42f, `docs/design/explainer-design-spec.md`). The suite has no skipped test; `tests/repo.test.ts` uses a fixture Design OS block (cd899c3, `tests/README.md:7`) | The real-installer test is on designOS-by-Uma PR #9, open and not merged |
| W19 | pstack integration | Unable to verify | The only repo mention is a routing exception in `tools/agents/skills/subagent-budget/SKILL.md` | Ask the owner whether a pstack requirement exists |
| W20 | Cursor User Rules at 1.5.5 | Implemented but incomplete | `status` (draft run): cursor-user-rules `needed: true`, `confirmedVersion` 1.5.2, `activeVersion` 1.5.5 | Owner pastes the 1.5.5 rules and runs `confirm cursor-user-rules` |
| W21 | Fresh-session checks of 1.5.5 (Codex, Cursor) | Not implemented | `verify codex` and `verify cursor-files`: `behaviorVerified: false`. The install-refresh probes asked for skill text only, not the release line | Start one fresh session each; ask for the release line; record it |
| W22 | Supabase search, packs, Grok export | Superseded or intentionally deferred | Code exists (`supabase/`, `src/supabase.ts`, `src/packs.ts`). Parked status is now public: README.md:195, `docs/workflows.md:10`, `docs/operations.md:29` | none |
| W23 | Public release refresh | Implemented but incomplete | `gh repo view`: visibility PUBLIC; root commit f42076c (fresh-history repo). No repo doc describes the refresh procedure (`grep` of CONTRIBUTING.md and `releases/README.md` finds none) | Document the refresh steps |
| W24 | Dependabot PRs | Implemented but incomplete | Draft run: `gh pr view` for #1, #2, #5, #7, #8: "Harness checks" SUCCESS; all open. Not re-read | Merge or close each; #5 (zod) overlaps PR #9 |
| W25 | Weekly ideas digest | Implemented but incomplete | Draft run: 6 digest worktrees, each with 2 untracked files in `industry-digests/` | Covered-ideas log does not persist between runs. Read and judge one digest |
| W26 | Backup-file hygiene | Not implemented | `.gitignore` has no `bak` rule (`grep -n bak .gitignore` is empty) | Add an ignore rule after the owner agrees; no deletes |
| W27 | Context audit (token load) | Implemented and verified | `npm run harness -- context audit` exit 0 on 2026-11-05; values labelled "estimate: chars / 4"; `tests/context.test.ts` | Values are estimates, not measured |
| W28 | Cross-repo reuse (`repo install`, `skills --repo`) | Implemented but incomplete | `tests/repo.test.ts`, `tests/skills.test.ts` pass. `docs/workflows.md` workflow 1 runs `repo install` in a throwaway demo folder: exit 0 (`readme-commands.log`) | Not run against a real second project. Work repos need owner approval |
| W29 | md-view builder, repo vs installed | Implemented and verified | `cmp tools/agents/bin/md-view.sh ~/.agents/bin/md-view.sh`: identical (re-run 2026-11-06). `md-view.sh --check plans/system-design.md`: `fresh` | none |
| W30 | Statechart and poteto-mode follow-ups | Not implemented | `grep -rli statechart .` and `grep -rli poteto .` find nothing (draft run) | Confirm the requirement with the owner, or close it |
| W31 | PR #6 (release 1.5.0 branch) | Superseded or intentionally deferred | Its content is on this branch (ecec5a8, effc3c3, d8ae9e4) | Close #6 after the mission PR merges, with a comment naming it |
| W32 | Engine checkpoints, handoff, recovery | Implemented but incomplete | `ae checkpoint` needs an IN_PROGRESS slice (`tools/agents/skills/autonomous-engineering/references/engine.md:32`). The journal carried 16 slices across model and session changes; `ae status` lists every state (`final-state.md`) | EVAL-10 (`ae report` and `ae handoff` from the journal alone) not run. A wrong failure reason stays in the append-only journal |
| W33 | Engine command guard and authority grants | Implemented and verified | `ae check` allowed every Verify line and refused a computed `$HOME/...` command name; `ae init` refused the CI path without the `ci` grant (baseline-gates.md). `tests/ae-guard.test.ts` passes | Redaction notes in W6 |
| W34 | CI "Harness checks" and secret scan | Implemented but incomplete | `.gitleaksignore` with exactly the 2 fixture fingerprints (62ac0d5); the same file is on PR #9 (owner decision D-2026-11-06-3). Gate: gitleaks 8.24.3 over remote refs plus `HEAD`: "43 commits scanned", "no leaks found", exit 0. PR #9 checks: SUCCESS, SUCCESS (`gh pr view 9`, 2026-11-06) | `main` CI stays red until PR #9 or the mission PR merges. Mission PR CI pending at writing time |
| W35 | Dependency vulnerabilities | Implemented but incomplete | On this branch `npm audit --omit=dev --audit-level=high`: "7 vulnerabilities (5 moderate, 2 high)", exit 1 (re-run 2026-11-06). PR #9: 0 vulnerabilities on its branch, checks pass, mergeable, not merged | Owner merges PR #9 |
| W36 | Lint gate | Not implemented | `package.json` scripts: `harness`, `test`, `typecheck`. README.md "Known limitations" states that typecheck is the only static gate | Owner decides: add a linter, or accept typecheck as the only static gate |
| W37 | Design OS boundary (slices 14, 15) | Implemented but incomplete | Design context moved under `docs/design/` (cd899c3, `docs/design/README.md`). Harness-side contract test with a fixture block in `tests/repo.test.ts`. Real-installer test `tests/test_harness_coexistence.py` on designOS-by-Uma PR #9: CI pass, independent review accept (`docs/audits/designos-test-move.md`, 3693534) | Owner merges designOS-by-Uma PR #9 |
| W38 | Screenshots and explainer tool (slice 10) | Implemented and verified | `tools/explainer.ts` with `tests/explainer-tool.test.ts` (b769275). 6 PNG captures of the real page in `docs/assets/screenshots/`, documented in `docs/assets/screenshots/README.md`. Explainer gate: 60 of 60, exit 0 | F26: the Chrome browser test runs in CI only with `EXPLAINER_CHROME_TESTS=1` |
| W39 | Public plan page (`plans/system-design.md`) | Broken or regressed | `--check` prints `fresh`, but the page states "release 1.4.3, published 2026-10-13" (`plans/system-design.md:12`) and the system as of 2026-10-12 (F25) | Refresh the facts (release, skills, engine) and rebuild |

### Requirement trace

| ID | Requirement (short) | Status today | Evidence |
|---|---|---|---|
| REQ-1 | Audit starts with summary, traceability, backlog | Met | this file |
| REQ-2 | Each workstream has a disposition and a resolving pointer | Met | Traceability register above |
| REQ-3 | Skill drift fails tests and CI | Met | W17 |
| REQ-4 | README commands ran in a clean clone | Met | W16 |
| REQ-5 | Real screenshots with alt text | Met | W38; `docs/assets/screenshots/` |
| REQ-6 | Design OS spec records the skills that ran | Met | W18; `docs/design/explainer-design-spec.md` |
| REQ-7 | Explainer responsive, accessible, no stale fact | Met by checks; owner approval of drafts pending | W15 |
| REQ-8 | ACCEPTED plus 3 overnight commits without the commit grant; suite passes | Met | W8, W9; 616 of 616 tests |
| REQ-9 | `subagent-budget` says the 2026-10-27 decision | Met, installed | W5 |
| REQ-10 | Redaction of the 2 gap shapes with tests | Met | W6 |
| REQ-11 | A new session can continue from plan, journal, run folder | Partly met; EVAL-10 not run | W32 |
| REQ-12 | PR to main after scans, then the A to I report | In progress (slice 12); scans pass; CI pending at writing time | W34, Gate results |
| NOT-1 | No push before the scans | Holds | gitleaks gate passed before any push of this branch |
| NOT-2 | No private plans, paths, or IDs in commits | Holds for `plans/`: the "plans in diff" gate exit 0 | Gate results |
| NOT-3 | No change to parked features or `knowledge/core.md` | Holds for this mission. `knowledge/core.md` differs from `main` only through d8ae9e4 (releases 1.5.0 to 1.5.5), which predates the mission | `git log origin/main..HEAD -- knowledge/core.md` |
| NOT-4 | No delete outside Git; no weakened or skipped test | Owner decision needed: 5d4cd72 changed 3 assertions in `tests/ae-skill.test.ts` to match overnight auto-load (meaning, not strength). The one skipped test is gone: it moved to designOS-by-Uma (W37) | `git show 5d4cd72 -- tests/ae-skill.test.ts` |

## Backlog

Finding numbers: F1 to F26 are from the mission's findings note. Slice 9's usage review numbered its own findings F1 to F6; they are written "usage F1" and so on.

| Priority | Item | Next action | Acceptance |
|---|---|---|---|
| Done | W34: gitleaks fixture findings | Done in 62ac0d5 (`.gitleaksignore`, 2 fingerprints); same file added to PR #9 | CI-style scan over remote refs plus `HEAD`: `no leaks found` |
| P0 | PR #9 not merged: `main` CI red on gitleaks; 2 high `npm audit` findings (body-parser, zod) | Owner reviews and merges PR #9 | `npm audit --omit=dev --audit-level=high` exits 0 on `main`; "Harness checks" passes on `main` |
| P1 | Mission PR CI | Open the PR after the gates; read the "Harness checks" run | The run passes, or each failure is classified with its log |
| Done | W17 / REQ-3: skill-list drift check | Done in 1af7086 | `skills catalog --check` exit 0; CI step at `checks.yml:22` |
| Done | F5: "At most 3 children at once" in multi-agent-planning | Done in 6c2064a | `grep -rniE 'at most 3' tools tests README.md docs --exclude-dir=audits` is empty |
| P1 | F1: `ae report` lists a manually ACCEPTED, then INTEGRATED, slice as engine-verified | Filter by evidence kind in `report.ts:87`, not only state; add a test | The slice shows under manual sign-off after `ae integrate`; new test passes |
| Done | W6 / REQ-10: 2 redaction gaps | Done in 81629eb | Tests `R1-11a` and `R1-11b` pass |
| P1 | W21: no fresh-session check of the 1.5.5 policy in Codex and Cursor | Start one fresh session in each; ask for the policy release line | Each answer names "Harness release 1.5.5"; result recorded |
| Done | W7: usage-continuity fix review | Done in 85b6058 (verdict accept) | `docs/audits/reviews/usage-continuity-s1.md` has a verdict |
| Done | usage F1: parse error echoed file content | Done in 9412ee0 | Tests for `--snapshot`, `--policy`, `--caps` pass; stderr holds no file content |
| Done | Installs drift (W4, W5, W12, W29) | Done in slice 11 (b29271c) | `skills verify` exit 0 for 5 skills; `cmp` of md-view.sh identical |
| Done | W16: README release and cap facts wrong | Done in 7a26171, f4eb3ec | No `1.5.3` or "caps a fan-out at 3" in README.md; shell blocks exit 0 |
| Done | F13: html-explainer purpose cell was trigger text | Done in 9412ee0 | No purpose cell starts with "Use when" |
| P2 | W15: explainer drafts | Owner approves or changes the drafts in `docs/design/explainer-drafts.md` | Owner decision recorded; explainer gate still 60 of 60 |
| P2 | W20: Cursor User Rules at 1.5.2 | Owner pastes the 1.5.5 rules; run `confirm cursor-user-rules` | `status` shows `needed: false` for cursor-user-rules |
| P2 | W37: designOS-by-Uma PR #9 not merged | Owner reviews and merges it | The real cross-installer test runs on that repo's `main` |
| P2 | F24: installer writes `backup: null` on replace | Record the backup on every `install --replace`; add a test | After `install --replace` over any prior state, `skills uninstall` restores the previous files |
| P2 | F25 / W39: public plan page states release 1.4.3 | Refresh `plans/system-design.md` facts and rebuild with md-view.sh | No stale release or skill count on the page; `--check` prints `fresh` |
| P2 | F19: header value that starts with an escaped quote leaks | Fix the unquoted branch of `maskHeaders` in `guard.ts`; add a test | `curl -H "X-Api-Key: \"LEAKVAL\""` redacts the value |
| Done | README.md:187 called this audit "a draft" | Done in the final commit of this branch | README.md describes the audit as final |
| P2 | No documented production-readiness criteria | Add a short "Readiness" section (gates and scope) to README.md or `docs/README.md` | The section exists and maps to the gate table in this audit |
| P2 | NOT-4: 3 changed assertions in `tests/ae-skill.test.ts` (5d4cd72) | Owner confirms the new meaning (overnight auto-load) | Owner decision recorded in the PR body |
| P2 | W2: self-edit controls protect only the checkout that ran `controls install` | Document the limit in `docs/platforms.md`, or bind the rule to every harness checkout | Doc states it, or `controls verify claude` from a worktree shows no missing rule |
| Done | W22: parked features documented only in private notes | Done in the README rewrite (README.md:195, `docs/workflows.md:10`) | A public doc names the parked features |
| P2 | W23: release-refresh steps documented only in private notes | Add the steps to CONTRIBUTING.md or `releases/README.md` | The public doc names the refresh steps |
| P2 | W24: 5 Dependabot PRs open | Review each; merge or close | No Dependabot PR older than 14 days |
| Done | W18: only skipped test needed the DesignOS repo as a sibling folder | Done in cd899c3 (fixture contract test; real test moved) | 616 tests, 0 skipped |
| Done | F9: `--write` refusal printed no hint | Done in 1af7086 (`src/skills-catalog.ts:152`) | Refusal says "fix docs/skills.md first; nothing was written" |
| Done | F14: `ae verify` of slice 2 needed `skills catalog --write` first | Documented in CONTRIBUTING.md:28-29 | The order (`--write`, then `--check`) is in CONTRIBUTING.md |
| P3 | F2: defd1eb removed a sentence from the `verifiable-change` eval prompt | Owner confirms intent | Confirmed in the ship note, or the sentence is restored |
| P3 | F3: conditional assertion in the ACCEPTED engine test (`tests/ae-engine.test.ts:569`) | Make the setup unconditional | Test fails if the FAILED state is not reached |
| P3 | F4: `ae charter --grant commit` says only `unknown flag --grant` | Add a hint that the commit grant was removed | Error text names the removed grant |
| P3 | usage F2 to F4: capacity label "normal" when unknown (`usage.ts:199`); `--remaining` accepts Infinity or more than 100 (`ae.ts:457`); `prepare` accepts another model of the current agent (`ae.ts:487`) | Fix each with a test | Each input is refused or labelled "unknown" |
| P3 | F8: catalog check cascade noise for an invalid skill | Report one message per real difference | One message per difference in the fixture test |
| P3 | F20 to F22, F12: redaction notes (plural list keys, plain comments in a secret block, flow lists, block scalars, unterminated quotes, split items, tab indentation) | Decide per shape: fix with a test, or document as unsupported | Each shape has a test or a line in the guard docs |
| P3 | F26: explainer browser test skips in CI unless `EXPLAINER_CHROME_TESTS=1` | Enable it on a runner with Chrome, or document the local-only gate | The test runs in CI, or the skip reason is in `tests/README.md` |
| P3 | W26: 57 untracked `.bak` files | Add an ignore rule after owner approval; no deletes | `git status` lists no `.bak` file |
| P3 | W36: no lint gate | Owner decides on a linter | Decision recorded; if yes, CI runs it |
| P3 | W30: statechart and poteto-mode follow-ups | Confirm the requirement with the owner | Kept with a slice, or closed |

## Harness self-check

How the harness worked when used to run this mission. Notes named below are in the mission run folder.

| Capability | Result | Evidence |
|---|---|---|
| Task decomposition | worked | 12 planned slices plus 4 added (13 to 16) by owner decisions; `ae init` accepted the plan; 15 slices VERIFIED (`final-state.md`) |
| Agent specialization and coordination | worked with limits | Slices went to Codex, Cursor, Claude, and Grok reviewers as routed. The coordinator edited 3 test assertions itself, a deviation from "one slice per fresh worker" (discovery.md). A coordinator mistake: an untracked `.gitleaksignore` in the PR #9 worktree was overwritten without being read first |
| Model routing | worked with limits | The coordinator ran on Sonnet 5.5, then Opus 5.5 from about 22:30 on 2026-11-05 (`final-state.md`). Codex through the T3 route hit a usage limit twice; the Codex CLI ran the same briefs. Cursor through T3 failed once; the Cursor CLI worked. Grok reviews sometimes arrived as late continuations |
| Token-efficient context loading | worked with limits | `context audit` exit 0; values are chars / 4 estimates, not measured (W27) |
| Recoverable checkpoints | worked with limits | `ae checkpoint` only works while a slice is IN_PROGRESS (`engine.md:32`). A wrong failure reason stays in the append-only journal (findings.md) |
| Context-drift detection | worked with limits | Editing a Verify line reset slice 12 to READY although its dependencies were unmet; `ae next` held it back (findings.md) |
| Safe new-session creation | worked with limits | The mission moved to a new worktree session and continued from the run folder. The user's brief was not carried over and had to be recovered (discovery.md) |
| Continuity across model changes | worked | After route failures and the coordinator's model change, the journal and run folder carried every slice; no slice lost its commits (`final-state.md`) |
| Controlled autonomous execution | worked with limits | The guard refused a computed command name and the CI path without a grant (W33). The commit grant is removed; commits were made by the coordinator by explicit path. The `balanced` profile allows 2 concurrent slices (`journal.ts:15`); the plan assumed 4 |
| Deterministic validation and evals | worked with limits | VERIFIED only after an engine-observed Verify exit 0 (`slice*-engine-verify.json`). The journal recorded every review, reject, and verify. No eval ran in this mission (W14) |
| Observable execution status | worked with limits | `ae status` lists all 16 slice states. F1: `ae report` can file manual evidence as engine evidence |
| UI evidence | worked with limits | The T3 preview browser did not respond overnight, so captures and the recording used headless Chrome through `tools/explainer.ts` (W38) |

## Gate results

Baseline: the mission worktree at c8219b2, before slice 1 (baseline-gates.md). Draft: 2526e19. Final: f4eb3ec, from the coordinator's gate log (gates.log), plus two re-runs by the auditor on 2026-11-06 (npm audit, links).

| Gate | Baseline | Draft (2526e19) | Final (f4eb3ec) | Failure class |
|---|---|---|---|---|
| Clean install (fresh clone, `npm ci && npm test`) | `npm ci` exit 0 | `npm ci` exit 0 (worktree, not a clone) | exit 0; tests 616, pass 616, fail 0, skipped 0 | none |
| Types (`npm run typecheck`) | exit 0 | exit 0 | exit 0 (`tsc --noEmit`) | none |
| Tests (`npm test`) | exit 0; 511 tests, 1 skipped | exit 0; 545 tests, 1 skipped | exit 0; 616 of 616 pass, 0 skipped | none |
| Pack catalog (`catalog build`, `git diff --exit-code catalog/index.json`) | exit 0 | exit 0 | exit 0 | none |
| Skill catalog (`skills catalog --check`) | not available | "Unknown skills command." | exit 0, `skills catalog: ok (10 skills)` | none |
| Public plan page (`md-view.sh --check plans/system-design.md`) | not recorded | `fresh`, exit 0 | `fresh: plans/system-design.html`, exit 0 | none (content stale: W39) |
| Secrets (gitleaks 8.24.3, remote refs plus `HEAD`) | not run | `leaks found: 2`, exit 1 | "43 commits scanned", `no leaks found`, exit 0 | none |
| Private data (`plans/` not in the diff) | not run | not run | exit 0 | none |
| Dependencies (`npm audit --omit=dev --audit-level=high`) | exit 1; 7 findings (2 high) | exit 1; same | exit 1; "7 vulnerabilities (5 moderate, 2 high)" | pre-existing: lockfile equals `origin/main`; fix is PR #9 (0 vulnerabilities on its branch) |
| Links (relative links in tracked `.md` outside `plans/`, plus the explainer) | not run | not run | 103 links, 0 missing (auditor's script, 2026-11-06). The coordinator reported 85 over a narrower file set; that run is not in gates.log | none |
| Explainer (`tools/explainer.ts check`) | not available | not available | exit 0; 60 of 60 (6 checks at 10 viewport and theme cases each) | none |
| Engine (`ae status`) | not done | 2 of 12 VERIFIED | 15 of 16 VERIFIED; slice 12 in progress | none |
| CI ("Harness checks" on the mission PR) | not run | `main` failed on gitleaks | pending at writing time (PR not yet opened) | not classified yet |

## Audit limitations

- Rows marked "draft run" (W2, W13, W20, W24, W25, W30) were not re-run on the final branch.
- The W27 numbers and the W33 `ae check` and `ae init` observations come from earlier mission runs recorded in the run folder.
- `npm test` fails one eval test (`tests/evals.test.ts:137`) when `FORCE_COLOR` is set, because a coloured `5` is printed. It passes with colour unset. Class: environment.

| Source | What happened | Effect |
|---|---|---|
| 58 Claude Code session transcripts | Not read in full | Requests made only in those sessions may be missing from the register |
| Imported T3 threads | Read only in part (by the planning session) | Rows W10, W19, W30 rest on planning notes, not on the original requests |
| GitHub PR review comments | Not read. PR states and check results were read with `gh` | Review feedback on PRs #1 to #9 is not reflected |
| Provider usage and remaining allowances | Unknown for every provider; no tool reports them | Routing and fallback claims cannot include remaining capacity |
| Private decision notes | Not read beyond what the mission plan quotes | Decisions such as the 2026-10-12 parking are cited from the plan |
| Notion | One bounded search returned harness pages last edited by 2026-10-13; none opened | Notion decision records may exist but were not checked |
| Codex and Cursor fresh-session checks of the 1.5.5 policy | Not run (only skill loading was probed) | W21 stays "Not implemented" |
| Eval results after 2026-10-26 | Only in local T3 checkpoint refs, not on any branch | W11 and W14 claims about later eval runs cannot be checked |
| Digest file contents | Counted, not read | W25 confirms the runs exist, not their quality |
| Mission PR CI | Not run at writing time | The CI row in Gate results is pending |

## Out of scope

- New framework features.
- Thread-continuity slices 2 to 6.
- Parked features: Supabase search, packs, and Grok export.
- A policy release.
- Live eval campaigns.
- Merging any PR.
- Cursor User Rules (only the owner can paste them).
