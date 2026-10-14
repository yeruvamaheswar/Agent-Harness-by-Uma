---
name: verify
description: Check a built product against its contract in a fresh session and report what passes, fails, or is unknown. Use only when the user asks to verify a product or names this skill.
disable-model-invocation: true
---

# Verify

Goal: an independent check of a product against `plans/<product>.contract.md`.

## Independence
- The session that built the product never verifies it.
- Start from the contract and the repo only.
- A builder's summary, chat, or "done" mark is a claim, not evidence.

## Hard limits
- Change no product code, test, requirement, or eval definition.
- Do not fix what you find.
- Write only `plans/<product>.verify.md`, in the plan-page format. Build it with the page builder.
- No deploy, migration, push, or package install without the user's yes.

## Steps
1. Build the contract page. List its `warn:` lines.
2. Run every eval by its method.
   - Unit and integration: the project's own test commands.
   - Browser: a real browser run, when a browser tool is available. Run it 3 times when cheap.
   - `verifier diff`: read the diff.
   - Record for each: `pass`, `fail`, or `unknown`, the date, the command, and a pointer to the evidence.
   - A check you could not run is `unknown`, never `pass`.
   - A result that differs between runs is `flaky`, not `pass`.
3. Check the scope.
   - List every changed or added file, dependency, route, and screen that no `REQ-n`, `DEC-n`, or approved `CR-n` explains.
   - A retrofit has no base commit. Check the whole repo against the contract.
   - Check each `NOT-n`.
   - Report these as possible scope expansion. The user decides.
4. Check Infrastructure and Observability. Each resource has its file. Each signal's eval was run. List `manual` and missing rows as gaps.
5. Check completion. List each slice marked done whose evals have no result with evidence.
6. Review the UI only when the contract has a UI requirement. Use the project's own design review skill on the rendered screens.

## Classify each failure
Give one class and the next action.
- Product defect
- Planning defect
- Requirement ambiguity
- Architecture defect
- Incorrect eval: the product matches the requirement and the eval disagrees. Say the eval is wrong, not the product.
- Environment failure
- External dependency

## Report
Write in this order:
1. Coverage: one row per `REQ-n` and `NOT-n`, with result and evidence.
2. Deviations.
3. Gaps.
4. What stayed unknown, and why.

- Give no combined score. Other passes do not hide one failed requirement.
- Hand the report to the user. The builder fixes. A new verify session checks again.
