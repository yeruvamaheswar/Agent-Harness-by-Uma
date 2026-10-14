# CLAUDE.md

Guidance for Claude Code, Codex, and Cursor in this folder. `AGENTS.md` is a symlink to this file.

## What this is
Agent harness and plan system for coordinated multi-platform work.

## Rules: Plan pages
- Read and edit only `.md` files in `plans/`. Never edit a `.html` by hand.
- After any `.md` edit, rebuild with `~/.agents/bin/md-view.sh plans/<slug>.md`, then verify with `--check`.
- Do not load impeccable (or any design skill) to rebuild. The template is fixed; rebuilding is mechanical.
- Load impeccable only when requested for a template redesign. It comes from the DesignOS plugin (`designOS-by-Uma`), not from this repo.

## Rules: Harness and config
- Back up every file before a change.
- Outside Git (home folder, `.state/`, platform config): no deletes. Rename or move, don't remove.
- Inside this repo: a file may be deleted through Git in a reviewed pull request, after a check that nothing uses it. Git history keeps it.
- No commits or pushes without explicit user approval.

## Files
- `plans/*.md`: source for plans. Agents read the `.md`, never the `.html`.
- `plans/*.html`: generated views for users. Built by `~/.agents/bin/md-view.sh`.
- `~/.agents/bin/md-view.sh` + `md-view.template.html`: shared builder for all repos. Works for any `<slug>.md`.
- `tools/agents/`: sources of the skills and the page builder. Installed copies live in `~/.agents/`.
- `design/`: impeccable redesign context (`DESIGN.md`, `PRODUCT.md`, `.impeccable/`). Agents do not read it for rebuilds.
- `plans/system-design.md`: how the assistants use the harness.
- `docs/project-explainer.html`: the public explainer, hand-built with DesignOS. `md-view.sh` does not generate it. Its design context is `PRODUCT.md`, `DESIGN.md`, and `.impeccable/`. The plan-page design context stays in `design/`.
- This repo is `Agent-Harness-by-Uma`.

## Commands
```bash
~/.agents/bin/md-view.sh plans/system-design.md      # rebuild after any .md edit
~/.agents/bin/md-view.sh --check plans/system-design.md  # verify freshness
```

## After editing plans
1. Rebuild with `~/.agents/bin/md-view.sh`.
2. Check `--check` prints `fresh`.
