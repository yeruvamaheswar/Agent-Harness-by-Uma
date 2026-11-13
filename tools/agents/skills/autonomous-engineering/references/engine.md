# Engine reference

The engine is `scripts/ae.ts` in this skill folder. It uses Node built-ins only, so the installed copy runs without `npm ci`.

```bash
node --experimental-strip-types <this skill folder>/scripts/ae.ts <command> PLAN [SLICE] [flags]
```

- `PLAN` is the path to `plans/<slug>.md`. `SLICE` is the slice number.
- Output is one JSON object on stdout. An error goes to stderr with exit 1.
- When a command changes the plan, the result has `rebuild: ~/.agents/bin/md-view.sh PLAN`. Run it.

## Commands
| Command | Flags | Needs state | Result |
|---|---|---|---|
| `init PLAN` | `--profile economy\|balanced\|sprint\|adaptive`, `--heavy-rss-mb N` (adaptive only), `--allow deps,branches,worktrees,migrations,ci` | no journal yet | Creates the journal. Imports plan states (see below). Refuses when a journal exists |
| `status PLAN` | | any | `counts` per state, `done`, `profile`, `authority`, one row per slice with failures, blocker, last move, evidence, and `journalBytes` (with `journalWarning` above 1 MiB). With decisions: `decisions` (total, active, settled, waiting RED keys, stale). With a lease: `lease` (id, label, renewedAt, staleAt). Takes no lease check |
| `next PLAN` | | any | Moves PLANNED slices with settled dependencies to READY. The batch crosses waves: lowest wave, then id. A slice is deferred with a reason: `no free slot`, `profile width N reached`, `a sequential or integration slice is running`, `a sequential or integration slice is in the batch`, `<kind> slice runs alone`, or `files overlap slice N`. Run it after every verify, finish, fail, or block. Returns `batch`, `waiting`, `deferred`, `slots`, `running`, `needsReview`, `needsVerify`, `done`. With the adaptive profile, it reads the capacity probe, keeps the reading in the journal, and adds `capacity`. Then `slots` is `null` unless the signals are not measured (see "Adaptive width") |
| `set-profile PLAN` | `--profile NAME` (required), `--heavy-rss-mb N` (adaptive only), `--reason TEXT` | any | Changes the profile of the journal under the journal lock. The save keeps the old journal as `.bak`. Each change appends a `profileChanges` row: `{at, from, to, reason?, heavyRssMB?}`. The same profile and estimate again gives `changed: false` and writes nothing. With adaptive, the result has `heavyRssMB` and `heavyRssFrom` (`default` or `set`). The lead runs it; a worker never does |
| `start PLAN N` | `--provider`, `--model`, `--effort`, `--task-id` | READY | IN_PROGRESS. Opens a work attempt. Refuses when a dependency is not settled. Returns `launchKey` (`ae:<slug>#N/a<n>`; under a lease `ae:<slug>~<nonce>#N/a<n>`): pass it to `delegate_task` as `clientRequestId`. Returns `baseTree` (the Git tree of the owned files) in a Git repo, and `warning` when the smallest handoff is within 600 characters of its cap |
| `finish PLAN N` | `--summary`, identity flags | IN_PROGRESS | AGENT_FINISHED. A claim, not proof |
| `block PLAN N` | `--reason` (required), `--decision Dn`, identity flags | IN_PROGRESS | BLOCKED, with the reason and a `signature`. `--decision` links the block to an active decision; `unblock` then waits for its approval. The same signature twice adds `loop: "same-blocker"` and `escalate` to the result |
| `fail PLAN N` | `--reason` (required), identity flags | IN_PROGRESS | READY, or FAILED when the budget is spent or the failure repeats three times. For a work failure the worker reported. A stopped or lost worker is `interrupt`, not `fail` |
| `review PLAN N` | `--by`, `--note` (both required), `--reject`, `--exception REASON` | AGENT_FINISHED; with `--reject` also REVIEWED | REVIEWED. Refuses when `Review:` is `CI`, or when `--by` equals the task id of any work attempt of the slice, also one that handed the slice off. Refuses a reviewer whose model family (from `--by` model text, else `--model` or `--provider`; under a lease, else the `Review:` line) has a work attempt on the slice, or whose family is unknown, unless `--exception` gives the reason; the result then has `reviewerException`. Without a lease, a review that names no model is not checked. `--reject` records a failed attempt instead, with a signature from the redacted note: READY, or FAILED at failure 4 or on three identical signatures, as for a failed verify |
| `verify PLAN N` | `--timeout S` (default 600), `--wait-lock S`, or `--manual --by NAME --note TEXT` | REVIEWED, or AGENT_FINISHED when `Review:` is `CI` | The guard checks the command first; anything but `allow` is refused and nothing is recorded. Exit 0: VERIFIED with evidence. Else READY or FAILED, with the redacted output tail. `--manual` is only for a Verify step with no backticked command, and is refused when there is one. It gives ACCEPTED (reason `accepted on a person's note: manual check by NAME`) with `manual` evidence and `verified: false`, never VERIFIED. A command result has `controls` (see below). A successful result (VERIFIED, or ACCEPTED with `--manual`) has `next: "run ae next: dependents may be READY"`. A failed result has no `next`. Two phases: the lock is held to check and to record, never while the command runs. When the state, attempts, definition, fingerprint, or handoff phase changed meanwhile, the result has `unstable: true` and `changed`, and nothing is recorded. A timeout or a signal records `timeout` or `signal`, never a null exit code |
| `unblock PLAN N` | `--reason` (required) | BLOCKED or FAILED | BLOCKED goes to IN_PROGRESS (planner rule). FAILED goes to READY. Both restart the budget. A user decision |
| `integrate PLAN N` | `--ref` (required) | VERIFIED or ACCEPTED | INTEGRATED, with the ref |
| `check [PLAN] -- CMD` | | any | The guard decision for a command: `allow`, `ask`, or `deny`, with level, rule, reason, and `controls` (see below). Process exit 0 for allow, 2 otherwise. With PLAN it uses the journal's authority. No lock, no writes |
| `check [PLAN] --path P` | | any | The guard decision for a file path. A path that needs `ci` is `ask` |
| `dispatch PLAN N` | `--caps FILE`, `--host t3\|claude-code\|other` (default `other`) | READY | `target`, `used` (model, escalated, fallback, handoff), `chain`, `intensity`, `failures`, `escalateWhen`. Read-only |
| `handoff PLAN N` | same as `dispatch`; pass the same values | READY, or IN_PROGRESS with a TRANSFERRED handoff that owns the open attempt (then `continuation: true`: the note for the replacement, under 3500 characters, with the checkpoint). Refuses while the latest handoff is PREPARED or CHECKPOINTED: run `transfer` first | `text`: the planner's handoff note plus an authority line and a data-not-instructions line, under 2500 characters, redacted. Files, Out of scope, and Verify are copied exactly as the plan line has them; they are never shortened, reformatted, or masked. When redaction would change one of them, `handoff` refuses with an error that names the field; remove the secret-like text from the plan line. `Do not touch: nothing else listed` appears only when the plan has no `Out of scope:` line. Only Goal, Accept, and the verified state are shortened. When the note still does not fit, it is an error. Read-only |
| `usage PLAN N` | `--snapshot FILE` (required), `--policy FILE`, `--remaining PCT`, `--agent LABEL`, `--caps FILE`, `--host` | IN_PROGRESS or READY | `risk` (level, limiting limit, reasons), `action`, `text`, and from `assess` up `candidates`, `excluded`, `need`. Read-only. See "Usage handoff" |
| `checkpoint PLAN N` | `--done`, `--next`, `--note`, `--by`, `--kind milestone\|post-mortem\|pre-handoff`, `--run-check`, `--timeout S`, `--launch-key K` | IN_PROGRESS | Records a checkpoint (see "Progress capture"). A lead checkpoint moves a PREPARED handoff to CHECKPOINTED. `--run-check` runs the slice's Verify command in two phases and stores it as `check`, never as evidence; a check during a file change has `stable: false` and moves no phase. `--launch-key K` is the worker's own checkpoint: a milestone claim for its open attempt only, refused for another key, a closed attempt, a lead kind, or an open handoff |
| `prepare PLAN N` | `--to LABEL`, `--lead "Claude (...)"`, `--reason` (all required), `--policy FILE` | IN_PROGRESS | Opens a handoff in phase PREPARED, or CHECKPOINTED when a lead `post-mortem` or `pre-handoff` checkpoint of the open attempt is newer than its last interruption and no slice file changed since. Refuses a lead that is not Claude, Grok, and the current worker (a fresh session of it is allowed). Refuses a target that is not the slice's Model (or its escalation), its Fallback, the approved pool, or the current worker. After a refusal, refuses another agent until an approved `provider-change` decision for the slice is newer than the refusal. The same `--to` again is a no-op; another `--to` replaces the choice |
| `transfer PLAN N` | `--lead` (required), `--task-id`, `--provider`, `--model`, `--effort`, `--mode resume-cross\|cli\|new`, `--disarmed STATUS,METHOD,READ_AT` | IN_PROGRESS, handoff CHECKPOINTED or TRANSFERRED | From CHECKPOINTED: ends the old work attempt as `handed-off`, opens one for the replacement with a new launch key (`handoff.launchKey`), phase TRANSFERRED. Run it before you delegate. Refuses when slice files changed after the checkpoint. Zombie gate: while a lease is held or a thread is bound, it needs `--disarmed` with a terminal status (`completed`, `failed`, `interrupted`, `cancelled`, `canceled`, `exited`; `working` is refused), a method (`cancel`, `configure-away`, `exited`), and an ISO read time. A live CLI worker (`cli:<pid>@<host>` on this host) is always refused. `--mode resume-cross` keeps the bound T3 thread. From TRANSFERRED: `--task-id` attaches the replacement's task to that attempt. The same task id again is a no-op; another task id is refused |
| `recover PLAN` | `--apply`, `--wait-lock S` | any | Reports `lock`, `planDrift` (hand edits), `handoffs` (each unfinished handoff with its `next` step), `staleEvidence`, `inProgress` with `needsCheck`, `needsReview`, `needsVerify`, `blockedFiles`, `git` (branch, head, unowned changes), `filesProblems`, `next`, `orphanSnapshotRefs` (crash orphans: a snapshot number above the highest the journal names) apart from `prunedSnapshotRefs` (left by the 5-checkpoint window). Module lists, when they have items: `decisions` (`stale`, `waitingRed`), `lease`, `unattached` (an open attempt with a launch key and no thread or task: search T3 for the key and attach it; never relaunch blindly), `cliWorkers` (pid, host, alive), and `recovery` (the ranked options of each interrupted slice). With the adaptive profile, `next` has `capacity` from a fresh reading. `recover` keeps no reading, also with `--apply`. Files paths are checked first: a slice whose Files fail is listed in `filesProblems`, and none of its files is read or fingerprinted. A VERIFIED slice among them is listed as stale (`recorded: "unchecked"`). A VERIFIED slice with no live evidence is listed as stale with `recorded: null`. A `BLOCKED*.md` that is a symlink or not a regular file is listed with `issue: null` and a note, and is never read. Without `--apply` it takes no lock and writes nothing. `--apply` only demotes stale VERIFIED and ACCEPTED slices to AGENT_FINISHED (ACCEPTED is checked the same way as VERIFIED), every one listed, also those with `recorded: null` (reason `evidence stale: no live evidence`). Dependents are not demoted |
| `report PLAN` | `--json` | any | Read-only, no lock. Text by default, JSON with `--json`: counts, slices with evidence and claims, attempts by model, commits with an exact `AE-Slice: PLAN#N` trailer, handoffs, charter, stop, and with decisions a `decisions` section (`settledByAgent`, `approved` with provenance and source, `waitingOnUser`, `reopened`, `stale`). It derives everything from the journal and Git; it stores nothing. See `overnight.md` section 9 |
| `charter PLAN` | `--approval PATH:LINE`, `--deadline ISO`, `--cap provider/model/effort=N` (repeatable), `--branch NAME`, `--replace --reason TEXT` | any | Records the run charter for OVERNIGHT mode. See `overnight.md` section 2 |
| `decide PLAN [N]` | `--key K` (required). A write adds `--lead "Claude (...)"` and any of `--risk green\|amber\|red`, `--status proposed\|assumed\|approved\|blocked`, `--question`, `--answer`, `--recommended`, `--rollback`, `--source`, `--scope run\|slice:N`, `--supersedes Dn`, `--evidence LIST`, `--watch PATHS` | any | With only `--key` (and SLICE): a read-only lookup, no lock: `result` is `answered` (with the decision; `stale` when the slice changed), `loop` (asked and still open: do not ask again), or `ask` (nothing recorded; `candidates` are similar keys, never an answer). A write records or moves one decision; see "Decisions". Returns `decision`, `created`, `next` |
| `decisions PLAN [N]` | `--active`, `--key K` | any | Read-only, no lock. `count` and `decisions`. With SLICE: the run scope, that slice, and the slices it depends on |
| `interrupt PLAN N` | `--class C` (required), `--lead "Claude (...)"` (required), `--code X`, `--source t3\|cli\|lead` (default `lead`), `--retryable true\|false`, `--reset-at ISO`, `--operation TEXT`, identity flags | IN_PROGRESS | Records an interruption on the open attempt. The attempt stays open and the fix budget does not move. A code of the code table must agree with `--class`. Returns `interruption`, `failures`, `budget`, and `recovery` (see "Recovery options"). A refusal, or the third stop in a row with one fingerprint, sets BLOCKED (`blocker.cause` `refusal` or `no-progress`). At most 5 per attempt |
| `attach PLAN N` | `--launch-key K` (required when the attempt has one), `--thread-id T`, `--task-id X`, `--observed TEXT` | IN_PROGRESS | Binds the T3 thread and task (or `cli:<pid>@<host>`) to the open attempt. Never rebinds a thread. A second task on the bound thread is an alias (a resend; at most 10). Refuses a thread or task of another attempt. Binding a replacement's thread after its files changed since the transfer's checkpoint needs `--observed` with the old task's status. Returns `attached` (`bound`, `alias`, `unchanged`) and `resendKey` for the next resend |
| `lead PLAN` | `--claim --lead-id ID --label L`, `--takeover --lead-id ID --reason R --observed STATUS@ISO`, `--release --lead-id ID`, or none (shows the lease) | any | The lead lease; see "Lead lease and identity". Takes no SLICE |

