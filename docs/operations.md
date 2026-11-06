# Operations reference

Configuration files, environment variables, and the test and eval commands. For commands, backups, and recovery, see [README.md](README.md) in this folder. For install steps, see [install.md](install.md).

## Configuration reference

| File or flag | What it controls |
| --- | --- |
| `harness.config.json` | The core policy path, the reference documents, and the optional Notion page IDs |
| `knowledge/core.md`, `knowledge/references/` | The policy source |
| `releases/<version>/` | Immutable releases. Never edit by hand |
| `controls/controls.json` | The enforced Claude Code deny and ask rules: `no-force-push`, `ask-push-main`, `ask-force-with-lease`, `no-secret-reads`, `ask-deploys`, `no-self-edit` |
| `.state/` | Private backups, receipts, and manual-step records. Ignored by Git |
| `--root DIR` or `HARNESS_ROOT` | Keeps harness content in a different folder from the code. `--root` wins |
| `evals/cases.jsonl`, `evals/results/` | Behavior cases and logged run rows |

The full command list is in [README.md](README.md). `npm run harness -- help` prints it too.

## Environment variables

The harness reads these names. Put values only in your shell or in the ignored env files. Never commit them or paste them into chat.

| Name | Used for |
| --- | --- |
| `HARNESS_ROOT` | Harness content folder (same as `--root`) |
| `CODEX_HOME` | Codex configuration folder, when it is not `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Claude Code configuration folder, when it is not `~/.claude` |
| `NOTION_TOKEN` | Notion import. Optional. Set it in the ignored env file |
| `SUPABASE_URL` | Optional Supabase indexing and search. Parked feature |

`.env.local` holds publishing credentials. `.env.runtime` holds read-only retrieval credentials. Both are ignored by Git.

## Testing and evals

```bash
npm run typecheck
npm run harness -- catalog build
npm run harness -- skills catalog --check
npm run harness -- eval list
npm run harness -- context audit
```

`npm test` runs every automated test in temporary homes. It reports its own test count; read it from the output instead of from this page. Automated tests do not call live services or touch your real settings. Behavior cases (`eval run`) start a real headless agent session and spend tokens, so run them on purpose. CI runs typecheck, tests, the pack catalog freshness check, the skills catalog check, and a secret scan (`.github/workflows/checks.yml`). Fresh-session acceptance steps are in [../tests/README.md](../tests/README.md).
