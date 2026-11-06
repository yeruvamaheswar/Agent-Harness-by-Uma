# Agentic Harness

One rulebook for your AI coding agents. You edit one policy, publish it as a versioned release, and install it into Codex, Claude Code, Cursor, and other agents.

Interactive explainer: [the whole project in nine figures](https://yeruvamaheswar.github.io/Agent-Harness-by-Uma/project-explainer.html). Its source is `docs/project-explainer.html`.

How the assistants use this repo, in plain words: [plans/system-design.md](plans/system-design.md).

## What it does

- `knowledge/core.md` is the policy. `knowledge/references/` holds supporting documents. `harness.config.json` lists them.
- `publish` freezes the policy into `releases/<version>/` with a SHA-256 digest. Releases never change.
- `install` writes the policy into each agent's global instruction file. It backs up the old file first and records a receipt in `.state/`.
- `repo install PATH` writes the policy block into a project's `AGENTS.md` for cloud agents, and `CLAUDE.md` imports it with the line `@AGENTS.md`. See [Repo scope for cloud agents](docs/platforms.md#repo-scope-for-cloud-agents).
- `controls install claude` writes enforced deny and ask rules from `controls/controls.json` into Claude Code settings, so the platform blocks force-push, secret reads, and edits to its own controls, and asks you before a push to `main`, a `--force-with-lease` push, or a production deploy.
- `skills install NAME` installs a harness skill from `tools/agents/skills/` for Claude Code, Codex, and Cursor, with a backup and a receipt. `--repo PATH` puts it inside a project for cloud agents.
- The `multi-agent-planning` skill turns a request into small verified slices, each routed to an agent, model, and effort. See [docs/multi-agent-planning.md](docs/multi-agent-planning.md).
- The `subagent-budget` skill caps a fan-out at 3 children. Fact-finding uses Sonnet or Haiku at medium effort. High effort needs you to name that one task. See [docs/subagent-budget.md](docs/subagent-budget.md).
- The `make-it-verifiable` skill plans how to prove a change works before any code. It waits for your "go", reports each check as pass, fail, or unknown with evidence, and ends with a prompt for a second reviewer. Type `/make-it-verifiable <change>`. It does not load by itself.
- A read-only MCP server lets agents search the reference documents.
- `rules scan`, `rules preview`, `rules apply`, and `rules undo` scan the other global rules in Cursor, Claude Code, and Codex. They find drift between agents and apply only the changes you approve, with backups and undo.

The repository is the harness. Your application repositories can live anywhere.

## Get started

Prerequisites: Node.js 24 or later, npm, and Git. Notion, Supabase, and embedding credentials are optional, only for those features.

1. Clone and install.

   ```sh
   git clone https://github.com/yeruvamaheswar/Agent-Harness-by-Uma.git
   cd Agent-Harness-by-Uma
   npm ci
   npm test
   npm run typecheck
   ```

2. Optional: connect Notion. To author in Notion, put your own page IDs in `harness.config.json`. See [docs/notion.md](docs/notion.md). The shipped `harness.config.json` holds the repo owner's Notion page IDs. You do not need them. Replace them with your own IDs, or with `null` to author in local files only.

3. Choose one path. `preview` prints a digest. You approve that exact digest.

   Path A: use the rules as shipped. Release `1.5.3` is already in `releases/`.

   ```sh
   npm run harness -- activate 1.5.3
   ```

   Expect `"active": "1.5.3"`.

   Path B: publish your own rules. Edit `knowledge/core.md` and the files in `knowledge/references/` to match your own engineering rules. The shipped text is a working example. Then choose a version number that is not in `releases/`, such as `2.0.0`.

   ```sh
   npm run harness -- preview
   npm run harness -- publish 2.0.0 --approve-sha <digest> --bootstrap
   ```

   `--bootstrap` is required for every release that does not come from a Notion import. Without Notion, run `preview`, then `publish VERSION --approve-sha DIGEST --bootstrap`. The CLI refuses a version that already exists, because releases never change.

4. Install it for each agent you use.

   ```sh
   npm run harness -- install codex
   npm run harness -- install claude
   npm run harness -- install cursor-files
   npm run harness -- install generic
   ```

   Cursor and Claude Code need one more manual step each. See [docs/platforms.md](docs/platforms.md).

5. Verify.

   ```sh
   npm run harness -- status
   ```

   Each installation shows `configurationVerified: true` when the installed text matches its receipt. Then start a fresh session in each agent and run the checks in [tests/README.md](tests/README.md). A matching file does not prove that the agent follows it.

6. Commit `knowledge/`, `harness.config.json`, and `releases/` to your own repository. The harness never commits or pushes for you.

## Daily use

Edit the policy files, run `preview`, review the digest, then run `publish VERSION --approve-sha DIGEST --bootstrap` (or import Notion first and omit `--bootstrap`). Then run `install` for each agent.

Use the CLI from any folder:

```sh
node --experimental-strip-types "<path-to-clone>/src/cli.ts" status
node --experimental-strip-types "<path-to-clone>/src/cli.ts" search 'tracer bullet'
```

## Documentation map

| Guide | What it covers |
| --- | --- |
| [Project explainer](https://yeruvamaheswar.github.io/Agent-Harness-by-Uma/project-explainer.html) | The whole project in nine figures. Source: `docs/project-explainer.html` |
| [Instructions](knowledge/README.md) | Policy meaning, scope, editing, references |
| [Global rules](docs/platforms.md#global-rules-beyond-the-harness-policy) | Scanning other global rules, drift findings, preview, apply, undo |
| [Operations](docs/README.md) | Commands, versions, backups, recovery, limits |
| [Platforms](docs/platforms.md) | Codex, Claude Code, Cursor, Grok Bot, custom agents |
| [Multi-Agent Planning](docs/multi-agent-planning.md) | The multi-agent slice planner skill: invocation, routing, states, install |
| [Subagent budget](docs/subagent-budget.md) | The fan-out cap: count, model, effort, and install |
| [Lavish review tool](docs/platforms.md#lavish-review-tool) | Visual review install, telemetry, verification, upgrade, recovery, limits |
| [Add-on packs](docs/packs.md) | Category rule packs, catalog format, add/remove/list, trust model, limits |
| [Notion](docs/notion.md) | Bringing your own page IDs, imports |
| [Retrieval](docs/retrieval.md) | MCP, local search, Supabase, credentials |
| [Implementation](src/README.md) | Code responsibilities and development |
| [Tests](tests/README.md) | Automated checks and fresh-session acceptance |
| [Database](supabase/README.md) | Optional Supabase schema, deployment, rollback |
| [GitHub](.github/README.md) | CI checks |

Every release folder includes its own README. Change installed instructions by publishing and installing a release. Do not edit installed copies or release files.

## What "global" means

Codex reads `AGENTS.md` in its configuration home. Claude Code reads the user-level `~/.claude/CLAUDE.md`. Cursor uses global User Rules; an `.mdc` file alone does not give global coverage. Grok Bot needs each Bot's description plus files on its cloud computer.

Installed files are different from proven behavior. Status reports never claim behavioral verification. No installation can guarantee that a model complies.

## Recovery

- Wrong policy: publish a new patch release, or run `npm run harness -- rollback <version>` and reinstall each platform.
- Broken install: `npm run harness -- uninstall <platform>` restores the previous file. It refuses if you edited the file after installation.
- Damaged release folder: restore it from Git. The CLI rejects a release whose digest does not match.

See [docs/README.md](docs/README.md) for the full list.

## Limitations

- Instructions guide models. They cannot force behavior.
- Cursor global User Rules, Claude web/desktop memory, Grok Bot profiles, and Notion page updates are manual steps.
- Supabase semantic search needs your own project and embedding provider. Local keyword search works without it.

## Credentials

Never commit credentials. `.env*` files (except `.env.example`), and `.state/` are ignored by Git. Publishing credentials go in `.env.local`. Read-only retrieval credentials go in `.env.runtime`.

## License

MIT. See [LICENSE](LICENSE).

## Skills

<!-- BEGIN GENERATED: skills -->
| Skill | Status | What it does | How to use |
| --- | --- | --- | --- |
| autonomous-engineering | beta | Execute, review, and recover a multi-agent-planning plan to VERIFIED slices, with an engine that records state and evidence and refuses unsafe commands. | /autonomous-engineering; Codex $autonomous-engineering. Also loads by description. |
| continue-work | beta | Resume a task in a new session from the prior trail and the real repo state, then stop at the resume point. | /continue-work; Codex $continue-work. Load only by name. |
| grill-me | stable | Interview the user relentlessly before building until goals, constraints, and decisions are settled. | /grill-me; Codex $grill-me. Also loads by description. |
| html-explainer | stable | Use whenever the user asks to build, write, make, or update a plan, audit, review, report, or comparison, in any repo, and as the running explainer of a nontrivial build. | /html-explainer; Codex $html-explainer. Also loads by description. |
| make-it-verifiable | beta | Plan how to prove a change works before any code, then run those checks with evidence. | /make-it-verifiable; Codex $make-it-verifiable. Load only by name. |
| multi-agent-planning | stable | Plan software work as verified slices and route each slice to an agent, model, and effort. | /multi-agent-planning; Codex $multi-agent-planning. Also loads by description. |
| render-rules | stable | Platform rules and a render.yaml Blueprint checklist for deploying to Render. | /render-rules; Codex $render-rules. Also loads by description. |
| subagent-budget | stable | Decide how many subagents to start, which provider and model each gets, and at what effort, so usage is spent where it pays and no provider sits idle. | /subagent-budget; Codex $subagent-budget. Also loads by description. |
| thread-continuity | experimental | Hand a T3 Code task to one fresh thread with the same project, checkout, mode, and the user's original approval, so the successor continues without asking again and never writes beside its predecessor. | /thread-continuity; Codex $thread-continuity. Load only by name. |
| verify | beta | Check a built product against its contract in a fresh session and report what passes, fails, or is unknown. | /verify; Codex $verify. Load only by name. |
<!-- END GENERATED: skills -->