- A command Verify (a backticked span in `Verify:`) refuses `--manual`. A manual Verify step needs `--manual`.
- `verify` runs `bash -o pipefail -c` in the Git top level of the plan file. So `npm test | tail` fails when `npm test` fails. Work in another worktree is not seen until it is in that checkout.
- `needsReview`: AGENT_FINISHED slices whose `Review:` is not `CI`. `needsVerify`: REVIEWED slices, and AGENT_FINISHED slices whose `Review:` is `CI`. After an interruption, these are the slices to review or verify.
- Identity flags: `--launch-key K`, `--thread-id T`, `--task-id X`. An event that names another attempt's key, thread, or task is refused. While an interruption is open, `finish`, `fail`, and `block` need one of them, or the lease holder's `--lead-id`.
- `--lead-id ID`: while a lead lease is held, every journal write except `status`, `lead`, and a worker's `checkpoint --launch-key` needs the holder's ID, and renews the lease. Read-only commands (`dispatch`, `handoff`, `usage`, `report`, `decisions`, a `decide` lookup, `recover` without `--apply`, `check`) need none.
- `--wait-lock S`: wait up to S seconds (at most 60) for a lock that a live process holds. The default fails fast. The record phase of `verify` and `checkpoint --run-check` waits at least 5 s.
- Free-text flags (`--summary`, `--reason`, `--by`, `--note`, `--ref`, `--task-id`, `--provider`, `--model`, `--effort`, `--question`, `--answer`, `--recommended`, `--rollback`, `--source`, `--code`, `--operation`, `--evidence`, `--label`, `--observed`, `--exception`) are redacted when they are read, before the journal, the plan, or the output can hold them. Imported Evidence claims are redacted too.
- Every string of a loaded journal is redacted before any output or save. When that changes the journal (an older journal held a secret), the next writing command saves it, and the `.bak` it writes is redacted too.
- The repo is the Git top level of the working folder. The plan's real path must be inside it, so run the engine from the plan's repo. Only when the working folder is not in Git does the plan's folder decide.
- `controls`: the path of the `controls/controls.json` that the guard used. The engine looks in `$HARNESS_ROOT`, then the folders above the script, then the folders above the plan's repo root. With none found, `controls` is `null` and `warning` says that only built-in rules apply and that setting `HARNESS_ROOT` adds the harness controls.
- File overlap compares normalized paths: `./src/` and `src` are the same, and `.` owns the whole repo.
- A Files path that is a symlink, or that runs through a symlinked folder inside the repo, is refused. So two slices cannot own one file under two names.

