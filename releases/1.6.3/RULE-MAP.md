# Rule map: 1.6.2 to 1.6.3

Source: `knowledge/core.md` at commit `e459e3f` (release 1.6.2, 48 lines, 7,000 bytes) and at release 1.6.3 (47 lines, 6,865 bytes).
Method: a word diff of the two files (`git diff --no-index --word-diff`), checked line by line.
Result: no rule was added, removed, or moved to another section. Two 1.6.2 lines (42 and 43) became one 1.6.3 line (42). All other lines map 1 to 1.

Status values:

| Status | Meaning |
| --- | --- |
| same | The line is byte-identical. |
| wording | Words changed. The meaning is the same. |
| CHECK | Words changed. The meaning may have changed. See "Lines to check". |

## Map

| 1.6.2 line | 1.6.3 line | Status | Change |
| --- | --- | --- | --- |
| 1 | 1 | wording | "tools, or automations" to "tools, automations". |
| 2 | 2 | same | Heading "Working principles". |
| 3 | 3 | wording | "assumptions, and unknowns" to "assumptions, unknowns". |
| 4 | 4 | same | Work order. |
| 5 | 5 | same | Simplest design. |
| 6 | 6 | wording | "and explicit references" to "explicit references". "When you name an ID ... say what it means" to "Say what an ID ... means". |
| 7 | 7 | wording | "what is open, and what needs the user's decision" to "what is open, what the user must decide". |
| 8 | 8 | wording | "what it changes, and the options" to "what it changes, the options". "send the user" to "send them". |
| 9 | 9 | same | Short thread messages. |
| 10 | 10 | wording | "handoff, and final report" to "handoff, final report". |
| 11 | 11 | CHECK | "record the changed UI in use" to "record the UI in use". |
| 12 | 12 | same | Heading "Decisions and questions". |
| 13 | 13 | same | GREEN. |
| 14 | 14 | same | AMBER. |
| 15 | 15 | same | RED. |
| 16 | 16 | same | Look before you ask. |
| 17 | 17 | same | Source precedence. |
| 18 | 18 | same | Feature request preflight. |
| 19 | 19 | same | Heading "Before changing code". |
| 20 | 20 | wording | "instructions, and tests" to "instructions, tests". |
| 21 | 21 | wording | "Decide how to make the change fully verifiable, and say how" to "Decide and say how to make the change fully verifiable". |
| 22 | 22 | CHECK | "use the `grill-me` skill first: before code and before any design or build skill" to "use the `grill-me` skill before code and any design or build skill". "block, and stop" to "block, stop". |
| 23 | 23 | same | Review for material changes. |
| 24 | 24 | same | Heading "Tracer bullets: mandatory loop". |
| 25 | 25 | same | Step 1. |
| 26 | 26 | same | Step 2. |
| 27 | 27 | same | Step 3. |
| 28 | 28 | same | Step 4. |
| 29 | 29 | same | Bugs, refactors, experiments. |
| 30 | 30 | same | Heading "Quality". |
| 31 | 31 | same | No speculative work. |
| 32 | 32 | same | Errors, types, tests. |
| 33 | 33 | same | Test in proportion to risk. |
| 34 | 34 | wording | "configuration, and workflows" to "configuration, workflows". |
| 35 | 35 | same | Heading "Context and agents". |
| 36 | 36 | wording | "skills, and personal context" to "skills, personal context". |
| 37 | 37 | wording | "the model and effort from the plan" to "the plan's model and effort". "or a sign of drift ... and a handoff prompt" to "or sign of drift ... and handoff prompt". |
| 38 | 38 | same | Secrets. |
| 39 | 39 | wording | "user work, and repo conventions" to "user work, repo conventions". |
| 40 | 40 | same | Configure another agent. |
| 41 | 41 | wording | "and the harness authority levels" to "and harness authority levels". |
| 42 | 42 | wording | "In T3 Code, start" to "In T3 Code: start". "and effort `high`" to "effort `high`". "or a missing reply" to "or missing reply". |
| 43 | 42 | CHECK | Merged into line 42. "In T3 Code, wait on a PR" to "Wait on a PR", inside the bullet that starts "In T3 Code:". |
| 44 | 43 | same | Heading "On-demand skills". |
| 45 | 44 | wording | "reports, and contracts" to "reports, contracts". |
| 46 | 45 | same | `multi-agent-planning`. |
| 47 | 46 | same | `subagent-budget`. |
| 48 | 47 | same | `render-rules`. |

Counts: 30 same, 15 wording, 3 CHECK. Total 48 lines of 1.6.2.

## Lines to check

1. **Line 11 (UI video).** 1.6.2 said "record the changed UI". 1.6.3 says "record the UI". The sentence still starts "After the change", so the scope is most likely the same. A reader could record a UI view that does not show the change. Risk: low.
2. **Line 22 (`grill-me`).** 1.6.2 said "first: before code and before any design or build skill". 1.6.3 drops "first". The order rule stays ("before code and any design or build skill"). The explicit "first" emphasis is gone. Risk: low.
3. **Line 43 to 42 (PR wait).** 1.6.2 had its own bullet "In T3 Code, wait on a PR with `watch_pull_request`". 1.6.3 puts "Wait on a PR ..." as a later sentence in the bullet that starts "In T3 Code:". The colon scope most likely covers the whole bullet. A reader could apply "Wait on a PR with `watch_pull_request`" outside T3 Code, where that tool does not exist. Risk: low to medium.

No other line changed meaning.
