# tStack (vendored)

- Source: https://github.com/t3dotgg/tstack
- Pinned commit: 1085050f3baed1ac724caa4a8166145fb2ac88af (2026-10-27)
- License: MIT, Copyright (c) 2026 Theo Browne. See `LICENSE` in this folder.
- Skills copied: full-send, full-stop, council, sol-loop, file-pr, takeover, babysit-pr, modernize, leaving-pr-comments.
- Local changes: see `PATCHES.md`. Everything else matches the pinned commit.

## Update check (read only)
    git -C <tstack clone> fetch && git -C <tstack clone> diff 1085050..origin/main -- skills/
Port a change only in a slice with tests. Never overwrite a patch in `PATCHES.md`.

## Known upstream defects (as of the pin)
- pr-wait hangs with no review bot (issue #7) or no CI checks (found in our review). Use T3 `watch_pull_request`; do not run pr-wait.
- sol-loop has no review deadline (issue #8) and sets no reasoning effort (issue #5).