## States
The engine uses the planner states from `multi-agent-planning/references/slice-format.md`.

| Requested name | Planner state |
|---|---|
| pending | PLANNED, READY |
| running | IN_PROGRESS |
| agent-finished | AGENT_FINISHED, REVIEWED |
| verified | VERIFIED, INTEGRATED |
| accepted | ACCEPTED: a person signed off; the engine observed nothing. It counts as settled for dependencies and `done` |
| blocked | BLOCKED |
| failed | FAILED |

`init` imports the plan's states. PLANNED, READY, BLOCKED, and FAILED stay. IN_PROGRESS becomes READY. AGENT_FINISHED and later become AGENT_FINISHED with reason `imported claim; needs verify`.

On every load, the engine syncs with the plan:
- A new slice is added as PLANNED.
- A changed slice definition moves the slice to READY with reason `definition changed`. Its evidence becomes stale.
- A removed slice moves under `removed` in the journal.

## Profiles
| Profile | Parallel slices | Default for plan `mode` |
|---|---|---|
| economy | 1 | quick |
| balanced | 2 | standard, deep |
| sprint | 4 | sprint |
| adaptive | No fixed number: set at each `ae next` from measured signals, by workload class | none. Name it with `--profile adaptive` |

- Profiles change width only. The budget, the guard, and verify are the same in every profile.
- `init` sets the profile. `ae set-profile` changes it later, for example from balanced to adaptive in a run that already started.

## Adaptive width
Source: `plans/adaptive-concurrency.md`. Code: `scripts/capacity.ts`.

At each `ae next`, the engine reads the machine, keeps the reading in the journal, and sets a limit for each workload class. The sequential and overlap rules apply first, as in every profile. The engine runs no daemon and no sampler between calls.

### Workload class
- A slice is `normal` by default. Add `- Class: heavy` to a slice whose work or Verify runs a heavy job: a Playwright e2e run, `xcodebuild`, or a video encode.
- `Class:` takes `heavy` or `normal`, in any case. Any other value is a plan error.
- The class is not part of the definition digest. A class change never resets a slice, and the new field changed no existing digest.
- The fixed profiles ignore the class.
- `Class:` is an engine field. The planner's `slice-format.md` does not list it yet.

