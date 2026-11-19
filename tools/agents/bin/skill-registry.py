#!/usr/bin/env python3
"""Central skill registry: who owns each skill name, and is every install a link to its owner.

Source: Agent-Harness-by-Uma tools/agents/bin/skill-registry.py. Installed to ~/.agents/bin/.
Python 3.9+, no network.

  skill-registry.py build              Write ~/.agents/skill-registry.json from the owner repos and installs.
  skill-registry.py check [--json]     Build, then fail (exit 1) on duplicates, broken links, or drift.
  skill-registry.py where NAME|PATH    Before installing a skill: is the name taken, and where should it live?

Owners, in priority order:
  1. Collection repos (matt-skills, pstack, tstack): skills listed in their UPSTREAM.json.
  2. The agent harness: folders in Agent-Harness-by-Uma tools/agents/skills.
  3. The `npx skills` lock file (~/.agents/.skill-lock.json).
  Anything else installed is "unowned" (your own, or app-managed). It is listed, not changed.
Edit ~/.agents/skill-sources.json to change the repo paths.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("SKILLSYNC_HOME", str(Path.home())))
AGENTS = HOME / ".agents"
REGISTRY = AGENTS / "skill-registry.json"
SOURCES = AGENTS / "skill-sources.json"
REPOS = HOME / "Code-Git-Repos"
DEFAULT_SOURCES = {
    "collections": {"matt-skills": str(REPOS / "matt-skills"), "pstack": str(REPOS / "pstack"), "tstack": str(REPOS / "tstack")},
    "harness": str(REPOS / "Agent-Harness-by-Uma-main" / "tools" / "agents" / "skills"),
    "install_dirs": {"shared (Codex)": str(AGENTS / "skills"), "claude-code (and Cursor)": str(HOME / ".claude" / "skills"),
                     "cursor": str(HOME / ".cursor" / "skills"), "codex": str(HOME / ".codex" / "skills")},
}
GUIDE = {
    "mattpocock": "matt-skills", "t3dotgg/tstack": "tstack", "cursor/plugins": "pstack", "pstack": "pstack",
}


def sources():
    s = json.loads(json.dumps(DEFAULT_SOURCES))
    if SOURCES.exists():
        user = json.loads(SOURCES.read_text())
        for k, v in user.items():
            if isinstance(v, dict):
                s.setdefault(k, {}).update(v)
            else:
                s[k] = v
    return s


def skill_name(path):
    md = Path(path) / "SKILL.md"
    try:
        text = md.read_text(errors="replace")
    except OSError:
        return None
    if text.startswith("---"):
        for line in text[3:text.find("\n---", 3)].splitlines():
            if line.startswith("name:"):
                return line[5:].strip().strip("'\"")
    return Path(path).name


def owners():
    """name -> list of {owner, path, active}"""
    s = sources()
    out = {}
    for coll, repo in s["collections"].items():
        man = Path(repo) / "UPSTREAM.json"
        if not man.exists():
            continue
        m = json.loads(man.read_text())
        act = m.get("activate", [])
        for name, e in m["skills"].items():
            active = e.get("status") == "active" and (act == "all" or name in act)
            out.setdefault(name, []).append({"owner": coll, "path": str(Path(repo) / "skills" / name), "active": active,
                                             "upstream": m["upstream"]["url"], "commit": e.get("commit", "")})
    h = Path(s["harness"])
    if h.is_dir():
        for p in sorted(h.iterdir()):
            if (p / "SKILL.md").exists():
                out.setdefault(p.name, []).append({"owner": "agent-harness", "path": str(p), "active": True,
                                                   "upstream": "Agent-Harness-by-Uma", "commit": ""})
    lock = AGENTS / ".skill-lock.json"
    if lock.exists():
        for name, e in json.loads(lock.read_text()).get("skills", {}).items():
            out.setdefault(name, []).append({"owner": "skills-cli", "path": str(AGENTS / "skills" / name), "active": True,
                                             "upstream": e.get("sourceUrl", ""), "commit": e.get("skillFolderHash", "")})
    return out


def scan_installs():
    """platform -> name -> {kind, target}"""
    res = {}
    for plat, d in sources()["install_dirs"].items():
        d = Path(d)
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.name.startswith("."):
                continue
            if p.is_symlink():
                tgt = os.path.realpath(p)
                kind = "link" if os.path.exists(tgt) else "broken-link"
            elif (p / "SKILL.md").exists():
                kind, tgt = "dir", str(p)
            else:
                continue  # not a skill folder (for example ~/.claude/skills/synced)
            res.setdefault(plat, {})[p.name] = {"kind": kind, "target": tgt}
    return res


def build():
    own = owners()
    inst = scan_installs()
    reg = {"version": 1, "skills": {}, "unowned": {}}
    for name, lst in sorted(own.items()):
        primary = next((o for o in lst if o["active"]), lst[0])
        reg["skills"][name] = {"owner": primary["owner"], "path": primary["path"], "active": primary["active"],
                               "upstream": primary["upstream"], "commit": primary["commit"],
                               "also_in": [o["owner"] for o in lst if o is not primary],
                               "installs": {p: v[name] for p, v in inst.items() if name in v}}
    for plat, items in inst.items():
        for name, v in items.items():
            if name not in reg["skills"]:
                reg["unowned"].setdefault(name, {})[plat] = v
    REGISTRY.write_text(json.dumps(reg, indent=2) + "\n")
    return reg, own


def file_hash(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None


def check(reg, own):
    errors, warnings = [], []
    for name, lst in own.items():
        active = [o["owner"] for o in lst if o["active"]]
        if len(active) > 1:
            errors.append(f"{name}: maintained in more than one place: {', '.join(active)}")
        elif len(lst) > 1:
            warnings.append(f"{name}: same name in {', '.join(o['owner'] for o in lst)}; only {reg['skills'][name]['owner']} is active")
    for name, e in reg["skills"].items():
        if e["owner"] not in sources()["collections"] or not e["active"]:
            continue
        want = os.path.realpath(e["path"])
        for plat, v in e["installs"].items():
            if v["kind"] == "broken-link":
                errors.append(f"{name}: broken link in {plat}")
            elif v["kind"] == "dir":
                errors.append(f"{name}: real copy in {plat} instead of a link to {e['owner']}")
            elif v["target"] != want:
                errors.append(f"{name}: {plat} links to {v['target']}, not {want}")
        if "shared (Codex)" not in e["installs"]:
            errors.append(f"{name}: active in {e['owner']} but not installed in ~/.agents/skills (run skillsync.py link)")
    for name, plats in reg["unowned"].items():
        for plat, v in plats.items():
            if v["kind"] == "broken-link":
                errors.append(f"{name}: broken link in {plat}")
        copies = sorted({v["target"] for v in plats.values() if v["kind"] != "broken-link"})
        if len(copies) > 1:
            warnings.append(f"{name}: {len(copies)} separate copies with no owner repo: {', '.join(copies)}")
    hashes = {c: file_hash(Path(r) / "scripts" / "skillsync.py") for c, r in sources()["collections"].items()}
    for c, h in hashes.items():
        if h is None:
            errors.append(f"{c}: scripts/skillsync.py is missing")
    if len({h for h in hashes.values() if h}) > 1:
        errors.append("scripts/skillsync.py differs between collection repos: " + ", ".join(f"{c}={(h or 'missing')[:8]}" for c, h in hashes.items()))
    return errors, warnings


def where(arg):
    p = Path(arg).expanduser()
    name = skill_name(p) if p.is_dir() else arg
    reg, own = build()
    if name in own:
        lst = own[name]
        print(f"'{name}' already exists. Owner: {reg['skills'][name]['owner']} ({reg['skills'][name]['path']}).")
        for o in lst:
            print(f"  - {o['owner']}: {o['path']} ({'active' if o['active'] else 'inactive'})")
        print("Do not install another copy. Change it in the owner repo, or pick a new name for a different skill.")
        return 1
    if name in reg["unowned"]:
        print(f"'{name}' is installed but has no owner repo: {reg['unowned'][name]}")
        return 1
    print(f"'{name}' is free. Where it should live:")
    print("  - From mattpocock/skills: add it to matt-skills (activate in UPSTREAM.json).")
    print("  - From cursor/plugins pstack or t3dotgg/tstack: it arrives through that repo's update.")
    print("  - Your own skill: Agent-Harness-by-Uma tools/agents/skills, installed with the harness CLI.")
    print("  - Another upstream: `npx skills add` (tracked in ~/.agents/.skill-lock.json).")
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__); return 0
    cmd = argv[0]
    if cmd == "build":
        reg, _ = build()
        print(f"{len(reg['skills'])} owned skills, {len(reg['unowned'])} unowned names -> {REGISTRY}")
        return 0
    if cmd == "check":
        reg, own = build()
        errors, warnings = check(reg, own)
        if "--json" in argv:
            print(json.dumps({"errors": errors, "warnings": warnings, "owned": len(reg["skills"]), "unowned": len(reg["unowned"])}, indent=2))
        else:
            for w in warnings:
                print("WARN ", w)
            for e in errors:
                print("ERROR", e)
            print(f"{'FAIL' if errors else 'OK'}: {len(reg['skills'])} owned skills, {len(errors)} errors, {len(warnings)} warnings")
        return 1 if errors else 0
    if cmd == "where" and len(argv) > 1:
        return where(argv[1])
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
