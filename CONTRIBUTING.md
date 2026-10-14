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
