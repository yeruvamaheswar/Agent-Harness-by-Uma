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
// From plans/autonomous-engineering.md, "ae.ts commands", and plans/usage-continuity.md.
const COMMANDS = ['init', 'status', 'next', 'start', 'finish', 'block', 'fail', 'review', 'verify', 'unblock', 'integrate', 'check', 'dispatch', 'handoff', 'recover', 'usage', 'checkpoint', 'prepare', 'transfer'];

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
  for (const c of ['init', 'next', 'dispatch', 'handoff', 'start', 'finish', 'block', 'fail', 'review', 'verify', 'recover', 'status', 'usage', 'checkpoint', 'prepare', 'transfer']) {
    assert.ok(named.includes(c), `SKILL.md names ae ${c}`);
  }
});
