// Journal contract (plans/unified-agent-harness-master.md, Slice 1, Accept 3 and 4; REQ-23).
// ACC reads plans/*.run.json with a strict decoder; any violation drops the whole journal. This file mirrors its rules
// (agent-control-center core/src/workflows/sources.ts: MAX_PLAN_BYTES and the Journal zod object) and checks that
// every journal the engine writes passes them and holds no null. It also loads the journal fixture written by the
// 66c3cd6 engine (tests/fixtures/ae-journal-66c3cd6.json) and checks that it loads and saves with the same meaning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { journalPath, loadJournal, saveJournal, withLock } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { MAX_DECISION_EVIDENCE, MAX_DECISION_HISTORY, MAX_DECISION_TEXT, MAX_DECISIONS, MAX_WATCH } from '../tools/agents/skills/autonomous-engineering/scripts/contract.ts';
import { interruptedHook, moduleCommand, register, resultFields, sections } from '../tools/agents/skills/autonomous-engineering/scripts/hooks.ts';
import type { HookCtx } from '../tools/agents/skills/autonomous-engineering/scripts/hooks.ts';
import { identityHooks } from '../tools/agents/skills/autonomous-engineering/scripts/failover.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ae-journal-66c3cd6.json');
const LEAD = 'Claude (opus/high)';

// ---- the ACC decoder, mirrored ----
const MAX_BYTES = 2 * 1024 * 1024;
const AccJournal = z.object({
  schemaVersion: z.literal(1),
  plan: z.string().optional(),
  slices: z.record(
    z.string(),
    z.object({
      state: z.string(),
      attempts: z.array(z.object({ provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional() }).passthrough()).optional(),
      evidence: z.array(z.object({ kind: z.string(), command: z.string().optional(), exitCode: z.number().optional(), note: z.string().optional(), at: z.string(), stale: z.boolean().optional() })).optional(),
      checkpoints: z.array(z.object({ at: z.string(), lastCheck: z.string().optional(), next: z.string().optional() })).optional(),
      blocker: z.object({ reason: z.string() }).optional(),
    }),
  ),
});
// What ACC would do with the file: null when it drops the journal.
const accRead = (text: string) => {
  if (Buffer.byteLength(text) > MAX_BYTES) return null;
  const p = AccJournal.safeParse(JSON.parse(text));
  return p.success ? p.data : null;
};
const nullPaths = (v: unknown, at = '$'): string[] => v === null ? [at]
  : Array.isArray(v) ? v.flatMap((x, i) => nullPaths(x, `${at}[${i}]`))
  : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => nullPaths(x, `${at}.${k}`)) : [];
function assertContract(text: string, where: string) {
  assert.deepEqual(nullPaths(JSON.parse(text)), [], `${where}: no null in the journal`);
  assert.ok(accRead(text), `${where}: the ACC decoder accepts the journal`);
}

// The fixture's plan, as the generator wrote it (same text, so the definition digests match).
const fslice = (n: number, files: string, verify: string) => [`### Slice ${n}: s${n}`, `- Goal: goal ${n}`, '- Model: Codex (gpt-6.1-sol/high)', '- Review: Claude (opus/medium)', '- Fallback: Claude (sonnet/high)',
  '- Wave: 1 parallel', '- Depends on: none', `- Files: ${files}`, '- Out of scope: src/', `- Accept: accept ${n}`, `- Verify: ${verify}`, '- State: PLANNED', '- Evidence: none', ''].join('\n');
const FIXTURE_PLAN = `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-07\nplanner: multi-agent-slice-planner\nmode: sprint\n---\nSummary: fixture\n\n## Slices\n${[fslice(1, 'a.ts', '`test -f a.ts`'), fslice(2, 'b.ts', '`false`'), fslice(3, 'c.ts', '`true`')].join('\n')}\n## Open\n- none\n`;

function repo(planText: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-contract-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md'), jfile = journalPath(plan);
  writeFileSync(plan, planText);
  let t = Date.UTC(2026, 10, 8, 6);
  const now = () => new Date((t += 1000));
  const written: { cmd: string; text: string }[] = [];
  // every command; the journal as it is on disk after it
  const run = async (...argv: string[]) => {
    const out = await main(argv, { cwd: dir, now }) as any;
    try { written.push({ cmd: argv.join(' '), text: readFileSync(jfile, 'utf8') }); } catch { /* no journal yet */ }
    return out;
  };
  return { dir, plan, jfile, run, written, put: (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); } };
}

