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
# Planner pages (front matter planner: multi-agent-planning, or the old name multi-agent-slice-planner): slice-format rules.
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
fm = re.match(r"^---\n(.*?)\n---", text, re.S)
fm = fm.group(1) if fm else ""
if re.search(r"(?m)^planner:[ \t]*[\"'`]?multi-agent-(?:planning|slice-planner)[\"'`]?[ \t]*$", fm):
    def field(body, name):
        got = re.search(r"^- " + name + r"[ \t]*(.*)$", body, re.M)
        return None if not got else got.group(1).strip()
    def paths(value, heading):
        out = []
        for part in re.split(r"\s*,\s*|\s+\u00b7\s+", value or ""):
            part = part.replace("`", "").strip()
            if part.endswith("**"): part = part[:-2].strip()
            elif part.endswith("*"): part = part[:-1].strip()
            while part.startswith("./"): part = part[2:]
            part = re.sub(r"/+", "/", part)
            while "/./" in part: part = part.replace("/./", "/")
            if part.endswith("/."): part = part[:-1]
            if part.startswith("/") or ".." in part.split("/"): print(f"warn: {heading}: Files: {part} is outside the repo")
            elif part: out.append(part)
        if value is not None and not out: print(f"warn: {heading}: Files: owns no path")
        return out
    def hit(a, b):
        return a == b or (a.endswith("/") and b.startswith(a)) or (b.endswith("/") and a.startswith(b))
    states = {"PLANNED", "READY", "IN_PROGRESS", "AGENT_FINISHED", "BLOCKED", "FAILED", "REVIEWED", "VERIFIED", "INTEGRATED"}
    need = ("Goal:", "Review:", "Fallback:", "Wave:", "Accept:", "Verify:", "State:", "Evidence:")
    slices, waves = [], {}
    for m in re.finditer(r"^### (Slice[^\n]*)\n(.*?)(?=^#{1,3} |\Z)", text, re.S | re.M):
        heading, body = m.group(1).strip(), m.group(2)
        for k in need:
            if not re.search(r"^- " + k, body, re.M): print(f"warn: {heading}: missing {k}")
        for k in ("Goal:", "Model:", "Review:", "Fallback:", "Wave:", "Depends on:", "Files:", "Accept:", "Verify:", "State:", "Evidence:"):
            found = re.findall(r"^- " + k + r"[ \t]*(.*)$", body, re.M)
            if len(found) > 1: print(f"warn: {heading}: {k} appears {len(found)} times")
            elif found and not found[0].strip(): print(f"warn: {heading}: empty {k}")
        state, evidence = field(body, "State:"), field(body, "Evidence:")
        if state is not None and state not in states: print(f"warn: {heading}: bad State: {state}")
        if state in ("VERIFIED", "INTEGRATED") and (evidence is None or evidence.lower() in ("", "none", "unknown")):
            shown = "missing" if evidence is None else (evidence if evidence else "empty")
            print(f"warn: {heading}: {state} Evidence: {shown}")
        model, review = field(body, "Model:"), field(body, "Review:")
        if model is not None and review is not None and model.lower() == review.lower():
            print(f"warn: {heading}: Review: equals Model:")
        for name in ("Model:", "Review:", "Fallback:"):
            value = field(body, name)
            if value is not None and re.search(r"antigravity", value, re.I):
                print(f"warn: {heading}: Antigravity in {name}")
        for name in ("Model:", "Fallback:"):
            value = field(body, name)
            if value is not None and re.search(r"\bgrok\b", value, re.I):
                print(f"warn: {heading}: Grok in {name}")
        wave = field(body, "Wave:")
        wave_m = re.fullmatch(r"(\d+) (sequential|parallel|integration)", wave) if wave is not None else None
        if wave is not None and not wave_m: print(f"warn: {heading}: Wave: {wave}")
        num = re.match(r"Slice\s+(\d+)\b", heading)
        deps = []
        for group in re.findall(r"(?i)\bslices?\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)", field(body, "Depends on:") or ""):
            for d in re.findall(r"\d+", group):
                if int(d) not in deps: deps.append(int(d))
        slices.append({
            "heading": heading, "num": int(num.group(1)) if num else None,
            "wave_n": int(wave_m.group(1)) if wave_m else None, "wave_k": wave_m.group(2) if wave_m else None,
            "files": paths(field(body, "Files:"), heading), "deps": deps,
        })
    for s in slices:
        if s["num"] is not None and s["wave_n"] is not None:
            waves.setdefault(s["num"], set()).add(s["wave_n"])
    for s in slices:
        if s["wave_n"] is None: continue
        for d in s["deps"]:
            if s["wave_n"] in waves.get(d, ()): print(f"warn: {s['heading']}: Depends on: slice {d}")
    for i, a in enumerate(slices):
        for b in slices[i + 1:]:
            if a["wave_n"] is None or a["wave_n"] != b["wave_n"]: continue
            if "parallel" not in (a["wave_k"], b["wave_k"]): continue
            seen = set()
            for fa in a["files"]:
                for fb in b["files"]:
                    if not hit(fa, fb): continue
                    shared = fa if fa == fb or (fb.endswith("/") and fa.startswith(fb)) else fb
                    if shared in seen: continue
                    seen.add(shared)
                    print(f"warn: {a['heading']}, {b['heading']}: overlap {shared}")
    mode_m = re.search(r"(?m)^mode:[ \t]*(.*?)\s*$", fm)
    if mode_m:
        mode = mode_m.group(1).strip()
        if mode not in ("quick", "standard", "sprint", "deep"): print(f"warn: mode: {mode}")
        elif mode == "quick":
            counts = {}
            for s in slices:
                if s["wave_n"] is None: continue
                counts[s["wave_n"]] = counts.get(s["wave_n"], 0) + 1
            for n in sorted(counts):
                if counts[n] >= 2: print(f"warn: mode quick: wave {n}")
            for s in slices:
                if s["wave_k"] == "parallel": print(f"warn: mode quick: {s['heading']}: parallel wave")
                elif s["wave_k"] and (s["wave_n"], s["wave_k"]) != (1, "sequential"): print(f"warn: mode quick: {s['heading']}: expected Wave: 1 sequential")
            if len(slices) != 1: print(f"warn: mode quick: {len(slices)} slices, expected 1")
        elif mode == "deep":
            second = [s for s in slices if s["wave_n"] == 2]
            if len(second) != 1 or second[0]["wave_k"] != "sequential": print("warn: mode deep: wave 2 must hold only the architecture-review slice, sequential")
    else: print("warn: missing mode:")
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
