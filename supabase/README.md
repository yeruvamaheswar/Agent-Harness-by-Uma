# Supabase deployment

`001_harness.sql` implements private, versioned pgvector storage and transactional publication. It has not been deployed merely because this file exists. Apply it once to your intended Supabase project after checking the project and existing schema. It creates only `harness_*` tables and two named functions.

## Authentication

Create/use your Supabase Auth user and record its UUID as `SUPABASE_OWNER_ID` for publishing. Read-only agents use a project publishable key and that user's authenticated access token. Row-level security limits reads to `auth.uid()`. Anonymous reads are not granted. The service role is for the publishing process only and is never installed in MCP runtime settings.

Access tokens expire. Refresh/re-authenticate using Supabase's supported auth flow; this version does not store user passwords or implement a token-refresh daemon. Do not substitute a service-role key when runtime authentication expires.

## Publication contract

The CLI `index VERSION --embeddings FILE` accepts a JSON embedding batch with a pinned `model`, `dimensions`, and a `vectors` map keyed by each chunk's SHA-256 content hash. Use `export-chunks VERSION` to obtain the exact texts/hashes. Only changed hashes need new vectors; callers may reuse vectors from a previous batch for the same model configuration.

The batch must contain every chunk in the release. It is validated before upload. A single Postgres transaction stores the release, embeddings, and references. Repeated publication of the same digest/configuration is idempotent; reusing a version for changed data fails. Concurrent publication of the same owner/version is serialized.

The schema permits vector dimensions up to 4096 and performs exact search. A small reference corpus does not initially need an approximate HNSW index. Search checks the requested release, owner, model, and vector dimensions. A model name must uniquely identify its embedding configuration; use a new identifier when changing dimensions or normalization.

## Query and rollback

`search-vector VERSION MODEL VECTOR_JSON_FILE` performs the actual pgvector query with an authenticated runtime credential. Natural-language-to-vector generation must be configured separately before semantic search can be exposed as the default MCP path. Local keyword retrieval is explicitly labeled and remains available.

Rollback selects a previous immutable release in the agent installation; searches specify that version. Old releases retain their original documents. Removing a reference affects new releases only. Permanent removal across historical releases is a separate deliberate data-retirement operation.

## Verification

Before marking cloud retrieval live, verify an authenticated owner can retrieve a known passage, a different owner cannot, anonymous access fails, incomplete indexing rolls back, a model/dimension mismatch fails, and retrying indexing does not duplicate data. Run the 20-question evaluation in `tests/README.md` against the real configured path.

Source: https://supabase.com/docs/guides/ai/semantic-search
