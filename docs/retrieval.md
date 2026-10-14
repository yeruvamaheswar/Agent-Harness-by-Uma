# Reference retrieval

## Available immediately

`search` and `get-document` read only documents in the selected immutable release. Search currently provides explicitly labeled **local-keyword** results, not a claim of vector search. It returns source URLs, document IDs, section headings, and excerpts. Domain filters accept engineering and communication.

The MCP server exposes `harness_status`, `search_knowledge`, and `get_document`. `harness_status` returns the release version, digest, and source. It returns the core policy text only when called with `include_policy: true`, because the policy is already in each agent's instructions. It uses the same release content as the CLI, pins its active version on startup, and offers no write or shell-execution tools. Installed core instructions stay available when retrieval is offline.

```sh
npm run harness -- search 'single-agent tool contracts'
npm run harness -- get-document agent-design
node --experimental-strip-types src/mcp.ts
```

The last command waits for an MCP client on standard input; it is not an interactive chat program. Use the SDK integration test to exercise it.

## Credential separation

Publishing uses `.env.local`. Runtime retrieval uses `.env.runtime`. Both are ignored by Git. Do not put publishing credentials in the runtime file or MCP configuration. Environment files are loaded without printing values.

Supabase semantic search requires the schema, a configured project, owner identity, restricted retrieval authentication, and an approved embedding provider. Provider selection/credentials and live deployment must be completed before claiming semantic search is active. The database stores model and dimension metadata so vectors from incompatible configurations cannot be mixed.

Do not use a Supabase service-role key as an agent retrieval credential. It bypasses row-level security. Publishing and retrieval must use different credentials.

## Verification and failures

Use source-attributed search queries in `tests/README.md`. Verify the expected document appears, the release matches installed rules, and other domains never appear. Missing semantic configuration must be reported; any fallback is explicitly labeled local-keyword. Restart MCP after installing a new release, rather than changing an active task's knowledge silently.