test('the mirrored decoder is as strict as ACC: a null, a wrong type, another schemaVersion, or 2 MiB drops the journal', () => {
  const base = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.ok(accRead(JSON.stringify(base)));
  const variant = (fn: (j: any) => void) => { const j = structuredClone(base); fn(j); return JSON.stringify(j); };
  assert.equal(accRead(variant(j => { j.slices['1'].attempts[0].provider = null; })), null, 'null provider');
  assert.equal(accRead(variant(j => { j.slices['1'].attempts[0].effort = null; })), null, 'null effort');
  assert.equal(accRead(variant(j => { j.slices['1'].evidence[0].exitCode = '0'; })), null, 'exitCode as text');
  assert.equal(accRead(variant(j => { j.slices['1'].checkpoints[0].next = ['a']; })), null, 'next not text');
  assert.equal(accRead(variant(j => { j.schemaVersion = 2; })), null, 'schemaVersion 2');
  assert.equal(accRead(variant(j => { j.slices['3'].blocker.reason = null; })), null, 'null blocker reason');
  assert.equal(accRead(variant(j => { j.pad = 'x'.repeat(MAX_BYTES); })), null, 'over 2 MiB');
  assert.ok(accRead(variant(j => { j.decisions = []; j.slices['1'].attempts[0].interruptions = []; })), 'unknown keys are fine');
});

test('Accept 3: the 66c3cd6 journal fixture loads and saves with the same meaning', async () => {
  const text = readFileSync(FIXTURE, 'utf8'), fixture = JSON.parse(text) as Journal;
  assertContract(text, 'fixture');
  assert.equal(fixture.decisions, undefined, 'written before decisions existed');
  // load, then save under the lock: only updatedAt changes
  const r = repo(FIXTURE_PLAN);
  copyFileSync(FIXTURE, r.jfile);
  const loaded = loadJournal(r.jfile);
  assert.equal(loaded.recoveredFromBackup, false);
  assert.equal(loaded.scrubbed, false);
  assert.deepEqual(loaded.journal, fixture);
  await withLock(r.jfile, () => saveJournal(r.jfile, loaded.journal, new Date(Date.UTC(2026, 10, 8, 7))));
  const saved = JSON.parse(readFileSync(r.jfile, 'utf8'));
  assert.equal(saved.updatedAt, '2026-11-08T07:00:00.000Z');
  assert.deepEqual({ ...saved, updatedAt: fixture.updatedAt }, fixture);
  assertContract(readFileSync(r.jfile, 'utf8'), 'fixture after save');

  // the new engine reads it with the same meaning
  const st = await r.run('status', r.plan);
  assert.deepEqual(Object.fromEntries(st.slices.map((s: any) => [s.id, s.state])), { 1: 'VERIFIED', 2: 'READY', 3: 'BLOCKED' }, 'no slice moved: the definitions match');
  assert.equal(st.slices[1].failures, 1);
  assert.equal(st.decisions, undefined, 'no decisions section for a journal without decisions');
  assert.deepEqual((await r.run('decisions', r.plan)).decisions, []);
  assert.equal((await r.run('decide', r.plan, '--key', 'storage.engine')).result, 'ask');
  const rep = await r.run('report', r.plan, '--json');
  assert.equal(rep.settled, 1);
  // the first write keeps every old field and adds only what it writes
  await r.run('decide', r.plan, '--key', 'storage.engine', '--risk', 'green', '--status', 'assumed', '--question', 'Which engine?', '--answer', 'sqlite', '--lead', LEAD);
  const after = JSON.parse(readFileSync(r.jfile, 'utf8'));
  assert.equal(after.decisions.length, 1);
  const { decisions: _d, updatedAt: _u, ...rest } = after;
  assert.deepEqual(rest, (({ updatedAt: _x, ...f }) => f)(fixture));
  assertContract(readFileSync(r.jfile, 'utf8'), 'fixture after a decide');
});

