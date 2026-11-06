Verdict: accept

## Summary
- Scope: slice 1 of the usage-continuity plan (usage risk, replacement ranking, checkpoint, transfer), at commit 69caa74. I changed no code.
- All 14 slice-1 evals (EVAL-1 to EVAL-14) pass in tests and in my own runs of the CLI in temp repos. The engine suite (199 tests) and the full suite (584 pass, 1 skipped) pass.
- No usage number is invented. A limit is `exhausted` only from `reached: true`, an exact code, or a stated 100. A handoff charges no failure. Ownership moves before the replacement note exists.
- One new medium finding (F1): when `--snapshot` or `--policy` is not valid JSON, Node's parse error echoes up to about 20 characters of the file to stderr without redaction.
- I accept because F1 needs a file that is not a snapshot, prints only a short fragment, and stores nothing. A strict reading of NOT-2 (no secret survives redaction) would reject on F1. That decision is the user's (see Limits).

## Evidence
| Command (from the worktree root) | Result |
|---|---|
| `node --experimental-strip-types --test tests/ae-usage.test.ts` | exit 0; tests 41, pass 41, fail 0 |
| `node --experimental-strip-types --test tests/ae-*.test.ts` (the slice Verify) | exit 0; tests 199, pass 199, fail 0 |
| `npm test` | exit 0; tests 585, pass 584, fail 0, skipped 1 |
| Throwaway scripts in a temp dir outside the repo: `ae init`, `start`, then `usage`, `prepare`, `checkpoint`, `transfer`, `handoff`, `recover`, `fail`, `dispatch` | Outputs below |

Selected `ae usage` outputs (Codex is the slice Model; default policy):
- `{"agents":{}}` or `usedPct: null`: level `unknown`, `limiting: null`, action `continue`, no candidates.
- 60 / 75 / 88 / 96 percent quota: `normal` / `assess` / `prepare` / `transfer`.
- `rate` with `reached: true`: `exhausted`, `transfer-now`. Code `usage_limit_reached`: `exhausted` (quota).
- `context` with `reached: true`: `exhausted`; first candidate `Codex (auto, fresh session)`.
- 50 percent used with `--remaining 60`: `prepare`. Unknown usage with `--remaining 500`: stays `unknown`.
- `usedPct` of -5, 1e308, or "88": `unknown`, value not echoed.
- Refused with a clear error: an `error` free-text field, an extra field, `reached: "yes"`, kind `tokens`, a top-level array, a `null` limit, a `null` agent, `--remaining abc`, `--remaining -1`.
- `__proto__` and `constructor` keys: listed in `ignored`, no effect. A token-shaped agent key or field name: printed as `[REDACTED]`.

Lifecycle run (one temp repo): transfer with no handoff, before checkpoint, or with a non-Claude lead: refused. `handoff` before transfer: refused. A file edit, a new file, or a deleted file in the slice after the checkpoint: transfer refused, nothing written. Transfer: `failures 0`, old attempt `handed-off`, new attempt opened. Transfer again: `unchanged`. `--task-id t1` twice: `unchanged`. `--task-id t2`: refused. Tokens in `--reason`, `--done`, `--next`, `--by`: `[REDACTED]`; `grep` for them in the journal and its `.bak`: 0 hits. `recover` lists the TRANSFERRED handoff and its next step. `fail` then counts failure 1 of 4 and closes the handoff.

## Criteria
| Criterion (paraphrase) | Result | Evidence |
|---|---|---|
| EVAL-1: thresholds give normal, assess, prepare, transfer; a policy moves them | pass | test `EVAL-1`; CLI run at 60/75/88/96 |
| EVAL-2: no usable number gives `unknown` and continue | pass | test `EVAL-2`; CLI run with `{}`, `null`, -5, 1e308, "88" |
| EVAL-3: remaining work above free capacity raises to `prepare` | pass | test `EVAL-3`; CLI 50 percent with `--remaining 60` |
| EVAL-4: `reached` or an exact code gives `exhausted`; free text is refused | pass | tests `EVAL-4`, `review 14 and 15`, `review 16`; CLI `error` field refused |
| EVAL-5: Fallback first; exhausted, incapable, and Grok excluded | pass | tests `EVAL-5` (two), `review 8`, `review 10`, `review 13` |
| EVAL-6: no qualifying candidate gives `block` | pass | test `EVAL-6` |
| EVAL-7: a non-Claude lead cannot prepare or transfer | pass | test `EVAL-7`; CLI: `Codex (auto)`, `Grok (x)`, `Claude`, `Claude Codex` refused |
| EVAL-8: checkpoint lists changed files; note says inspect first | pass | test `EVAL-8`; CLI note has the inspect line and no token |
| EVAL-9: transfer keeps failures and state; VERIFIED only via review and verify | pass | test `EVAL-9 and end to end`; CLI `failures 0` after transfer |
| EVAL-10: a slice edit after checkpoint, or a second task id, is refused | pass | test `EVAL-10`; CLI edit, new file, delete, and `t2` all refused |
| EVAL-11: repeated steps are no-ops; recover names the next step | pass | tests `EVAL-11` (two); CLI repeated prepare and transfer |
| EVAL-12: low use and small remaining work gives continue, no candidates | pass | test `EVAL-12`; CLI 60 percent |
| EVAL-13: a failed replacement counts one failure; new prepare allowed | pass | test `EVAL-13`; CLI `fail` gives failure 1 of 4 |
| EVAL-14: a token in snapshot `source` and `--done` is redacted; no new import | pass, with F1 | tests `EVAL-14` (two), `review 16: a secret in an unknown code`; F1 is outside these inputs |
| The existing engine tests still pass | pass | `tests/ae-*.test.ts`: 199 of 199 |

