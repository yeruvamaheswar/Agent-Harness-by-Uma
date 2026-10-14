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

   Path A: use the rules as shipped. Release `1.4.3` is already in `releases/`.

   ```sh
   npm run harness -- activate 1.4.3
   ```

   Expect `"active": "1.4.3"`.

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
