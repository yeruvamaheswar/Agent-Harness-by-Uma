# Contributing

Run the checks before opening a pull request:

```sh
npm ci
npm run typecheck
npm test
```

## Add a rule pack

1. Read [docs/packs.md](docs/packs.md) for the format and [catalog/README.md](catalog/README.md) for the trust rules.
2. Add `catalog/packs/<your-github>/<id>/<version>/pack.json` and `rules.md`. The author must be your GitHub handle.
3. Run `npm run harness -- catalog build` and `npm test`. Commit the updated `catalog/index.json`.
4. Open a pull request. CI repeats these checks. A maintainer reviews the rules text before merge.

Never edit a published version folder. Publish a new version instead.

## Code changes

Keep TypeScript erasable (no enums, no constructor parameter properties). Add tests that use temporary homes; never touch real global settings. Document new commands in the matching README.

## Add or change a skill

1. Edit `tools/agents/skills/<name>/SKILL.md` (front matter `name`, `description`, and `disable-model-invocation` for a skill that loads only by name).
2. Update the entry for that skill in [docs/skills.md](docs/skills.md): `Group:`, `Status:`, `Needs:`, `Example:`, `Result:`.
3. Run `npm run harness -- skills catalog --write`. It regenerates the skills block in `README.md` and the list in `docs/project-explainer.html`. Never edit those generated blocks by hand.
4. Run `npm run harness -- skills catalog --check` and `npm test`. CI repeats the check, and a skill that is added, removed, or renamed without these steps fails it.

## Edit the README or the workflows page

Every command in a `bash` block of `README.md` and `docs/workflows.md` must have run in a clean clone, with a temporary `HOME` and no tokens, and exited 0. Run each block in a fresh clone and fix the page until it passes. A command that needs a live agent, a login, a remote, or a placeholder value goes in a `text` block, with a sentence that says it was not run. State no fixed test count or skill count; say how to get the number.

## Keep private data out

Commit only repo-relative paths and `~/` paths. Do not commit a personal path, a thread ID, an email address, a credential, or a private plan.
