# Local patches to vendored tStack skills

| File | Change | Why |
|---|---|---|
| tools/agents/skills/full-send/SKILL.md | Added `disable-model-invocation: true` to the frontmatter | Run only when the user types `/full-send`. It grants merge and force-with-lease. |
| tools/agents/skills/full-stop/SKILL.md | Added `disable-model-invocation: true` to the frontmatter | An emphatic "Full stop." must not start an autonomous PR run. |