### Signals
| Signal | Source on macOS | Use |
|---|---|---|
| Pressure level | `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical | Gates normal and heavy starts |
| Swapouts | `vm_stat` "Swapouts": pages swapped out since boot | The swap window gates heavy starts |
| Free memory | `sysctl -n kern.memorystatus_level`: the percent of total memory that `memory_pressure` calls free | The memory fit of heavy starts |
| Load average | `os.loadavg()` and the CPU count | Shown, and quoted in heavy reasons. Never decides alone |

- The probe runs `/usr/sbin/sysctl` and `/usr/bin/vm_stat` by absolute path, with a 2 s timeout. A failed read gives `unknown` or `null`. The probe never throws.
- The engine never uses `os.freemem()`. On macOS it counts only unused pages: on one machine it gave 0.46% while `memory_pressure` gave 47% free.
- Load never defers or allows a start alone. On macOS it also counts threads that wait on I/O, so it swings without a memory problem.

### Rules
| Class | A new slice starts when |
|---|---|
| normal | The pressure level is normal. There is no numeric limit. At warn: one slice, and only when no slice of the plan runs, so a busy machine cannot stall the run. At critical: none |
| heavy | The pressure level is normal, the swap window is known and flat, and free memory fits it (see "Memory fit"). When a Verify run of a heavy slice timed out after the last passing heavy Verify, heavy slices run one at a time until a heavy Verify passes. A later ordinary failure does not end this |
| sequential, integration | The rule of every profile: the slice runs alone |

- Parallel slices of any wave start beside each other, as in a fixed profile. A parallel slice that waits for capacity does not hold later slices back.
- A sequential or integration slice keeps its place. When it waits for capacity, later slices wait too, with the reason `waits for slice N (W kind), which waits for capacity`.

### Swap window
- Each adaptive `ae next` keeps its reading. The journal holds the newest 16.
- The base is the newest stored reading that is 60 s old or more. When Swapouts grew since the base, heavy slices wait.
- With no such reading, as at the first `ae next`, the trend is unknown and heavy slices wait. Run `ae next` again 60 s later or more.
- After a long gap between calls, the window is long and can hold an old burst. A long window can only defer, never allow. The reason then asks for a fresh window.

### Memory fit
- The RSS estimate is the memory of one heavy job. The default is 2048 MB: a middle estimate for one Playwright run with 1 worker, or one small `xcodebuild test`.
- Each heavy start in one batch needs free memory, minus the estimate for each heavy start before it in the batch, of at least twice the estimate. With 8192 MB free and the default, 3 heavy slices fit.
- Memory width is the running heavy slices plus the starts that fit. A running heavy slice is in the reading already.
- Calibrate it from one measured run. Measure the peak RSS, for example with `/usr/bin/time -l` ("maximum resident set size"). Then run `ae set-profile PLAN --profile adaptive --heavy-rss-mb N`.

### Back-off
- Triggers count after the last passing Verify of a heavy slice:
  - A Verify that timed out, of any slice.
  - A pressure episode: warn or critical at an `ae next`, after a reading that was neither.
  - Two failed slices in a row: a work or verify failure of one slice, then of another slice, with no passing Verify between them. A review rejection does not count.
- Each trigger lowers the heavy width by one. While memory fits one heavy slice, the width is never below 1.
- A passing Verify of a heavy slice clears every trigger.

### No measured signals
- When the platform is not macOS, or the pressure level or Swapouts cannot be read, the signals are not measured.
- Then adaptive uses the balanced width (2) for all slices, and one heavy slice at a time. A known warn or critical level still applies.
- The engine reads no Linux signals. Adaptive was not tested on Linux.

### Output
- `capacity.measured` and `capacity.signals`: platform, pressure, `swap` (`state` flat, grew, unknown, or unavailable, with `pages` and `windowS`), `freeMB`, `totalMB`, `load`, `cpus`.
- `capacity.normal`, `capacity.heavy`, and `capacity.total`: `starts` (how many may start now; `null` is no numeric limit) and `reason` (why no more may start). `total` has a limit only when the signals are not measured.
- `capacity.heavy` also has `running`, `width` (the heavy slices that may run at once when the gates are open), `rssMB`, `rssFrom` (`default` or `set`), `backoff` (`steps`, `since`, the newest `triggers`), and `serial` (the timeout rule, or `null`).
- Each deferred slice has the reason of its limit, such as `heavy: memory pressure warn (load 4.2 on 10 CPUs)` or `normal: memory pressure warn; 2 running`.
- A heavy slice shows `class: "heavy"` in `batch` and in `status`.

### Journal records
- `capacity`: `{samples, pressureEpisodes, heavyRssMB?}`. Only `ae next` writes it, under the journal lock.
- `profileChanges`: one row per `set-profile` that changed something.
- Two coordinators of one plan share these records through the journal.

### Limits
- A heavy job that has not reached its peak is not in the reading yet. The 2x margin covers part of that. The next `ae next` sees the pressure and swap signals, and back-off follows.
- Heavy slices of another plan are not counted. The memory signals are machine-wide, so they still see that load.
- The engine sees only the Verify runs that it executes. A timeout inside a worker's own run is not a trigger.
- One RSS estimate applies to every heavy slice of the plan.
- An engine older than this profile fails on `ae next` for an adaptive journal. Reinstall the skill before `init --profile adaptive`.

## Attempt budget and no-progress rule
The ladder is the planner's rule. `ae dispatch` picks the target for each step.

| Failures since the last unblock | Next attempt |
|---|---|
| 0 | The `Model:` builder |
| 1 | The builder again: one bounded fix |
| 2 | `Model:` escalated one level |
| 3 | The `Fallback:` owner |
| 4 | FAILED |

- A failure signature is 12 hex over the redacted output tail with digits removed. Three identical signatures in a row set FAILED early (no progress).
- A definition change also restarts the budget.
- After FAILED, only `unblock --reason` (a user decision) returns the slice to READY.

## Loop rules
One table for every rule that stops a repeat. A handoff and an interruption are not failed attempts, so they never move the fix budget.

| Rule | Counts | Trigger | Engine result | Lead action |
|---|---|---|---|---|
| Fix budget | failed verify, failed work, review reject, since the last unblock | failure 4 | FAILED | a user decision, then `unblock --reason` |
| Failure with no progress | failure signatures (12 hex over the redacted tail, digits removed) | 3 identical signatures in a row | FAILED early | as above |
| Same blocker | block signatures of one slice | the same signature twice | BLOCKED, with `loop: "same-blocker"` and `escalate` | escalate once with the missing fact; do not retry |
| Stops with no progress | interruptions since the last unblock, across handoffs | 3 in a row with one fingerprint | BLOCKED, `blocker.cause: "no-progress"` | tell the user the missing fact once; do not transfer again |
| Refusal | an interruption of class `refusal` | one | BLOCKED, `blocker.cause: "refusal"` | ask for a `provider-change` decision |
| Open question | a decision that is `proposed` or `blocked` | `ae decide --key K` | `result: "loop"` | do not ask again; finish other work |

## Evidence
- Command evidence: command, exit code, duration, output tail (last 40 lines, at most 4000 characters, redacted), Git head, fingerprint, time. The `Evidence:` line quotes the last output line that says `pass` or `fail`, else the last output line.
- Manual evidence: who, note, Git head, fingerprint, time.
- The fingerprint is 12 hex over each owned file's path and content hash. Folders are walked. `.git` and `node_modules` are skipped. A missing file counts as `missing`. In a Git repo, a walked folder counts only the files that `git ls-files -co --exclude-standard` lists: tracked files, plus untracked files that are not ignored. Git-ignored files, such as build output, never count and are never read. A path the plan owns by name always counts, even when Git ignores it (an owned file, or an owned folder). Outside a Git repo, or when Git fails, every file counts. Protected paths still count by name only, and symlinks by link text. **One-time effect:** after the skill is reinstalled, a slice whose owned folders hold ignored files gets a new fingerprint. `ae recover` may report its VERIFIED evidence stale once, and the slice needs one re-verify. The plan, its page, and the journal files never count: the engine rewrites them. They are matched by their canonical path, from the real repo root to the real plan folder.
- Each path is normalized first: `.`, `./`, `./src/`, and `src//a.ts` give the same entries as `src` and `src/a.ts`. So a slice that owns `.` does not count the plan, the page, or the journal files.
- A symlink inside an owned folder counts with its link text only. The engine never reads or follows it: its target may be outside the repo or protected.
- A protected path inside an owned folder counts with its name only. The engine never reads it or walks into it. The rules are the `checkPath` rules: `.env*` except `.env.example`, `*.pem`, `*.key`, `.claude/settings*.json`, `.state/`, and `controls/` at the repo root.
- Evidence goes stale when the slice definition changes, or when `recover` finds that owned files changed after verification.

