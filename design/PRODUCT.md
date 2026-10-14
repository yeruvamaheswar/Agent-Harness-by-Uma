# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One reader: the owner of this agent setup. They direct three coding agents (Claude Code, Codex, Cursor) and approve their work. They open a generated page to understand a plan, see whose turn it is, and decide what to approve. Agents never read the page; they read the `.md`.

## Product Purpose
`md-view.sh` turns any `<slug>.md` (kind `plan`, `audit`, `review`, or `report`) into one self-contained HTML page. The `.md` is the agent's working document; the page is the human's view of the same facts. Success: the reader understands the plan from the page alone, without opening the `.md`.

## Operating Context
- Agents edit the `.md`, then run `./md-view.sh <slug>.md` and `./md-view.sh --check <slug>.md`.
- The reader opens the `.html` in a desktop browser on a Mac. Light or dark follows the macOS system theme.
- The reader reads in short checks between agent turns, then approves or redirects in chat.

## Capabilities and Constraints
- The template (`md-view.template.html`) is generic and fixed. Rebuilds are mechanical: no design skill, no hand edits to the `.html`.
- The template parses front matter (`kind`, `title`, `status`, `updated`), `## ` sections, a `## Loop` of `N. Step · owner`, task items `- [ ] text · owner · check · rollback`, `### Always loaded` / `### On demand` pairs, and the word `unknown`.
- Owners are `Claude`, `user`, or an agent. Unconfirmed facts are written `unknown`.
- The page loads marked.js (cdnjs) and the Archivo font (Google Fonts). One HTML file, no build step beyond `md-view.sh`.

## Evidence on Hand
- Real content: `context-diet.md` (current plan), `context-diet.v1.md` (old plan, history only).
- No other `.md` kinds exist yet; `audit`, `review`, and `report` are supported but unseen.

## Product Principles
- The first screen answers four questions: what is next and who owns it, how far along, how the steps fit together, what is still unknown.
- No detail hides behind tabs or clicks; no page runs long. Density over decoration.
- The `.md` is the single source. The page adds layout, never facts.
- Rebuilding stays cheap: an agent rebuilds without loading design context.
