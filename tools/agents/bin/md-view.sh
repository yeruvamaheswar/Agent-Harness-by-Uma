#!/usr/bin/env bash
# Build <slug>.html (user view) from <slug>.md (agent source).
# Usage: md-view.sh <slug>.md        build the page
#        md-view.sh --check <slug>.md  exit 1 if the page is stale
# The page hash covers the .md and the template, so a template update makes old pages stale.
set -euo pipefail
check=0
[[ "${1:-}" == "--check" ]] && { check=1; shift; }
src="${1:?usage: md-view.sh [--check] <slug>.md}"
[[ -f "$src" ]] || { echo "not found: $src" >&2; exit 2; }
out="${src%.md}.html"
tpl="$(dirname "$0")/md-view.template.html"
hash=$(cat "$src" "$tpl" | shasum -a 256 | cut -c1-12)

# Warn (never fail). Fenced code blocks are removed first, so samples in them are not linted.
# All files: a "### Slice" section lacks a Model:, Depends on:, or Files: line.
# Files named *.contract.md: also check that requirements, evals, slices, infrastructure,
# and observability point at each other (see "Contract" in the html-explainer skill).
python3 - "$src" >&2 <<'PY' || true
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
text = re.sub(r"^ {0,3}(`{3,}|~{3,}).*?^ {0,3}\1[`~]*[ \t]*$", "", text, flags=re.S | re.M)
for m in re.finditer(r"^### (Slice[^\n]*)\n(.*?)(?=^#{1,3} |\Z)", text, re.S | re.M):
    missing = [k for k in ("Model:", "Depends on:", "Files:") if not re.search(r"^- " + k, m.group(2), re.M)]
    if missing: print(f"warn: {m.group(1).strip()}: missing {', '.join(missing)}")
if path.endswith(".contract.md"):
    def section(name):
        m = re.search(r"^## " + name + r"[ \t]*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
        return m.group(1) if m else None
    def rows(body):
        out = []
        for line in (body or "").splitlines():
            if not line.startswith("|"): continue
            cells = [c.replace("`", "").strip() for c in line.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-+:?", c) for c in cells if c) and any(cells): continue
            out.append(cells)
        return out[1:]  # drop the header row
    cell = lambda r, i: r[i] if i < len(r) else ""
    ids = lambda t: re.findall(r"\b(?:REQ|NOT)-\d+\b", t)
    reqs = {c[0] for c in rows(section("Requirements")) if re.fullmatch(r"(?:REQ|NOT)-\d+", cell(c, 0))}
    evals = rows(section("Evals"))
    eval_ids = {cell(r, 0) for r in evals}
    named = set()
    for r in evals:
        found = ids(cell(r, 1)); named.update(found)
        if not found: print(f"warn: {cell(r, 0)}: no requirement")
        for i in found:
            if i not in reqs: print(f"warn: {cell(r, 0)}: unknown {i}")
    for i in sorted(reqs, key=lambda x: (x[0], int(x[4:]))):
        if i not in named: print(f"warn: {i}: no eval")
    covered = set()
    for m in re.finditer(r"^### (Slice[^\n]*)\n(.*?)(?=^#{1,3} |\Z)", text, re.S | re.M):
        c = re.search(r"^- Covers:(.*)$", m.group(2), re.M)
        if not c: print(f"warn: {m.group(1).strip()}: missing Covers:"); continue
        for i in ids(c.group(1)):
            covered.add(i)
            if i not in reqs: print(f"warn: {m.group(1).strip()}: unknown {i}")
    for i in sorted(reqs, key=lambda x: (x[0], int(x[4:]))):
        if i.startswith("REQ-") and i not in covered: print(f"warn: {i}: no slice covers it")
    infra = section("Infrastructure")
    if infra is None: print("warn: no Infrastructure section")
    for r in rows(infra):
        if cell(r, 0).lower() == "none": continue
        if cell(r, 1).lower() in ("", "manual"): print(f"warn: infrastructure: {cell(r, 0)}: no file (manual)")
    obs = rows(section("Observability"))
    if not obs: print("warn: no Observability rows")
    for r in obs:
        e = re.findall(r"\bEVAL-\d+\b", cell(r, 2))
        if not e or any(i not in eval_ids for i in e): print(f"warn: observability: {cell(r, 0)}: no eval")
PY

if (( check )); then
  grep -q "data-hash=\"$hash\"" "$out" 2>/dev/null && { echo "fresh: $out"; exit 0; }
  echo "stale: $out (rebuild with md-view.sh $src)" >&2; exit 1
fi

# Repo name: the git top folder. Outside git: the nearest folder up with CLAUDE.md or AGENTS.md,
# else the folder that holds the .md.
dir="$(cd "$(dirname "$src")" && pwd)"
root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || {
  root="$dir"; d="$dir"
  while [[ "$d" != "/" ]]; do
    [[ -e "$d/CLAUDE.md" || -e "$d/AGENTS.md" ]] && { root="$d"; break; }
    d="$(dirname "$d")"
  done
}
rel="${dir#"$root"}"; rel="${rel#/}"
path="${rel:+$rel/}$(basename "$src")"

python3 - "$src" "$out" "$tpl" "$hash" "$(basename "$root")" "$path" <<'PY'
import sys, datetime, html
src, out, tpl, h, repo, path = sys.argv[1:]
md = open(src, encoding="utf-8").read().replace("</script", "<\\/script")
page = open(tpl, encoding="utf-8").read()
built = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
# Fill {{MD}} last, so placeholder text inside the .md stays as written.
page = (page.replace("{{HASH}}", h).replace("{{BUILT}}", built)
            .replace("{{SRC}}", html.escape(src.split("/")[-1])).replace("{{REPO}}", html.escape(repo))
            .replace("{{PATH}}", html.escape(path)).replace("{{MD}}", md))
open(out, "w", encoding="utf-8").write(page)
PY
echo "OK $out"