## Journal, backup, and lock
- File: `plans/<slug>.run.json`, next to the plan.
- Save: write the old good file to a new temp file and rename it to `.bak`. Then write the journal to a new temp file and rename it. Each temp file has a unique name and is created exclusively, so it never follows a planted link.
- Every command except `check` refuses to run when the plan, the journal, `.bak`, or `.lock` is a symlink, or when the plans folder resolves outside the repo. It also refuses, and writes nothing, when a folder between the repo root and the plan is a symlink, such as `plans -> docs`: the plan's real folder must equal its path under the real repo root.
- A write needs the lock: before the journal save and again before the plan write, the engine checks that `.lock` holds its own lock text. When it does not, the write fails with `lost the journal lock`.
- Load: when the JSON is bad, the engine uses `.bak` and reports `recoveredFromBackup: true`.
- Lock: `<journal>.lock` holds `pid:hex` (the pid and 32 random hex). A lock of a dead pid is taken over by one elected process: each contender links a unique election file, and only the winner removes the stale lock it read. A lock of a live pid, or an empty lock younger than 10 s, is an error (or a wait, with `--wait-lock`).
- Crash safety: each temp file is fsynced before its rename, and the folder after it. A crash at any step leaves the old or the new journal.
- Size: `status` reports `journalBytes` (serialized UTF-8 bytes). See "Known limits" for the 1 MiB, 1.5 MiB, and 1.75 MiB limits. ACC drops a journal above 2 MiB.
- The engine writes the journal first, then the plan lines. The next command repairs a crash between the two writes.
- Two processes that race for one stale lock lose no update: the election lets one of them take over, and the other gets a busy lock. `tests/ae-hardening.test.ts` races two contenders across the save check and the rename.

## Dispatch and escalation
- With a T3 capabilities file, the provider must exist, `canRunChildTask` must be true, and it must have no constraints.
- Claude tiers resolve to the newest listed model id with `-<tier>-` (numeric sort: `claude-fable-5-2` before `claude-fable-5-1`). Effort is passed only when the model lists that value.
- `Codex (auto)` gets no model. `Cursor (auto)` gets `default`. `Grok (default)` gets no model.
- A named model (`Codex (model-id/effort)`, `Antigravity (model-id)`) must be in the host list, else it is unavailable and dispatch uses the Fallback. The agent `Antigravity` maps to the T3 driver `antigravity`.
- `Codex (model-id/effort)` sets the effort option when the model advertises it under `effort`, `reasoningEffort`, or `reasoning_effort`. Otherwise `notes` says so and no option is set.
- With no capabilities on Claude Code, Claude is a `native-subagent`. Other agents are `handoff`.
- With host `other`, every target is `handoff`.
- Escalation: one level per failure. Claude raises effort low, medium, high; past `high` it goes to the next tier at `medium` (haiku, sonnet, opus, fable). Past `fable/high` it uses the Fallback. A Claude ref at `xhigh` counts as past `high`. Never `max`.
- A named Codex model with an effort steps through the same efforts and then has no step left. It never changes model. `Antigravity (model-id)` has no step: its effort is in the id.
- When `auto`, `default`, a named model without an effort, or the top rung cannot escalate, dispatch uses the Fallback. When nothing can run, it returns a handoff.
- `intensity` is a relative estimate, not a measured quota.

## Usage handoff
Source: `plans/usage-continuity.md`. Code: `scripts/usage.ts`. The engine never calls a provider and never polls. The lead writes what it observed.

### Snapshot (`--snapshot FILE`)
```json
{"agents": {
  "Codex":  {"limits": [{"kind": "quota", "usedPct": 88, "resetAt": "2026-10-27T20:00Z", "source": "codex /status"}]},
  "Cursor": {"limits": [{"kind": "quota", "usedPct": null}]},
  "Claude": {"limits": [{"kind": "context", "reached": true}]}
}}
```
- Keys are agent names: `Claude`, `Codex`, `Antigravity`, `Cursor`, `Grok`. Case does not matter, and a model text such as `Cursor (auto)` counts as its agent. All Claude tiers share one key: one account. Any other key is listed in `ignored`, redacted.
- `kind` is set by the lead: `quota` (subscription), `rate` (rate limit), or `context` (context window). Quota and rate are account limits. Context is a session limit. The engine never guesses the kind from text.
- `usedPct` is 0 to 100, or `null` when the provider shows none. A missing agent, a `null`, or a number outside 0 to 100 gives `unknown`. The bad value is dropped, never echoed.
- `"reached": true` on a limit means the lead saw it at its limit. It counts as 100 percent and gives `exhausted` for that kind.
- `code` is an exact provider code, matched after trimming and lower-casing. Only these codes count, and each one sets `reached` for its kind:
  | code | kind |
  |---|---|
  | `usage_limit_reached`, `insufficient_quota` | quota |
  | `rate_limit_exceeded`, `rate_limited`, `rate_limit_error` | rate |
  | `context_length_exceeded`, `context_window_exceeded` | context |
  Any other code is listed in `ignored`, redacted, and changes nothing. Free text is never read: a `limitReached` or `error` field is refused with an error, so no phrase can exhaust an agent. Any other field the engine does not read, at agent or limit level, is refused too, and `reached` must be `true` or `false`.
