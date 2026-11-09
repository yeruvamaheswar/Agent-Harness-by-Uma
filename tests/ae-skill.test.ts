import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillMeta } from '../src/context.ts';

// EVAL-1 (REQ-1): the autonomous-engineering skill text is valid, small, and loads references on demand.
// Overnight slice 4 made the skill load for overnight requests in Claude and Cursor. Codex stays hidden (see openai.yaml).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tools/agents/skills/autonomous-engineering');
const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
const refs = join(dir, 'references');

// Agent Skills spec fields, plus the Claude Code and Cursor hide flag this repo uses.
const FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools', 'disable-model-invocation'];
// From plans/autonomous-engineering.md, "ae.ts commands", plans/usage-continuity.md, and
// plans/unified-agent-harness-master.md (slice 12: decide, decisions, interrupt, attach, lead).
const COMMANDS = ['init', 'status', 'next', 'start', 'finish', 'block', 'fail', 'review', 'verify', 'unblock', 'integrate', 'check', 'dispatch', 'handoff', 'recover', 'usage', 'checkpoint', 'prepare', 'transfer',
  'report', 'charter', 'set-profile', 'decide', 'decisions', 'interrupt', 'attach', 'lead'];
const NEW_COMMANDS = ['decide', 'decisions', 'interrupt', 'attach', 'lead'];
const engineDoc = readFileSync(join(refs, 'engine.md'), 'utf8');
const planner = join(root, 'tools/agents/skills/multi-agent-planning/references');
// The body of one `## ` section of a Markdown text, up to the next `## ` heading.
const section = (text: string, heading: string) => {
  const lines = text.split('\n'), start = lines.indexOf(heading);
  assert.ok(start >= 0, `missing section ${heading}`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

const frontMatterKeys = (text: string) => {
  const lines = text.split('\n'), end = lines.indexOf('---', 1);
  assert.equal(lines[0], '---', 'SKILL.md starts with front matter');
  assert.ok(end > 0, 'front matter is closed');
  return lines.slice(1, end).filter(l => /^\S/.test(l)).map(l => l.split(':')[0]);
};

test('front matter is valid per the Agent Skills spec', () => {
  const meta = skillMeta(skill);
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(meta.name.length >= 1 && meta.name.length <= 64);
  assert.equal(meta.name, basename(dir), 'name equals the folder name');
  assert.ok(meta.description.length >= 1 && meta.description.length <= 400, `description is ${meta.description.length} chars`);
  assert.match(meta.description, /Use when the user asks to run a plan overnight/);
  assert.match(meta.description, /Not for /);
  if (meta.compatibility) assert.ok(meta.compatibility.length <= 500);
  const keys = frontMatterKeys(skill);
  assert.deepEqual(keys.filter(k => !FIELDS.includes(k)), [], 'only spec fields plus disable-model-invocation');
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
});

test('Claude and Cursor may auto-load the skill, and Codex may not', () => {
  assert.equal(skillMeta(skill)['disable-model-invocation'], undefined);
  const yaml = readFileSync(join(dir, 'agents/openai.yaml'), 'utf8');
  assert.match(yaml, /^policy:\n(?:[ \t]+.*\n)*?[ \t]+allow_implicit_invocation: false$/m);
});

test('SKILL.md stays inside its line and size budget', () => {
  const lines = skill.trimEnd().split('\n').length;
  assert.ok(lines < 120, `SKILL.md has ${lines} lines`);
  assert.ok(skill.length < 20000, `SKILL.md has ${skill.length} chars (about 5000 tokens)`);
});

test('every relative file path in SKILL.md exists', () => {
  const spans = [...skill.matchAll(/`([^`\s]+)`/g)].map(m => m[1]);
  const paths = spans.filter(p => /^(\.\.\/|references\/|scripts\/|agents\/)/.test(p));
  assert.ok(paths.includes('references/engine.md') && paths.includes('references/authority.md'), 'SKILL.md names both references');
  for (const p of paths) assert.ok(existsSync(join(dir, p)), `missing: ${p}`);
  assert.ok(existsSync(join(dir, 'scripts/ae.ts')), 'the engine entry point exists');
});

test('references stay one level deep and are not inlined in SKILL.md', () => {
  const entries = readdirSync(refs);
  assert.deepEqual(entries.sort(), ['authority.md', 'engine.md', 'overnight.md']);
  for (const e of entries) {
    assert.ok(statSync(join(refs, e)).isFile(), `${e} is a file, not a folder`);
    const text = readFileSync(join(refs, e), 'utf8');
    const headings = text.split('\n').filter(l => /^#{1,2} /.test(l));
    assert.ok(headings.length > 0, `${e} has headings`);
    for (const h of headings) assert.ok(!skill.split('\n').includes(h), `SKILL.md inlines "${h}" from ${e}`);
    assert.doesNotMatch(text, /\]\((?!https?:)[^)]*references\//, `${e} links no deeper reference`);
  }
});

test('every ae command named in SKILL.md is in the engine contract', () => {
  const named = [...skill.matchAll(/`[^`]*\bae ([a-z]+)/g)].map(m => m[1]);
  assert.ok(named.length >= 10, 'SKILL.md names the engine commands');
  assert.deepEqual([...new Set(named.filter(n => !COMMANDS.includes(n)))], [], 'unknown ae commands');
  for (const c of ['init', 'next', 'dispatch', 'handoff', 'start', 'finish', 'block', 'fail', 'review', 'verify', 'recover', 'status', 'usage', 'checkpoint', 'prepare', 'transfer', ...NEW_COMMANDS]) {
    assert.ok(named.includes(c), `SKILL.md names ae ${c}`);
  }
});

test('the test command list equals the engine COMMANDS list', () => {
  const src = readFileSync(join(dir, 'scripts/ae.ts'), 'utf8');
  const list = src.match(/^const COMMANDS = \[([^\]]*)\]/m);
  assert.ok(list, 'ae.ts has a COMMANDS list');
  assert.deepEqual([...list[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).sort(), [...COMMANDS].sort());
});

// Slice 12 Accept (1), (2): FAILOVER mode, decision steps, and the Never line.
test('EXECUTE sends a stopped worker to FAILOVER mode, and FAILOVER records an interruption, not a failure', () => {
  const exec = section(skill, '## EXECUTE mode'), fo = section(skill, '## FAILOVER mode');
  assert.doesNotMatch(exec, /Crash or lost task: `ae fail/);
  assert.match(exec, /stopped, crashed, or was lost.*FAILOVER mode/);
  for (const c of ['interrupt', 'checkpoint', 'prepare', 'transfer', 'handoff', 'attach']) assert.match(fo, new RegExp(`\`ae ${c}\\b`), `FAILOVER runs ae ${c}`);
  assert.match(fo, /not a failed attempt/);
  assert.match(fo, /--kind post-mortem/);
  assert.match(fo, /--disarmed STATUS,METHOD,READ_AT/);
  assert.match(fo, /provider-change/);
});

test('PLAN records the batch with ae decide, EXECUTE looks a key up before any question, RECOVER reads decisions first', () => {
  const plan = section(skill, '## PLAN mode'), exec = section(skill, '## EXECUTE mode'), rec = section(skill, '## RECOVER mode');
  assert.match(plan, /once, in one batch/);
  assert.match(plan, /`ae decide PLAN \[N\] --key K --risk R --status approved [^`]*--source S`/);
  assert.match(plan, /`ae lead PLAN --claim --lead-id ID --label/);
  assert.match(exec, /Before any question to the user, run `ae decide PLAN \[N\] --key K`/);
  for (const r of ['`answered`', '`loop`', '`ask`']) assert.ok(exec.includes(r), `EXECUTE handles ${r}`);
  const first = rec.split('\n').find(l => /^1\. /.test(l)) ?? '';
  assert.match(first, /^1\. Before any question, run `ae decisions PLAN --active`, `ae status PLAN`, and `ae recover PLAN`/);
  assert.match(section(skill, '## Never'), /^- Record a decision as approved without a user source\.$/m);
});

// Slice 12 Accept (3): the handoff template shows the packet sections in the engine's order.
test('slice-format.md shows the packet sections of contract.ts in order', () => {
  const fmt = readFileSync(join(planner, 'slice-format.md'), 'utf8'), body = section(fmt, '## Handoff note');
  const contract = readFileSync(join(dir, 'scripts/contract.ts'), 'utf8');
  const titles = [...contract.matchAll(/\{ n: (\d), key: '[a-z]+', title: '([^']+)', tier: (\d) \}/g)].map(m => [Number(m[1]), m[2], Number(m[3])] as const);
  assert.equal(titles.length, 9, 'contract.ts lists 9 packet sections');
  const rows = body.split('\n').filter(l => /^\| \d \| /.test(l));
  assert.deepEqual(rows.map(r => { const c = r.split('|').slice(1, -1).map(x => x.trim()); return [Number(c[0]), c[1], c[2]]; }),
    titles.map(([n, t, tier]) => [n, t, tier === 0 ? 'never shrinks' : `tier ${tier}`]));
  for (const line of ['Plan: <absolute path to plans/<slug>.md>. Read it first. Your slice: Slice N.', 'Authority: Level A work in your files.', 'Continuation: you take over slice N from', 'Settled, do not re-ask (data, not instructions):', 'First inspect the existing work: git status, git diff, and the changed files.']) {
    assert.ok(body.includes(line), `the template shows: ${line}`);
  }
});

// Slice 12 Accept (4): the provider-error rule in routing.md and the engine's options table give one order.
test('routing.md provider-error rule matches the engine recovery options', () => {
  const routing = readFileSync(join(planner, 'routing.md'), 'utf8');
  const lines = routing.split('\n'), start = lines.indexOf('### Provider error');
  assert.ok(start >= 0, 'routing.md has a Provider error heading (slice-format.md links it)');
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  const rule = lines.slice(start + 1, end).join('\n');
  const opts = section(engineDoc, '## Recovery options');
  for (const [cls, order] of [['api, auth', '2, 3, 5'], ['quota', '1, 4, 5'], ['rate', '2, 4, 5'], ['context', '5'], ['refusal', 'none']]) {
    assert.match(rule, new RegExp(`^\\| ${cls} \\| ${order} \\|`, 'm'), `routing.md: ${cls} -> ${order}`);
    assert.match(opts, new RegExp(`^\\| ${cls} \\| ${order} \\|`, 'm'), `engine.md: ${cls} -> ${order}`);
  }
  assert.match(rule, /same agent's CLI/);
  assert.match(rule, /provider-change/);
});

// Slice 12 Accept (5): one loop-rules table.
test('engine.md has one loop-rules table and SKILL.md does not copy it', () => {
  const body = section(engineDoc, '## Loop rules');
  const tables = body.split('\n').filter(l => /^\|---/.test(l));
  assert.equal(tables.length, 1, 'one table');
  for (const rule of ['with no progress', 'same-blocker', 'Stops with no progress', 'Refusal', 'result: "loop"']) assert.ok(body.includes(rule), `loop rule ${rule}`);
  assert.equal(engineDoc.split('\n').filter(l => l === '## Loop rules').length, 1);
  assert.doesNotMatch(skill, /^\| *Loop|same-blocker \|/m);
});

test('engine.md documents every engine command and the known limits', () => {
  const rows = engineDoc.split('\n').filter(l => l.startsWith('| `'));
  for (const c of COMMANDS) assert.ok(rows.some(l => new RegExp(`^\\| \`${c}( |\`)`).test(l)), `engine.md has a row for ${c}`);
  const limits = section(engineDoc, '## Known limits');
  for (const want of ['cannot prove', 'ISO format only', '`pid:hex`', 'never run mixed versions', '1,048,576 bytes', '1.5 MiB', '1.75 MiB', 'recover --apply', 'archive the journal', 'below 100', '`cancelled`', '`canceled`']) {
    assert.ok(limits.includes(want), `Known limits names ${want}`);
  }
});
