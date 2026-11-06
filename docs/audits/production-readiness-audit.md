# Production readiness audit

- Date: 2026-11-05
- Branch: mission branch `harness/production-readiness` at commit 2526e19 (slices 1 and 3 of the mission plan are in it; slices 2 and 5 to 12 are not).
- Status: DRAFT (slice 4). The coordinator finalizes the verdict and the gate table in slice 12.
- How to read it: each claim has a repo path or a command with its observed output. "Checked" means the auditor ran it on 2026-11-05. A claim taken from the mission run folder (the coordinator's local notes) names the note file. Nothing here is proof of behavior that was not run.

## Executive summary

**Already implemented (and checked)**
- Policy releases 1.0.0 to 1.5.5 in `releases/`. `verify claude`, `verify codex`, and `verify cursor-files` report version 1.5.5 with `configurationVerified: true`.
- 10 skill folders in `tools/agents/skills/`. The `skills` command (`status`, `install`, `verify`, `uninstall`) has unit tests. Only `skills status` was run in this audit; it reports each install state.
- The `ae` engine (`tools/agents/skills/autonomous-engineering/scripts/ae.ts`, 21 commands) runs this mission. It gives VERIFIED only on a Verify exit 0 that it observed.
- On this branch: the ACCEPTED state, `ae report`, overnight mode, and `ae charter`, with the commit grant removed. Typecheck exit 0. `npm test`: 545 tests, 544 pass, 0 fail, 1 skipped.
- The `subagent-budget` source is restored to the 2026-10-27 "no fixed cap" text (commit 2526e19).

**Implemented but not fully verified**
- Fresh-session behavior of the 1.5.5 policy in Codex and Cursor. Every `verify` command prints `behaviorVerified: false`.
- Usage-aware handoff (`tools/agents/skills/autonomous-engineering/scripts/usage.ts`): unit tests pass. No fresh review of the fix, and no live usage source.
- Cross-repo reuse (`repo install`, `skills --repo`): tests only.
- 5 installed skills differ from their sources. `thread-continuity` is not installed.

**Actually missing**
- A check that stops README.md, the explainer, or docs from drifting from the skill folders. `skills catalog --check` prints "Unknown skills command." on this branch.
- A lint step. `package.json` has only `harness`, `test`, and `typecheck` scripts.
- Fresh-session checks of release 1.5.5 in Codex and Cursor.
- An ignore rule for backup files. The main checkout holds 57 untracked `.bak` files.

**Broken**
- CI "Harness checks" fails on `main` since 2026-11-05. gitleaks flags 2 test fixtures in `tests/ae-guard.test.ts` (lines 283 and 290, rule `curl-auth-header`). The same 2 findings reproduce locally. Cause: the CI checkout uses `fetch-depth: 0` and gitleaks scans every fetched branch. Commit 2529cc1 exists only on the unmerged remote branch `harness/verifiable-and-skills`. `origin/main` itself has no leak (local gitleaks over `origin/main`: `no leaks found`). So `main`, PR #9 and every other branch go red while that remote branch exists, and any branch that carries 2529cc1, this one included, also fails on its own.
- README.md on this branch names release 1.5.3 (line 43) and says `subagent-budget` "caps a fan-out at 3" (line 18).
- The explainer on this branch says release 1.4.3 and "No harness command installs them yet" (`docs/project-explainer.html:385`, `:734`).
- `tools/agents/skills/multi-agent-planning/SKILL.md:58` says "At most 3 children at once". This contradicts the restored `subagent-budget` (finding F5).

**Intentionally out of scope**
- Supabase search, packs, and Grok export (parked). Thread-continuity slices 2 to 6. Live eval campaigns. A policy release. Merging any PR. Cursor User Rules, which only the owner can paste.

**Documented production-readiness criteria**
- The repository documents no production-readiness criteria. README.md, CONTRIBUTING.md, SECURITY.md, and `docs/` have no such section. The only written criteria are the mission brief's acceptance list and this mission's plan. Neither is in the repository.
- Against the CI gate the repository does define (`.github/workflows/checks.yml`), the branch fails: the gitleaks step exits 1.

## Verdict

Not production-ready. CI "Harness checks" is red on `main` and on this branch (gitleaks, 2 findings). README.md and the explainer state wrong releases and a wrong cap. No check stops the skill list from drifting. The 1.5.5 policy has no fresh-session check in Codex or Cursor. The engine and the installer run and pass their tests, and this mission uses the engine for real work.

What changes the verdict:
- To "Functionally complete but awaiting specific validation": CI green on this branch (gitleaks false positives handled), slice 2 (catalog check) integrated, and slices 6 and 7 (README, explainer) integrated.
- To "Production-ready within its documented scope": the above, plus written readiness criteria, fresh-session checks in Codex and Cursor, refreshed installs (slice 11), and every gate in the gate table passing or classified.

## Traceability register

Dispositions changed from the provisional register: W2, W5, W8, W24, W25, W27. Rows W32 to W36 are new.

| ID | Workstream | Disposition | Evidence | Open work |
|---|---|---|---|---|
| W1 | Policy releases and platform installs | Implemented but incomplete | `releases/` holds 1.0.0 to 1.5.5. `verify claude`, `verify codex`, `verify cursor-files` (run with `--root` set to the main checkout) print version 1.5.5, `configurationVerified: true`, `behaviorVerified: false`. This Claude Code session loaded "Harness release 1.5.5". `origin/main` has releases up to 1.4.3 only (`git ls-tree origin/main releases/`) | Fresh-session checks in Codex and Cursor (W21). Merge the 1.5.x releases to `main` |
| W2 | Claude controls (6) | Implemented but incomplete | `controls/controls.json` defines 6 controls (no-force-push, ask-push-main, ask-force-with-lease, no-secret-reads, ask-deploys, no-self-edit). A `no-secret-reads` refusal was observed in the planning session (discovery.md). `controls verify claude` run from this worktree prints 27 rules, `configurationVerified: false`, and 2 missing rules: the no-self-edit rules name the checkout path that ran `controls install` | Changed from "verified": the self-edit rules protect one checkout only, so a T3 worktree gets no self-edit protection. Decide if that is intended; document it in docs/platforms.md |
| W3 | Skills installer | Implemented but incomplete | `src/skills.ts`, `tests/skills.test.ts` pass. `skills status` ran and reports per-skill states; receipts exist for make-it-verifiable, multi-agent-planning, subagent-budget (`receipt=true`), so real installs ran before | Checked here: `status` only, plus unit tests. `install`, `verify` and `uninstall` were not run for real in this audit; slice 11 runs `install --replace` and `verify`. Acceptance: `skills verify` exits 0 for the refreshed skills and `skills uninstall` restores a backup once |
| W4 | multi-agent-planning | Implemented but incomplete | Source `tools/agents/skills/multi-agent-planning/SKILL.md`. `skills status`: installed copy `stale`. Line 58 says "At most 3 children at once" (F5) | Settle F5 before slice 11; refresh the install |
| W5 | subagent-budget | Implemented but incomplete | Commit 2526e19. Diff of the installed snapshot (mission run folder) against `tools/agents/skills/subagent-budget/SKILL.md`: 0 lines removed, 2 added. SKILL.md:12 says "There is no fixed cap on subagent count." `skills status`: installed `modified` | Changed from "Broken or regressed": the source is fixed. README.md:18 still says the old cap (W16). Install refresh in slice 11 |
| W6 | autonomous-engineering core | Implemented but incomplete | `tools/agents/skills/autonomous-engineering/scripts/ae.ts` (21 commands), `tests/ae-engine.test.ts`, `tests/ae-guard.test.ts` pass. No test named `R1-11a` or `R1-11b` on this branch (`grep -n R1-11 tests/ae-guard.test.ts` shows rounds 1 to 4 only) | The 2 known redaction gaps (slice 8) are on a separate branch, review pending |
| W7 | Usage-aware handoff | Implemented but incomplete | `tools/agents/skills/autonomous-engineering/scripts/usage.ts`; `usage`, `checkpoint`, `prepare`, `transfer` in `tools/agents/skills/autonomous-engineering/references/engine.md:31-34`; `tests/ae-usage.test.ts` passes in `npm test` | Fresh review (slice 9). No live provider usage source exists; `usage` needs a snapshot file |
| W8 | ACCEPTED state | Implemented but incomplete | Commit defd1eb; `ae integrate` accepts VERIFIED or ACCEPTED (`tools/agents/skills/autonomous-engineering/references/engine.md:26`); tests pass | Changed: it is now committed and tested. Open: F1 (report shows manual evidence as engine evidence), F3 (conditional assertion) |
| W9 | Overnight mode | Implemented but incomplete | Commits bd88a09, 96fbf58, a4be884, af7c1ff on this branch; `tools/agents/skills/autonomous-engineering/references/overnight.md`; test "charter refuses --grant commit" at `tests/ae-run.test.ts:219` passes | Not on `main`. The overnight plan's slice 5 FAILED (planning notes; not re-checked). That slice was the commit grant, which commit af7c1ff removed on purpose, so the FAILED state is closed by decision, not by a fix. No unattended overnight run observed in this audit |
| W10 | thread-continuity and drift checks | Implemented but incomplete | `tools/agents/skills/thread-continuity/SKILL.md` (T3 only, hidden); `skills status`: `absent` | Slices 2 to 6 of its plan are out of scope. Not installed by decision |
| W11 | make-it-verifiable | Implemented but incomplete | `tools/agents/skills/make-it-verifiable/`; installed `current` with receipt; eval case `verifiable-change` at `evals/cases.jsonl:22` | No result for `verifiable-change` in `evals/results/2026-10.jsonl`. The "passes both arms" claim is not checkable on this branch |
| W12 | grill-me and html-explainer | Implemented but incomplete | `skills status`: both `unmanaged`; `diff -rq` against source: both differ | Refresh installs (slice 11). drift-table.md (mission run folder) found no installed-only user decision |
| W13 | render-rules, verify, continue-work | Unable to verify | `skills status`: all 3 `current`, no receipt | No behavior evidence. Run each once in a fresh session and record the result. Acceptance: three recorded runs (skill, input, observed result) in this audit |
| W14 | Evals (22 cases, live only) | Implemented but incomplete | `evals/cases.jsonl` holds 22 cases. `evals/results/2026-10.jsonl` holds 161 runs from 2026-10-12 to 2026-10-26 | No case `overnight-preflight` on this branch (`git grep` finds none). No eval ran in this mission. Live runs only; no offline gate in CI |
| W15 | Explainer content | Broken or regressed | `docs/project-explainer.html:385` "Release 1.4.3"; `:734` "No harness command installs them yet"; `:746` "the four skills" | Matches `main` but is stale for this branch (10 skills, 1.5.5). Slice 7 |
| W16 | README and docs | Broken or regressed | `README.md:18` "caps a fan-out at 3"; `README.md:43` "Release `1.5.3`". Only 3 of 10 skills are named in the feature list (lines 17 to 19) | Slice 6 |
| W17 | Skill-list drift guard | Not implemented | `npm run harness -- skills catalog --check` prints "Unknown skills command."; no `src/skills-catalog.ts`, no `docs/skills.md` on this branch | Slice 2 (rejected round 1, fix in progress) |
| W18 | Design OS integration | Implemented but incomplete | `context audit` lists plugin `design-os@design-os-by-uma` with 6 skills. `docs/design/` does not exist. The only skipped test, `tests/repo.test.ts:550`, skips because the DesignOS installer is not at the sibling path it expects | Slice 5 spec. Make the skipped test runnable in CI or document why it skips |
| W19 | pstack integration | Unable to verify | The only repo mention is `tools/agents/skills/subagent-budget/SKILL.md:35` (a routing exception). `context audit` shows a `pstack` plugin in Cursor | No pstack init or enforcement requirement found in accessible sources. Ask the owner whether one exists. Acceptance: the owner answers; if yes, a backlog row exists, if no, W19 becomes Superseded or intentionally deferred |
| W20 | Cursor User Rules at 1.5.5 | Implemented but incomplete | `status` (with `--root` set to the main checkout): `manualSteps` cursor-user-rules `needed: true`, `confirmedVersion` 1.5.2, `activeVersion` 1.5.5 | Owner pastes the 1.5.5 rules and runs `confirm cursor-user-rules` |
| W21 | Fresh-session checks of 1.5.5 (Codex, Cursor) | Not implemented | `verify codex` and `verify cursor-files`: `behaviorVerified: false`, note "fresh-session behavior not yet verified" | Start one fresh session each; ask for the release line; record it |
| W22 | Supabase search, packs, Grok export | Superseded or intentionally deferred | Code exists: `supabase/`, `src/supabase.ts`, `src/packs.ts`; README.md:27 calls Supabase optional. The parking decision (2026-10-12) is in private notes, not in the repo | Record the parked status in a public doc (slice 6) |
| W23 | Public release refresh | Implemented but incomplete | `gh repo view`: visibility PUBLIC. Root commit f42076c "Agentic Harness, release 1.4.3" (a fresh-history repo). No repo doc describes the refresh procedure | Document the refresh steps in CONTRIBUTING.md or releases/README.md |
| W24 | Dependabot PRs | Implemented but incomplete | `gh pr view` for #1, #2, #5, #7, #8: every "Harness checks" run is SUCCESS. All 5 are open | Changed from "Unable to verify": CI results are now read. Merge or close each; #5 (zod) overlaps PR #9 |
| W25 | Weekly ideas digest | Implemented but incomplete | `git worktree list` shows 6 digest worktrees; each holds 2 files in `industry-digests/` (untracked) | Changed only in evidence: 6 worktrees, not 5 runs. Verified only that the worktrees and files exist; the digest contents were not read. `log.md` is untracked and per worktree, so a run starts without the covered-ideas log (the 6 files differ in size). No idea adopted. Acceptance: the covered-ideas log persists between runs, and one digest is read and judged |
| W26 | Backup-file hygiene | Not implemented | `.gitignore` has no `bak` rule; `git status --untracked-files=all` in the main checkout lists 57 `.bak` files | Add an ignore rule after the owner agrees; no deletes |
| W27 | Context audit (token load) | Implemented and verified | `npm run harness -- context audit` exit 0 on 2026-11-05. Example: Claude user instructions about 1,445 estimated tokens; `~/.claude/skills` 6 skills, about 520 estimated tokens. Output labels values as "estimate: chars / 4"; `tests/context.test.ts` | Changed: it ran. Values are estimates, not measured |
| W28 | Cross-repo reuse (`repo install`, `skills --repo`) | Unable to verify | `tests/repo.test.ts`, `tests/skills.test.ts` pass | Not run against a real second repo in this audit. Work repos need owner approval first. Acceptance: `repo install` and `skills --repo` run once against a throwaway second repo, with exit codes recorded |
| W29 | md-view builder, repo vs installed | Implemented but incomplete | `cmp` of `tools/agents/bin/md-view.sh` and `~/.agents/bin/md-view.sh`: differ at line 50. `ACCEPTED` appears 2 times in the repo copy, 0 in the installed copy | Copy after a backup (slice 11) |
| W30 | Statechart and poteto-mode follow-ups | Not implemented | `grep -rli statechart .` and `grep -rli poteto .` (outside node_modules) find nothing | The requirement exists only in planning notes. Confirm it with the owner, or close it |
| W31 | PR #6 (release 1.5.0 branch) | Superseded or intentionally deferred | `gh pr list`: #6 open since 2026-10-26, checks SUCCESS. Its content (multi-agent-planning, skills installer, 1.5.0) is on this branch (commits ecec5a8, effc3c3, d8ae9e4) | Close #6 after this branch merges. Acceptance: PR #6 is closed with a comment that names the PR that merged its content |
| W32 | Engine checkpoints, handoff, recovery | Implemented but incomplete | `ae checkpoint` only works for an IN_PROGRESS slice (`tools/agents/skills/autonomous-engineering/references/engine.md:32`, `tools/agents/skills/autonomous-engineering/scripts/ae.ts:459`). `ae report` printed this plan from the journal that the base engine wrote (slice 1 Verify, discovery.md) | EVAL-10 (`ae report` and `ae handoff` from the journal alone) not run. A wrong failure reason stays in the append-only journal (findings.md) |
| W33 | Engine command guard and authority grants | Implemented and verified | `ae check` returned `allow` for all 12 Verify lines and refused a computed `$HOME/...` command name; `ae init` refused the CI workflow path without the `ci` grant (baseline-gates.md). `tests/ae-guard.test.ts` passes | Real behavior observed in this mission. Redaction gaps are tracked in W6 |
| W34 | CI "Harness checks" and secret scan | Broken or regressed | `gh run list --workflow "Harness checks"`: failure on `main` (2026-11-05), on `harness/verifiable-and-skills`, and on PR #9. Failed log: gitleaks `leaks found: 2`, rule `curl-auth-header`, `tests/ae-guard.test.ts` lines 283 and 290, commit 2529cc1. Local gitleaks 8.24.3 over `HEAD` history: the same 2 findings. Over `origin/main` alone: `no leaks found`. 2529cc1 is only on the remote branch `harness/verifiable-and-skills` | The values are synthetic fixtures (an `Authorization` curl at line 283 and an `X-Api-Key` curl at line 290). Rewriting them cannot fix the scan, because commit 2529cc1 stays in history. Fix: a `.gitleaksignore` with exactly the 2 fingerprints (added on the mission branch), and the same file on `main` (for example through PR #9) so `main` and PR #9 go green. CI must pass before the PR |
| W35 | Dependency vulnerabilities | Implemented but incomplete | `npm audit --omit=dev --audit-level=high`: "7 vulnerabilities (5 moderate, 2 high)", exit 1; lockfile equals `origin/main` (baseline-gates.md). PR #9 changes only `package-lock.json` and is mergeable; its CI fails only on the W34 gitleaks step | Fix W34, then merge PR #9 in its own review |
| W36 | Lint gate | Not implemented | `package.json` scripts: `harness`, `test`, `typecheck`. `.github/workflows/checks.yml` runs no linter | The brief asks for linting. Decide: add a linter, or record that typecheck is the only static gate |

### Requirement trace

| ID | Requirement (short) | Status today | Evidence |
|---|---|---|---|
| REQ-1 | Audit starts with summary, traceability, backlog | In progress (this draft) | this file |
| REQ-2 | Each workstream has a disposition and a resolving pointer | In progress; reviewer check pending | Traceability register above |
| REQ-3 | Skill drift fails tests and CI | Not met on this branch | W17 |
| REQ-4 | README commands ran in a clean clone | Not started (slice 6) | W16 |
| REQ-5 | Real screenshots with alt text | Not started (slice 10) | no `docs/assets/screenshots/` |
| REQ-6 | Design OS spec records the skills that ran | Not started on this branch (slice 5) | no `docs/design/` |
| REQ-7 | Explainer responsive, accessible, no stale fact | Not met | W15 |
| REQ-8 | ACCEPTED plus 3 overnight commits without the commit grant; suite passes | Met | W8, W9; `npm test` exit 0 (545 tests, 0 fail) |
| REQ-9 | `subagent-budget` says the 2026-10-27 decision | Met in source; install pending | W5 |
| REQ-10 | Redaction of the 2 gap shapes with tests | Not on this branch (slice 8) | W6 |
| REQ-11 | A new session can continue from plan, journal, run folder | Partly met; EVAL-10 not run | W32 |
| REQ-12 | PR to main after scans, then the A to I report | Not started; blocked by W34 | W34 |
| NOT-1 | No push before the scans | Holds | `git branch -a` lists no remote `harness/production-readiness` |
| NOT-2 | No private plans, paths, or IDs in commits | Holds for `plans/`: `git diff --name-only origin/main...HEAD -- plans/` is empty | Final private-data grep runs in slice 12 |
| NOT-3 | No change to parked features or `knowledge/core.md` | Holds for this mission. The branch differs from `main` in `knowledge/core.md` through commit d8ae9e4 (releases 1.5.0 to 1.5.5), which predates the mission | `git log origin/main..HEAD -- knowledge/core.md` |
| NOT-4 | No delete outside Git; no weakened or skipped test | Owner decision needed: commit 5d4cd72 changed 3 assertions in `tests/ae-skill.test.ts` (description text, `disable-model-invocation`, references list) to match overnight auto-load. They changed meaning, not strength | `git show 5d4cd72 -- tests/ae-skill.test.ts` |

## Backlog

| Priority | Item | Next action | Acceptance |
|---|---|---|---|
| P0 | W34: CI "Harness checks" red on `main` and this branch (gitleaks, 2 fixture findings) | Add a `.gitleaksignore` with exactly the 2 fingerprints (`2529cc143cfadbc62aae28716beb9df19346b0b5:tests/ae-guard.test.ts:curl-auth-header:283` and `:290`). Land the same file on `main` (for example in PR #9) so `main` and PR #9 go green while the remote branch exists. A new fixture committed later needs its own line, because a fingerprint includes the commit | A CI-style scan (gitleaks over remote branches plus `HEAD`) prints `no leaks found`; a new fake secret in another file is still reported; "Harness checks" passes on the PR |
| P1 | W17 / REQ-3: no skill-list drift check | Finish and review slice 2 | `skills catalog --check` exits 0 on the branch and 1 for each fixture drift; CI runs it |
| P1 | F5: `tools/agents/skills/multi-agent-planning/SKILL.md:58` "At most 3 children at once" contradicts `subagent-budget` | Owner decides; proposed: defer the cap to `subagent-budget` | `grep -rniE 'at most 3' tools docs tests README.md` is empty; settled before slice 11 |
| P1 | F1: `ae report` lists a manually ACCEPTED, then INTEGRATED, slice as engine-verified | Filter by evidence kind, not only state; add a test | Report lists that slice under manual sign-off; new test passes |
| P1 | W6 / REQ-10: 2 redaction gaps | Review and integrate slice 8 | Tests `R1-11a` and `R1-11b` pass; existing guard tests pass |
| P1 | W21: no fresh-session check of 1.5.5 in Codex and Cursor | Start one fresh session in each; ask for the policy release line | Each answer names "Harness release 1.5.5"; result recorded |
| P1 | W7: usage-continuity fix never re-reviewed | Run slice 9 | `docs/audits/reviews/usage-continuity-s1.md` has a verdict; `tests/ae-usage.test.ts` passes |
| P1 | Installs drift (W4, W5, W12, W29) | Run slice 11 after F5 | `skills verify` for the 5 names exits 0; `cmp` of md-view.sh is silent |
| P2 | `npm audit`: 7 findings (2 high: body-parser, zod), pre-existing | Fix W34, then review and merge PR #9 (lockfile only) | `npm audit --omit=dev --audit-level=high` exits 0 on `main` |
| P2 | W16: README release and cap facts wrong | Slice 6 | No `1.5.3` or "caps a fan-out at 3" in README.md; every shell block logged with exit 0 |
| P2 | W15: explainer stale | Slices 5 and 7 | No stale fact per slice 7 Verify; browser checks pass |
| P2 | No documented production-readiness criteria | Add a short "Readiness" section (gates and scope) to README.md or docs/README.md | The section exists and the gate table in this audit maps to it |
| P2 | NOT-4: 3 changed assertions in `tests/ae-skill.test.ts` (commit 5d4cd72) | Owner confirms the new meaning (overnight auto-load) | Owner decision recorded in the PR body |
| P2 | W2: self-edit controls protect only the checkout that ran `controls install` | Document the limit in docs/platforms.md, or bind the rule to every harness checkout | Doc states it, or `controls verify claude` from a worktree shows no missing rule |
| P2 | W20: Cursor User Rules at 1.5.2 | Owner pastes the 1.5.5 rules; run `confirm cursor-user-rules` | `status` shows `needed: false` for cursor-user-rules |
| P2 | W22, W23: parked features and release-refresh steps documented only in private notes | Add both to a public doc | The public doc names the parked features and the refresh steps |
| P2 | W24: 5 Dependabot PRs open with green checks | Review each; merge or close | No Dependabot PR older than 14 days |
| P3 | F2: commit defd1eb removed a sentence from the `verifiable-change` eval prompt | Owner confirms intent | Confirmed in the ship note, or the sentence is restored |
| P3 | F3: conditional assertion in the ACCEPTED engine test | Make the setup unconditional | Test fails if the FAILED state is not reached |
| P3 | F4: `ae charter --grant commit` says only `unknown flag --grant` | Add a hint that the commit grant was removed | Error text names the removed grant |
| P3 | F8, F9: catalog check cascade noise and no `--write` hint | Fix in slice 2 follow-up | One message per real difference; refusal prints the fix |
| P3 | W18: only skipped test (`tests/repo.test.ts:550`) needs the DesignOS repo as a sibling folder | Document the skip reason in tests/README.md, or fetch the installer in CI | Skip reason is documented, or the test runs in CI |
| P3 | W26: 57 untracked `.bak` files | Add an ignore rule after owner approval; no deletes | `git status` lists no `.bak` file |
| P3 | W36: no lint gate | Owner decides on a linter | Decision recorded; if yes, CI runs it |
| P3 | W30: statechart and poteto-mode follow-ups | Confirm the requirement with the owner | Kept with a slice, or closed |

## Harness self-check

How the harness worked when used to run this mission. Notes named below are in the mission run folder.

| Capability | Result | Evidence |
|---|---|---|
| Task decomposition | worked | 12 slices with Files, Verify, and dependencies; `ae init` accepted the plan; `ae check` allowed all 12 Verify lines (discovery.md, baseline-gates.md) |
| Agent specialization and coordination | worked with limits | Slices went to Codex, Cursor, and Claude as routed. The coordinator edited 3 test assertions itself, a deviation from "one slice per fresh worker" (discovery.md) |
| Model routing | worked with limits | The coordinator ran on Sonnet 5.5, not the planned Opus (warmup.md). Codex via the T3 route hit its usage limit twice; Cursor via T3 failed once with a provider error (discovery.md) |
| Token-efficient context loading | worked with limits | `context audit` exit 0; values are chars / 4 estimates, not measured (W27) |
| Recoverable checkpoints | worked with limits | `ae checkpoint` only works while a slice is IN_PROGRESS (`tools/agents/skills/autonomous-engineering/references/engine.md:32`). A wrong failure reason stays in the append-only journal (findings.md) |
| Context-drift detection | worked with limits | Editing a Verify line reset slice 12 to READY although its dependencies were unmet (findings.md). `ae recover` reports `planDrift` (`tools/agents/skills/autonomous-engineering/references/engine.md:35`); not run in this audit |
| Safe new-session creation | worked with limits | The mission moved to a new worktree session and continued from the run folder (discovery.md). The user's brief was not carried over and had to be recovered later (discovery.md) |
| Continuity across model changes | worked with limits | After the Codex and Cursor route failures, the Codex CLI and the Cursor CLI ran the same briefs in the same worktrees; slice 1 kept its 6 commits and slice 3 reached VERIFIED (discovery.md) |
| Controlled autonomous execution | worked with limits | The guard refused a computed command name and the CI path without a grant (W33). The `balanced` profile allows 2 concurrent slices (`tools/agents/skills/autonomous-engineering/scripts/journal.ts:15`); the plan assumed 4 |
| Deterministic validation and evals | worked with limits | VERIFIED only after an engine-observed Verify exit 0 (slices 1 and 3). No eval ran in this mission; the last recorded run is 2026-10-26 (W14) |
| Observable execution status | worked with limits | `ae report` printed this plan from the journal (slice 1 Verify). F1: the report can file manual evidence as engine evidence |

## Gate results

Baseline: the mission worktree at c8219b2, before slice 1 (baseline-gates.md). Today: this branch at 2526e19, run by the auditor on 2026-11-05.

| Gate | Baseline | Today | Final |
|---|---|---|---|
| Clean install (`npm ci && npm test` in a fresh clone) | `npm ci` exit 0 (7 audit warnings) | `npm ci` exit 0 in this worktree (not a fresh clone) | to be completed in slice 12 |
| Types (`npm run typecheck`) | exit 0 | exit 0 | to be completed in slice 12 |
| Tests (`npm test`) | exit 0; 511 tests, 510 pass, 1 skipped | exit 0; 545 tests, 544 pass, 0 fail, 1 skipped (`tests/repo.test.ts:550`) | to be completed in slice 12 |
| Pack catalog (`catalog build` and `git diff --exit-code catalog/index.json`) | exit 0, exit 0 | exit 0, exit 0 | to be completed in slice 12 |
| Skill catalog (`skills catalog --check`) | not available | "Unknown skills command." (slice 2 not integrated) | to be completed in slice 12 |
| Public plan page (`md-view.sh --check plans/system-design.md`) | not recorded | `fresh: plans/system-design.html`, exit 0 | to be completed in slice 12 |
| Secrets (gitleaks 8.24.3) | not run (no Docker) | local binary over `HEAD` history: `leaks found: 2`, exit 1 (W34) | to be completed in slice 12 |
| Private data (pattern list over the diff) | not run | not run | to be completed in slice 12 |
| Dependencies (`npm audit --omit=dev --audit-level=high`) | exit 1; 7 findings (2 high), pre-existing | exit 1; same 7 findings | to be completed in slice 12 |
| Links (relative links in README.md and docs) | not run | not run | to be completed in slice 12 |
| Explainer (`tools/explainer.ts check`) | not available | not available (slice 10) | to be completed in slice 12 |
| Engine (`ae status` reports done) | not done | not done (2 of 12 slices VERIFIED) | to be completed in slice 12 |
| CI ("Harness checks" on the PR) | not run | `main` run failed on gitleaks (W34) | to be completed in slice 12 |

## Audit limitations

- Not re-run in this audit: the numbers in the W27 (context audit) row and the live `ae check` and `ae init` notes in W33 come from the earlier mission runs recorded in the mission run folder. `npm test` can fail once when `FORCE_COLOR` is set, because one eval test prints a coloured `5`; it passes with colour unset.

| Source | What happened | Effect |
|---|---|---|
| 58 Claude Code session transcripts | Not read in full | Requests made only in those sessions may be missing from the register |
| Imported T3 threads | Read only in part (by the planning session; not by this audit) | Some register rows (W10, W19, W30) rest on planning notes, not on the original requests |
| GitHub PR review comments | Not read. PR states and check results were read with `gh` | Review feedback on PRs #1 to #9 is not reflected |
| Provider usage and remaining allowances | Unknown for every provider; no tool reports them | Routing and fallback claims cannot include remaining capacity |
| Private decision notes | Not read beyond what the mission plan quotes | Decisions such as the 2026-10-12 parking are cited from the plan, not from the note |
| Notion | One bounded search ("Agent Harness decision") worked. It returned harness pages last edited by 2026-10-13. None was opened, and no decision log appeared in the results | Notion decision records may exist but were not checked |
| Codex and Cursor fresh-session checks of 1.5.5 | Not run | W21 stays "Not implemented" |
| Plan run journals (`plans/*.run.json`) | Not in this checkout | Slice states come from the plan page and run-folder notes |
| Eval results after 2026-10-26 | Only in local T3 checkpoint refs, not on any branch | W11 and W14 claims about later eval runs cannot be checked |
| Digest file contents | Counted, not read | W25 confirms the runs exist, not their quality |
| Other branches (slices 2, 5, 8 work) | Not read | Their dispositions use the run-folder notes |

## Out of scope

- New framework features.
- Thread-continuity slices 2 to 6.
- Parked features: Supabase search, packs, and Grok export.
- A policy release.
- Live eval campaigns.
- Merging any PR.
- Cursor User Rules (only the owner can paste them).
