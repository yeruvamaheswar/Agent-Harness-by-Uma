import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillMeta } from '../src/context.ts';

// Slice 4 (REQ-8, REQ-9): the skill loads for overnight requests and overnight.md holds every rule the lead needs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tools/agents/skills/autonomous-engineering');
const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
const over = readFileSync(join(dir, 'references/overnight.md'), 'utf8');
const yaml = readFileSync(join(dir, 'agents/openai.yaml'), 'utf8');

const TITLES = ['Preflight', 'Charter rows and defaults', 'The loop', 'Waits', 'Provider errors and rate limits', 'Thread lifecycle', 'Crash recovery and supervisor', 'Stop conditions', 'Morning report', 'Runtime matrix', 'Stop or disable a run'];

const headings = (text: string) => text.split('\n').filter(l => /^## /.test(l));
const section = (text: string, n: number) => {
  const lines = text.split('\n'), start = lines.findIndex(l => l.startsWith(`## ${n}. `));
  assert.ok(start >= 0, `section ${n} exists`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
// ae commands named inside inline code spans. Fenced blocks are removed first so their fences do not pair up.
const named = (text: string) => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`[^`\n]*\bae ([a-z]+)/g)].map(m => m[1]);

test('front matter has no hide flag, and the description names the trigger and its limits', () => {
  const meta = skillMeta(skill);
  assert.equal(meta['disable-model-invocation'], undefined);
  assert.match(meta.description, /overnight/);
  assert.match(meta.description, /unattended/);
  assert.match(meta.description, /Not for /);
  assert.ok(meta.description.length <= 400, `description is ${meta.description.length} chars`);
});

test('openai.yaml keeps implicit invocation off, because Codex never leads', () => {
  assert.match(yaml, /^policy:\n(?:[ \t]+.*\n)*?[ \t]+allow_implicit_invocation: false$/m);
});

test('SKILL.md stays inside 120 lines and 20000 characters', () => {
  const lines = skill.trimEnd().split('\n').length;
  assert.ok(lines < 120, `SKILL.md has ${lines} lines`);
  assert.ok(skill.length < 20000, `SKILL.md has ${skill.length} chars`);
});

test('OVERNIGHT mode has at most 12 lines and opens with the worker rule', () => {
  const lines = skill.split('\n'), start = lines.indexOf('## OVERNIGHT mode');
  assert.ok(start >= 0, 'SKILL.md has an OVERNIGHT mode');
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end).filter(l => l.trim());
  assert.ok(body.length <= 12, `OVERNIGHT mode has ${body.length} lines`);
  assert.match(body[0], /received an `ae` handoff note is a worker/);
  assert.match(body[0], /`ae check`/);
  assert.match(body.join('\n'), /references\/overnight\.md/);
});

test('the skill and overnight reference refuse commit authority', () => {
  assert.match(skill, /Never commit, push, merge, or deploy\./);
  assert.doesNotMatch(skill + over, /ae commit|grant commit|commit grant/);
  assert.match(over, /No commits during the run/);
});

test('overnight.md has the 11 sections in order', () => {
  const found = headings(over).filter(h => /^## \d+\. /.test(h));
  assert.deepEqual(found, TITLES.map((t, i) => `## ${i + 1}. ${t}`));
});

test('section 9 keeps the Morning report text', () => {
  const body = section(over, 9);
  for (const part of ['Run `ae report PLAN` for a morning report, or `ae report PLAN --json` for JSON.', 'It reads commits reachable from HEAD with an exact `AE-Slice: PLAN#N` trailer.', 'A VERIFIED state is the journal\'s recorded result. Worker completion remains a claim.', 'Unavailable Git history is reported explicitly. A backup journal is identified when used.']) {
    assert.ok(body.includes(part), `missing: ${part}`);
  }
});

test('section 1 lists the warm-ups and ends with approval, then the charter', () => {
  const body = section(over, 1);
  for (const w of ['ae status PLAN', 'ae check PLAN -- git status', "first slice's Verify command", 'delegate_task` probe for each planned provider']) {
    assert.ok(body.includes(w), `missing warm-up: ${w}`);
  }
  for (const f of ['Why', 'Default', 'Consequence', 'Blocking']) assert.match(body, new RegExp(`\\| ${f} \\|`));
  assert.ok(body.indexOf('plan approval') > body.indexOf('ae status PLAN'), 'approval comes after the warm-ups');
  const last = body.trim().split('\n').filter(l => /^\d+\. /.test(l)).pop() ?? '';
  assert.match(last, /plan approval/);
  assert.match(last, /ae charter/);
});

test('section 2 covers the ten areas', () => {
  const body = section(over, 2);
  for (const a of ['Code edits', 'Dependencies', 'Branches and commits', 'Pull requests', 'External APIs', 'Spending', 'Deploys', 'Secrets', 'Destructive operations', 'Migrations']) {
    assert.match(body, new RegExp(`^\\| ${a} \\|`, 'm'), `missing area: ${a}`);
  }
  assert.match(body, /--approval PATH:LINE/);
  assert.match(body, /UTC offset/);
});

test('section 5 names the outage form, one wait, and never ae fail', () => {
  const body = section(over, 5);
  assert.ok(body.includes('--to "Codex (auto, fresh session)"'));
  assert.match(body, /get one wait only/);
  assert.match(body, /Never `ae fail` for a provider error/);
});

test('section 6 is a Symptom, Observed signal, Action table with no invented numbers', () => {
  const body = section(over, 6);
  const rows = body.split('\n').filter(l => l.startsWith('|'));
  assert.equal(rows[0], '| Symptom | Observed signal | Action |');
  const data = rows.slice(2);
  assert.ok(data.length >= 4, 'the table has rows');
  for (const r of data) {
    const cells = r.split('|').slice(1, -1).map(c => c.trim());
    assert.equal(cells.length, 3, `three cells: ${r}`);
    assert.ok(cells.every(Boolean), `no empty cell: ${r}`);
    assert.match(cells[1], /\(source: [^)]+\)/, `the signal names its source: ${r}`);
  }
  assert.doesNotMatch(body, /\d\s*%|percent|\d+\s*k?\s*tokens?\b|\btokens?\s*(count|left|used)\b/i, 'no percent or token count');
  assert.match(body, /thread-continuity\/SKILL\.md/);
  assert.match(body, /typed approval row/);
});

test('section 10 and 7 record the observed runtime facts', () => {
  const m = section(over, 10), c = section(over, 7);
  assert.match(m, /background `sleep` plus `t3_background_wait`/);
  assert.match(m, /\| Codex, Cursor, Grok \| Never \|/);
  assert.match(m, /No usage numbers/);
  assert.match(c, /Nothing restarts a lead/);
  assert.match(c, /caffeinate -i/);
  assert.match(c, /ae recover/);
  assert.match(section(over, 1), /7 hours/);
});

test('every ae command overnight.md names is in the engine', () => {
  const src = readFileSync(join(dir, 'scripts/ae.ts'), 'utf8');
  const list = src.match(/^const COMMANDS = \[([^\]]*)\]/m);
  assert.ok(list, 'ae.ts has a COMMANDS list');
  const engine = [...list[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  const names = named(over);
  assert.ok(names.length >= 12, 'overnight.md names the engine commands');
  assert.deepEqual([...new Set(names.filter(n => !engine.includes(n)))], [], 'unknown ae commands');
  for (const c of ['status', 'check', 'charter', 'next', 'report', 'recover', 'usage', 'prepare', 'checkpoint', 'transfer', 'handoff']) {
    assert.ok(names.includes(c), `overnight.md names ae ${c}`);
  }
});
