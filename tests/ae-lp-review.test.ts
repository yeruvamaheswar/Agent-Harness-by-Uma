// Slice 19: regressions for the Codex review of slice 12 and the lead patches.
// Engine commands run only in temporary repositories, never against the master plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath, loadJournal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { packet } from '../tools/agents/skills/autonomous-engineering/scripts/packet.ts';
import { definitionDigest, parsePlan } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';

const LEAD = 'Claude (opus/high)';
const slice = (id: number, deps: string) => [
  `### Slice ${id}: s${id}`, `- Goal: goal ${id}`, '- Model: Codex (gpt-6.1-sol/medium)',
  '- Review: Claude (opus/medium, fresh session)', '- Fallback: Claude (sonnet/medium)',
  `- Wave: ${id} sequential`, `- Depends on: ${deps}`, `- Files: f${id}.ts`,
  '- Out of scope: src/', `- Accept: accept ${id}`, `- Verify: \`test -f f${id}.ts\``,
  '- State: PLANNED', '- Evidence: none', '',
].join('\n');
const PLAN = `---\nkind: plan\ntitle: review\nstatus: active\nupdated: 2026-11-08\nplanner: multi-agent-slice-planner\nmode: standard\n---\nSummary: review regressions\n\n## Slices\n${slice(1, 'none')}\n${slice(2, '1')}\n${slice(3, 'none')}\n## Open\n- none\n`;

async function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-lp-review-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, PLAN);
  let time = Date.UTC(2026, 10, 8);
  const run = (...argv: string[]) => main(argv, { cwd: dir, now: () => new Date(time += 1000) });
  await run('init', plan);
  return {
    dir, plan, run,
    record: (scope: string, key: string) => run('decide', plan, '--scope', scope, '--key', key,
      '--risk', 'green', '--status', 'assumed', '--question', 'Which option?', '--answer', 'sqlite', '--lead', LEAD),
    journal: () => loadJournal(journalPath(plan)).journal,
  };
}

test('Accept 1 / F-1: dependency decisions use the owning digest; receiving changes do not make them stale', async () => {
  const r = await repo();
  await r.record('slice:1', 'dependency.engine');
  await r.record('run', 'run.engine');
  const journal = r.journal();
  const receiver = parsePlan(PLAN, r.plan).slices.find(s => s.id === '2');
  assert.ok(receiver);
  assert.notEqual(journal.slices['1'].definitionDigest, journal.slices['2'].definitionDigest);
  const note = () => packet(journal, receiver, 'dispatch', {
    planPath: r.plan, journalFile: journalPath(r.plan), label: 'Codex (gpt-6.1-sol/medium)',
  });
  assert.match(note().text, /dependency\.engine = sqlite/);
  assert.doesNotMatch(note().text, /\[re-check, do not rely\]/);

  const changed = parsePlan(PLAN.replace('- Goal: goal 2', '- Goal: changed receiving goal'), r.plan).slices.find(s => s.id === '2');
  assert.ok(changed);
  journal.slices['2'].definitionDigest = definitionDigest(changed);
  assert.doesNotMatch(note().text, /\[re-check, do not rely\]/);

  const owner = parsePlan(PLAN.replace('- Goal: goal 1', '- Goal: changed owning goal'), r.plan).slices.find(s => s.id === '1');
  assert.ok(owner);
  journal.slices['1'].definitionDigest = definitionDigest(owner);
  const settled = note().json.sections.find(s => s.key === 'settled');
  assert.ok(settled);
  assert.match(settled.items.find(i => i.text.includes('dependency.engine'))!.text, /\[re-check, do not rely\]/);
  assert.doesNotMatch(settled.items.find(i => i.text.includes('run.engine'))!.text, /\[re-check, do not rely\]/);
  assert.match(note().text, /dependency\.engine = sqlite.*\[re-check, do not rely\]/);
});

test('Accept 2 / F-2: running the shortened packet command includes run, own, and dependency decisions only', async () => {
  const r = await repo();
  await r.record('slice:1', 'dependency.engine');
  await r.record('slice:3', 'unrelated.engine');
  await r.record('run', 'run.engine');
  for (let i = 0; i < 25; i++) await r.record('slice:2', `own.choice-${i}`);
  const receiver = parsePlan(PLAN, r.plan).slices.find(s => s.id === '2');
  assert.ok(receiver);
  const note = packet(r.journal(), receiver, 'dispatch', {
    planPath: r.plan, journalFile: journalPath(r.plan), label: 'Codex (gpt-6.1-sol/medium)',
  });
  assert.ok(note.text.length < 2500);
  const command = note.text.match(/`(ae decisions [^`]+)`/);
  assert.ok(command, 'the shortened settled section gives a runnable lookup');
  assert.equal(command[1], `ae decisions ${r.plan} 2 --active`);
  const result = await r.run(...command[1].split(' ').slice(1));
  const listed = z.object({ decisions: z.array(z.object({ key: z.string() })) }).parse(result);
  const keys = listed.decisions.map(d => d.key).sort();
  assert.deepEqual(keys, ['dependency.engine', 'run.engine', ...Array.from({ length: 25 }, (_, i) => `own.choice-${i}`)].sort());
  assert.ok(!keys.includes('unrelated.engine'));
});

const engine = readFileSync(new URL('../tools/agents/skills/autonomous-engineering/references/engine.md', import.meta.url), 'utf8');
const phases = engine.split('### Phases\n')[1].split('### Journal records\n')[0];

test('Accept 3 / F-3: replacement stops use FAILOVER interrupts and work failures alone use fail', () => {
  assert.match(phases, /A replacement that stops is an `ae interrupt` handled by FAILOVER mode: the attempt stays open and takes no fix-budget step/);
  assert.match(phases, /Use `ae fail` only for a reported work failure/);
  assert.doesNotMatch(phases, /crashes is an ordinary `fail`/);
});

test('Accept 4 / F-4: search by launch key and attach before considering another launch', () => {
  assert.match(phases, /search T3 threads by the attempt's launch key/);
  assert.match(phases, /If found, attach it with `ae attach PLAN N --launch-key K --thread-id T --task-id X` before continuing/);
  assert.match(phases, /Only consider another launch after the search confirms no task was launched\. Never relaunch blindly/);
  assert.doesNotMatch(phases, /else delegate again/);
});

test('Accept 5 / F-5: the snapshot code table includes the Anthropic rate limit code', () => {
  const snapshot = engine.split('### Snapshot (`--snapshot FILE`)\n')[1].split('### Levels and actions\n')[0];
  assert.match(snapshot, /\| `rate_limit_exceeded`, `rate_limited`, `rate_limit_error` \| rate \|/);
});