- Quota and rate limits belong to the account; the context window belongs to the session. They are judged apart. An account limit wins a tie. With no account number, a context reading decides only from `assess` up; a low one leaves the level `unknown`.
- Free text (`source`, `resetAt`) is redacted when read. Put no credentials in it.

### Levels and actions
| Used (default) | Level | `action` |
|---|---|---|
| no usable number | unknown | `continue`: checkpoint at milestones, watch for reached limits |
| below 70 | normal | `continue` |
| 70 to 84 | assess | `assess`: candidates listed for reference |
| 85 to 94 | prepare | `prepare`: the lead picks, then `prepare` and `checkpoint` |
| 95 to 99 | transfer | `transfer` at the next safe checkpoint |
| 100, or a reached limit | exhausted | `transfer-now` |
| prepare or higher, no candidate | | `block`: checkpoint, block, tell the user |

- `--remaining PCT`: the lead's estimate of the work left, as a percent of the current agent's allowance. It is compared with the scarcest quota or rate limit, never the context window. When it exceeds that free capacity, the level rises to `prepare` (or to `transfer` when it is already `prepare`), before any threshold.
- The current agent is the replacement while the attempt opened by `transfer` is open, else the slice's `Model:`. `--agent` overrides it, for example after an escalation.

### Policy (`--policy FILE`, optional)
```json
{"thresholds": {"default": {"assess": 70, "prepare": 85, "transfer": 95}, "Codex": {"assess": 60, "prepare": 75, "transfer": 90}, "context": {"assess": 80, "prepare": 90, "transfer": 98}},
 "ranks": {"Claude haiku": 1, "Claude sonnet": 2, "Claude opus": 3, "Claude fable": 3, "Codex": 3, "Antigravity": 1, "Cursor": 2, "Grok": 0},
 "pool": ["Cursor (auto)", "Codex (auto)", "Claude (sonnet/high)", "Claude (opus/high)"]}
```
- Any key may be left out; the defaults above apply. Threshold lookup: `Agent.kind`, then `Agent`, then `kind`, then `default`. Each needs assess <= prepare <= transfer.
- `ranks` is capability. A candidate needs a rank at least that of the slice's `Model:`. A slice `Model:` with no rank needs the highest rank. A candidate with no rank is excluded. The ranks are a judgment; change them in the policy file. `Antigravity` is 1 because the agent key cannot tell its models apart, so it gets the lowest build rank. It is not in the default pool.
- Grok never builds: it is excluded as a candidate, and `prepare` refuses it. The planner uses Grok for review only.

### Candidates
1. Only when the context window alone is the problem (no account limit at `prepare` or worse, no limit reached): a fresh session of the current agent, with the checkpoint. It meets the capability need by definition.
2. The slice's `Fallback:`.
3. The `pool`, cheapest first by `intensity` (a relative estimate, not measured cost). At equal cost, known capacity comes before unknown.

Excluded, with the reason: the current agent for a quota or rate limit (it shares the account), a rank below the need, capacity `prepare` or worse, and a target that the T3 capabilities do not offer. An agent with unknown capacity stays, with the note `capacity unknown`. The engine only ranks. The Claude lead decides.

### Phases
The plan `State:` stays IN_PROGRESS. The journal holds the phase.

| Phase | Set by | Next |
|---|---|---|
| PREPARED | `prepare` | `checkpoint` |
| CHECKPOINTED | `checkpoint` after `prepare` | stop the old worker, then `transfer` |
| TRANSFERRED | `transfer` | `handoff`, delegate, `transfer --task-id`. The replacement works; `finish`, `review`, `verify` as usual. `prepare` again starts a new handoff |
| CLOSED | the engine: an open handoff when the slice leaves IN_PROGRESS (the old worker finished or failed, or the definition changed); a transferred one when the replacement no longer owns the slice: its attempt ended other than by a block, the definition changed, or a newer handoff took over | nothing; its checkpoint is never reused. `prepare` starts a new handoff |

- A handoff is not a failed attempt. The fix budget, review, and evidence carry over. A replacement that stops is an `ae interrupt` handled by FAILOVER mode: the attempt stays open and takes no fix-budget step. Use `ae fail` only for a reported work failure.
- No two workers own the slice: `start` needs READY, and `transfer` refuses a second task.
- `transfer` runs before the replacement starts and compares the slice fingerprint with the checkpoint. A change means the old worker may still write: stop it, checkpoint again.
- After a block and `unblock`, the replacement stays the worker.
- Crash between steps: each step is safe to repeat. `recover` lists the handoff and its next step. At TRANSFERRED with no task id, search T3 threads by the attempt's launch key for an already launched task. If found, attach it with `ae attach PLAN N --launch-key K --thread-id T --task-id X` before continuing. Only consider another launch after the search confirms no task was launched. Never relaunch blindly.

### Journal records
- `checkpoints` (last 5): `{at, by, gitHead, branch, fingerprint, changed, unowned, lastCheck, done?, next?, note?}`. `changed` is the slice's changed files from `git status`; `unowned` is changed files that no slice owns.
- `handoffs`: `{phase, at, lead, reason, from: {label, attempt?, taskId?}, to, checkpointAt?, taskId?, history: [{at, phase, note}]}`. `phase` is PREPARED, CHECKPOINTED, TRANSFERRED, or CLOSED.
- A work attempt opened by `transfer` has `handoff` (the index into `handoffs`). The old one ends with outcome `handed-off`.

### Example: Codex at 88 percent, Cursor continues
```bash
ae usage plans/p.md 3 --snapshot /tmp/usage.json --remaining 30   # risk transfer; candidates: Cursor (auto) (Fallback)
ae prepare plans/p.md 3 --to "Cursor (auto)" --lead "Claude (opus/high)" --reason "Codex quota 88%; rest will not fit"
ae checkpoint plans/p.md 3 --done "routes and model written" --next "write the service tests"
# stop the Codex task (T3: task_cancel), then claim ownership before Cursor starts:
ae transfer plans/p.md 3 --lead "Claude (opus/high)"
ae handoff plans/p.md 3 --caps /tmp/caps.json --host t3          # continuation note for Cursor
# delegate_task to Cursor with that note, then attach its task:
ae transfer plans/p.md 3 --lead "Claude (opus/high)" --task-id <cursor task id>
```
`tests/ae-usage.test.ts` runs this path end to end in a temp repo.