test('Accept 4: every journal written in a run that uses every new field passes the ACC decoder and holds no null', async () => {
  const slice = (n: number, files: string, verify: string, deps = 'none') => [`### Slice ${n}: s${n}`, `- Goal: goal ${n}`, '- Model: Codex (gpt-6.1-sol/high)', '- Review: Claude (opus/medium)',
    '- Fallback: Codex (gpt-6-astra/medium)', '- Wave: 1 parallel', `- Depends on: ${deps}`, `- Files: ${files}`, '- Out of scope: src/', `- Accept: accept ${n}`, `- Verify: ${verify}`,
    '- State: PLANNED', '- Evidence: none', ''].join('\n');
  const plan = `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-08\nplanner: multi-agent-slice-planner\nmode: sprint\n---\nSummary: contract\n\n## Slices\n${[
    slice(1, 'a.ts, lib/', '`test -f a.ts`'), slice(2, 'b.ts', '`test -f b.ts`'),
  ].join('\n')}\n## Open\n- none\n`;
  const r = repo(plan);
  await r.run('init', r.plan, '--allow', 'deps');
  await r.run('next', r.plan);
  // decisions: every status and both scopes
  await r.run('decide', r.plan, '--key', 'storage.engine', '--risk', 'amber', '--status', 'assumed', '--question', 'Which engine?', '--answer', 'sqlite', '--rollback', 'use files', '--lead', LEAD);
  await r.run('decide', r.plan, '--key', 'push', '--risk', 'red', '--status', 'blocked', '--question', 'May I push?', '--lead', LEAD);
  await r.run('decide', r.plan, '2', '--key', 'api.shape', '--risk', 'green', '--question', 'REST or RPC?', '--recommended', 'REST', '--lead', LEAD);
  await r.run('decide', r.plan, '--key', 'push', '--status', 'approved', '--answer', 'yes, the branch only', '--source', 'user-cli', '--lead', LEAD);
  // slice 1: start, worker milestone, interrupt with every optional field, post-mortem, prepare, transfer, attach
  await r.run('start', r.plan, '1', '--provider', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--task-id', 'task-1a');
  r.put('a.ts', 'export const a = 1;\n');
  r.put('lib/x.ts', 'export const x = 1;\n');
  await r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--kind', 'milestone', '--done', 'a.ts written');
  await r.run('interrupt', r.plan, '1', '--class', 'rate', '--code', '429', '--source', 'cli', '--retryable', 'true', '--reset-at', '2026-11-08T07:00:00Z', '--operation', 'send', '--lead', LEAD);
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem', '--next', 'add lib/y.ts');
  await r.run('prepare', r.plan, '1', '--to', 'Claude (sonnet/high)', '--lead', LEAD, '--reason', 'rate limit');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  await r.run('handoff', r.plan, '1');
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'task-1b', '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  r.put('lib/y.ts', 'export const y = 1;\n');
  await r.run('finish', r.plan, '1', '--launch-key', 'ae:p#1/a2');
  await r.run('review', r.plan, '1', '--by', 'reviewer', '--note', 'ok');
  await r.run('verify', r.plan, '1');
  // slice 2: block and unblock keep the worker's launch key; a failed verify records a number exit code
  await r.run('start', r.plan, '2');
  await r.run('block', r.plan, '2', '--reason', 'waits for the api decision');
  await r.run('unblock', r.plan, '2', '--reason', 'decided');
  await r.run('checkpoint', r.plan, '2', '--launch-key', 'ae:p#2/a1', '--next', 'write b.ts');
  await r.run('finish', r.plan, '2');
  await r.run('review', r.plan, '2', '--by', 'reviewer', '--note', 'ok');
  await r.run('verify', r.plan, '2');

  const j = JSON.parse(r.written.at(-1)!.text) as Journal;
  // the run used every new field the tracer writes
  const a = j.slices['1'].attempts;
  assert.ok(a[0].launchKey && a[0].baseTree && a[0].interruptions?.[0].retryable === true && a[0].interruptions[0].resolved === 'handed-off');
  assert.ok(j.slices['1'].checkpoints!.some(c => c.role === 'worker' && c.kind === 'milestone'));
  assert.ok(j.slices['1'].checkpoints!.some(c => c.role === 'lead' && c.kind === 'post-mortem' && c.delta?.length === 2 && c.attempt === 1));
  assert.ok(j.slices['1'].handoffs![0].launchKey);
  assert.equal(j.decisions!.length, 3);
  assert.equal(j.decisions!.find(d => d.key === 'push')!.status, 'approved');
  assert.equal(j.decisions!.find(d => d.key === 'push')!.provenance, 'attested');
  assert.equal(j.decisions!.find(d => d.key === 'api.shape')!.scope, 'slice:2');
  assert.deepEqual(j.slices['2'].attempts.filter(x => x.kind === 'work').map(x => x.launchKey), ['ae:p#2/a1', 'ae:p#2/a1'], 'the same worker keeps its key after unblock');
  assert.equal(j.slices['2'].attempts.at(-1)!.kind, 'verify');
  assert.equal(typeof j.slices['2'].attempts.at(-1)!.exitCode, 'number');
  assert.equal(j.schemaVersion, 1);
  // every journal on disk after every command
  assert.equal(r.written.length, 24, "one journal per command");
  for (const w of r.written) assertContract(w.text, `after "${w.cmd}"`);
  // and the .bak the last save kept
  assertContract(readFileSync(r.jfile + '.bak', 'utf8'), '.bak');
});

// R2: character limits cannot bound UTF-8 plus JSON escaping. The save boundary refuses the first over-budget ledger.
test('Accept 2 (R2): multibyte and JSON-escaped text at every free-text cap is byte-budgeted below 1 MiB', async () => {
  const j = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Journal;
  const t = (n: number) => '界"\\\n\u0001'.repeat(n).slice(0, n);
  const at = '2026-11-08T06:00:00.000Z';
  j.decisions = Array.from({ length: MAX_DECISIONS }, (_, i) => ({
    id: `D${i + 1}`, key: `k.${'x'.repeat(75)}${String(i).padStart(3, '0')}`, scope: 'slice:1', risk: 'amber', status: 'assumed',
    question: t(MAX_DECISION_TEXT), answer: t(MAX_DECISION_TEXT), recommended: t(MAX_DECISION_TEXT), rollback: t(MAX_DECISION_TEXT),
    source: 'file:' + '界"\\'.repeat(MAX_DECISION_TEXT).slice(0, MAX_DECISION_TEXT - 7) + ':1', provenance: 'attested', by: LEAD, sliceDigest: 'd'.repeat(12),
    evidence: Array.from({ length: MAX_DECISION_EVIDENCE }, () => t(100)),
    watch: Array.from({ length: MAX_WATCH }, (_, w) => ({ path: `src/${t(30)}-${w}.ts`, fp: 'f'.repeat(12), fpv: 2 })),
    at, updatedAt: at, history: Array.from({ length: MAX_DECISION_HISTORY }, () => ({ at, status: 'assumed', by: LEAD })),
  }));
  const text = JSON.stringify(j, null, 2), bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes > 1024 * 1024, `frozen character caps alone allow ${bytes} serialized bytes`);
  const r = repo(FIXTURE_PLAN); copyFileSync(FIXTURE, r.jfile);
  const before = readFileSync(r.jfile, 'utf8');
  await assert.rejects(withLock(r.jfile, () => saveJournal(r.jfile, j)), /decision write refused: .*serialized UTF-8 bytes.*1 MiB/);
  assert.equal(readFileSync(r.jfile, 'utf8'), before, 'refusal preserves the previous journal');
  // Find the largest prefix of full-cap decisions that fits the serialized budget. No field is cut silently.
  const all = j.decisions;
  let kept = all.length;
  while (Buffer.byteLength(JSON.stringify(j, null, 2) + '\n', 'utf8') >= 1024 * 1024) j.decisions = all.slice(0, --kept);
  await withLock(r.jfile, () => saveJournal(r.jfile, j));
  const saved = readFileSync(r.jfile, 'utf8');
  assert.ok(Buffer.byteLength(saved, 'utf8') < 1024 * 1024);
  assertContract(saved, 'largest admitted full-cap ledger');
  j.decisions = all.slice(0, kept + 1);
  await assert.rejects(withLock(r.jfile, () => saveJournal(r.jfile, j)), /decision write refused/);
  assert.equal(readFileSync(r.jfile, 'utf8'), saved);
});

