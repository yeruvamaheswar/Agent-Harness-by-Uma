# Install, upgrade, and remove

The full install path for the harness. The [README quick start](../README.md#quick-start) is the short version: it needs no global agent file.

**Prerequisites.** Node.js 24 or later, npm, and Git. Notion, Supabase, and embedding credentials are optional.

**Supported platforms.** The installer writes global rules for Codex, Claude Code, Cursor, and a generic package. `repo install` writes project rules for cloud agents. Grok Bot needs manual steps. See [platforms.md](platforms.md).

## Install

1. Clone the repository. This command needs the network, so it is shown here but not part of the validated blocks.

   ```text
   git clone https://github.com/yeruvamaheswar/Agent-Harness-by-Uma.git
   cd Agent-Harness-by-Uma
   ```

2. From the clone root, install the dependencies and type-check.

   ```bash
   npm ci
   npm run typecheck
   npm test
   ```

   The tests take about two minutes. The browser test of `tools/explainer.ts` is opt-in: run it with `EXPLAINER_CHROME_TESTS=1 npm test` on a machine with Google Chrome.

3. Choose a release. The newest folder in `releases/` is the active policy release; at the time of writing it is `1.5.5`. `activate` selects it. Expect `"active": "1.5.5"`.

   ```bash
   ls releases
   npm run harness -- activate 1.5.5
   ```

   To publish your own rules instead, edit `knowledge/core.md` and `knowledge/references/`, run `preview` to get a digest, and approve that exact digest. The version must not exist in `releases/`. `--bootstrap` is required when the release does not come from a Notion import. The digest below is a placeholder, so this block is not run as shown.

   ```text
   npm run harness -- preview
   npm run harness -- publish 2.0.0 --approve-sha DIGEST --bootstrap
   ```

4. Optional: connect Notion. `harness.config.json` holds the repo owner's Notion page IDs. Replace them with your own, or ignore them and author in local files. See [notion.md](notion.md).

5. Install the policy into each agent you use. Each command backs up the old file and writes a receipt in `.state/`.

   ```bash
   npm run harness -- install codex
   npm run harness -- install claude
   npm run harness -- install cursor-files
   npm run harness -- install generic
   ```

   Cursor needs one manual step: paste `releases/<version>/cursor/user-rules.md` into Cursor User Rules, then run `confirm cursor-user-rules`. See [platforms.md](platforms.md#cursor).

6. Optional integrations: enforced Claude Code controls, and shared skills.

   ```bash
   npm run harness -- controls install claude
   npm run harness -- skills install subagent-budget multi-agent-planning
   ```

7. Verify.

   ```bash
   npm run harness -- status
   npm run harness -- verify claude
   npm run harness -- verify codex
   npm run harness -- controls verify claude
   npm run harness -- skills verify subagent-budget multi-agent-planning
   ```

   A good result shows `configurationVerified: true`. It always shows `behaviorVerified: false`. Start a fresh session in each agent and run the checks in [../tests/README.md](../tests/README.md) to see whether the agent follows the policy.

## Upgrade

Pull new changes, activate the newer release, and install again. The pull needs a remote, so it is not part of the validated blocks.

```text
git pull
npm ci
npm run harness -- activate NEW_VERSION
npm run harness -- install claude
npm run harness -- skills install NAME --replace
```

## Removal

Each command restores the earlier file or moves files into `.state/backups/`. It refuses when you edited the file after installation.

```bash
npm run harness -- uninstall claude
npm run harness -- uninstall codex
npm run harness -- uninstall cursor-files
npm run harness -- uninstall generic
npm run harness -- controls uninstall claude
npm run harness -- skills uninstall subagent-budget multi-agent-planning
```

## Releases

The active policy release is the newest folder in `releases/`. [../releases/README.md](../releases/README.md) lists every release with its date and digest. A new policy needs a new version: `preview`, then `publish VERSION --approve-sha DIGEST --bootstrap`, then `install` for each agent. `rollback VERSION` selects an earlier release; reinstall each platform afterwards. The `package.json` version is not the policy release.
