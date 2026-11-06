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

function plannerPage(mode: string, body: string) {
  return `---\nkind: plan\ntitle: T\nstatus: active\nupdated: 2026-10-25\nplanner: multi-agent-planning\nmode: ${mode}\n---\n${body}`;
}

function sliceBody(title: string, omit = "", overrides: Record<string, string> = {}) {
  const fields: [string, string][] = [
    ["Goal:", "one result"],
    ["Model:", "Cursor (auto)"],
    ["Review:", "Claude (opus/high)"],
    ["Fallback:", "Codex (auto)"],
    ["Wave:", "1 sequential"],
    ["Depends on:", "none"],
    ["Files:", "a.ts"],
    ["Accept:", "the check passes"],
    ["Verify:", "`npm test`"],
    ["State:", "PLANNED"],
    ["Evidence:", "none"],
  ];
  const lines = fields.filter(([k]) => k !== omit).map(([k, v]) => `- ${k} ${overrides[k] ?? v}`);
  return `### ${title}\n${lines.join("\n")}\n`;
}

const cleanPlanner = plannerPage("standard", [
  sliceBody("Slice 1: tracer", "", { "Wave:": "1 sequential", "Files:": "a.ts", "Depends on:": "none" }),
  sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": "b.ts", "Depends on:": "slice 1" }),
  sliceBody("Slice 3: ui", "", { "Wave:": "2 parallel", "Files:": "c.ts", "Depends on:": "slice 1" }),
].join("\n"));

test("a planner page with a tracer and two parallel slices warns nothing", () => {
  const b = build("planner.md", cleanPlanner);
  assert.equal(b.r.status, 0);
  assert.ok(existsSync(b.html));
  assert.deepEqual(b.warns, []);
});

test("planner lint warns when a slice lacks a required field", () => {
  for (const field of ["Goal:", "Review:", "Fallback:", "Wave:", "Accept:", "Verify:", "State:", "Evidence:"]) {
    const b = build("miss.md", plannerPage("standard", sliceBody("Slice 2: tag API", field)));
    assert.equal(b.r.status, 0);
    assert.deepEqual(b.warns, [`warn: Slice 2: tag API: missing ${field}`], field);
  }
});

test("planner lint warns when State is not a lifecycle state", () => {
  const b = build("state.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "State:": "planned" })));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 1: tracer: bad State: planned"]);
});

test("planner lint warns when VERIFIED or INTEGRATED has no evidence", () => {
  for (const state of ["VERIFIED", "INTEGRATED"]) {
    for (const [evidence, shown] of [["none", "none"], ["unknown", "unknown"], ["", "empty"]] as [string, string][]) {
      const b = build("evidence.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "State:": state, "Evidence:": evidence })));
      assert.equal(b.r.status, 0);
      assert.deepEqual(b.warns, [...(evidence === "" ? ["warn: Slice 1: tracer: empty Evidence:"] : []), `warn: Slice 1: tracer: ${state} Evidence: ${shown}`]);
    }
    const missing = build("evidence-missing.md", plannerPage("standard", sliceBody("Slice 1: tracer", "Evidence:", { "State:": state })));
    assert.equal(missing.r.status, 0);
    assert.deepEqual(missing.warns, [
      "warn: Slice 1: tracer: missing Evidence:",
      `warn: Slice 1: tracer: ${state} Evidence: missing`,
    ]);
  }
});

test("planner lint warns when Review equals Model", () => {
  const b = build("review.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", {
    "Model:": " codex (auto)",
    "Review:": "Codex (auto)",
  })));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 1: tracer: Review: equals Model:"]);
});

test("planner lint warns when Antigravity is routed", () => {
  const b = build("anti.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "Fallback:": "antigravity" })));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 1: tracer: Antigravity in Fallback:"]);
});

test("planner lint warns when Wave is not a number and a kind", () => {
  const b = build("wave.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "Wave:": "2 Parallel" })));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 1: tracer: Wave: 2 Parallel"]);
});

