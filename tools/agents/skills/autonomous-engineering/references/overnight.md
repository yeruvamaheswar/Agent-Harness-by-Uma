# Overnight reference

Read this file when the user asks for a run while they are away. The Claude lead follows it. A worker never does. Every rule below sits under `references/authority.md`: the stricter rule wins, and only the user grants authority.

## 1. Preflight
1. Inspect first: the repo, the plan, running threads, dirty files, and the providers that `orchestrator_capabilities` lists. Ask nothing the repo answers.
2. Ask one batch. Each question has four fields:

| Field | Meaning |
|---|---|
| Why | What the answer changes |
| Default | What the lead does when the user does not answer |
| Consequence | What happens if the default is wrong |
| Blocking | `yes` when the run cannot start without it, else `no` |

3. Clear every first-use permission prompt before the user leaves. One unanswered plan-mode prompt stalled a run for 7 hours on 2026-11-04 (T3 record: asked 04:20Z, answered 11:18Z). Run one warm-up for each command class the run uses:

| Warm-up | Command class it clears |
|---|---|
| `ae status PLAN` | The engine run |
| `ae check PLAN -- git status` | A guarded shell command |
| The first slice's Verify command | The test runner |
| One `delegate_task` probe for each planned provider | Child launches, and the usage state |

4. Start `caffeinate -i -t SECONDS` for the run length, so idle sleep cannot stall it (section 7).
5. Ask for plan approval last. The user types it in the thread. Then run `ae charter` with the approval row, the deadline, the caps, the branch, and the grants (section 2). Nothing runs before the charter.

## 2. Charter rows and defaults
The charter is the user's written limit for the run. Record it with:

`ae charter PLAN --approval PATH:LINE --deadline ISO --cap provider/model/effort=N --branch NAME --grant commit`

| Flag | Rule |
|---|---|
| `--approval` | `PATH:LINE` of a repo line that holds the user's typed approval. The engine stores that line's text. A lead's own words are not an approval |
| `--deadline` | An ISO time with a UTC offset, such as `2026-11-05T19:00:00-06:00`. A time with no offset is refused |
| `--cap` | A limit on attempts for one provider, model, and effort. It counts work and review attempts |
| `--branch` | The local run branch. Never a default branch. Creating it needs the user's `branches` grant (`references/authority.md`, level B) |
| `--grant commit` | Lets `ae commit` commit a VERIFIED slice on the run branch. Add it only when the user approved commits |

A second charter needs `--replace --reason`. Defaults for the ten areas, when the user did not decide:

| Area | Default | Who can change it |
|---|---|---|
| Code edits | Allowed inside the slice's Files only | The plan |
| Dependencies | No install. Needs `--allow deps` from the user | The user |
| Branches and commits | Work on the run branch. `ae commit` commits a VERIFIED slice, once, when the charter holds `--grant commit`. Without the grant, no commit | The user |
| Pull requests | Never | Nobody in this run |
| External APIs | None. A call to a service outside the repo needs the user's approval | The user |
| Spending | None. Never buy usage and never switch to a paid API | The user |
| Deploys | Never | Nobody in this run |
| Secrets | Never read. Never write to a note, plan, journal, or commit | Nobody in this run |
| Destructive operations | Never. This includes `reset --hard`, `clean -f`, force-push, and `rm -r` of a path outside the repo | Nobody in this run |
| Migrations | Local only, and only with `--allow migrations`. Never a remote or production database | The user |

A typed `git commit`, push, merge, rebase, or PR command stays level C. The commit grant covers `ae commit` and nothing else.

## 3. The loop
One fresh child owns one slice. The lead keeps the plan, the journal, and the report.

```text
ae next -> dispatch + handoff -> child builds -> finish (a claim)
        -> review (a different session) -> verify (the evidence) -> commit -> ae next
```

| Step | Mode in SKILL.md | Rule here |
|---|---|---|
| EXECUTE | EXECUTE | Run `ae next PLAN`. Start the batch it returns. Give each child the `ae handoff` note and the checkout path. Set provider, model, and effort. The charter's caps apply |
| REVIEW | REVIEW | A different session reads the diff. The reviewer is never the builder |
| USAGE | USAGE | Write a snapshot only from numbers a provider showed. A reached limit starts section 5 |
| RECOVER | RECOVER | After a crash or a new thread, run `ae recover PLAN` first |

- After `ae verify` passes, run `ae commit PLAN N`. Check the trailer first: a slice that already has an `AE-Slice:` commit needs no second one.
- Ask the user nothing during the run. A decision need gets `ae block` with a reason. Then continue other safe slices.
- Commit paths that the slice owns. Never use `-a`, `--amend`, or `--no-verify`.

## 4. Waits
- End the turn while children run. Their completion wakes a T3 lead.
- For a timed wait, run a background `sleep` of 30 minutes or less. Then call `t3_background_wait` on it.
- Never poll with `task_status`, a `sleep` loop, or a watcher.
- Record the wait in the lead log: what you wait for, and until when.

## 5. Provider errors and rate limits
| Event | Action |
|---|---|
| Login failure or outage | Probe the agent's CLI first. Then use the outage form below. Then the slice's Fallback |
| Limit reached, reset in 30 minutes or less | Wait once (section 4). The limit and the slice get one wait only |
| Limit reached, reset later, or a second limit for the same slice | Take the handoff path |
| Reset time unknown | Take the handoff path. Do not guess a time |

