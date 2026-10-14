# Notion authoring and migration

Notion is optional. Without it, you edit `knowledge/` files. With it, Notion pages become the source, and you import them before each release.

## Bring your own pages

1. Create one Notion page for the core policy and one page for each reference document.
2. Copy each page ID. It is the 32-character hexadecimal string at the end of the page URL.
3. Put the IDs in `harness.config.json`. Set `coreNotionPageId` for the core policy and `notionPageId` for each document. Set each `sourceUrl` to the page URL, so search results cite it.

```json
{
  "coreNotionPageId": "0123456789abcdef0123456789abcdef",
  "documents": [
    {"id": "engineering", "title": "First-principles engineering", "path": "knowledge/references/engineering.md", "domain": "engineering",
     "notionPageId": "fedcba9876543210fedcba9876543210", "sourceUrl": "https://www.notion.so/fedcba9876543210fedcba9876543210"}
  ]
}
```

Leave the IDs `null` to work without Notion. `npm run harness -- status` reports `notion.pagesMapped`. The import commands refuse to run until every listed page has an ID. The mapped pages are the complete allowlist; the importer reads no other pages.

## Use a connected Notion plugin

Ask your agent: "Fetch all mapped harness pages through the Notion plugin, import their complete content, and show me the changes for the next release."

The agent fetches each page, checks that it is complete, and saves the parsed page results to an ignored file such as `.state/notion-export.json`. The JSON object has `schemaVersion: 1`, an ISO `exportedAt` time, and `pages`, an array of the complete parsed fetch results. Each page must include `url`, `text` with its complete content wrapper, and `page_last_edited_at`. Preserve truncation and unknown-block flags. Do not invent missing content or strip error flags.

Then run:

```sh
npm run harness -- import-notion-export .state/notion-export.json
git diff -- knowledge harness.config.json
npm run harness -- preview
```

The importer validates that every mapped page is present exactly once and rejects incomplete or empty content. It fetches no other pages and requires no separate Notion token. These are validated local inputs, not cryptographic proof of origin; a human or authorized publishing agent still reviews the changed source before publication. Keep export files private and out of Git.

## Optional standalone API importer

For publishing outside a connected app, share only the mapped pages with a Notion integration and configure `NOTION_TOKEN` in ignored `.env.local`. Plugin credentials do not automatically become CLI credentials. Never extract browser or plugin session tokens.

```sh
npm run harness -- import-notion
npm run harness -- preview
git diff -- knowledge harness.config.json
```

This API importer follows pagination and nested blocks. It refuses archived pages, unsupported blocks, empty pages, or pages changed during export. Rate limits and temporary failures retry with bounded delays. See the [Notion API documentation](https://developers.notion.com/reference/get-block-children).

## Daily editing and recovery

Edit mapped Notion pages, import, review the full diff, and publish with the matching preview digest. A local edit after import invalidates Notion provenance. Keep one authoring surface; do not maintain Notion and local files independently.

Both import paths validate all source pages before local writes. Ordinary write failures restore the source files. A failed import never changes the active release. On a missing page, verify its ID and sharing; on incomplete content, fetch the complete page or convert unsupported instructions to text and retry. Review before republishing; never force an incomplete export through validation.
