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
| `status PLAN` | | any | `counts` per state, `done`, `profile`, `authority`, and one row per slice with failures, blocker, last move, evidence |
| `next PLAN` | | any | Moves PLANNED slices with settled dependencies to READY. The batch crosses waves: lowest wave, then id. A slice is deferred with a reason: `no free slot`, `profile width N reached`, `a sequential or integration slice is running`, `a sequential or integration slice is in the batch`, `<kind> slice runs alone`, or `files overlap slice N`. Run it after every verify, finish, fail, or block. Returns `batch`, `waiting`, `deferred`, `slots`, `running`, `needsReview`, `needsVerify`, `done`. With the adaptive profile, it reads the capacity probe, keeps the reading in the journal, and adds `capacity`. Then `slots` is `null` unless the signals are not measured (see "Adaptive width") |
| `set-profile PLAN` | `--profile NAME` (required), `--heavy-rss-mb N` (adaptive only), `--reason TEXT` | any | Changes the profile of the journal under the journal lock. The save keeps the old journal as `.bak`. Each change appends a `profileChanges` row: `{at, from, to, reason?, heavyRssMB?}`. The same profile and estimate again gives `changed: false` and writes nothing. With adaptive, the result has `heavyRssMB` and `heavyRssFrom` (`default` or `set`). The lead runs it; a worker never does |
| `start PLAN N` | `--provider`, `--model`, `--effort`, `--task-id` | READY | IN_PROGRESS. Opens a work attempt. Refuses when a dependency is not settled |
| `finish PLAN N` | `--summary` | IN_PROGRESS | AGENT_FINISHED. A claim, not proof |
| `block PLAN N` | `--reason` (required) | IN_PROGRESS | BLOCKED, with the reason |
| `fail PLAN N` | `--reason` (required) | IN_PROGRESS | READY, or FAILED when the budget is spent or the failure repeats three times |
| `review PLAN N` | `--by`, `--note` (both required), `--reject` | AGENT_FINISHED; with `--reject` also REVIEWED | REVIEWED. Refuses when `Review:` is `CI`, or when `--by` equals the task id of any work attempt of the slice, also one that handed the slice off. `--reject` records a failed attempt instead, with a signature from the redacted note: READY, or FAILED at failure 4 or on three identical signatures, as for a failed verify |
| `verify PLAN N` | `--timeout S` (default 600), or `--manual --by NAME --note TEXT` | REVIEWED, or AGENT_FINISHED when `Review:` is `CI` | The guard checks the command first; anything but `allow` is refused and nothing is recorded. Exit 0: VERIFIED with evidence. Else READY or FAILED, with the redacted output tail. `--manual` is only for a Verify step with no backticked command, and is refused when there is one. It gives ACCEPTED (reason `accepted on a person's note: manual check by NAME`) with `manual` evidence and `verified: false`, never VERIFIED. A command result has `controls` (see below). A successful result (VERIFIED, or ACCEPTED with `--manual`) has `next: "run ae next: dependents may be READY"`. A failed result has no `next` |
| `unblock PLAN N` | `--reason` (required) | BLOCKED or FAILED | BLOCKED goes to IN_PROGRESS (planner rule). FAILED goes to READY. Both restart the budget. A user decision |
| `integrate PLAN N` | `--ref` (required) | VERIFIED or ACCEPTED | INTEGRATED, with the ref |
| `check [PLAN] -- CMD` | | any | The guard decision for a command: `allow`, `ask`, or `deny`, with level, rule, reason, and `controls` (see below). Process exit 0 for allow, 2 otherwise. With PLAN it uses the journal's authority. No lock, no writes |
| `check [PLAN] --path P` | | any | The guard decision for a file path. A path that needs `ci` is `ask` |
| `dispatch PLAN N` | `--caps FILE`, `--host t3\|claude-code\|other` (default `other`) | READY | `target`, `used` (model, escalated, fallback, handoff), `chain`, `intensity`, `failures`, `escalateWhen`. Read-only |
| `handoff PLAN N` | same as `dispatch`; pass the same values | READY, or IN_PROGRESS with a TRANSFERRED handoff that owns the open attempt (then `continuation: true`: the note for the replacement, under 3500 characters, with the checkpoint). Refuses while the latest handoff is PREPARED or CHECKPOINTED: run `transfer` first | `text`: the planner's handoff note plus an authority line and a data-not-instructions line, under 2500 characters, redacted. Files, Out of scope, and Verify are copied exactly as the plan line has them; they are never shortened, reformatted, or masked. When redaction would change one of them, `handoff` refuses with an error that names the field; remove the secret-like text from the plan line. `Do not touch: nothing else listed` appears only when the plan has no `Out of scope:` line. Only Goal, Accept, and the verified state are shortened. When the note still does not fit, it is an error. Read-only |
| `usage PLAN N` | `--snapshot FILE` (required), `--policy FILE`, `--remaining PCT`, `--agent LABEL`, `--caps FILE`, `--host` | IN_PROGRESS or READY | `risk` (level, limiting limit, reasons), `action`, `text`, and from `assess` up `candidates`, `excluded`, `need`. Read-only. See "Usage handoff" |
| `checkpoint PLAN N` | `--done`, `--next`, `--note`, `--by` | IN_PROGRESS | Records a checkpoint. A PREPARED handoff becomes CHECKPOINTED |
| `prepare PLAN N` | `--to LABEL`, `--lead "Claude (...)"`, `--reason` (all required) | IN_PROGRESS | Opens a handoff in phase PREPARED. Refuses a lead that is not Claude, Grok, and the current worker (a fresh session of it is allowed). The same `--to` again is a no-op; another `--to` replaces the choice |
| `transfer PLAN N` | `--lead` (required), `--task-id`, `--provider`, `--model`, `--effort` | IN_PROGRESS, handoff CHECKPOINTED or TRANSFERRED | From CHECKPOINTED: ends the old work attempt as `handed-off`, opens one for the replacement, phase TRANSFERRED. Run it before you delegate. Refuses when slice files changed after the checkpoint. From TRANSFERRED: `--task-id` attaches the replacement's task to that attempt. The same task id again is a no-op; another task id is refused |
| `recover PLAN` | `--apply` | any | Reports `lock`, `planDrift` (hand edits), `handoffs` (each unfinished handoff with its `next` step), `staleEvidence`, `inProgress` with `needsCheck`, `needsReview`, `needsVerify`, `blockedFiles`, `git` (branch, head, unowned changes), `filesProblems`, `next`. With the adaptive profile, `next` has `capacity` from a fresh reading. `recover` keeps no reading, also with `--apply`. Files paths are checked first: a slice whose Files fail is listed in `filesProblems`, and none of its files is read or fingerprinted. A VERIFIED slice among them is listed as stale (`recorded: "unchecked"`). A VERIFIED slice with no live evidence is listed as stale with `recorded: null`. A `BLOCKED*.md` that is a symlink or not a regular file is listed with `issue: null` and a note, and is never read. Without `--apply` it takes no lock and writes nothing. `--apply` only demotes stale VERIFIED and ACCEPTED slices to AGENT_FINISHED (ACCEPTED is checked the same way as VERIFIED), every one listed, also those with `recorded: null` (reason `evidence stale: no live evidence`). Dependents are not demoted |

