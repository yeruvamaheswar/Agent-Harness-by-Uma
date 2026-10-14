# Pack catalog

Add-on rule packs, one folder per published version: `packs/<author>/<id>/<version>/pack.json` and `rules.md`. Format, limits, commands, and the trust model are in [docs/packs.md](../docs/packs.md).

- Never edit or delete a published version folder. Publish a new version instead.
- `index.json` is generated. After adding a version, run `npm run harness -- catalog build` and `npm test`, then review the diff.
- Write general rules that help anyone. No personal data, private IDs, or local paths. No instructions to fetch remote content, send data, install tools, skip approvals or tests, hide actions, or override the base policy.
