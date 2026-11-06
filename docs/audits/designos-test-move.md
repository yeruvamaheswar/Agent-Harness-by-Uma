# Design OS repo test move

- Date: 2026-11-05
- Decision: the owner decided that the test which runs Design OS's real installer next to the harness installer belongs in the Design OS repo. This repo keeps a contract test with a fixture Design OS block (see the harness-side change in the same mission).
- Result: a pull request in the Design OS repo, open and not merged.

## The pull request
- URL: https://github.com/yeruvamaheswar/designOS-by-Uma/pull/9
- Branch: `test/harness-coexistence`, commit `d15d59c`, based on that repo's `main` at `cf5686e`.
- Change: one new file, `tests/test_harness_coexistence.py` (129 lines, Python `unittest`).
- CI ("Validate seed", the `check` job): pass on both runs (push and pull request). The PR is mergeable.

## What the new test checks
- It runs both real installers against one temporary project in three orders: harness first, Design OS first, and harness removed first.
- `AGENTS.md` holds exactly one block from each tool. `CLAUDE.md` is the shared stub `@AGENTS.md`.
- Both import flags are `true` (strict). Harness `repo verify` and Design OS `status` pass.
- After both uninstall, the project is byte-identical to its original state.
- It finds this repo through `HARNESS_CHECKOUT`, or else a sibling folder named `Agent-Harness-by-Uma`. It never writes into that checkout. It skips with a reason when the checkout or Node 24 is missing, so CI skips it.

## Evidence
- With `HARNESS_CHECKOUT` set to this repo's mission checkout: 1 test, three orders, OK, about 3 s, three repeat runs with no leftover temporary files.
- With `HARNESS_CHECKOUT=/nonexistent`: skipped, with the reason.
- Design OS full suite: 191 tests, exit 0, 1 skip on the branch; 190 tests, exit 0, on `main` at `cf5686e`.
- `python3 scripts/validate.py`: 0 errors. gitleaks 8.24.3 over remote refs plus `HEAD`: no leaks.
- Independent review by a separate session (Grok): accept. The port keeps every assertion of the source test. Both harness checkouts were unchanged before and after the runs (status and `.state` hashes compared).

## Open
- The owner reviews and merges the pull request. Until then the real cross-installer check exists only on that branch.
- When the test runs from a Design OS worktree outside the usual folder layout, the sibling default does not find this repo. Set `HARNESS_CHECKOUT` in that case.