### Limits
- Most subscriptions do not expose quota to the harness. Then the level is `unknown`, and only reached limits and checkpoints protect the work.
- The engine cannot stop a worker. The lead stops it; the fingerprint check catches a worker that still writes to slice files. It cannot see writes outside the slice files.
- A session cannot move between providers. The replacement gets the checkpoint and the repo, not the old conversation.
- `--lead` is text the lead passes. The engine records it and refuses a non-Claude lead; it cannot prove who called it (see "Known limits").

## Decisions
Code: `scripts/decisions.ts`. Only the Claude lead writes decisions. A lookup and `ae decisions` take no lock, so they work during a long verify.

- Fields: `id` (D1, D2, ...; never reused), `key`, `scope` (`run` or `slice:N`), `risk`, `status`, `question`, `answer`, `recommended`, `rollback`, `source`, `provenance` (`attested`), `evidence`, `watch`, `supersedes`, `supersededBy`, `history` (last 10).
- Keys: 1 to 80 lowercase letters, digits, dots, dashes, or underscores. These keys are always RED: `deploy`, `push`, `commit`, `merge`, `spend`, `prod-data`, `auth`, `credentials`, `delete`, `deps`, `branches`, `worktrees`, `migrations`, `ci`, `provider-change`.
- Moves: `proposed` to `assumed`, `approved`, or `blocked`; `blocked` to `approved`; `assumed` to `approved` or `blocked`; `approved` to `blocked` (a revoke, with `--source`). A settled decision changes only by a new decision with `--supersedes Dn`. An approval may supersede anything; an assumption supersedes only an assumption. Reopening a settled decision with an open one needs `--evidence` (what changed); the old one stays in force until the user decides.
- Refusals: a RED item as `assumed`; an AMBER assumption without `--rollback`; `assumed` or `approved` without `--answer`; `approved` without `--source`; a second settled decision for one key in overlapping scopes (`run` overlaps every slice); text over 500 characters; more than 5 evidence locators or 10 watched paths; more than 100 active decisions (superseded ones do not count; the oldest superseded ones are dropped).
- Sources (DEC-19): `claude:<session>:<msg>`, `t3:<thread>:<item>`, `file:PATH:LINE`, or `user-cli`. Provenance is `attested`: the engine checks the form, not the content.
- Stale: a slice decision whose slice definition changed, or a decision with `--watch` whose watched files changed. A stale decision still answers a lookup, marked `stale`. The packet marks it "re-check, do not rely".
- Blocks: `ae block PLAN N --reason TEXT --decision Dn` links the block. `unblock` is refused until Dn (or the decision that superseded it) is `approved`, or `assumed` and not RED.
- A lookup sees the run scope and the slice it names. A slice decision wins over a run decision for the same key. `ae decisions PLAN N` and the packet also include decisions scoped to the slices that N depends on.

## Lead lease and identity
Code: `scripts/failover.ts`. One lead writes at a time (NOT-12). A journal with no lease behaves as before.

- Claim: `ae lead PLAN --claim --lead-id ID --label "Claude (opus/high)"`. ID is the T3 `parentThreadId` or the Claude Code session id. The holder's claim again renews it. TTL: 2 hours from the last renewal; every lead write renews it.
- Takeover: `ae lead PLAN --takeover --lead-id ID --reason R --observed STATUS@ISO`. STATUS is the predecessor's stopped status: `completed`, `failed`, `interrupted`, `cancelled`, or `exited`. It works on a fresh or a stale lease; the old ID is refused from then on.
- Release: `ae lead PLAN --release --lead-id ID`. Once a lease was claimed, a released lease still refuses lead writes until a new claim.
- Launch keys: `start` and `transfer` record one per attempt. Under a lease it carries the journal nonce (6 hex), so keys never repeat across journals. A resend k of the same attempt uses `<key>/r<k>`. A worker that continues after `unblock` keeps its key, thread, and task.
- Bind: `ae attach` binds the thread and task after the launch. Then an event may name `--thread-id` or `--task-id` instead of the key.

## Progress capture
Code: `scripts/progress.ts`. Everything here is observed by the engine; a worker's text stays a claim.

- Each work attempt records `baseTree`: a Git tree of the owned files as they are on disk, built in a temporary index. A replacement and a worker after `unblock` keep the first base, so finished files stay in the delta.
- Each checkpoint in a Git repo records `delta` (at most 40 paths, with `deltaCount`), `diffStat`, `snapshot`, and `health`.
- `snapshot`: the hidden ref `refs/ae/snapshots/<slug>/<slice>/<n>`, one commit of the owned files only: never the journal and never a `plans/` file. It is local and never pushed. An empty delta takes no snapshot.
- `health`: at most 8 codes: `merge-in-progress`, `rebase-in-progress`, `cherry-pick-in-progress`, `revert-in-progress`, `bisect-in-progress`, `index-lock`, `unmerged-paths`, `head-moved`.
- `role` is `lead` or `worker`. `kind` is `milestone`, `post-mortem` (after a stop), or `pre-handoff` (before a planned transfer). While an interruption is open, the first line of `next` is `interrupted: <class> ... attempt N stays open`.

## Recovery options
Code: `scripts/options.ts`. `ae interrupt` and `ae recover` return the options for the open interruption, best first. The engine only ranks; the Claude lead picks (DEC-11). Nothing switches back by itself.

| # | Option | When | Identity |
|---|---|---|---|
| 1 | Wait for T3 auto-resume | quota, when an observed reset is 60 minutes or less away and before the charter deadline. Send nothing to the limited thread | same attempt |
| 2 | Resume the same thread | rate, api, auth, process, tool, unknown. Only after `task_status` is terminal (never `working`). Resend, then `ae attach` the new task as an alias | same attempt |
| 3 | The same agent's CLI in the same workspace | api or auth, after option 2 fails. `ae prepare --to` the current label plus `, fresh session`, such as `Codex (gpt-6.1-sol/low, fresh session)`; then `ae transfer --mode cli`, and attach `cli:<pid>@<host>` | handoff `cli` |
| 4 | Same thread, other provider | quota or rate, when a T3 thread is bound (probe P3 passed). `ae transfer --mode resume-cross`; send the full packet | handoff `resume-cross` |
| 5 | New child in the same workspace | any class but refusal: a fresh session of the same agent first for context, process, and tool; then the Fallback; then the pool, cheapest capable first. `ae transfer --mode new` | handoff `new` |
| none | Refusal | a provider change needs an approved RED decision `provider-change` for the slice, approved after the refusal | BLOCKED |