// Review 1 (F1): the hook surface later tracks plug into. Each helper is inert with no module and refuses ambiguity.
test('Review 1: hook helpers merge module output and refuse collisions', () => {
  const c = { command: 'block' } as unknown as HookCtx;
  assert.ok(moduleCommand('attach') && moduleCommand('lead'), 'failover.ts provides attach and lead (slice 8)');
  register('failover', { ...identityHooks, commands: undefined });
  try {
    assert.equal(moduleCommand('attach'), undefined, 'no module provides attach');
    assert.deepEqual(resultFields(c, { state: 'BLOCKED' }), {});
    register('t-a', { result: () => ({ loop: 'same-blocker' }), commands: { attach: () => ({ ok: true }) }, interrupted: () => undefined });
    register('t-b', { interrupted: () => ({ block: { reason: 'refusal', cause: 'refusal' } }), statusSection: (_j, env) => ({ env: env?.root ?? 'none' }) });
    assert.deepEqual(resultFields(c, { state: 'BLOCKED' }), { loop: 'same-blocker' });
    assert.throws(() => resultFields(c, { loop: 'x' }), /already returns/);
    assert.deepEqual(moduleCommand('attach')!({} as never), { ok: true });
    assert.deepEqual(interruptedHook(c, {} as never, {} as never), { block: { reason: 'refusal', cause: 'refusal' } });
    assert.deepEqual(sections('statusSection', {} as never, { root: '/r' } as never).env, '/r');
    register('t-c', { commands: { attach: () => ({}) } });
    assert.throws(() => moduleCommand('attach'), /both provide attach/);
  } finally { for (const n of ['t-a', 't-b', 't-c']) register(n, {}); register('failover', identityHooks); }
});
