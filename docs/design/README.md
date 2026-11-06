# Design context

This folder keeps the design context of this repo's own pages. It holds no Design OS content.

| Folder | Page it describes |
|---|---|
| `explainer/` | `docs/project-explainer.html`: `PRODUCT.md`, `DESIGN.md`, `.impeccable/` |
| `plan-pages/` | The plan-page template `md-view.template.html`: the same three items |

`explainer-design-spec.md` and `explainer-drafts.md` record the explainer rebuild.

Impeccable reads `PRODUCT.md` and `DESIGN.md` from the project it runs in. Its SKILL.md says to run `context` with the current folder at the user's project. It writes `DESIGN.md` at the project root and `.impeccable/mocks/` under that project.
So run Impeccable with the page's folder as the project (for example `cd docs/design/explainer`).
Or move the two files and `.impeccable/` back to the repo root for the redesign. Move them back here when it ends.
Agents do not read these folders to rebuild plan pages. Use `~/.agents/bin/md-view.sh`.