## Findings
| ID | Severity | file:line | What | Repro or test |
|---|---|---|---|---|
| F1 | medium | `tools/agents/skills/autonomous-engineering/scripts/ae.ts:178` (also the CLI error writer at `ae.ts:732`) | A non-JSON `--snapshot`, `--policy` or `--caps` file puts Node's parse message in the error (seen on `usage`, `dispatch` and `handoff`). That message quotes up to about 20 characters of the file, and nothing redacts it. The error writer's `redact()` would mask a whole AWS key ID or an `sk-` key inside that message, but not a quoted `token: hunter2pass` line, so a short secret-shaped fragment can reach the terminal. The text goes only to stderr of the command that named the file. It is not written to stdout, the journal, its backup or a handoff note. The path of the named file is also printed in full, so a secret inside a path is shown on stderr (not stored). | Write a file that holds only `token: hunter2pass` (or a 20-character AWS key ID). Run `ae usage PLAN 1 --snapshot FILE`. Stderr shows `Unexpected token 'o', "token: hunter2pass" is not valid JSON`. A file that starts with `sk-ant-api03-...` shows its first 10 characters. Fix idea: wrap the message in `redact()`, or drop the parse detail. |
| F2 | low | `tools/agents/skills/autonomous-engineering/scripts/usage.ts:199` | A fresh-session candidate shows `capacity: normal` even when its account usage is unknown. That level is not observed. It is a label, not a number. | Snapshot `{"agents":{"Codex":{"limits":[{"kind":"context","reached":true}]}}}`. `ae usage` lists `Codex (auto, fresh session)` with capacity `normal`. |
| F3 | low | `tools/agents/skills/autonomous-engineering/scripts/ae.ts:453` | `--remaining` accepts `Infinity`, `1e400`, and values above 100. The reason then reads `predicted remaining work Infinity%`. The level is still a safe `prepare`. | `ae usage PLAN 1 --snapshot S --remaining 1e400` |
| F4 | low | `tools/agents/skills/autonomous-engineering/scripts/ae.ts:487` | `prepare` accepts another model of the current agent, for example `Codex (gpt-x)` for `Codex (auto)`. It shares the account limit, and the ranking would exclude it. Round 3 left this as the lead's choice. | `ae prepare PLAN 1 --to "Codex (gpt-x)" --lead "Claude (opus/high)" --reason r` succeeds |
| F5 | info | `tools/agents/skills/autonomous-engineering/scripts/ae.ts:462` | Outside a Git repo, `checkpoint` records `changed: []` and head `none` with no warning. This is from reading the code only. A second reviewer ran it: `changed: []`, head `none`, no engine warning. | Code read: `changedFiles(c.root) ?? []` |
| F6 | info (documented limit) | `tools/agents/skills/autonomous-engineering/scripts/ae.ts:523` | The fingerprint covers slice files only. A write outside them after the checkpoint does not block the transfer. `engine.md` states this limit. | Checkpoint, write `other.txt`, transfer: it succeeds |

No finding loses completed work. `transfer` changes no files. No finding invents a usage number.

## Not checked
- A live usage source. None exists: the engine reads only the snapshot the lead writes. Every number in tests and in my runs is a fixture.
- Real provider limits on Codex, Cursor, or Claude, and real T3 task ids, `task_cancel`, or `delegate_task`.
- Whether a real Claude lead writes correct snapshots and `reached` marks (SKILL.md USAGE mode). That is behavior of the agent, not of the engine.
- Two `ae` processes at once (the journal lock). I did not test concurrent runs.
- `--caps` filtering against a real capability list. I ran only with `--host other` and no caps.
- The installed copy in the home folder. I reviewed the repo source only.

## Limits of this review
- One reviewer, one session, Claude Opus. I read `usage.ts`, the four engine commands in `ae.ts`, the usage section of `references/engine.md`, SKILL.md USAGE mode, and `tests/ae-usage.test.ts`. I did not read every line of `journal.ts` or `guard.ts`.
- The usage code in this worktree matches the copy that the earlier rounds reviewed. `ae.ts` and `journal.ts` here also hold later, unrelated commands (`report`, `charter`).
- The verdict rests on my judgment for F1. A non-JSON file is not a snapshot, the echo is at most about 20 characters, and nothing is stored. Under a strict reading of NOT-2, any unredacted echo is a reject. If the user takes that reading, the verdict becomes reject, and a one-line fix (redact the parse error) resolves it.
