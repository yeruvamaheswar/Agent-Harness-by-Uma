---
name: grill-me
description: Interview the user relentlessly before building until goals, constraints, and decisions are settled. Use when the user says "grill me", asks to plan a feature or its architecture, or when an engineering request is ambiguous or big enough that a wrong assumption would waste work.
---

# Grill me

Goal: shared understanding before any code is written.

1. Explore first. Answer what you can from the code, docs, and installed instructions. Do not ask the user what you can look up.
2. Map the decision tree. List the open decisions and how they depend on each other. Resolve parent decisions before child decisions.
3. Ask one question at a time. Give your recommended answer and its main tradeoff in one or two lines.
4. Push back on vague answers. Ask for a concrete example, a number, or an acceptance check.
5. Stop when every decision that changes the first slice is settled. Leave details that a tracer-bullet slice will settle faster.
6. Write the result. The `html-explainer` skill, section "Contract (product-size work)", gives the size rule and the format. A product gets a contract file. A feature gets `## Requirements` and `## Evals` in its plan page.
   - Give each requirement an ID: `REQ-n`, or `NOT-n` for a thing the product must not have. Write a behavior as "When CONDITION, the app does BEHAVIOR".
   - Give each requirement a Source. The user's own words are `user`. Anything you added is `agent` and stays a suggestion until the user confirms it.
   - Give each decision a `DEC-n` and the name of who made it.
   - Write one or more evals for each requirement before any code. Write them from the requirement, not from the planned code.
   - Fill the Infrastructure and Observability rows. Write `unknown` where the user has not decided.
   - Write the first slice with its `Covers:` line and its acceptance check. If the work has 2+ slices, the file must let each slice start in a fresh session.
7. Get the user's approval of the contract before the first slice starts.

## When the user cannot answer

This rule applies in a headless run and when no reply comes.

- Do not guess and build.
- Write the open questions, each with your recommended answer, into the plan or contract.
- Give the same questions in your final message.
- Stop. Build nothing until the user answers.