The order per class, as `recovery.options` gives it:

| Class | Options in order | Note |
|---|---|---|
| quota | 1, 4, 5 | 2 and 3 share the account limit or the auto-resume |
| rate | 2, 4, 5 | 3 shares the account limit |
| api, auth | 2, 3, 5 | the same agent's CLI before another provider (DEC-11) |
| context | 5 | a fresh session of the same agent first |
| process, tool | 2, 5 | 5 starts with a fresh session of the same agent |
| unknown | 2, 5 | 5 uses another agent only: it may be an account limit |
| refusal | none | BLOCKED until a `provider-change` decision is approved |

- Authorized targets: the slice's `Model:` and its escalations, its `Fallback:`, the approved pool (`ae usage` policy), and the current worker. `prepare` refuses any other.
- Who refused (DEC-22): the engine names the worker from what the attempt recorded at `ae start` or `ae transfer` (`--provider`, else the model's family), then the handoff target, and only when neither exists the slice's `Model:`. An unknown provider or model keeps its own text, so any switch after its refusal needs the approval. After `ae unblock` the continuing worker keeps its recorded identity. A refusal is recorded only by `ae interrupt --class refusal`: `block` and `fail` refuse a refusal class. After a refusal, `start` as another provider than the refusing agent needs the approved `provider-change` too. A `start` with no `--provider` or `--model` counts as both the `Model:` and the `Fallback:` agent (the fix ladder can reach the Fallback early, with an escalation spent or on a host that runs it natively): it needs the approval unless both are the refusing agent. Name the worker with `--provider` and `--model` to launch the one you mean. Record the worker at every `start` and `transfer` (`--provider`, `--model`, `--effort`): an attempt that recorded nothing binds a later refusal to both agents when the `Model:` and the `Fallback:` differ, and every later start then needs the approval, even on the same agent. An attempt that recorded no worker binds a later refusal to both the `Model:` and the `Fallback:` agents. A `transfer` whose `--provider` or `--model` names another agent than the handoff target is refused, also on the second call that attaches the task. A Gemini provider or model is the Antigravity agent.
- The pool: `ae interrupt` ranks with the `--policy` pool, as `prepare` authorizes. `ae recover` and `ae status` show recovery with the default pool: they are advice, and `prepare` is the authority that refuses a label the policy does not allow.
- Option 3 note: `prepare` refuses the current worker's exact label, although the option-3 `when` text names it. Add `, fresh session`: a CLI run is a fresh session of the same agent, and the target stays authorized.
- The code table maps exact provider codes: `usage_limit_reached`, `insufficient_quota` (quota); `rate_limit_exceeded`, `rate_limited`, `rate_limit_error` (rate); `context_length_exceeded`, `context_window_exceeded` (context); `api_error`, `overloaded_error`, `server_error` (api); `authentication_error`, `invalid_api_key` (auth); `permission_error` (refusal). A listed code must agree with `--class`. Any other code is kept as text and classifies nothing.
- T3 gives a status and free text only (probe P4), so the lead sets the class. A reset time comes only from a CLI's JSON.

## Real automation and instruction
| Behavior | Kind |
|---|---|
| State transitions, journal, backup, lock, plan line rewrite | Engine (real) |
| Batch selection, dependency and file-overlap checks | Engine (real) |
| Capacity probe, adaptive width, and back-off | Engine (real), from the signals that the probe read |
| Choosing the profile and calibrating the RSS estimate | Instruction: the lead does it with `ae set-profile` |
| Running Verify and recording evidence | Engine (real) |
| Fix budget, no-progress rule, escalation, target resolution | Engine (real) |
| Usage risk, candidate ranking, checkpoint, handoff phases, the transfer fingerprint check | Engine (real), from the snapshot the lead wrote |
| Decision rules, lookups, stale marks, decision-linked blocks, loop results | Engine (real), from what the lead recorded |
| Lease checks, launch keys, event binding, the zombie gate, recovery option ranking, the code table | Engine (real). The class, the observed status, and the source come from the lead |
| Base tree, delta, snapshot refs, health codes, the engine-run check | Engine (real) |
| Setting the class, reading `task_status`, choosing an option, asking the user, disarming the old worker | Instruction: the Claude lead does it |
| Observing usage, choosing the replacement, stopping the old worker | Instruction: the Claude lead does it |
| Guard and redaction on commands the engine runs | Engine (real). Other commands are guarded only by the platform (Claude Code permission rules) |
| Calling `orchestrator_capabilities`, `delegate_task`, `task_status` | Instruction: the coordinator does it |
| Launching a native subagent or printing a handoff | Instruction |
| Independent review and the review note | Instruction; the engine records it |
| Asking the user for authority, rebuilding the page, the final report | Instruction |
| Moving worktree changes into the plan's checkout | Instruction; needs the user when it needs a commit or merge |

## Known limits
- Caller identity (R7): a local CLI cannot prove who called it. `--lead`, `--lead-id`, and launch keys are strings the caller passes. The lease is a fence against honest mistakes, not a security boundary. A worker's packet holds its launch key, never the lead ID.
- Times: `--observed` (STATUS@ISO) and the READ_AT of `--disarmed` are checked for ISO format only, not against the clock. A wrong time is recorded as given.
- Spelling: `--observed` accepts `cancelled` but not `canceled`. `--disarmed` accepts both.
- Lock format: the lock text is now `pid:hex`. An older installed engine reads only a pid. Install all engine copies at once, and never run mixed versions on one journal.
- Size limits, counted in serialized UTF-8 bytes:
  - `ae decide` is refused once the whole journal reaches 1 MiB (1,048,576 bytes).
  - Other writes pass up to the 1.5 MiB soft guard. Above it, a write that grows the journal is refused unless it moves a slice state.
  - At the 1.75 MiB hard ceiling nothing is written, state moves and `recover --apply` included.
  - At either limit, archive the journal (move it aside) and start a new one.
  - The 100-decision cap assumes short text. With multibyte text the real decision limit is below 100.
- A dispatch note has no launch key: `handoff` runs while the slice is READY, before `start`. Pass the key from `start` to `delegate_task`. A continuation note names the new key.
- `report` derives a `decisions` section and lists `handoffs`. It has no separate recoveries section.
- `--workspace` is an accepted flag, and `attempt.workspace` is in the contract type, but no command records it yet.
- Probes P5 and P6 (T3 auto-resume and a send to a limited thread) are unknown, so the engine assumes the worst case: option 2 is never offered for quota, and every transfer away from a bound thread needs `--disarmed`.
