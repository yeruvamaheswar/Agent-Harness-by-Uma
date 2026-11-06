# Shipped

Ship notes for Uma's portfolio site. Newest first. Add an entry only for a significant ship (see "Portfolio ship notes" in `AGENTS.md`). Facts only; no secrets, client names, or family details.

<!-- Format:
## YYYY-MM-DD: what shipped, one line
- Evidence: commit SHA, release tag, URL, or test output path
- Portfolio impact: which claim on the site changes, or "new item"
- Public: yes, or no and what must stay private
-->

## 2026-11-06: production readiness pass: one skill source, rebuilt explainer, rewritten README (merge pending)
- Evidence: branch `harness/production-readiness`, pull request https://github.com/yeruvamaheswar/Agent-Harness-by-Uma/pull/10 ("Harness checks" passed on 6af0139); gates in `docs/audits/production-readiness-audit.md` (616 of 616 tests pass with 0 skipped in a clean clone; `skills catalog --check` ok; the explainer check passes 60 of 60 at five widths in light and dark; gitleaks clean over all remote branches plus `HEAD`).
- Portfolio impact: the explainer now shows release 1.5.5, ten skills in a skills explorer, and new plates for orchestration, checkpoint and handoff, and unattended runs (the figure count and hero lead are drafts awaiting the owner). The README is rewritten from verified commands, with real screenshots. A CI check keeps the README, the explainer and `docs/skills.md` in step with the skill folders. The overnight mode, `ae report` and `ae charter` are merged without any commit grant.
- Public: yes. The plan pages, run journals and the mission run folder stay private.