test("planner lint warns when parallel slices in one wave share a file", () => {
  const dot = " \u00b7 ";
  const pair = (left: string, right: string, rightWave = "2 parallel") => plannerPage("standard", [
    sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": left, "Depends on:": "none" }),
    sliceBody("Slice 3: ui", "", { "Wave:": rightWave, "Files:": right, "Depends on:": "none" }),
  ].join("\n"));
  const line = "warn: Slice 2: api, Slice 3: ui: overlap src/a.ts";
  for (const page of [
    pair("`src/a.ts`", "src/a.ts"),
    pair("src/**", "src/a.ts"),
    pair(`src/a.ts${dot}other.ts`, "src/a.ts"),
    pair("src/a.ts, keep.ts", "src/a.ts"),
    pair("src/a.ts", "src/a.ts", "2 sequential"),
  ]) {
    const b = build("overlap.md", page);
    assert.equal(b.r.status, 0);
    assert.deepEqual(b.warns, [line]);
  }
  const sequential = build("overlap-seq.md", pair("src/a.ts", "src/a.ts", "2 sequential").replace("2 parallel", "2 sequential"));
  assert.equal(sequential.r.status, 0);
  assert.deepEqual(sequential.warns, []);
});

test("planner lint warns when a slice depends on a slice in its wave", () => {
  const b = build("deps.md", plannerPage("standard", [
    sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": "b.ts", "Depends on:": "none" }),
    sliceBody("Slice 3: ui", "", { "Wave:": "2 parallel", "Files:": "c.ts", "Depends on:": "Slice 2" }),
  ].join("\n")));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 3: ui: Depends on: slice 2"]);
});

test("planner lint warns when mode is not a known mode", () => {
  const b = build("mode.md", plannerPage("turbo", sliceBody("Slice 1: tracer")));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: mode: turbo"]);
});

test("planner lint warns when quick mode shares a wave", () => {
  const b = build("quick.md", plannerPage("quick", [
    sliceBody("Slice 1: tracer", "", { "Wave:": "1 sequential", "Files:": "a.ts" }),
    sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": "b.ts", "Depends on:": "slice 1" }),
    sliceBody("Slice 3: ui", "", { "Wave:": "2 parallel", "Files:": "c.ts", "Depends on:": "slice 1" }),
  ].join("\n")));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, [
    "warn: mode quick: wave 2",
    "warn: mode quick: Slice 2: api: parallel wave",
    "warn: mode quick: Slice 3: ui: parallel wave",
    "warn: mode quick: 3 slices, expected 1",
  ]);
});

test("planner lint warns on one parallel slice in quick mode", () => {
  const b = build("quick-one.md", plannerPage("quick", sliceBody("Slice 1: fix", "", { "Wave:": "1 parallel" })));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: mode quick: Slice 1: fix: parallel wave"]);
});

test("planner lint warns on two sequential slices in quick mode", () => {
  const b = build("quick-two.md", plannerPage("quick", [
    sliceBody("Slice 1: fix", "", { "Wave:": "1 sequential", "Files:": "a.ts" }),
    sliceBody("Slice 2: more", "", { "Wave:": "2 sequential", "Files:": "b.ts", "Depends on:": "slice 1" }),
  ].join("\n")));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: mode quick: Slice 2: more: expected Wave: 1 sequential", "warn: mode quick: 2 slices, expected 1"]);
});

test("planner lint warns when Grok builds or is the fallback, not when it reviews", () => {
  const bad = build("grok.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "Model:": "Grok (default)", "Fallback:": "grok" })));
  assert.equal(bad.r.status, 0);
  assert.deepEqual(bad.warns, ["warn: Slice 1: tracer: Grok in Model:", "warn: Slice 1: tracer: Grok in Fallback:"]);
  const ok = build("grok-review.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "Review:": "Grok (default)" })));
  assert.deepEqual(ok.warns, []);
});

test("a page without planner gets no planner warning", () => {
  const b = build("plain.md", `${head}${sliceBody("Slice 1: tracer", "Review:")}`);
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, []);
});

test("a planner fault inside a code fence is not linted", () => {
  const b = build("planner-fence.md", plannerPage("standard", `${sliceBody("Slice 1: tracer")}
\`\`\`markdown
### Slice 9: bad
- Model: antigravity
- Review: antigravity
- Fallback: antigravity
- Wave: no
- State: VERIFIED
- Evidence: none
- Files: a.ts
- Depends on: slice 1
\`\`\`
`));
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, []);
});

test("planner lint runs on a quoted planner value and warns when mode is missing", () => {
  const page = `---\nkind: plan\ntitle: T\nstatus: active\nupdated: 2026-10-25\nplanner: "multi-agent-planning"\n---\n${sliceBody("Slice 1: tracer", "Review:")}`;
  const b = build("quoted.md", page);
  assert.equal(b.r.status, 0);
  assert.deepEqual(b.warns, ["warn: Slice 1: tracer: missing Review:", "warn: missing mode:"]);
});

