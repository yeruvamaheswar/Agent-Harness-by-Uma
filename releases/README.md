# Released instruction bundles

This folder holds every published version of the harness policy. Each numbered folder is an immutable, reviewed snapshot. It contains the core policy, the approved reference documents, and one generated copy of the policy for each supported agent platform.

All platform files in one release come from the same core policy. They differ only in format.

Do not edit anything in this folder by hand. To change the policy, publish a new version (see [Publish a new release](#publish-a-new-release)).

## Releases

| Version | Created (UTC) | Source | Digest (SHA-256, first 12) |
| --- | --- | --- | --- |
| [1.4.3](1.4.3/) | 2026-10-13 | Local files (`--bootstrap`) | `eb3efd7bd143` |
| [1.4.2](1.4.2/) | 2026-10-13 | Notion export, 2026-10-13 | `a14e2c1eb560` |
| [1.4.1](1.4.1/) | 2026-10-05 | Notion export, 2026-10-05 | `bb160e9b41d0` |
| [1.4.0](1.4.0/) | 2026-10-05 | Notion export, 2026-10-05 | `593881d332fb` |
| [1.3.1](1.3.1/) | 2026-10-05 | Notion export, 2026-10-05 | `8f0c7123327d` |
| [1.3.0](1.3.0/) | 2026-10-05 | Notion export, 2026-10-05 | `5fbf3e316cf9` |
| [1.2.0](1.2.0/) | 2026-10-04 | Notion export, 2026-10-04 | `98bec0803f96` |
| [1.1.0](1.1.0/) | 2026-09-25 | Notion export, 2026-09-25 | `aa8f120930f8` |
| [1.0.0](1.0.0/) | 2026-09-25 | Local bootstrap files | `9b93d6e04749` |

The full digest and provenance of each release are in its `release.json` and its `README.md`.

### What changed

- **1.4.3**
  - A new product, or an ambiguous or significant request, goes to the `grill-me` skill first: before code and before any design or build skill. If no one can answer, the agent writes its questions and stops.
  - The "On-demand skills" section no longer lists `grill-me`, because the rule above names it. The `html-explainer` line now covers plans, audits, reviews, reports, and contracts.
- **1.4.2**
  - Changes four lines of the core policy. The closing report now names what needs the user's decision. An agent must not be the only verifier of its own work. A slice handoff names the model and effort from the plan. The `html-explainer` line covers plans, audits, reviews, reports, and comparisons.
  - The platform files now start with the plain line `Harness release 1.4.2.`, so an agent can state its release.
- **1.4.1**
  - Renames the skill `render-deploy` to `render-rules` in the core policy.
- **1.4.0**
  - Shortens the core policy from 44 lines to 32. The sections are now: working principles, before changing code, tracer bullets, quality, context and agents, on-demand skills.
  - Removes the "Visual artifacts" section. The Lavish review steps now live in the `html-explainer` skill.
  - Adds the "On-demand skills" section, which names the three skills.
- **1.3.1**
  - Plan execution now applies only to written plans with two or more slices. Without subagents, the stop after each slice overrides tracer step 4.
- **1.3.0**
  - Adds a "Plan execution" section to the core policy. Each plan slice runs in a fresh subagent session with a handoff note. Slices run in parallel only when they touch separate files and are independent. Without subagents, the agent stops after each slice and gives a handoff prompt.
  - Rewords the "Default to one agent" rule so it applies to work that is not a planned slice.
- **1.2.0**
  - Adds a "Visual artifacts" section to the core policy. It covers self-contained HTML reviews with the Lavish CLI and forbids `lavish-axi share` unless the user asks.
  - Adds the `claude/` platform folder (`CLAUDE.md` for Claude Code).
  - Renames the Cursor export from `uma-harness.mdc` to `agentic-harness.mdc`. The release marker now reads "Agentic harness" instead of "Uma harness".
- **1.1.0**
  - Imports the core policy and the three reference documents from the mapped Notion pages.
  - The policy rules are the same as 1.0.0. The title heading is removed, and the reference documents now follow the Notion text.
- **1.0.0**
  - First release, published with `--bootstrap` from local files before Notion was connected.
  - Contains the core policy and three reference documents: first-principles engineering, AI agent system design, and pragmatic engineering with tracer bullets.

## Folder layout

```text
releases/
  README.md                  This file. Maintained by hand.
  <version>/
    README.md                Version, provenance, and digest. Generated.
    release.json             Core policy, reference documents, provenance, digest, creation time.
    codex/AGENTS.md          Policy for Codex.
    claude/CLAUDE.md         Policy for Claude Code (1.2.0 and later).
    cursor/user-rules.md     Policy text for Cursor global User Rules.
    cursor/*.mdc             Optional Cursor rule-file export.
    generic/instructions.md  Policy for any other agent.
    grok-bot/                Bot description and skill for Grok Bot.
```

Each platform folder also has a short generated `README.md` with the source digest.

## Use a release

Run all commands from the root of the harness repository.

1. Check which release is active on this machine:

   ```sh
   npm run harness -- status
   ```

2. Select a release. Do this after a fresh clone, or to switch versions:

   ```sh
   npm run harness -- activate 1.4.3
   ```

3. Install the active release for each agent you use:

   | Platform file | Install step |
   | --- | --- |
   | `codex/AGENTS.md` | `npm run harness -- install codex` |
   | `claude/CLAUDE.md` | `npm run harness -- install claude` |
   | `cursor/user-rules.md` | Manual. Paste the full file into Cursor → Customize → Rules → User Rules, then run `npm run harness -- confirm cursor-user-rules`. |
   | `cursor/*.mdc` | None. It is an optional project-format export. `npm run harness -- install cursor-files` registers the reference search only. |
   | `generic/instructions.md` | `npm run harness -- install generic` |
   | `grok-bot/` | Manual. Add `bot-description.md` to each Bot profile and the skill to its computer. |

   Cursor needs the manual User Rules step for global coverage. The `.mdc` file alone does not give it. See [docs/platforms.md](../docs/platforms.md) for all platform details.

4. Verify the installation, then restart MCP and start a fresh agent session:

   ```sh
   npm run harness -- verify codex
   npm run harness -- status
   ```

   A matching file shows the policy is installed. It does not prove the agent follows it. Run the fresh-session checks in [tests/README.md](../tests/README.md).

## Publish a new release

1. Edit the source. Use local files in `knowledge/`, or the mapped Notion pages followed by an import.
2. Preview the snapshot and note its digest:

   ```sh
   npm run harness -- preview
   ```

3. Review the changes. Then publish the next version with that exact digest:

   ```sh
   npm run harness -- publish NEW_VERSION --approve-sha <digest>
   ```

   Add `--bootstrap` only for a release that does not come from a Notion import. A fresh clone with no releases needs it for its first release.

4. Add a row to the [Releases](#releases) table and a [What changed](#what-changed) entry in this file. The CLI does not update this file.
5. Install the new release on each platform. Commit `releases/` after review. The harness never commits or pushes for you.

## Integrity and recovery

- The CLI checks the snapshot digest before activation and retrieval. It rejects a release whose files do not match.
- **Damaged release folder:** restore it from Git.
- **Wrong policy in the latest release:** publish a new patch release, or roll back to an older one:

  ```sh
  npm run harness -- rollback 1.4.2
  ```

  Rollback changes only the active release on this machine. Reinstall each platform afterward, including the manual Cursor and Grok Bot steps.

## Related documentation

- [Root README](../README.md): overview and first-time setup.
- [docs/README.md](../docs/README.md): all commands, versions, backups, and recovery.
- [docs/platforms.md](../docs/platforms.md): per-platform installation and verification.
- [knowledge/README.md](../knowledge/README.md): meaning and editing of the policy source.
