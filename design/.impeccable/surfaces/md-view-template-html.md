---
version: 1
slug: "md-view-template-html"
primary_target: "md-view.template.html"
related_targets: ["md-view.template.sample.html"]
---

Scope: the shared plan-page template (`md-view.template.html`), filled by `md-view.sh` from any `<slug>.md`. Visitor mode: Read.
Audience and job: one reader, the owner of the agent setup, checks the page between agent turns to see what is next, whose turn it is, how far along, how the loop fits, and what is unknown; then approves in chat.
Constraints: generic for kinds plan, audit, review, report; no detail behind tabs; no long scroll; no decoration; light/dark follows macOS; rebuilds stay mechanical (no design skill). Sample first: the live template changes only after the user approves the sample.

## Direction contract
THESIS: Each plan is a numbered notebook page that agents write and the user witnesses. It refuses the tabbed doc viewer and the dashboard of cards.
OWN-WORLD: Flat cool paper, printed form rules and labels in green-grey, one pink-red margin rule, owner inks (agent blue-black, Claude clay, user green) in the margin marks and wherever an owner is named (owner column, after-that list, step frames) to answer who owns it, unknowns in graphite pencil, tally strokes, tabular figures, condensed form face for labels and headings.
STORY: The reader sees the next entry and its owner, each section's progress, the loop as owner lanes, and every unknown, then reads any section on the same page and signs off in chat.
FIRST VIEWPORT: Notebook header strip (kind, title, status, dated, entries, page = source hash). Left: contents with tally marks. Main: Next entry flagged in the margin with owner, check, rollback, and the two after it; right of it, For your sign-off and Unconfirmed boxes; below, the loop as owner lanes with an elbow wire. Signature interaction: pressing an owner lane dims everyone else's entries page-wide. Motion: the margin flag lands on load; a section's opener inks when reached from contents.
FORM: Witnessed Notebook, candidate 6 of 7, seed 5a5a3560.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