test("planner lint reads slices N and M in Depends on", () => {
  const b = build("deps-and.md", plannerPage("standard", [
    sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": "b.ts", "Depends on:": "none" }),
    sliceBody("Slice 3: ui", "", { "Wave:": "2 parallel", "Files:": "c.ts", "Depends on:": "none" }),
    sliceBody("Slice 4: glue", "", { "Wave:": "2 parallel", "Files:": "d.ts", "Depends on:": "slices 2 and 3" }),
  ].join("\n")));
  assert.deepEqual(b.warns, ["warn: Slice 4: glue: Depends on: slice 2", "warn: Slice 4: glue: Depends on: slice 3"]);
});

test("planner lint wants Wave 1 sequential in quick mode", () => {
  const b = build("quick-int.md", plannerPage("quick", sliceBody("Slice 1: fix", "", { "Wave:": "1 integration" })));
  assert.deepEqual(b.warns, ["warn: mode quick: Slice 1: fix: expected Wave: 1 sequential"]);
});

test("planner lint wants only the architecture review in wave 2 of deep mode", () => {
  const slices = (second: string) => plannerPage("deep", [
    sliceBody("Slice 1: tracer", "", { "Wave:": "1 sequential", "Files:": "a.ts" }),
    sliceBody("Slice 2: review", "", { "Wave:": second, "Files:": "docs/review.md", "Depends on:": "slice 1" }),
    sliceBody("Slice 3: api", "", { "Wave:": "3 parallel", "Files:": "b.ts", "Depends on:": "slice 2" }),
  ].join("\n"));
  assert.deepEqual(build("deep-ok.md", slices("2 sequential")).warns, []);
  assert.deepEqual(build("deep-bad.md", slices("2 parallel")).warns, ["warn: mode deep: wave 2 must hold only the architecture-review slice, sequential"]);
});

test("planner lint normalizes owned paths like the graders", () => {
  const pair = (left: string, right: string) => plannerPage("standard", [
    sliceBody("Slice 2: api", "", { "Wave:": "2 parallel", "Files:": left, "Depends on:": "none" }),
    sliceBody("Slice 3: ui", "", { "Wave:": "2 parallel", "Files:": right, "Depends on:": "none" }),
  ].join("\n"));
  assert.deepEqual(build("dot.md", pair("src/b.ts", "./src/b.ts")).warns, ["warn: Slice 2: api, Slice 3: ui: overlap src/b.ts"]);
  assert.deepEqual(build("comma.md", pair("src/x.ts,src/c.ts", "src/c.ts")).warns, ["warn: Slice 2: api, Slice 3: ui: overlap src/c.ts"]);
  assert.deepEqual(build("dotdir.md", pair("server/./", "server/routes.js")).warns, ["warn: Slice 2: api, Slice 3: ui: overlap server/routes.js"]);
  assert.deepEqual(build("outside.md", pair("../x.ts", "c.ts")).warns, ["warn: Slice 2: api: Files: ../x.ts is outside the repo", "warn: Slice 2: api: Files: owns no path"]);
  assert.deepEqual(build("stars.md", pair("**", "c.ts")).warns, ["warn: Slice 2: api: Files: owns no path"]);
});

test("planner lint warns on a blank or repeated required field", () => {
  const blank = build("blank.md", plannerPage("standard", sliceBody("Slice 1: tracer", "", { "Verify:": "" })));
  assert.deepEqual(blank.warns, ["warn: Slice 1: tracer: empty Verify:"]);
  const twice = build("twice.md", plannerPage("standard", sliceBody("Slice 1: tracer").replace("- State: PLANNED", "- State: PLANNED\n- State: VERIFIED")));
  assert.deepEqual(twice.warns, ["warn: Slice 1: tracer: State: appears 2 times"]);
});

test("planner lint still runs on pages with the old planner name", () => {
  const page = `---\nkind: plan\ntitle: T\nstatus: active\nupdated: 2026-10-25\nplanner: multi-agent-slice-planner\nmode: standard\n---\n${sliceBody("Slice 1: tracer", "Review:")}`;
  assert.deepEqual(build("legacy.md", page).warns, ["warn: Slice 1: tracer: missing Review:"]);
});
