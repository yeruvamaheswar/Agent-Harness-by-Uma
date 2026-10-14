import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("tools/agents/bin/md-view.sh");

function build(name: string, content: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "md-view-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  const r = spawnSync("bash", [script, ...args, file], { encoding: "utf8" });
  const warns = r.stderr.split("\n").filter((l) => l.startsWith("warn: "));
  return { r, file, warns, html: file.replace(/\.md$/, ".html") };
}

const head = "---\nkind: plan\ntitle: T\nstatus: active\nupdated: 2026-10-14\n---\nIntent: x\n\n";

const good = `${head}## Requirements
| ID | Requirement | Source |
|---|---|---|
| REQ-1 | Timers | Uma |
| REQ-2 | Start and stop | Uma |
| REQ-3 | Correct a time | Uma |
| REQ-4 | Log a bottle | Uma |
| NOT-1 | No charts | Uma |

## Evals
| ID | REQ | Check | Method | Result |
|---|---|---|---|---|
| EVAL-1 | REQ-1, REQ-2 | Timers run | unit | not run |
| EVAL-2 | REQ-3 | Edit works | unit | not run |
| EVAL-3 | REQ-4 | Bottle saved | browser | not run |
| EVAL-4 | NOT-1 | No chart route | integration | not run |

## Infrastructure
| Resource | Defined in | Applied by | Secrets |
|---|---|---|---|
| Hosting | \`vercel.json\` | git push | none |

## Observability
| Signal | Seen in | Eval |
|---|---|---|
| Errors | error table | EVAL-4 |

## Slices
### Slice 1: timer
- Covers: REQ-1, REQ-2
- Model: Claude (sonnet/medium)
- Depends on: none
- Files: a.ts

### Slice 2: edit and bottle
- Covers: REQ-3, REQ-4
- Model: Claude (sonnet/medium)
- Depends on: slice 1
- Files: b.ts
`;

test("a complete contract builds with no warning and is fresh", () => {
  const b = build("ok.contract.md", good);
  assert.equal(b.r.status, 0);
  assert.ok(existsSync(b.html));
  assert.deepEqual(b.warns, []);
  const c = spawnSync("bash", [script, "--check", b.file], { encoding: "utf8" });
  assert.equal(c.status, 0);
  assert.match(c.stdout, /^fresh/);
});

const faulty = `${head}## Requirements
| ID | Requirement | Source |
|---|---|---|
| REQ-1 | One | Uma |
| REQ-3 | Three | Uma |
| NOT-1 | No charts | Uma |

## Evals
| ID | REQ | Check | Method | Result |
|---|---|---|---|---|
| EVAL-1 | REQ-1 | c | unit | not run |
| EVAL-4 | | c | unit | not run |
| EVAL-5 | REQ-9 | c | unit | not run |

## Infrastructure
| Resource | Defined in | Applied by | Secrets |
|---|---|---|---|
| Database | manual | dashboard | none |

## Observability
| Signal | Seen in | Eval |
|---|---|---|
| Errors | logs | EVAL-99 |

## Slices
### Slice 1: one
- Covers: REQ-1, REQ-8
- Model: m
- Depends on: none
- Files: a

### Slice 2: nocover
- Model: m
- Depends on: none
- Files: a
`;

const expected = [
  "warn: REQ-3: no eval",
  "warn: NOT-1: no eval",
  "warn: EVAL-4: no requirement",
  "warn: EVAL-5: unknown REQ-9",
  "warn: Slice 2: nocover: missing Covers:",
  "warn: Slice 1: one: unknown REQ-8",
  "warn: REQ-3: no slice covers it",
  "warn: infrastructure: Database: no file (manual)",
  "warn: observability: Errors: no eval",
];

test("each contract fault warns once and the build still succeeds", () => {
  const b = build("bad.contract.md", faulty);
  assert.equal(b.r.status, 0);
  assert.ok(existsSync(b.html));
  for (const w of expected) assert.equal(b.warns.filter((l) => l === w).length, 1, w);
  assert.equal(b.warns.length, expected.length, b.warns.join("\n"));
});

test("missing Infrastructure section and Observability rows warn", () => {
  const b = build("min.contract.md", `${head}## Requirements\n| ID | Requirement | Source |\n|---|---|---|\n`);
  assert.equal(b.r.status, 0);
  assert.ok(b.warns.includes("warn: no Infrastructure section"));
  assert.ok(b.warns.includes("warn: no Observability rows"));
});

test("an infrastructure row with the resource none gives no warning", () => {
  const b = build("none.contract.md", good.replace("| Hosting | `vercel.json` | git push | none |", "| none | | | |"));
  assert.deepEqual(b.warns, []);
});

test("a file not named .contract.md gets no contract warning", () => {
  const b = build("plan.md", faulty);
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, []);
});

test("a Slice heading inside a code fence is not linted", () => {
  const b = build("fence.md", `${head}Example:\n\n\`\`\`markdown\n### Slice 1: sample\n- Covers: REQ-1\n\`\`\`\n`);
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, []);
});

test("a Slice outside a fence without Model still warns", () => {
  const b = build("slice.md", `${head}### Slice A: x\n- Depends on: none\n- Files: a\n`);
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice A: x: missing Model:"]);
});