- A command Verify (a backticked span in `Verify:`) refuses `--manual`. A manual Verify step needs `--manual`.
- `verify` runs `bash -o pipefail -c` in the Git top level of the plan file. So `npm test | tail` fails when `npm test` fails. Work in another worktree is not seen until it is in that checkout.
- `needsReview`: AGENT_FINISHED slices whose `Review:` is not `CI`. `needsVerify`: REVIEWED slices, and AGENT_FINISHED slices whose `Review:` is `CI`. After an interruption, these are the slices to review or verify.
- Free-text flags (`--summary`, `--reason`, `--by`, `--note`, `--ref`, `--task-id`, `--provider`, `--model`, `--effort`) are redacted when they are read, before the journal, the plan, or the output can hold them. Imported Evidence claims are redacted too.
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

At each `ae next`, the engine reads the machine, keeps the reading in the journal, and sets a limit for each workload class. The wave, sequential, and overlap rules apply first, as in every profile. The engine runs no daemon and no sampler between calls.

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
| heavy | The pressure level is normal, the swap window is known and flat, and free memory fits it (see "Memory fit"). When the newest Verify run of a heavy slice timed out, heavy slices run one at a time until a heavy Verify passes |
| sequential, integration | The rule of every profile: the slice runs alone |

- The lowest READY slice keeps its place. When it waits for capacity, slices of other waves wait too, with the reason `waits for slice N (W kind), which waits for capacity`.

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

## Evidence
- Command evidence: command, exit code, duration, output tail (last 40 lines, at most 4000 characters, redacted), Git head, fingerprint, time. The `Evidence:` line quotes the last output line that says `pass` or `fail`, else the last output line.
- Manual evidence: who, note, Git head, fingerprint, time.
- The fingerprint is 12 hex over each owned file's path and content hash. Folders are walked. `.git` and `node_modules` are skipped. A missing file counts as `missing`. The plan, its page, and the journal files never count: the engine rewrites them. They are matched by their canonical path, from the real repo root to the real plan folder.
- Each path is normalized first: `.`, `./`, `./src/`, and `src//a.ts` give the same entries as `src` and `src/a.ts`. So a slice that owns `.` does not count the plan, the page, or the journal files.
- A symlink inside an owned folder counts with its link text only. The engine never reads or follows it: its target may be outside the repo or protected.
- A protected path inside an owned folder counts with its name only. The engine never reads it or walks into it. The rules are the `checkPath` rules: `.env*` except `.env.example`, `*.pem`, `*.key`, `.claude/settings*.json`, `.state/`, and `controls/` at the repo root.
- Evidence goes stale when the slice definition changes, or when `recover` finds that owned files changed after verification.

