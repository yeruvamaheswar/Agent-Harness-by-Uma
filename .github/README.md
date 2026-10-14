# Repository automation

## Checks (active)

`workflows/checks.yml` runs on every push and pull request. It runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24. It then runs `catalog build`, which validates every pack, and fails if `catalog/index.json` changed. Last, gitleaks scans the full history for secrets.

The workflow needs no Notion, Supabase, or embedding credentials and performs no deployment. Run the same checks locally with `npm ci`, `npm run typecheck`, `npm test`, and `npm run harness -- catalog build`. Add branch protection separately if desired; a workflow alone does not prevent merges.
