---
name: make-it-verifiable
description: "Plan how to prove a change works before any code, then run those checks with evidence. Use for /make-it-verifiable <change>, or \"how do we make this change fully verifiable?\"."
disable-model-invocation: true
---

# Make it verifiable

Source: Matt Pocock's tip, "How do we make this change fully verifiable?". The guardrails are Uma's additions.

The change is the text after the command: $ARGUMENTS
If no change is given, ask for it in one sentence. Then stop.

## Step 1: plan the checks (before any code)

Do not write or edit code in this step. Answer with:

1. The user-visible outcome, in one sentence.
2. Each check: what you will run or click, on which real page or service, and what result proves it.
3. What you cannot verify, and why.

Rules:

- Use test or sandbox accounts only.
- Ask the user before any sign-up, payment, email to a real person, or use of production data.
- Ask for secrets with `request_secret` when it exists. Never ask for a secret in chat.
- Then stop. Do not write code until the user says "go".

## Step 2: build, then run every check

After "go", make the change. Then run every check from the Step 1 list.

For each check, report:

| Check | Result | Command or click path | Evidence |
|---|---|---|---|

- Result is pass, fail, or unknown.
- A check you did not run is "unknown", not "pass".
- Evidence is output, a screenshot, or a recording.
- For UI changes, record the changed UI in the browser preview. If no recorder exists, say so and use screenshots.

## Step 3: second opinion

End with this block, so the user can paste it into a fresh thread, Codex, or a Grok Bot:

```text
Here is a change, its check list, and the evidence. Which "pass" has no real evidence? Which user path is not checked? Answer in 5 bullets or fewer.
<change, check table, and evidence>
```
