# Global platform installation

Every installed copy starts with the plain-text line `Harness release VERSION.`, then an HTML comment with the version and digest. Claude Code hides HTML comments, so an agent reads its release from the plain-text line. The rules scanner matches the comment, so keep both lines. Release folders 1.4.1 and earlier contain only the comment. `install` writes both lines for any release, including a rollback. Cursor is the exception: you paste the release file by hand (see [Cursor](#cursor)).

## Codex

Run `npm run harness -- install codex`. The installer uses `CODEX_HOME` when set, otherwise `~/.codex`. It preserves unrelated text in `AGENTS.md`, adds a managed core policy block, and registers the read-only MCP server in `config.toml` using an absolute executable and script path. The installer prefers a `node` on `PATH` that points at the running binary, so a Homebrew upgrade does not break the entry.

Run `verify codex`. If `AGENTS.override.md` exists globally, reconcile it before declaring coverage. Start a new task in an empty directory and ask it to identify the harness version and describe its first coding slice. A matching file hash alone does not prove a running model loaded it. Remote Codex environments and other machines need their own installation.

## Claude Code

Run `npm run harness -- install claude`. The installer uses `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. It preserves unrelated text in the user-level `CLAUDE.md` and adds the same managed core policy block used by Codex. `verify claude` and `uninstall claude` work the same way as Codex.

The installer does not edit `~/.claude.json`; Claude Code rewrites that file continuously. Register the read-only MCP server once with the Claude CLI instead:

Run this from the root of your harness clone:

```bash
claude mcp add --scope user agentic_harness -- "$(which node)" --experimental-strip-types "$PWD/src/mcp.ts"
claude mcp list   # expect: agentic_harness ... Connected
```

Remove it with `claude mcp remove --scope user agentic_harness`. Project-level `CLAUDE.md` files load alongside the user file and can contradict it; reconcile conflicts before declaring coverage. Start a fresh `claude` session in an empty directory and run the acceptance exercise.

## Cursor

Cursor keeps the policy in one place: the User Rules of your Cursor account. The harness writes no rule file for the policy.

Why one place:

- Cursor's IDE and CLI load User Rules and the `.mdc` files in `~/.cursor/rules/`. With a policy rule file, the policy loaded twice in every chat.
- Cursor cloud agents get only User Rules.
- After a release, the two copies differed until you pasted the new text.

### Install

Run `npm run harness -- install cursor-files`. It registers the read-only MCP server in `~/.cursor/mcp.json`.

- It keeps unrelated MCP entries and saves the previous file in `.state/backups/cursor-files/`.
- It stops if an existing `agentic_harness` entry points at a different harness.
- It writes nothing in `~/.cursor/rules/`.

`verify cursor-files` and `status` compare the MCP entry with the receipt. `uninstall cursor-files` restores the previous `mcp.json`. Enable the `agentic_harness` MCP server if Cursor asks.

### Required manual step: User Rules

No tool can read or write Cursor User Rules. Do these steps once. Do them again after every change of the active release (`publish`, `activate`, or `rollback`).

1. Open Cursor, then Customize, Rules, User Rules.
2. Open the rule named **Agentic Harness**. Create it if it does not exist.
3. Replace its content with the complete content of `releases/VERSION/cursor/user-rules.md`. Keep the release lines at the top. Keep your other user rules, and resolve contradictions with them.
4. Open a fresh Agent chat in an empty or unrelated folder. Ask for the harness release. Expect the new version.
5. Run `npm run harness -- confirm cursor-user-rules`.

`confirm cursor-user-rules` records the version and digest of the active release, with a timestamp, in `.state/manual-steps.json`. Add `--version VERSION` to record a different release. That release must exist and pass the integrity check.

The harness reminds you:

- `status` prints `manualSteps` with one entry, `cursor-user-rules`. The entry holds `needed`, `confirmedVersion`, `activeVersion`, and `instruction`.
- `needed` is `true` when nothing is confirmed. It is also `true` when the confirmed version or digest differs from the active release.
- `publish`, `activate`, `rollback`, and `install cursor-files` print the same entry while `needed` is `true`.

Limits:

- The record is your statement. It does not prove that Cursor holds the text or that a chat loaded it. A fresh Cursor chat is the only proof.
- The `user-rules.md` file in release folders 1.4.1 and earlier starts with the comment line only. Paste it as it is.
- Rules do not universally cover Tab or Inline Edit.

### The rule file from earlier installs

Earlier versions of `install cursor-files` wrote the policy to `~/.cursor/rules/pragmatic-engineer.mdc`. That file is retired. The next `install cursor-files` handles it:

| State of the file | What the installer does |
|---|---|
| The last receipt lists it, and it is unchanged | Saves a copy as `.state/backups/cursor-files/<install time>/pragmatic-engineer.mdc`, removes the file, and prints both paths under `retired` |
| The last receipt lists it, and it changed or is a symlink | Leaves it in place and prints a warning. Cursor loads the policy twice until you remove the file by hand |
| No receipt lists it | Does not touch it |

- The warning appears on that one run only. The new receipt no longer lists the file.
- The installer never touches another file in `~/.cursor/rules/`.
- `uninstall cursor-files` after the upgrade restores `mcp.json` only. It does not bring the rule file back.
- A receipt from before the upgrade lists both files. `uninstall cursor-files` with that receipt still restores both.
- `rules scan` lists a retired file that is still on disk as a harness rule and never proposes a change to it.

The release folder still holds `cursor/agentic-harness.mdc`. It is an optional project-format export. No command installs it.

## Cursor's Grok Bot

Grok Bot runs on a separate cloud computer. Mac file installation alone cannot configure it.

1. On its computer, clone your harness repository into a stable directory, install Node 24+, run `npm ci`, and activate the approved version.
2. Read `releases/VERSION/grok-bot/README.md` and install the generated `SKILL.md` through the supported skill mechanism.
3. For **each existing Bot**, open its profile and append the complete `bot-description.md` policy, preserving its role description. Record the version. If a description length limit prevents the full policy, report the limitation; do not silently truncate it.
4. Configure reference retrieval on that computer. The CLI supports local reference search without cloud credentials; semantic retrieval needs its restricted environment configuration.
5. Start a fresh task and run the acceptance exercise. The skill's existence alone does not prove it was invoked.

Create a reusable Bot template with the policy already included. Every new Bot must use it or receive equivalent setup before onboarding is complete. The harness asks parent agents to propagate instructions to new/delegated agents; this must still be tested per platform.

## Repo scope for cloud agents

A cloud agent sees only a clone of the project repository. It does not see your home folder. `repo install` puts the policy into the project itself.

```bash
npm run harness -- repo install PATH --dry-run   # print the planned writes; change nothing
npm run harness -- repo install PATH             # write the block and the receipt
npm run harness -- repo install PATH --pointer   # write a short pointer block and the policy file
npm run harness -- repo verify PATH              # compare each block with the receipt
npm run harness -- repo uninstall PATH           # remove only the Harness block
```

`PATH` is the root folder of the project. It must exist.

What it writes:

- `AGENTS.md` at the root of `PATH`. It gets the same managed block that the user-scope install writes, between `<!-- BEGIN AGENTIC HARNESS -->` and `<!-- END AGENTIC HARNESS -->`. A missing file is created. Cursor reads the root `AGENTS.md`, so no `.mdc` file is written.
- `CLAUDE.md` at the root of `PATH`. What the command writes there depends on the file. See [Single instruction file](#single-instruction-file).
- `.agentic-harness/manifest.json`, the receipt. It holds the release version and digest, the install time, and per file the path, the block hash, whether the install created the file, and the separator bytes added around the block. It holds `claudeViaImport: true` in the single-file layout. It holds relative paths only. Commit it with the instruction files.
- A safety copy of each existing file that the run changes or deletes, in `.state/backups/repo/<timestamp>/` in the harness root. The receipt does not reference it.

### Single instruction file

The block lives in one file when that is possible. `CLAUDE.md` then holds the line `@AGENTS.md`, and Claude Code imports `AGENTS.md` through it. Cursor reads both files, so one block means that it loads the policy once.

"`CLAUDE.md` imports `AGENTS.md`" means that `CLAUDE.md` is a regular file and one of its lines, without the spaces around it, is exactly `@AGENTS.md`. A sentence that mentions `@AGENTS.md` is not an import. Every `repo install` decides from the current files:

| `CLAUDE.md` | What `repo install` writes |
|---|---|
| Missing | The block in `AGENTS.md` only. It creates `CLAUDE.md` with the one line `@AGENTS.md` (the stub). |
| Imports `AGENTS.md` | The block in `AGENTS.md` only. It does not write `CLAUDE.md`. |
| Exists without the import | The block in both files (the two-file layout). It never adds the import line to your file. |

Rules:

- **The stub:** the stub is a shared convention file. The receipt does not list it as an owned file. DesignOS uses the same stub and the same rules.
- **Convert a two-file install:** add the line `@AGENTS.md` to `CLAUDE.md`, then run `repo install PATH` again. The command removes its block and the recorded separator bytes from `CLAUDE.md` and keeps the rest of the file byte for byte. It refuses if that block differs from the receipt.
- **Lost import:** if `CLAUDE.md` loses the import line, the next `repo install PATH` goes back to the two-file layout and puts the block in `CLAUDE.md`.
- **Unowned block:** if `CLAUDE.md` imports `AGENTS.md` and holds a Harness block with no receipt, the install stops, with or without `--adopt`. Remove that block by hand.
- **Verify:** in the single-file layout, `repo verify PATH` prints `claudeViaImport: true` and `claudeImport`. `CLAUDE.md` must be missing, or be a regular file that imports `AGENTS.md`. If not, `claudeImport.problem` says that Claude Code no longer receives the block, and `configurationVerified` is false.
- **Uninstall:** `repo uninstall PATH` deletes `CLAUDE.md` only when the receipt holds `claudeViaImport: true`, the file is exactly the stub, and no `AGENTS.md` is left after the uninstall. Otherwise the file stays, because another tool can rely on it.
- **Dry run:** `--dry-run` lists the stub creation, the stub deletion, and the block removal from `CLAUDE.md`.
- **Symlinks:** a symlink layout is not a single-file layout. See the Symlinks rule below.
- **Limit:** loading through the import is untested in fresh sessions. The cloud and local evidence in this file is for a block in `CLAUDE.md` itself. Rerun the fresh-session check before you rely on the import.

Rules:

- **Pointer mode:** see [Pointer mode](#pointer-mode). Full mode is the default.
- **Dry run:** `--dry-run` works for `repo install` and `repo uninstall`. It prints the writes and deletes and changes nothing.
- **Checks first:** every check runs before the first write. A refusal changes nothing.
- **Verify:** `repo verify PATH` reads only the receipt and the target files. It works in a clone with no `releases/` folder. It prints `matches` per file, `release`, `configurationVerified`, and `behaviorVerified: false`. The exit code is non-zero when a block does not match.
- **Upgrade:** after a new release, run `repo install PATH` again. It replaces the block in place and updates the receipt. `--version VERSION` selects a release other than the active one.
- **Text outside the block:** your own text is preserved byte for byte. You can edit it at any time.
- **DesignOS:** a DesignOS block (`<!-- BEGIN UMA DESIGN OS -->`) in the same file is preserved, before or after the Harness block, whichever tool ran first.
- **Edited block:** if the Harness block differs from the receipt, `repo install` and `repo uninstall` refuse. Restore the block. Or delete `.agentic-harness/manifest.json` and run `repo install PATH --adopt`.
- **`--adopt`:** a Harness block with no receipt, for example a hand copy, stops the install. `--adopt` replaces that block and owns it from then on. Malformed or duplicate markers always stop the install.
- **Symlinks:** if `AGENTS.md` is a symlink to `CLAUDE.md` in the same folder, or the reverse, the command writes the real file once and records the other as an alias. Any other symlink stops the command.
- **Uninstall:** `repo uninstall PATH` removes the block and the recorded separator bytes. It never restores a whole file. It deletes a file only when the install created it and only whitespace remains. The stub has its own rule in [Single instruction file](#single-instruction-file). Then it removes the receipt.

### Pointer mode

`repo install PATH --pointer` is an opt-in mode. Full mode stays the default.

What it writes:

- `.agentic-harness/policy.md`: the full policy text, the same text that full mode puts inside the block. Commit it with the receipt.
- A short block between the same markers, in `AGENTS.md` only or in both files as [Single instruction file](#single-instruction-file) describes. It holds the two release lines and one sentence that tells the agent to read `.agentic-harness/policy.md` if the policy is not already in its instructions.
- The receipt, with `mode: "pointer"` and `policy: {path, hash}`. A receipt without `mode` is a full-mode receipt.

Rules:

- **Switch modes:** run `repo install PATH --pointer` on a full-mode install to switch to pointer mode. Run `repo install PATH` without `--pointer` to switch back; that removes the policy file. Each run sets the mode, so add `--pointer` to every upgrade of a pointer-mode repo.
- **Verify:** `repo verify PATH` also prints `mode` and `policy.matches`. The policy file must exist, be a regular file, and match the hash in the receipt.
- **Edited policy file:** if `.agentic-harness/policy.md` differs from the receipt or is missing, `repo install` and `repo uninstall` refuse and change nothing. Restore the file. Or delete it and `.agentic-harness/manifest.json`, then run `repo install PATH --adopt`.
- **Existing file:** if `.agentic-harness/policy.md` exists and the receipt does not own it, `repo install PATH --pointer` refuses and changes nothing.
- **Dry run and safety copy:** `--dry-run` lists the policy file among the writes or deletes. The safety copy in the harness root includes the policy file when one existed.
- **Uninstall:** `repo uninstall PATH` also removes the policy file, then the receipt, then the folder if it is empty.

Trade-off:

- Full mode puts the policy in the instruction file. The agent loads it without any action.
- Pointer mode saves start context in a local session, which already has the policy at user scope. Measured first-call cost of the full block in such a session: +1,279 tokens on Claude Code and +860 on Codex.
- In pointer mode, an agent with no user-scope policy, for example a cloud agent, must choose to read the file. That is not guaranteed. It is untested on every cloud runtime.

Limits:

- Cloud loading is untested on Claude Code cloud, Codex cloud, and Cursor cloud agents. A matching block does not prove that a cloud session loaded it.
- Loading through the `@AGENTS.md` import is untested in fresh sessions until the fresh-session check is rerun.
- If the two installers leave in a different order than they arrived, the last one to leave tidies up. When Harness installs first and uninstalls first, the DesignOS uninstall deletes the `AGENTS.md` it empties and the stub, because the layout is installer-made (`claude_via_import`, an exact stub, nothing else in `AGENTS.md`). A user-written empty `AGENTS.md` next to such a stub goes too. Anything else in `AGENTS.md` keeps both files.
- A local session in a full-mode repo loads the policy from user scope and from repo scope. Pointer mode removes most of that duplicate cost.
- This command does not install the MCP server or the on-demand skills that the policy names. A cloud agent has neither unless the project provides them.
- Files are read and written as UTF-8. A file with invalid UTF-8 stops the command.

## Custom and future agents

Run `install generic` to write `~/.config/agentic-harness/instructions.md`, or load the complete generic instructions from a release. Insert them through the agent's persistent instruction mechanism before task input. Custom launchers must refuse to start if the release is absent or fails integrity checks. Pass the same version to delegated tasks and retrieval. A new platform integration must document its loading mechanism, precedence, installation, preservation of existing settings, verification, rollback, and unsupported features.

Keep an inventory of platform/account/machine, release, installed location, configuration verification, and fresh-session behavioral verification. Do not treat a new account or application as configured by inheritance from a different app.

## Global rules beyond the harness policy

Each agent also loads other global rules that you or a plugin added:

- **Cursor:** `.mdc` files in `~/.cursor/rules/` and rules shipped by plugins. Cursor User Rules in the settings UI are separate.
- **Claude Code:** the user-level `CLAUDE.md`, and every `*.md` file in `~/.claude/rules/`. These load in every session. A rule with `paths:` front matter loads only for matching files.
- **Codex:** the user-level `AGENTS.md`. It has no rules folder and no path scoping.

These copies drift apart when you edit one agent's copy by hand. Run `rules scan` to scan these locations and show the drift. Run `rules preview PROPOSAL_ID...` to see the exact changes and their digest, `rules apply PROPOSAL_ID... --approve-sha DIGEST` to apply them with backups, and `rules undo RECEIPT_ID|APPLY_ID` to revert. Run `rules retire RECEIPT_ID --reason TEXT` for a receipt whose rule you removed on purpose. Plugin rules and Cursor's settings UI stay outside their control.

## Lavish review tool

Lavish (`lavish-axi`) opens an agent's HTML file in a local browser. You annotate it, and the agent reads your feedback. The `html-explainer` skill points agents at the CLI, and only when you want to annotate a page. Agents learn current usage from `lavish-axi --help`, `lavish-axi design`, and `lavish-axi playbook [id]`.

Install a pinned version. It needs Node 22 or later.

```bash
npm install -g lavish-axi@0.1.82
lavish-axi --version
```

Lavish sends anonymous telemetry by default. To turn it off, add `export LAVISH_AXI_TELEMETRY=0` to your shell profile.

Verify the review loop:

1. Write a small HTML file at `/tmp/lavish-check/sample.html`.
2. Run `lavish-axi /tmp/lavish-check/sample.html`. It opens or resumes a session in your browser. `--no-open` skips the browser.
3. In the browser, write one message and click **Send to Agent**.
4. Run `lavish-axi poll /tmp/lavish-check/sample.html`. Confirm that your message appears.
5. Run `lavish-axi end /tmp/lavish-check/sample.html`, then `lavish-axi stop`.

To upgrade, choose a new version, install it pinned, and run the verification again. Then update the pinned version in this section. The policy text does not pin a version.

If a session hangs, run `lavish-axi stop`. State lives in `~/.lavish-axi/`, or in `LAVISH_AXI_STATE_DIR` when set. The server log is `~/.lavish-axi/server.log`. The default port is 4387; set `LAVISH_AXI_PORT` to change it. Remove Lavish with `npm uninstall -g lavish-axi`.

`lavish-axi share` uploads the file to ht-ml.app, a third-party host. Shared pages are public by default. The `html-explainer` skill forbids `share` unless the user asks. When Tailscale runs, the server also listens on the tailnet address and serves local files to tailnet devices without authentication. Set `LAVISH_AXI_HOST=127.0.0.1` to keep it on loopback only.

Optional: `lavish-axi setup plugin` links the package as a Cursor plugin at `~/.cursor/plugins/local/lavish-axi`. `lavish-axi setup hooks` adds session hooks for Claude Code, Codex, OpenCode, and Copilot CLI; restart sessions after you run it. Neither step is required, because the `html-explainer` skill already tells agents how to find Lavish.

Grok Bot's cloud computer is not covered. It needs its own install and has no local browser for review. An installed skill does not prove that an agent uses Lavish. Run the fresh-session check in [tests/README.md](../tests/README.md).

## Shared skills and visibility

The live copies of the shared skills are in `~/.agents/skills/`. Claude Code reaches them through symlinks in `~/.claude/skills/`. Codex reads the folder directly.

Three skills stay visible on every platform: `grill-me`, `html-explainer`, and `render-rules`. The engineering policy names them. An agent can load them without being asked.

Every other shared skill loads only when you call it by name. This keeps the start context small and stops two skills from claiming the same request.

Each hidden skill needs two flags:

| Flag | Where | Read by |
|---|---|---|
| `disable-model-invocation: true` | `SKILL.md` front matter | Claude Code and Cursor |
| `policy.allow_implicit_invocation: false` | `agents/openai.yaml` | Codex |

Set both. Codex does not read the `SKILL.md` flag. A Codex session loaded `unslop` on every task while only that flag was set.

An update of a third-party skill can replace its files and remove the flags. After a skill update, run `npm run harness -- context audit`. Compare the visible lists with the three names above.

The sources of the three named skills live in `tools/agents/skills/`. Keep them identical to the live copies.

Not tested: whether Cursor's CLI honors `disable-model-invocation`. Cursor's docs describe the flag. No session was run for it.

## Adapter table

The table lives in `src/platforms.ts` as `PLATFORM_RECORDS`. It holds one record per runtime: `claude-local`, `claude-cloud`, `codex-local`, `codex-cloud`, `cursor-ide`, `cursor-cli`, `cursor-cloud`, and `generic`.

A record holds:

- the platform and the environment (local or cloud);
- instruction targets and skill roots, by user scope and repo scope, each marked documented, observed, or unknown;
- the path-scoped rule mechanism, the MCP registration, and the hooks;
- what must exist on the machine, and the manual steps;
- the version check, the non-interactive probe command, and the evidence (`configured`, `tested`, `behaviorally verified`, or `unknown`, with a date);
- the documentation sources.

The table is data only. No installer reads it yet. A value that the sources do not state is `unknown`.

To add a runtime, add one record to `PLATFORM_RECORDS`. A cloud record has no user-scope instruction target and no local MCP registration. Run `npm test`. `tests/platforms.test.ts` checks every record.

## Sources
- https://cursor.com/docs/rules
- https://developers.openai.com/codex/guides/agents-md/
- https://developers.openai.com/codex/mcp/
- https://docs.anthropic.com/en/docs/claude-code/memory
- https://code.claude.com/docs/en/memory#user-level-rules
- https://docs.anthropic.com/en/docs/claude-code/mcp
- https://cursor.com/docs/grok-bot/work
