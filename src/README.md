# Implementation

- `core.ts`: allowlisted source snapshots, reviewed digests, immutable releases, platform rendering, activation, chunking, and local retrieval.
- `install.ts`: global file installation with backups, managed sections, verification, and guarded restoration. For Cursor it owns only the MCP entry and retires the rule file of earlier installs.
- `skills.ts`: `skills status|install|verify|uninstall`: copies a skill from `tools/agents/skills/` to `~/.agents/skills/` and links it from `~/.claude/skills/` (or into a repo with `--repo`), with preflight of every name, refusal of differing copies unless `--replace`, backups, receipts in `.state/installations/skills/`, rollback, and moves instead of deletes.
- `manual-steps.ts`: the one manual step, Cursor User Rules: the `confirm cursor-user-rules` record in `.state/manual-steps.json`, the `manualSteps` entry in `status`, and the reminder that other commands print.
- `packs.ts`: add-on rule packs from `catalog/` and local packs from `.state/packs/local/`: manifest validation, digests, preview/approve, the shared placement planner and receipt format, pack sections in Claude Code and Codex, one pack file each in Cursor, removal, and `catalog build`. See `docs/packs.md`.
- `platforms.ts`: adapter table as data, one record per runtime (instruction targets, skill roots, MCP, hooks, runtime, probe, evidence). No installer reads it yet. See `docs/platforms.md`.
- `rules.ts`: read-only scan of every agent's global rules (`rules scan`): records, deterministic findings, and proposals. User-level `~/.claude/rules/*.md` loads in every session; `paths` front matter limits a rule to matching files ([Claude Code memory docs](https://code.claude.com/docs/en/memory#user-level-rules)).
- `rules-apply.ts`: digest-approved rule changes from `rules scan` proposals: native formats (Cursor `.mdc`, Claude `~/.claude/rules/<name>.md`, Codex `<!-- BEGIN AGENTIC HARNESS RULE <name> -->` sections in `AGENTS.md`), backups, per-file receipts, verification, rollback, and guarded undo of one file or a whole apply. The adopt action creates a local pack and installs it through `packs.ts` in the same apply. Ignored findings are stored in `.state/rules-ignored.json`.
- `notion.ts`: complete page export with pagination, recursive blocks, bounded retries, and import provenance.
- `env.ts`: separate publishing/runtime environment loading without logging secrets.
- `cli.ts`: commands documented in `docs/README.md`.
- `mcp.ts`: SDK-based read-only stdio tools. No publishing operations are exposed to agents.
- `supabase.ts`: optional release indexing and pgvector search.

Use Node 24+ with native TypeScript stripping. Keep TypeScript syntax erasable; constructor parameter properties/enums are not supported by strip-only mode. Run `npm run typecheck` and `npm test` after behavior changes. Package versions are pinned in package-lock.json; install with `npm ci`.

Do not add a new platform based only on assumed file locations. Verify the supported global instruction mechanism, preserve existing state, add meaningful integration tests, and document pending behavioral checks. Never introduce mutable provider credentials into release artifacts.