## Journal, backup, and lock
- File: `plans/<slug>.run.json`, next to the plan.
- Save: write the old good file to a new temp file and rename it to `.bak`. Then write the journal to a new temp file and rename it. Each temp file has a unique name and is created exclusively, so it never follows a planted link.
- Every command except `check` refuses to run when the plan, the journal, `.bak`, or `.lock` is a symlink, or when the plans folder resolves outside the repo. It also refuses, and writes nothing, when a folder between the repo root and the plan is a symlink, such as `plans -> docs`: the plan's real folder must equal its path under the real repo root.
- A write needs the lock: before the journal save and again before the plan write, the engine checks that `.lock` holds its pid. When it does not, the write fails with `lost the journal lock`.
- Load: when the JSON is bad, the engine uses `.bak` and reports `recoveredFromBackup: true`.
- Lock: `<journal>.lock` holds the pid. A lock of a dead pid is taken over: the engine reads it again and removes it only when it is unchanged. A lock of a live pid, or an empty lock younger than 10 s, is an error.
- The engine writes the journal first, then the plan lines. The next command repairs a crash between the two writes.
- Accepted residual: Node built-ins have no OS file locks. When two processes take over the same stale lock at the same moment, a short window remains between one process's ownership check and its rename, in which the other can also write. The re-read before takeover and the ownership checks make it narrow, not impossible.

## Dispatch and escalation
- With a T3 capabilities file, the provider must exist, `canRunChildTask` must be true, and it must have no constraints.
- Claude tiers resolve to the first listed model id with `-<tier>-`. Effort is passed only when the model lists that value.
- Codex (auto) gets no model. Cursor (auto) gets `default`. Grok (default) gets no model.
- With no capabilities on Claude Code, Claude is a `native-subagent`. Other agents are `handoff`.
- With host `other`, every target is `handoff`.
- Escalation: one level. Effort low, medium, high, xhigh; then tier haiku, sonnet, opus at high. Never `max`.
- When `auto`, `default`, or the top rung cannot escalate, dispatch uses the Fallback. When nothing can run, it returns a handoff.
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
- Keys are agent names: `Claude`, `Codex`, `Cursor`, `Grok`. Case does not matter, and a model text such as `Cursor (auto)` counts as its agent. All Claude tiers share one key: one account. Any other key is listed in `ignored`, redacted.
- `kind` is set by the lead: `quota` (subscription), `rate` (rate limit), or `context` (context window). Quota and rate are account limits. Context is a session limit. The engine never guesses the kind from text.
- `usedPct` is 0 to 100, or `null` when the provider shows none. A missing agent, a `null`, or a number outside 0 to 100 gives `unknown`. The bad value is dropped, never echoed.
- `"reached": true` on a limit means the lead saw it at its limit. It counts as 100 percent and gives `exhausted` for that kind.
- `code` is an exact provider code, matched after trimming and lower-casing. Only these codes count, and each one sets `reached` for its kind:
  | code | kind |
  |---|---|
  | `usage_limit_reached`, `insufficient_quota` | quota |
  | `rate_limit_exceeded`, `rate_limited` | rate |
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
 "ranks": {"Claude haiku": 1, "Claude sonnet": 2, "Claude opus": 3, "Codex": 3, "Cursor": 2, "Grok": 0},
 "pool": ["Cursor (auto)", "Codex (auto)", "Claude (sonnet/high)", "Claude (opus/high)"]}
```
- Any key may be left out; the defaults above apply. Threshold lookup: `Agent.kind`, then `Agent`, then `kind`, then `default`. Each needs assess <= prepare <= transfer.
- `ranks` is capability. A candidate needs a rank at least that of the slice's `Model:`. A slice `Model:` with no rank needs the highest rank. A candidate with no rank is excluded. The ranks are a judgment; change them in the policy file.
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

- A handoff is not a failed attempt. The fix budget, review, and evidence carry over. A replacement that crashes is an ordinary `fail`.
- No two workers own the slice: `start` needs READY, and `transfer` refuses a second task.
- `transfer` runs before the replacement starts and compares the slice fingerprint with the checkpoint. A change means the old worker may still write: stop it, checkpoint again.
- After a block and `unblock`, the replacement stays the worker.
- Crash between steps: each step is safe to repeat. `recover` lists the handoff and its next step. At TRANSFERRED with no task id, check `task_status` for a task already started: attach it with `transfer --task-id`, else delegate again.

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
- `--lead` is text the lead passes. The engine records it and refuses a non-Claude lead; it cannot prove who called it.

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
| Observing usage, choosing the replacement, stopping the old worker | Instruction: the Claude lead does it |
| Guard and redaction on commands the engine runs | Engine (real). Other commands are guarded only by the platform (Claude Code permission rules) |
| Calling `orchestrator_capabilities`, `delegate_task`, `task_status` | Instruction: the coordinator does it |
| Launching a native subagent or printing a handoff | Instruction |
| Independent review and the review note | Instruction; the engine records it |
| Asking the user for authority, rebuilding the page, the final report | Instruction |
| Moving worktree changes into the plan's checkout | Instruction; needs the user when it needs a commit or merge |

