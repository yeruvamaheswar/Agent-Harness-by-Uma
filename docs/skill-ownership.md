# Skill ownership

Each skill has one owner. Agents read a link to the owner's copy, never a second copy.

Third-party mirrors live in `~/3p-Repos/` (with upstream clones in `~/3p-Repos/.upstream/`). Your own repos stay in `~/Code-Git-Repos/`.

| Owner | Repo | Skills | Installed by |
|---|---|---|---|
| Agent harness | this repo, `tools/agents/skills/` | Uma's own skills (see [skills.md](skills.md)) | `npm run harness -- skills install NAME` (copy + receipt) |
| tstack | [yeruvamaheswar/tstack](https://github.com/yeruvamaheswar/tstack) (private), from t3dotgg/tstack | 9 PR and review skills, listed below | `python3 ~/3p-Repos/tstack/scripts/skillsync.py link` |
| pstack | [yeruvamaheswar/pstack](https://github.com/yeruvamaheswar/pstack) (private), from cursor/plugins `pstack/skills` | 58 skills | `python3 ~/3p-Repos/pstack/scripts/skillsync.py link` |
| matt-skills | [yeruvamaheswar/matt-skills](https://github.com/yeruvamaheswar/matt-skills) (private), from mattpocock/skills | 39 skills, none active by default; 6 renamed with a `matt-` prefix (below) | `activate` in its `UPSTREAM.json`, then `skillsync.py link` |
| skills CLI | `~/.agents/.skill-lock.json` | for example security-audit | `npx skills add` |

```text
matt-skills ─┐
pstack ──────┼─ skillsync.py link ─> ~/.agents/skills/<name> (symlink) <─ ~/.claude/skills/<name> (symlink)
tstack ──────┘                         Codex reads this                      Claude Code and Cursor read this
harness ───── skills install ─────> ~/.agents/skills/<name> (copy + receipt)
```

## Registry
`tools/agents/bin/skill-registry.py` (installed to `~/.agents/bin/`) builds `~/.agents/skill-registry.json` from the owner repos and the install folders. Harness skills are read from `origin/main` of `~/Code-Git-Repos/Agent-Harness-by-Uma-main`, so the branch that checkout is on does not matter.

Format (version 2), for tools such as the agent control center:
- `collections.<name>`: `path` (local clone), `github`, `upstream`, `upstream_path`, `skills` (count), `activate`.
- `skills.<name>`: `owner`, `path`, `description`, `active`, `upstream`, `upstream_name`, `commit`, `also_in`, `installs` (per platform: `kind` link/dir, `target`).
- `unowned.<name>`: `description`, `installs` for skills with no owner repo.

- `skill-registry.py check` fails on a name that two owners keep active, a real copy where a link should be, a link to the wrong place, a broken link, or a `skillsync.py` that differs between the three repos.
- `skill-registry.py where NAME` (or a folder path) says whether a name is taken and where a new skill belongs. Run it before you install a skill.
- Each collection's `skillsync.py update` reads the registry and sends a new upstream skill with a taken name to review.

## Where a new skill goes
1. Run `~/.agents/bin/skill-registry.py where NAME`. If the name is taken, change the owner's copy instead.
2. From mattpocock/skills: it is already in matt-skills. Add the name to `activate` and run `skillsync.py link`.
3. From pstack or tStack upstream: it arrives through that repo's Tuesday/Friday update.
4. Your own skill (including skills inspired by someone else's idea, like `grill-me` or `make-it-verifiable`): this repo, `tools/agents/skills/`.
5. Another upstream: `npx skills add`, which records it in `~/.agents/.skill-lock.json`.
Never copy a skill folder into `~/.agents/skills` or `~/.claude/skills` by hand.

## No two skills share a name
When an upstream skill's name is taken, the mirror renames it with its repo prefix (`rename` in that repo's `UPSTREAM.json`). The sync tool applies the prefix to the folder, the `name:` line, and references in the collection's other skills, so updates still merge. `skill-registry.py check` warns on any name owned twice.

| Upstream skill | Local name | Different skill it would clash with |
|---|---|---|
| Matt `grill-me` | `matt-grill-me` | harness `grill-me` (Uma's own rewrite) |
| Matt `teach` | `matt-teach` | pstack `teach` |
| Matt `tdd` | `matt-tdd` | pstack `tdd` |
| Matt `code-review` | `matt-code-review` | Claude Code `code-review` plugin |
| Matt `handoff` | `matt-handoff` | Grok built-in `handoff` |
| Matt `implement` | `matt-implement` | Grok built-in `implement` |

- Cursor's own pstack plugin (`~/.cursor/plugins/cache/cursor-public/pstack/`) is a second, Cursor-managed copy. Turn it off in Cursor Settings > Plugins to use only the pstack repo.

## tstack skills
These moved out of this repo on 2026-11-19. The tstack repo keeps the two local patches (full-send and full-stop run only when typed) and the license.

### babysit-pr
Group: Execution
Status: experimental
Needs: gh, an authenticated GitHub account, and a PR. In T3 Code it uses watch_pull_request; elsewhere pr-wait needs python3. pr-wait can hang with no review bot or no CI.
Example: Ask the agent to babysit PR 12 through CI and review.
Result: One watcher per PR, fixes for real findings, and a ready or blocked report. It never merges unless asked. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### council
Group: Quality
Status: experimental
Needs: Delegation to three different providers, such as T3 delegate_task.
Example: Ask for a council review of a change.
Result: Read-only reviews from three models, a summary of findings and disagreements, and scores. Rounds and deadlines are not capped upstream. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### file-pr
Group: Execution
Status: beta
Needs: gh and a branch with a reviewed diff.
Example: Ask the agent to file a PR.
Result: A short PR that leads with the problem, checked for secrets, with the model and harness named at the end. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### full-send
Group: Execution
Status: experimental
Needs: gh, an unwatched thread, and your typed /full-send. It grants merge and force-with-lease on the PR branch.
Example: Type /full-send with a change request.
Result: A change taken to a merged PR with proof, review, and babysitting. Patched to run only on /full-send. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### full-stop
Group: Execution
Status: experimental
Needs: The same tools as full-send, and your typed /full-stop. It never merges.
Example: Type /full-stop with a change request.
Result: A PR that is proven, reviewed, and ready for you to merge, with auto-merge off. Patched to run only on /full-stop. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### leaving-pr-comments
Group: Communication
Status: beta
Needs: gh and a PR comment to post.
Example: Ask the agent to reply to a review comment.
Result: A comment with an attribution note, checked for secrets, with the posted URL verified. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### modernize
Group: Execution
Status: beta
Needs: gh, git, and a stale PR.
Example: Ask the agent to modernize an old PR.
Result: A MODERNIZE, REWORK, or CLOSE call with evidence, and a rebase pushed with a lease only when it applies. It never merges or closes. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### sol-loop
Group: Quality
Status: experimental
Needs: Delegation to a GPT Sol model, such as T3 delegate_task.
Example: Ask for a sol loop on a change.
Result: Up to three review rounds with a ledger of findings and a stop rule. It has no review deadline upstream and sets no effort. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.

### takeover
Group: Execution
Status: beta
Needs: Access to the source PR, branch, or thread.
Example: Ask the agent to take over a PR.
Result: The original goal finished on a new branch with the original authors credited. Owned by the tstack repo (yeruvamaheswar/tstack); installed by its skillsync.py link.
