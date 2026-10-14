# Operations and maintenance

Run all examples from the root of your harness clone. They work regardless of the location of your application repositories.

### Separate content folder

By default the engine code and your harness content share one folder. To keep content elsewhere, point the engine at a harness root:

```sh
npm run harness -- --root ~/my-harness status
HARNESS_ROOT=~/my-harness npm run harness -- preview
```

`--root DIR` wins over `HARNESS_ROOT`; with neither, the root is the code folder. The root holds `harness.config.json`, `knowledge/`, `releases/`, `.state/`, and `.env.local`/`.env.runtime`. The code folder holds `src/` and `catalog/`. The public pack catalog ships with the code, so it resolves from the code folder unless the root has its own `catalog/` folder, which then takes precedence. `install` writes MCP entries that run the code folder's `src/mcp.ts` with `--root DIR`, so retrieval reads the same root. Verify with `status`: its `root` field shows the folder in use. If a command reports a missing `harness.config.json`, check the root path.

## Commands

| Command after `npm run harness --` | Meaning and expected result |
| --- | --- |
| `help` | Prints supported commands |
| `preview` | Shows the core, document inventory, provenance, and approval digest |
| `import-notion` | Imports all mapped approved pages; fails on incomplete input |
| `import-notion-export FILE` | Imports complete page fetch results from the connected Notion plugin |
| `publish VERSION --approve-sha DIGEST` | Creates an immutable release from exactly the reviewed source. `VERSION` must not exist in `releases/` yet |
| `publish VERSION --approve-sha DIGEST --bootstrap` | A release made from local files, not from a Notion import |
| `activate 1.0.0` | Selects an existing verified release after cloning |
| `install codex` | Backs up and installs global Codex rules and MCP configuration |
| `install claude` | Backs up and installs global Claude Code rules in `~/.claude/CLAUDE.md`; MCP is registered with `claude mcp add` (see platforms) |
| `install cursor-files` | Registers the MCP server in `~/.cursor/mcp.json`. It writes no rule file, and it retires the rule file of an earlier install. The policy itself is a manual paste into Cursor User Rules; see [platforms](platforms.md#cursor) |
| `confirm cursor-user-rules [--version VERSION]` | Records that you pasted the active release (or `VERSION`) into Cursor User Rules. It stores the version, digest, and time in `.state/manual-steps.json`. No tool can read User Rules, so this is your statement, not proof |
| `install generic` | Writes a generic global package for custom-agent use |
| `verify codex` | Checks the harness-owned instructions/settings and global override conflicts; unrelated settings can change |
| `status` | Reports active release, installed configuration, rule receipts, Notion mapping, and pending connections. `manualSteps` holds the Cursor User Rules step: `needed`, `confirmedVersion`, `activeVersion`, and `instruction`. `publish`, `activate`, `rollback`, and `install cursor-files` print the same entry while `needed` is `true` |
| `search 'tracer bullet'` | Searches approved local reference chunks and returns citations |
| `get-document pragmatic` | Reads the released reference document |
| `export-chunks 1.0.0` | Outputs the exact texts and hashes for embedding generation |
| `index 1.0.0 --embeddings FILE` | Atomically uploads the released chunks and supplied embeddings to Supabase |
| `search-vector 1.0.0 MODEL FILE` | Queries pgvector using an authenticated runtime token and supplied query vector |
| `rollback 1.0.0` | Selects a previous release; then reinstall each platform |
| `uninstall codex` | Restores the immediately preceding configuration if no newer user edits exist; refuses while add-on packs are installed |
| `repo install PATH [--version V] [--adopt] [--pointer] [--dry-run]` | Writes the managed policy block into `AGENTS.md` at the root of the project folder `PATH`; `CLAUDE.md` imports it with the line `@AGENTS.md` (an existing `CLAUDE.md` without that line also gets the block), with a relative-path receipt in `PATH/.agentic-harness/manifest.json`. Run it again to upgrade. For cloud agents; see [platforms](platforms.md#repo-scope-for-cloud-agents) |
| `repo verify PATH` | Compares each Harness block in `PATH` with the receipt. Needs no `releases/` folder. Exit code is non-zero on a mismatch |
| `repo bar PATH` | Checks the repo setup bar: CI on push and pull request, secret scan, workflow `permissions`, dependency updates, `SECURITY.md` and `CONTRIBUTING.md`, agent deny rules in `.claude/settings.json`, CODEOWNERS and a pull request template. Files only, no network. Exit code is non-zero when a check fails |
| `repo uninstall PATH [--dry-run]` | Removes only the Harness block and the receipt from `PATH`; refuses when the block was edited. Other text stays |
| `controls list`, `controls install\|verify\|uninstall claude` | Enforced controls from `controls/controls.json`: Claude Code enforces them, not the model. Install adds `permissions.deny` and `permissions.ask` entries to `~/.claude/settings.json`, keeps every other setting, backs up the file, and records only the entries it added in `.state/installations/controls-claude.json`. Verify lists missing rules and a changed source; exit code is non-zero on a mismatch. Uninstall restores the original bytes if the file is unchanged, else removes only the added entries. Bash rules match command prefixes, so they stop plain commands, not a determined bypass |
| `pack add AUTHOR/ID@VERSION --platform claude\|codex\|cursor` | Previews an add-on pack: full text, digest, target. Writes nothing. Add `--approve-sha DIGEST` to install: a marker section in `CLAUDE.md` or `AGENTS.md`, or one `.mdc` file per pack in `~/.cursor/rules/`. See [packs.md](packs.md) |
| `pack remove AUTHOR/ID --platform claude\|codex\|cursor` | Removes one pack section (Claude, Codex) or pack file (Cursor) and its receipt |
| `pack list` | Lists catalog packs and installed packs with verification |
| `catalog build` | Validates `catalog/` and regenerates `catalog/index.json` |
| `rules scan` | Read-only: lists global rules for Cursor (including plugin rules), Claude Code (`CLAUDE.md`, `~/.claude/rules/`), and Codex (`AGENTS.md`), with drift findings and proposed fixes. Writes nothing |
| `rules preview ID...`, `rules apply ID... --approve-sha DIGEST`, `rules undo RECEIPT`, `rules verify`, `rules retire RECEIPT --reason TEXT` | Previews the exact diff and digest for chosen proposals (writes nothing); applies only that digest with backups in `.state/backups/rules/` and per-file receipts in `.state/installations/rules/`, rolling back on failure; undo restores a backup only if the file is unchanged since the write. Retire moves a receipt that no longer verifies (the rule was removed on purpose) to `.state/installations/rules/retired/` with your reason; it refuses a receipt that still verifies, and keeps the backup. To reverse, move the file back. Never touches harness blocks, add-on packs, plugin rules, or symlinks |
| `eval list`, `eval run --platform claude\|codex\|cursor --case ID [--arm plain\|harness] [--keep] [--no-log] [--trials N]`, `eval results [--case ID] [--platform P] [--last N]`, `eval compare A [B] [--platform P]`, `eval mark RUN-ID environment "REASON" [--arm plain\|harness]` | Lists the behavior cases in `evals/cases.jsonl`, or runs one as a fresh headless Claude Code, Codex, or Cursor session in a throwaway git repo. Prints JSON with a pass, fail, or null and evidence per check; exits 1 when the run does not succeed. See "Eval platforms" below. Each run spends tokens. Each run also appends one validated row to `evals/results/YYYY-MM.jsonl` (UTC month) under the root, and the printed JSON shows `logged: PATH`. The row adds `schemaVersion`, `startedAt`, `cliVersion`, and a null `transcriptPath`; unknown values stay null. Rows hold no prompt output or transcript. `--no-log` skips the append (`logged: null`). `eval results` reads every results file, skips and counts bad lines, and prints `{rows, skippedLines}` with the last N matching rows (default 20, newest last). Each row lists `failedChecks` and `notObservedChecks`. `--trials N` (a whole number from 1 to 10, default 1) runs the case N times in a row, each in a fresh scratch repo, and logs one row per run. For N above 1 the output is `{case, platform, trials, passes, runs}`, and the exit code is 1 when any run fails. Each row also holds `caseDigest`: 12 hex characters of a hash of the case, its fixture files, and the held-out scripts it names. `eval compare A B` reads the log and prints, per case and platform, `runs`, `passes`, `nullRuns` (runs with a null check), `medianCostUsd`, `medianDurationMs`, and a `verdict` (`better`, `worse`, `same`, or `no-data`) for B against A. The verdict uses pass rates only. There is no total score. A `worse` row comes first. A and B are harness versions, for example `1.4.2` and `1.5.0`. A side can end in `@ARM`, for example `1.4.3@plain` or `1.4.3+60ac9e6aa905@harness`. Without `@ARM` a side counts only `harness` rows, and a row with no `arm` counts as `harness`. Each side lists the `arm` it counted. Two sides that differ only by arm are valid: `eval compare 1.4.3@plain 1.4.3`. A row counts only when its `caseDigest` equals the case's current digest. Other rows are left out and shown as `staleRows`. Rows with `errorCategory` `unsupported` or `runner-error` are left out as `notRunRows`. Each row has a `skillsDigest` of the installed harness skills; a side can be `VERSION+DIGEST` or `VERSION+none` to count only those rows, and each side lists its `skillsDigests`. With one version, it prints the same table without a verdict. It always exits 0. `eval mark RUN-ID environment "REASON"` marks a run that failed for the machine, for example a laptop that slept. `RUN-ID` is the `startedAt` of the run's row (see `eval results`). Two runs started together on two arms share a `startedAt`; then `--arm` picks one, and without it the command fails. Any run can be marked, and the reason is required. The command appends one mark row (`kind` `mark`, `runId`, `arm`, `mark`, `reason`, `markedAt`) to the log file that holds the run, and prints it with `logged: PATH`. It never edits an existing row. An unknown run id, a missing reason, or a mark other than `environment` exits with an error and writes nothing. `eval compare` leaves a marked run out of its side and counts it in `markedRows`. It also prints `leftOut`: one line per side, `SIDE: N left out (environment mark)`. Rows written before marks existed still read as before |
| `context audit [--save] [--claude-context FILE]` | Read-only: lists what Claude Code, Codex, and Cursor load at session start: instruction files, the skill list by source (name + description chars, with `estimatedTokens` = chars / 4), and MCP server names (never their args or env). Skills count only when always on or enabled in config; `enablement: unknown` and disabled sources are reported apart. Adds `measured` numbers from the newest Codex session log with a `token_count` event, and from a saved `claude -p "/context" > FILE` when you pass `--claude-context FILE`. Cursor User Rules and plugin enablement are reported as `unknown`. `--save` writes `.state/context-baseline/YYYY-MM-DD.json` (same day overwrites); otherwise nothing is written |

### Eval platforms

The same cases, scratch repo, checks, and row format apply to every platform. A value that a platform does not report is null.

| Platform | Command the runner starts | Reported | Not reported (null) | Tool checks |
|---|---|---|---|---|
| `claude` | `claude -p PROMPT --allowedTools LIST --max-turns N --output-format stream-json --verbose` | model, turns, duration, tokens, cost | none | answered |
| `codex` | `codex exec --json -s read-only PROMPT`; `-s workspace-write` only for a case with `needsWrite: true` | input and output tokens | model, turns, duration, cost | answered only when a matching call is in the output |
| `cursor` | `cursor-agent -p --output-format stream-json --mode ask --trust PROMPT` | model name, duration, input and output tokens | turns, cost | answered only when a matching call is in the output |

- `--arm plain|harness` (default `harness`) sets the arm of a run. `plain` adds `--safe-mode` to every Claude turn. The CLI help describes it as a start without CLAUDE.md, skills, plugins, hooks, and MCP servers. The row holds the `arm`, and `eval results` shows it. Any other value is an error.
- A case can set three optional fields. `followUp` is a second user message in the same session: the runner starts turn 1 with `--session-id UUID`, then turn 2 with `-p FOLLOWUP --resume UUID`. Tool uses, turns, cost, duration, and tokens of both turns are added (null if either is null); the result is the text of the last turn. `timeoutMinutes` replaces the 240 s limit for each turn. `maxBudgetUsd` adds `--max-budget-usd N` to each turn. A turn that times out gives a `timeout` row and no further turn. Cases without these fields keep their digest.
- Claude only: `followUp`, `maxBudgetUsd`, and `--arm plain`. Codex and Cursor report `unsupported` for a case with `followUp` and for the plain arm, and start nothing.
- A case can name a `fixture`, the files of its scratch repo. The default is `basic` (`sum.js`, `NOTES.md`). The others are `tracker-empty`, `feeds`, `feeds-broken-save`, `feeds-failing-test`, `feeds-bad-test`, `feeds-plan`, `timer-contract`, `feeds-vacuous-contract`, `feeds-infra-contract`, `feeds-observability-contract`, `tracker-product` (an empty repo whose README fixes the core module `tracker.js`), and `tracker-vague` (the same repo, but the README gives only the function names and says some rules are open). The four before `tracker-product` hold a contract file in `plans/`. They live in `src/evals.ts`, not in the cases file. Every fixture also holds the `.env` probe file and a `.gitignore`.
- Check type `heldOut` (`{"type": "heldOut", "name": NAME}`) runs a script that lives in `src/evals.ts`. The runner writes it next to the scratch repo, not in it, and runs it with `node` after the session, in the scratch repo, with a 10 s limit. It passes on exit code 0. The agent never sees the script. A held-out check needs no tool output, so it is true or false on every platform. Names: `save-survives-reload`, `bottle-total`, `list-newest-first`, `readme-behavior`, `original-tests-pass`, `timer-sum-property` (2000 seeded sessions, checks that left plus right equals the total), `eval-fails-without-code` (the tests must pass on the repo code and fail when `feeds.js` has no `bottleTotal`), `infra-rows-have-files` (a new migration holds the note, and every Infrastructure row of the contract names a file that exists, the new migration included), `error-is-recorded` (a file that is not valid JSON gives an empty list and a line in `errors.log`; a valid file gives its feeds); for `product-build`: `tracker-sides` (left 60 s then right 30 s), `tracker-start-stop` (a pause is not counted), `tracker-correction` (a corrected `startedAt` changes the order), `tracker-bottle` (type `bottle`, `ml` 120), and `tracker-history` (three mixed feeds, newest first, different ids). `product-build` is a two-turn, Claude-only case: it sets `followUp`. `product-vague` is the same kind of case with the vague README. Turn 2 states three rules: starting one side pauses the other, `deleteFeed(tracker, babyId, id)`, and `addBaby(tracker, name)` with `babyId` as the second argument of every feed function. Eight checks use those signatures: `vague-sides`, `vague-start-stop`, `vague-correction`, `vague-bottle`, `vague-history` (the same behavior as the five `tracker-*` checks), `vague-overlap` (left 60 s, then right starts and runs 30 s: left 60000, right 30000), `vague-delete` (the deleted feed is gone, the other two stay in order), and `vague-babies` (each baby sees only its own feed).
- Check type `changedFilesMatch` (`{"type": "changedFilesMatch", "patterns": [...]}`) passes when every changed file, new files included, matches a pattern. A pattern is an exact path, a folder that ends in `/`, or an extension that starts with `*.`. `onlyFilesChanged` now also lists each new file inside a new folder, not just the folder.
- Check type `resultIncludesAny` (`{"type": "resultIncludesAny", "values": [...]}`) passes when the result holds one or more of the values, in any letter case.
- A check result has `pass: true`, `pass: false`, or `pass: null`. Null means the platform output cannot answer the check. The evidence starts with "not observable on PLATFORM".
- A run succeeds when at least one check has an answer and no check failed. A run where every check is null does not succeed.
- Tool checks are `toolCalled`, `toolNotCalled`, `toolInputExcludes`, and `toolErrorIncludes`.
- Codex: the output can leave out a command that the sandbox blocked. So "no matching call" proves nothing, and the check is null. A matching call is real, and the check is answered.
- Codex tool names are mapped: a shell command counts as `Bash`, and an MCP call counts as `mcp__SERVER__TOOL`. Codex has no allowed-tools list and no turn limit, so `allowedTools` and `maxTurns` do not apply.
- Codex: `codex exec` refuses MCP tool calls ("requires approval, but approval policy is never"). The `reference` case cannot reach the harness MCP server this way.
- Codex token counts include cached input. Claude token counts do not. Do not compare them directly.
- Cursor trust rule: `cursor-agent` refuses to start in a new folder without workspace trust, so the runner passes `--trust`. The runner trusts only the scratch folder that it created for that run, and it runs Cursor read-only (`--mode ask`). It never passes `--force`, `-f`, `--yolo`, or a flag that approves commands or edits. Do not add `--trust` for a real project folder.
- Cursor keeps files for each run under `~/.cursor`: a `.workspace-trusted` marker, a transcript, and a chat store for the scratch path. The runner removes the scratch folder. It does not remove these files.
- Cursor: in 2 of 2 real runs the output held every call that the answer reported, with a rejected MCP call and a failed command among them. A write call that ask mode refuses was not seen: the model made no such call. So "no matching call" gives null, as for Codex.
- Cursor tool names are mapped: a shell command counts as `Bash`, an MCP call counts as `mcp__SERVER__TOOL`, a file read counts as `Read`, and a file search counts as `Glob`. Every other tool keeps its Cursor name. The runner passes no allowed-tools list and no turn limit to Cursor, so `allowedTools` and `maxTurns` do not apply.
- Cursor: in ask mode a shell command that only reads still runs (seen: `ls`, `git status`). An MCP tool call is rejected ("User rejected MCP"). The `reference` case cannot reach the harness MCP server this way.
- Cursor reports the model as the name "Auto", not a model id. Cursor token counts do not include cached input, as for Claude.
- `needsWrite: true` in a case means the task must change files. Cursor has no safe write mode in this runner, so such a case gives `errorCategory: "unsupported"`, starts no agent, and is still logged.
- `errorDetail` is a short reason written by the runner. It never holds agent output.

## Publishing workflow

1. Edit Notion, import, and inspect the Git diff. During initial bootstrap only, edit local source.
2. Run tests and preview. Review the complete changed documents, not only their character counts.
3. Copy the preview digest into `publish VERSION --approve-sha DIGEST`. A source change invalidates the digest.
4. Commit and push only as authorized. The publish command itself creates local release files; it does not claim GitHub or Supabase has been updated.
5. Update the matching Supabase release when configured, then install the release in each environment. Explicitly record failures; other installations may still be on an older release. For Cursor, paste the new `releases/VERSION/cursor/user-rules.md` into User Rules, then run `confirm cursor-user-rules`.
6. Restart the retrieval server and open fresh agent sessions. Existing tasks retain old context.

Releases are immutable. Use a new version for changed content. If publication fails before activation, the prior active release remains selected. A rerun of an identical already-published version is safe; use `activate` if you want to select it again.

## Backups and restoration

`.state/backups/` contains private before-install copies. `.state/installations/` contains per-platform receipts. These are not committed or published. Uninstall restores the immediately previous state and refuses to overwrite changes made since installation. A second installation's backup is the state immediately before that second installation, not the original pre-harness state. Older backups remain available for manual recovery. Receipts store backup paths relative to the harness root, so uninstall keeps working after the harness folder moves. Receipts from older versions store absolute paths; if such a path is gone, uninstall looks for the same file under the current `.state/backups/`. If no backup is found, uninstall names the missing file and changes nothing.

`rollback VERSION` changes only this installation's active release. Run `install codex`, update Cursor User Rules and run `confirm cursor-user-rules`, and update Grok Bot profiles to distribute the rollback. The pinned MCP server must restart. Supabase search uses the requested immutable release ID rather than a mutable global latest pointer.

## Failures

- **No active release:** run `activate VERSION` using a release present in `releases/`. In a fresh clone with no releases, run `preview`, then `publish NEW_VERSION --approve-sha DIGEST --bootstrap`.
- **Notion pages not mapped:** the import commands refuse to run until every page ID in `harness.config.json` is set. See [notion.md](notion.md). Local file authoring works without them.
- **Source changed:** preview and review again; never reuse an old approval digest.
- **Integrity failure:** do not edit release files. Restore the committed release from Git.
- **Configuration changed:** preserve the user's changes, compare with the backup, and reconcile before retrying.
- **Unsupported application:** install instructions through its supported global mechanism and run fresh-session tests. Do not mark it covered based on a file existing nearby.
- **Missing credentials:** configure the relevant local ignored environment file; never paste keys into chat.

## Limits

Instructions guide models but cannot guarantee behavior. Platform policies retain their own precedence. Cursor Tab/Inline Edit may not consume global Agent User Rules. Third-party applications, new accounts, remote machines, and newly created Bots require onboarding and verification. This tool does not silently alter unknown applications.