- Handoff path: `ae usage`, `ae prepare`, `ae checkpoint`, `ae transfer`, then `ae handoff` and a new delegate.
- Outage form, with no `ae usage`: `ae prepare PLAN N --to "Codex (auto, fresh session)" --lead "Claude (...)" --reason TEXT`. Then `ae checkpoint`, `ae transfer`, and `ae handoff`. Use the agent that failed, as a fresh session, to try its CLI. The `--reason` text is what the journal shows as the cause.
- Never `ae fail` for a provider error. It spends a build attempt, and the work did not fail.
- The checkpoint `done` text reaches the continuation note. Write it with care.

## 6. Thread lifecycle
A thread becomes unreliable by symptoms you can see. Act on a signal you observed. Never invent a threshold, and never claim a thread exists that you did not read.

| Symptom | Observed signal | Action |
|---|---|---|
| A slice fails again for the same reason | Failure count and repeated reason in `ae status` (source: the journal) | Follow `ae dispatch`: builder fix, escalation, then the Fallback. Do not retry the same prompt |
| A worker reports its context is full | The error text in the task result (source: `delegate_task` or `task_status`) | Mark the context limit reached in a usage snapshot. Take the handoff path |
| The lead repeats a finished step or loses a decision | The lead log and `ae status` disagree (source: the run folder log and the journal) | Reread the journal. If one correction fails, move to a fresh thread or session |
| A turn ends with no journal write | No new entry after a wake-up (source: the `ae status` last-move time) | Read the child with `t3_thread_read` and `task_status`. Run `ae recover` |
| A prompt waits for the user | A pending request on the thread (source: `t3_pending_request`) | Stop that work. Report it. Warm-ups in section 1 prevent it |
| Usage or context numbers are needed | None. T3 shows no usage numbers and no context signal (source: observed 2026-11-04 and 2026-11-05) | Record them as unknown. Act only on a limit that a provider reported |

- T3: a successor thread needs a typed approval row from the user. Follow `tools/agents/skills/thread-continuity/SKILL.md`. That skill allows one successor.
- Claude Code CLI: it cannot launch a thread. Write a checkpoint with `ae checkpoint`. Then resume in a fresh session with `ae recover`.
- Never claim a successor thread exists until `t3_thread_read` shows it.

## 7. Crash recovery and supervisor
| Event | Observed | Mitigation |
|---|---|---|
| The app crashes | Nothing restarts a lead | None is automatic. The user or a new session runs `ae recover PLAN` |
| The Mac restarts | Nothing restarts a lead | The same as above |
| The Mac sleeps from idle | Assumed: a sleeping Mac stalls a run (not observed) | Run `caffeinate -i -t SECONDS` at preflight. It ends by itself |
| A process dies during a write | The journal has a lock, a temp file, or an IN_PROGRESS slice | `ae recover PLAN` lists them. Redo no VERIFIED slice |

- `ae recover` lists `needsCommit` for a VERIFIED slice with no commit. Run `ae commit PLAN N` for each.
- A supervisor service that restarts a lead is not built. Do not claim one.
- Unverified: a restart after an app crash, and a restart after a Mac restart.

## 8. Stop conditions
Stop, write the report, and end when one of these is true:
- `ae next` gives `done: true`.
- `ae next` gives `stop: "deadline"` or `stop: "budget"`.
- Every remaining slice is BLOCKED or FAILED, or waits on one.
- A command needs authority the charter does not hold.
- The engine reports an error outside your authority.
- The user says stop.

## 9. Morning report

Run `ae report PLAN` for a morning report, or `ae report PLAN --json` for JSON.
The report reads recorded states, evidence, failures, blockers, and work attempts from the journal.
It reads commits reachable from HEAD with an exact `AE-Slice: PLAN#N` trailer.
The goal is a plan label. The period runs from journal creation to its last recorded update.
Attempts are grouped by recorded provider, model, and effort. Missing labels appear as `unknown`.
The report includes the journal path and redacts secrets from all output strings.
It takes no lock and changes no journal or plan bytes. It does not sync plan changes or recheck evidence freshness.
A VERIFIED state is the journal's recorded result. Worker completion remains a claim.
Unavailable Git history is reported explicitly. A backup journal is identified when used.

Add lead notes after the report: waits, provider events, budget used, and what stays unverified.

## 10. Runtime matrix
| Runtime | Leads | Wake-up | Delegation | Thread handoff | Limits seen |
|---|---|---|---|---|---|
| T3 Code, Claude lead | Yes | Each delegate completion. A background `sleep` plus `t3_background_wait` (observed 2026-11-04 and 2026-11-05) | `delegate_task` | One successor, with a typed approval row | No usage numbers. No context signal |
| Claude Code CLI, Claude lead | Yes | None between turns | Native subagents | None. Checkpoint, then resume in a fresh session | No context signal. No thread launch |
| Codex, Cursor, Grok | Never | A worker ends when its task ends | The lead delegates to them | None | No harness locks (`references/authority.md`). Nothing stops a worker's command |

- A session that received an `ae` handoff note is a worker. It runs the note and `ae check`. It never runs the loop.
- Grok may review. It does not lead.

## 11. Stop or disable a run
- Stop one run: tell the lead to stop. It finishes the step in progress, then writes the report. For a lost lead, run `ae recover PLAN` in a new session.
- Cancel children: `task_cancel` each running task. Do not use `t3_thread_interrupt` on a child.
- Disable a deadline or cap: run `ae charter` again with `--replace --reason`. Only the user decides.
- Turn off auto-load: restore `disable-model-invocation: true` in `SKILL.md`. Reinstall the skill. A name-only call still works.
- Stop the sleep guard: end the `caffeinate` process you started, by its PID, or wait for its time limit.
