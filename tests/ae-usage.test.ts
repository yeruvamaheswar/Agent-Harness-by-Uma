import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAgent, assessSlice, DEFAULT_POLICY, parsePolicy, parseSnapshot, rankCandidates } from '../tools/agents/skills/autonomous-engineering/scripts/usage.ts';
import { journalPath } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';

// Usage-aware handoff (plans/usage-continuity.md). Usage data is always a fixture; no provider is called.
const P = DEFAULT_POLICY, NO_HOST = { caps: null, host: 'other' };
const snap = (agents: Record<string, unknown>) => parseSnapshot({ agents });
const quota = (usedPct: number | null) => ({ limits: [{ kind: 'quota', usedPct }] });
const LEAD = 'Claude (opus/high)';

// ---- usage.ts: risk ----
test('EVAL-1: thresholds give normal, assess, prepare, transfer; a policy override moves them', () => {
  const lvl = (n: number, p = P) => assessAgent('Codex', snap({ Codex: quota(n) }).agents.Codex, p).level;
  assert.deepEqual([60, 75, 88, 96].map(n => lvl(n)), ['normal', 'assess', 'prepare', 'transfer']);
  const strict = parsePolicy({ thresholds: { Codex: { assess: 50, prepare: 60, transfer: 70 } } });
  assert.equal(lvl(65, strict), 'prepare');
  assert.equal(assessAgent('Cursor', snap({ Cursor: quota(65) }).agents.Cursor, strict).level, 'normal', 'the override is per agent');
  // per kind: a context window is not a quota
  const ctx = parsePolicy({ thresholds: { context: { assess: 80, prepare: 90, transfer: 98 } } });
  assert.equal(assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'context', usedPct: 85 }] } }).agents.Codex, ctx).level, 'assess');
  assert.throws(() => parsePolicy({ thresholds: { default: { assess: 90, prepare: 80, transfer: 95 } } }), /assess <= prepare <= transfer/);
});

test('EVAL-2: no usable number gives unknown and continue, never a guessed percent', () => {
  for (const u of [undefined, {}, quota(null), { limits: [{ kind: 'quota', usedPct: 140 }] }]) {
    const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', snap(u ? { Codex: u } : {}), P, NO_HOST);
    assert.equal(r.risk.level, 'unknown');
    assert.equal(r.risk.limiting, null);
    assert.equal(r.action, 'continue');
    assert.match(r.text, /checkpoint/);
  }
});

test('EVAL-3: predicted remaining work above free capacity raises the level before any threshold', () => {
  const a = assessAgent('Codex', snap({ Codex: quota(50) }).agents.Codex, P, 60);
  assert.equal(a.level, 'prepare');
  assert.match(a.reasons.join(' '), /exceeds free quota capacity 50%/);
  assert.equal(assessAgent('Codex', snap({ Codex: quota(88) }).agents.Codex, P, 20).level, 'transfer', 'already preparing: the shortfall means transfer');
  assert.equal(assessAgent('Codex', snap({ Codex: quota(50) }).agents.Codex, P, 30).level, 'normal');
});

test('EVAL-4: a reached limit, with no warning, is exhausted', () => {
  assert.equal(assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'quota', reached: true }] } }).agents.Codex, P).level, 'exhausted');
  assert.equal(assessAgent('Codex', snap({ Codex: { code: 'rate_limit_exceeded' } }).agents.Codex, P).level, 'exhausted');
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', snap({ Codex: { code: 'usage_limit_reached' } }), P, NO_HOST);
  assert.equal(r.action, 'transfer-now');
});

// ---- usage.ts: replacement ----
test('EVAL-5: Fallback first; same agent, exhausted, and incapable agents are excluded; Grok never builds', () => {
  const s = snap({ Codex: quota(88), Claude: { limits: [{ kind: 'quota', reached: true }] } });
  const r = rankCandidates({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', false, s, parsePolicy({ ranks: { Cursor: 3 }, pool: ['Codex (auto)', 'Grok (default)', 'Claude (opus/high)', 'Cursor (auto)'] }), NO_HOST);
  assert.deepEqual(r.candidates.map(c => c.label), ['Cursor (auto)']);
  assert.equal(r.candidates[0].source, 'fallback');
  assert.equal(r.candidates[0].capacity, 'unknown');
  const why = Object.fromEntries(r.excluded.map(e => [e.label, e.reason]));
  assert.match(why['Codex (auto)'], /same agent/);
  assert.match(why['Grok (default)'], /never builds/);
  assert.match(why['Claude (opus/high)'], /capacity exhausted/);
  // default ranks: Cursor (2) cannot take an opus-level slice; the cheapest capable pool entry follows the Fallback
  const hard = rankCandidates({ model: 'Claude (opus/high)', fallback: 'Cursor (auto)' }, 'Claude (opus/high)', false, snap({}), P, NO_HOST);
  assert.deepEqual(hard.candidates.map(c => c.label), ['Codex (auto)']);
  const easy = rankCandidates({ model: 'Claude (sonnet/medium)', fallback: 'Codex (auto)' }, 'Claude (sonnet/medium)', false, snap({}), P, NO_HOST);
  assert.deepEqual(easy.candidates.map(c => c.label), ['Codex (auto)', 'Cursor (auto)'], 'Fallback first, then the cheapest');
});

test('EVAL-5: a context limit suggests a fresh session of the same agent first; caps exclude a missing provider', () => {
  const r = rankCandidates({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', true, snap({}), parsePolicy({ ranks: { Cursor: 3 } }), NO_HOST);
  assert.equal(r.candidates[0].label, 'Codex (auto, fresh session)');
  const caps = { providers: [{ providerInstanceId: 'codex', driverKind: 'codex', models: [], canRunChildTask: true }] };
  const c = rankCandidates({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', false, snap({}), parsePolicy({ ranks: { Cursor: 3 } }), { caps, host: 't3' });
  assert.match(c.excluded.find(e => e.label === 'Cursor (auto)')!.reason, /not listed/);
});

test('EVAL-6: no candidate with capacity gives block, never a blind pick', () => {
  const s = snap({ Codex: quota(97), Cursor: quota(99), Claude: quota(90) });
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', s, P, NO_HOST);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.action, 'block');
  assert.match(r.text, /ae checkpoint, then ae block/);
});

test('EVAL-12: low use and small remaining work gives continue and no candidates', () => {
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', snap({ Codex: quota(40) }), P, NO_HOST, 10);
  assert.equal(r.action, 'continue');
  assert.deepEqual(r.candidates, []);
});

test('EVAL-14: snapshot free text is redacted; usage.ts imports only engine files', () => {
  const s = snap({ Codex: { limits: [{ kind: 'quota', usedPct: 10, source: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' }] } });
  assert.doesNotMatch(JSON.stringify(s), /ghp_abc/);
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tools/agents/skills/autonomous-engineering/scripts/usage.ts'), 'utf8');
  for (const m of src.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^\.\/\w+\.ts$/);
});

// ---- engine: a temp repo with partial work ----
const PLAN = `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-10-27\nplanner: multi-agent-planning\nmode: quick\n---\nSummary: test\n\n## Slices
### Slice 1: backend service
- Goal: build the service
- Model: Codex (auto)
- Review: Claude (opus/high)
- Fallback: Cursor (auto)
- Wave: 1 sequential
- Depends on: none
- Files: svc/
- Out of scope: docs/
- Accept: the service test passes
- Verify: \`test -f svc/a.ts && test -f svc/b.ts\`
- State: PLANNED
- Evidence: none
- [ ] build it · Codex (auto) · Verify command passes · revert
\n## Open\n- none\n`;

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-usage-')));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, PLAN);
  g('add', '.'); g('commit', '-q', '-m', 'plan');
  let t = Date.UTC(2026, 9, 27);
  const run = (...argv: string[]) => main(argv, { cwd: dir, now: () => new Date((t += 1000)) }) as Promise<any>;
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
  const file = (name: string, data: unknown) => { const f = join(dir, '..', `${name}-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
  const journal = () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal;
  return { dir, plan, run, put, file, journal };
}
// READY -> IN_PROGRESS under Codex, with half the service written.
async function started() {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1', '--provider', 'codex', '--task-id', 'codex-task-1');
  r.put('svc/a.ts', 'export const a = 1;\n');
  return r;
}

for (const flag of ['snapshot', 'policy', 'caps']) {
  test(`usage: malformed --${flag} JSON never exposes file contents on stderr`, async () => {
    const r = repo();
    const engine = fileURLToPath(new URL('../tools/agents/skills/autonomous-engineering/scripts/ae.ts', import.meta.url));
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', engine, ...args], { cwd: r.dir, encoding: 'utf8' });
    const init = cli('init', r.plan);
    assert.equal(init.status, 0, init.stderr);
    await r.run('next', r.plan);
    const invalid = join(r.dir, 'invalid.json');
    writeFileSync(invalid, 'token: hunter2pass');
    const snapshot = r.file('snapshot', { agents: {} });
    const result = cli('usage', r.plan, '1', '--snapshot', flag === 'snapshot' ? invalid : snapshot,
      ...(flag === 'snapshot' ? [] : [`--${flag}`, invalid]));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`--${flag}`));
    assert.match(result.stderr, /not valid JSON/);
    assert.doesNotMatch(result.stderr, /hunter2pass/);
    assert.doesNotMatch(result.stderr, /token:/);
  });
}
async function prepared(r: Awaited<ReturnType<typeof started>>) {
  await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'Codex quota 88% and the rest will not fit');
  return r.run('checkpoint', r.plan, '1', '--done', 'svc/a.ts written', '--next', 'write svc/b.ts');
}

test('EVAL-7: only a Claude lead can prepare or transfer', async () => {
  const r = await started();
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', 'Codex (auto)', '--reason', 'x'), /only a Claude lead/);
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', 'me', '--reason', 'x'), /only a Claude lead/);
  await prepared(r);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', 'Cursor (auto)', '--task-id', 't2'), /only a Claude lead/);
});

test('EVAL-8: the checkpoint records partial work and the continuation note says to inspect it first', async () => {
  const r = await started();
  r.put('notes.txt', 'unowned');
  const cp = (await prepared(r)).checkpoint;
  assert.deepEqual(cp.changed, ['svc/a.ts']);
  assert.deepEqual(cp.unowned, ['notes.txt']);
  assert.match(cp.gitHead, /^[0-9a-f]{40}$/);
  assert.equal(cp.lastCheck, 'none');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'CHECKPOINTED');
  await assert.rejects(r.run('handoff', r.plan, '1', '--host', 'other'), /ae transfer first/, 'no note before ownership moves');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  const h = await r.run('handoff', r.plan, '1', '--host', 'other');
  assert.equal(h.continuation, true);
  assert.equal(h.target, 'Cursor (auto)');
  assert.ok(h.chars < 3500);
  for (const want of ['svc/a.ts', 'First inspect the existing work', 'Next: write svc/b.ts', 'do not rebuild', 'Run: `test -f svc/a.ts', 'from Codex (auto)']) assert.ok(h.text.includes(want), want);
});

test('EVAL-9 and end to end: Codex runs out, Cursor continues from the checkpoint, and verify decides', async () => {
  const r = await started();
  const s = r.file('snap', { agents: { Codex: { limits: [{ kind: 'quota', usedPct: 88 }] } } });
  const u = await r.run('usage', r.plan, '1', '--snapshot', s, '--remaining', '30', '--policy', r.file('pol', { ranks: { Cursor: 3 } }));
  assert.equal(u.risk.level, 'transfer');
  assert.equal(u.candidates[0].label, 'Cursor (auto)');
  assert.match(u.decidedBy, /Claude lead/);
  await prepared(r);
  const t = await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cursor-task-1', '--provider', 'cursor');
  assert.equal(t.state, 'IN_PROGRESS');
  assert.equal(t.failures, 0, 'a usage handoff is not a failed attempt');
  const rec = r.journal().slices['1'];
  assert.deepEqual(rec.attempts.map(a => [a.taskId, a.outcome ?? 'open']), [['codex-task-1', 'handed-off'], ['cursor-task-1', 'open']]);
  // the replacement writes only the missing part; svc/a.ts stays as Codex left it
  r.put('svc/b.ts', 'export const b = 2;\n');
  assert.equal(readFileSync(join(r.dir, 'svc/a.ts'), 'utf8'), 'export const a = 1;\n');
  const st = await r.run('status', r.plan);
  assert.deepEqual(st.slices[0].handoff, { phase: 'TRANSFERRED', to: 'Cursor (auto)' });
  await assert.rejects(r.run('verify', r.plan, '1'), /IN_PROGRESS/, 'no shortcut to VERIFIED');
  await r.run('finish', r.plan, '1', '--summary', 'b written');
  await r.run('review', r.plan, '1', '--by', 'claude-reviewer', '--note', 'diff ok');
  const v = await r.run('verify', r.plan, '1');
  assert.equal(v.verified, true);
  assert.match(readFileSync(r.plan, 'utf8'), /- State: VERIFIED/);
});

test('EVAL-10: transfer refuses when files changed after the checkpoint, and refuses a second task', async () => {
  const r = await started();
  await prepared(r);
  r.put('svc/a.ts', 'export const a = 3; // old worker still writing\n');
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't2'), /files changed after the checkpoint/);
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'CHECKPOINTED', 'nothing was written');
  await r.run('checkpoint', r.plan, '1', '--next', 'write svc/b.ts');
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't2');
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't3'), /already transferred to task t2/);
  await assert.rejects(r.run('start', r.plan, '1'), /IN_PROGRESS/, 'start cannot open a parallel worker');
});

test('EVAL-11: repeated steps are no-ops and recover names the next step of an interrupted handoff', async () => {
  const r = await started();
  await prepared(r);
  const again = await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'same');
  assert.equal(again.unchanged, true);
  const rec = await r.run('recover', r.plan);
  assert.equal(rec.readOnly, true);
  assert.deepEqual(rec.handoffs.map((h: any) => [h.slice, h.phase, h.to]), [['1', 'CHECKPOINTED', 'Cursor (auto)']]);
  assert.match(rec.handoffs[0].next, /old worker stopped.*ae transfer/);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't2');
  const twice = await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't2');
  assert.equal(twice.unchanged, true);
  assert.equal(r.journal().slices['1'].attempts.length, 2, 'no extra attempt');
});

test('EVAL-13: a failed replacement counts one failure, and a new handoff can start from TRANSFERRED', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't2');
  await r.run('prepare', r.plan, '1', '--to', 'Claude (opus/high)', '--lead', LEAD, '--reason', 'Cursor also hit its limit');
  assert.equal(r.journal().slices['1'].handoffs!.length, 2);
  assert.equal(r.journal().slices['1'].handoffs![1].from.label, 'Cursor (auto)');
  const r2 = await started();
  await prepared(r2);
  await r2.run('transfer', r2.plan, '1', '--lead', LEAD, '--task-id', 't2');
  const f = await r2.run('fail', r2.plan, '1', '--reason', 'cursor task crashed');
  assert.equal(f.state, 'READY');
  assert.equal(f.failures, 1);
});

test('EVAL-11: existing verification state survives a handoff; a failed verify before it stays in lastCheck', async () => {
  const r = repo();
  await r.run('init', r.plan); await r.run('next', r.plan);
  await r.run('start', r.plan, '1', '--task-id', 'c1');
  await r.run('finish', r.plan, '1');
  await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  await r.run('verify', r.plan, '1'); // fails: no files yet
  await r.run('start', r.plan, '1', '--task-id', 'c2');
  r.put('svc/a.ts', 'a');
  const cp = (await prepared(r)).checkpoint;
  assert.match(cp.lastCheck, /^verify exit 1/);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't3');
  assert.equal((await r.run('status', r.plan)).slices[0].failures, 1, 'budget carried over, not reset or raised');
});

test('EVAL-14: free text in checkpoint flags is redacted before the journal', async () => {
  const r = await started();
  await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'limit');
  await r.run('checkpoint', r.plan, '1', '--done', 'used API_TOKEN=supersecretvalue123 once');
  assert.doesNotMatch(readFileSync(journalPath(r.plan), 'utf8'), /supersecretvalue123/);
});

test('a handoff not transferred closes when the slice leaves IN_PROGRESS; its old checkpoint is never reused', async () => {
  const r = await started();
  await prepared(r);
  await r.run('finish', r.plan, '1', '--summary', 'Codex finished after all');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'CLOSED');
  await r.run('review', r.plan, '1', '--reject', '--by', 'rev', '--note', 'b.ts missing');
  const d = await r.run('handoff', r.plan, '1', '--host', 'other');
  assert.equal(d.continuation, undefined, 'READY: the normal note, not the old continuation');
  await r.run('start', r.plan, '1', '--task-id', 'c3');
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 't9'), /CLOSED/);
  const u = await r.run('usage', r.plan, '1', '--snapshot', r.file('s', { agents: {} }));
  assert.equal(u.current, 'Codex (auto)');
  const p2 = await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'again');
  assert.equal(p2.handoff.phase, 'PREPARED');
  assert.equal(r.journal().slices['1'].handoffs!.length, 2);
});

// ---- regressions from the independent review (2026-10-27) ----
test('review 1: an exhausted account is never offered as a fresh session of itself', () => {
  const slice = { model: 'Codex (auto)', fallback: 'Cursor (auto)' }, pol = parsePolicy({ ranks: { Cursor: 3 } });
  const tie = assessSlice(slice, 'Codex (auto)', snap({ Codex: { limits: [{ kind: 'quota', usedPct: 99 }, { kind: 'context', usedPct: 96 }] } }), pol, NO_HOST);
  assert.equal(tie.risk.limiting!.kind, 'quota', 'an account limit wins a tie');
  assert.ok(!tie.candidates.some(c => c.source === 'fresh-session'));
  const reached = assessSlice(slice, 'Codex (auto)', snap({ Codex: { limits: [{ kind: 'context', usedPct: 50 }, { kind: 'quota', reached: true }] } }), pol, NO_HOST);
  assert.equal(reached.action, 'transfer-now');
  assert.equal(reached.candidates[0].label, 'Cursor (auto)');
  const ctxOnly = assessSlice(slice, 'Codex (auto)', snap({ Codex: { limits: [{ kind: 'quota', usedPct: 40 }, { kind: 'context', usedPct: 97 }] } }), pol, NO_HOST);
  assert.equal(ctxOnly.candidates[0].label, 'Codex (auto, fresh session)');
  const ctxErr = assessSlice(slice, 'Codex (auto)', snap({ Codex: { limits: [{ kind: 'context', reached: true }] } }), pol, NO_HOST);
  assert.equal(ctxErr.candidates[0].source, 'fresh-session');
  assert.equal(assessAgent('Codex', snap({ Codex: quota(100) }).agents.Codex, P).level, 'exhausted', '100% used is the limit');
});

test('review 4 and 9: bad numbers, pool labels, and agent keys are never echoed raw; keys are normalized', () => {
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const s = parseSnapshot({ agents: { codex: { limits: [{ kind: 'quota', usedPct: tok }] }, 'Cursor (auto)': { limits: [{ kind: 'quota', reached: true }] }, [tok]: {} } });
  assert.deepEqual(Object.keys(s.agents).sort(), ['Codex', 'Cursor']);
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', s, P, NO_HOST);
  assert.doesNotMatch(JSON.stringify(r), /ghp_abc/);
  assert.equal(r.ignored!.length, 1);
  assert.equal(assessAgent('Cursor', s.agents.Cursor, P).level, 'exhausted', 'a lower-case or labeled key still counts');
  assert.doesNotMatch(JSON.stringify(parsePolicy({ pool: [`Codex (${tok})`] })), /ghp_abc/);
  assert.throws(() => parseSnapshot({ agents: { Codex: { limits: [{ kind: tok }] } } }), e => !String(e).includes('ghp_abc'));
});

test('review 5: the shortfall uses the scarcest quota or rate limit, never the context window', () => {
  const a = assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'quota', usedPct: 50 }, { kind: 'context', usedPct: 10 }] } }).agents.Codex, P, 60);
  assert.equal(a.level, 'prepare');
  const b = assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'quota', usedPct: 20 }, { kind: 'rate', usedPct: 60 }] } }).agents.Codex, P, 50);
  assert.equal(b.level, 'prepare');
  assert.equal(b.limiting!.kind, 'rate');
  assert.equal(assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'context', usedPct: 50 }] } }).agents.Codex, P, 90).level, 'unknown', 'no quota number: no shortfall, and no claim that the quota is fine');
});

test('review 10: a replacement is judged on its quota, not on its own context window', () => {
  const s = snap({ Codex: quota(96), Claude: { limits: [{ kind: 'context', reached: true }] } });
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Claude (opus/high)' }, 'Codex (auto)', s, P, NO_HOST);
  assert.equal(r.action, 'transfer');
  assert.deepEqual(r.candidates.map(c => c.label), ['Claude (opus/high)'], 'Claude is a candidate, not a false block');
});

test('review 11: a reached context limit is a session problem with a fresh-session suggestion', () => {
  const a = assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'context', reached: true }] } }).agents.Codex, P);
  assert.equal(a.level, 'exhausted');
  assert.equal(a.limiting!.kind, 'context');
  assert.equal(a.freshSession, true);
});

test('review 12: a rate code is an account limit; the OpenAI context code is a session limit', () => {
  const rate = assessAgent('Codex', snap({ Codex: { code: 'rate_limit_exceeded' } }).agents.Codex, P);
  assert.equal(rate.level, 'exhausted');
  assert.equal(rate.freshSession, false, 'a shared rate limit gets no fresh session');
  const ctx = assessAgent('Codex', snap({ Codex: { code: 'context_length_exceeded' } }).agents.Codex, P);
  assert.equal(ctx.level, 'exhausted');
  assert.equal(ctx.freshSession, true);
});

test('review 13: a throttled account gets no fresh session; a reached context limit is a session problem', () => {
  const throttle = assessAgent('Codex', snap({ Codex: { code: 'rate_limited' } }).agents.Codex, P);
  assert.equal(throttle.level, 'exhausted');
  assert.equal(throttle.freshSession, false, 'a throttled account gets no fresh session');
  const ctx = assessAgent('Codex', snap({ Codex: { limits: [{ kind: 'context', reached: true }] } }).agents.Codex, P);
  assert.equal(ctx.level, 'exhausted');
  assert.equal(ctx.freshSession, true, 'a context window is a session problem, not an account limit');
});

test('review 13: a replacement that is throttled is excluded, not offered as a candidate', () => {
  const s = snap({ Codex: quota(96), Claude: { limits: [{ kind: 'rate', reached: true }] } });
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Claude (opus/high)' }, 'Codex (auto)', s, P, NO_HOST);
  assert.equal(r.action, 'block');
  assert.deepEqual(r.candidates, []);
  assert.ok(r.excluded.some(e => e.label === 'Claude (opus/high)' && /exhausted/.test(e.reason)));
});

test('review 14 and 15: free text is never classified; only exact codes and reached limits count', () => {
  for (const text of ['usage limit reached', 'Context window: limit reached', 'HTTP 429 Too Many Requests', 'line 429 of parser', 'Unclosed quotation mark', 'throttle is not a function']) {
    assert.throws(() => parseSnapshot({ agents: { Codex: { error: text } } }), /"error" are not read/, text);
  }
  assert.throws(() => parseSnapshot({ agents: { Codex: { limitReached: true } } }), /"limitReached" and "error" are not read/);
  for (const code of ['Context window: limit reached', 'usage limit reached', 'HTTP 429', 'constructor']) {
    const s = parseSnapshot({ agents: { Codex: { code } } });
    assert.equal(assessAgent('Codex', s.agents.Codex, P).level, 'unknown', code);
    assert.equal(s.ignored.length, 1, `${code} is listed as ignored`);
  }
  assert.equal(assessAgent('Codex', parseSnapshot({ agents: { Codex: { code: ' Insufficient_Quota ' } } }).agents.Codex, P).level, 'exhausted', 'case and spaces are normalized');
  assert.equal(assessAgent('Claude', snap({ Claude: { limits: [{ kind: 'quota', usedPct: 99 }] } }).agents.Claude, P).level, 'transfer', 'a number, not a phrase, sets the level');
});

test('review 16: a field the engine does not read is refused, at agent and limit level; "reached" must be a boolean', () => {
  for (const agent of [{ reached: true }, { errorCode: 'usage_limit_reached' }, { message: 'x' }, [{ kind: 'quota', reached: true }]]) {
    assert.throws(() => parseSnapshot({ agents: { Codex: agent } }), /unknown field/, JSON.stringify(agent));
  }
  for (const limit of [{ kind: 'quota', reached: 'true' }, { kind: 'quota', reached: 1 }, { kind: 'quota', code: 'usage_limit_reached' }, { kind: 'quota', limitReached: true }, { kind: 'quota', error: 'usage limit reached' }]) {
    assert.throws(() => parseSnapshot({ agents: { Codex: { limits: [limit] } } }), /limit 0/, JSON.stringify(limit));
  }
});

test('review 16: a secret in an unknown code is redacted in the output, in any letter case', () => {
  for (const code of ['AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
    assert.doesNotMatch(JSON.stringify(parseSnapshot({ agents: { Codex: { code } } })), /AKIA|ghp_/i, code);
  }
});

test('review 16: each code sets its own kind, so only a context code opens a fresh session', () => {
  const quota = assessAgent('Codex', snap({ Codex: { code: 'insufficient_quota' } }).agents.Codex, P);
  assert.equal(quota.limiting!.kind, 'quota');
  assert.equal(quota.freshSession, false);
  const rate = assessAgent('Codex', snap({ Codex: { code: 'rate_limited' } }).agents.Codex, P);
  assert.equal(rate.limiting!.kind, 'rate');
  assert.equal(rate.freshSession, false);
  const ctx = assessAgent('Codex', snap({ Codex: { code: 'context_window_exceeded' } }).agents.Codex, P);
  assert.equal(ctx.limiting!.kind, 'context');
  assert.equal(ctx.freshSession, true);
});

test('review 16: a context-only limit names the same agent as a fresh session, not as sharing the limit', () => {
  const r = rankCandidates({ model: 'Codex (auto)', fallback: 'Codex (gpt-5)' }, 'Codex (auto)', true, snap({ Codex: { limits: [{ kind: 'context', reached: true }] } }), P, NO_HOST);
  assert.equal(r.candidates[0].label, 'Codex (auto, fresh session)');
  const why = Object.fromEntries(r.excluded.map(e => [e.label, e.reason]));
  assert.match(why['Codex (gpt-5)'], /fresh session is listed first/);
});

test('review 8: Grok never builds, and an unranked slice Model needs the highest rank', () => {
  const r = rankCandidates({ model: 'Claude (mythos/high)', fallback: 'Grok (default)' }, 'Claude (mythos/high)', false, snap({}), P, NO_HOST);
  assert.ok(!r.candidates.some(c => c.label.startsWith('Grok')));
  assert.equal(r.need, 3);
  assert.deepEqual(r.candidates.map(c => c.label), ['Codex (auto)']);
});

test('review 8: prepare refuses Grok', async () => {
  const r = await started();
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Grok (default)', '--lead', LEAD, '--reason', 'x'), /never builds/);
});

test('review 2: after a new prepare, handoff never returns the previous replacement note', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  await r.run('prepare', r.plan, '1', '--to', 'Claude (opus/high)', '--lead', LEAD, '--reason', 'Cursor low too');
  await assert.rejects(r.run('handoff', r.plan, '1', '--host', 'other'), /PREPARED handoff/);
  await r.run('checkpoint', r.plan, '1');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  const h = await r.run('handoff', r.plan, '1', '--host', 'other');
  assert.equal(h.target, 'Claude (opus/high)');
  assert.match(h.text, /from Cursor \(auto\)/);
});

test('review 3: ownership moves before delegation; a crash after delegation recovers by attaching the task', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD);            // claim: fingerprint still the checkpoint's
  await r.run('handoff', r.plan, '1', '--host', 'other');
  r.put('svc/b.ts', 'replacement already writing\n');           // delegated; then the lead crashed
  const rec = await r.run('recover', r.plan);
  assert.match(rec.handoffs[0].next, /attach it with ae transfer --task-id/);
  const t = await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  assert.equal(t.attached, 'cur-1');
  assert.equal((await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1')).unchanged, true);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-2'), /already transferred to task cur-1/);
  assert.deepEqual(r.journal().slices['1'].attempts.map(a => a.taskId), ['codex-task-1', 'cur-1']);
});

test('review 6: a worker that handed the slice off cannot review it', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  r.put('svc/b.ts', 'b');
  await r.run('finish', r.plan, '1');
  await assert.rejects(r.run('review', r.plan, '1', '--by', 'codex-task-1', '--note', 'ok'), /builder's task/);
  await assert.rejects(r.run('review', r.plan, '1', '--by', 'cur-1', '--note', 'ok'), /builder's task/);
});

test('review 7: a transfer closes when its attempt ends, and survives a block and unblock', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  await r.run('block', r.plan, '1', '--reason', 'needs a decision');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'TRANSFERRED', 'a block keeps the replacement');
  await r.run('unblock', r.plan, '1', '--reason', 'decided');
  const u = await r.run('usage', r.plan, '1', '--snapshot', r.file('s', { agents: {} }));
  assert.equal(u.current, 'Cursor (auto)', 'the replacement continues after unblock');
  await r.run('fail', r.plan, '1', '--reason', 'cursor crashed');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'CLOSED');
  await r.run('start', r.plan, '1', '--task-id', 'codex-2');
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1'), /CLOSED/, 'no false "unchanged"');
  assert.deepEqual((await r.run('recover', r.plan)).handoffs, []);
});

// ---- regressions from the second review (2026-10-27) ----
test('review 2.1: the usage advice gives the transfer-first order', () => {
  for (const pctUsed of [96, 100]) {
    const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', snap({ Codex: quota(pctUsed) }), parsePolicy({ ranks: { Cursor: 3 } }), NO_HOST);
    assert.match(r.text, /ae checkpoint.*ae transfer, ae handoff, delegate, ae transfer --task-id/);
  }
});

test('review 2.4 and 2.5: a rate and a context limit together exhaust the account; an unranked worker can get a fresh session', () => {
  const both = snap({ Codex: { limits: [{ kind: 'rate', reached: true }, { kind: 'context', reached: true }] } });
  const r = assessSlice({ model: 'Codex (auto)', fallback: 'Cursor (auto)' }, 'Codex (auto)', both, parsePolicy({ ranks: { Cursor: 3 } }), NO_HOST);
  assert.equal(r.risk.level, 'exhausted');
  assert.ok(!r.candidates.some(c => c.source === 'fresh-session'));
  const u = assessSlice({ model: 'Claude (fable/high)', fallback: 'Codex (auto)' }, 'Claude (fable/high)', snap({ Claude: { limits: [{ kind: 'context', usedPct: 99 }, { kind: 'quota', usedPct: 10 }] } }), P, NO_HOST);
  assert.equal(u.candidates[0].label, 'Claude (fable/high, fresh session)');
});

test('review 2.3: changing an open handoff to the current worker is refused', async () => {
  const r = await started();
  await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'x');
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Codex (auto)', '--lead', LEAD, '--reason', 'y'), /is the current worker/);
  const ok = await r.run('prepare', r.plan, '1', '--to', 'Codex (auto, fresh session)', '--lead', LEAD, '--reason', 'context only');
  assert.equal(ok.handoff.to, 'Codex (auto, fresh session)');
});

test('review 2.2 and 2.6: a definition change or a new handoff closes the old transfer; no stale owner remains', async () => {
  const r = await started();
  await prepared(r);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace('- Goal: build the service', '- Goal: build the service v2'));
  await r.run('status', r.plan);
  assert.equal(r.journal().slices['1'].state, 'READY');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'CLOSED');
  const u = await r.run('usage', r.plan, '1', '--snapshot', r.file('s', { agents: {} }));
  assert.equal(u.current, 'Codex (auto)');
  await r.run('start', r.plan, '1', '--task-id', 'codex-2');
  assert.deepEqual((await r.run('recover', r.plan)).handoffs, []);
  // an older TRANSFERRED handoff closes once a newer one takes over
  const q = await started();
  await prepared(q);
  await q.run('transfer', q.plan, '1', '--lead', LEAD, '--task-id', 'cur-1');
  await q.run('prepare', q.plan, '1', '--to', 'Claude (opus/high)', '--lead', LEAD, '--reason', 'again');
  await q.run('checkpoint', q.plan, '1');
  await q.run('transfer', q.plan, '1', '--lead', LEAD, '--task-id', 'opus-1');
  await q.run('finish', q.plan, '1');
  assert.deepEqual(q.journal().slices['1'].handoffs!.map(h => h.phase), ['CLOSED', 'CLOSED']);
});

// ---- dynamic model routing: Antigravity and named Codex models ----
test('Antigravity has rank 1: it can replace a cheap slice only; a usage snapshot may name it', () => {
  assert.equal(DEFAULT_POLICY.ranks.Antigravity, 1);
  const cheap = rankCandidates({ model: 'Claude (haiku/medium)', fallback: 'Antigravity (gemini-3.8-flash-low)' }, 'Claude (haiku/medium)', false, snap({}), P, NO_HOST);
  assert.equal(cheap.candidates[0].label, 'Antigravity (gemini-3.8-flash-low)'); assert.equal(cheap.candidates[0].source, 'fallback'); assert.equal(cheap.candidates[0].rank, 1);
  const mid = rankCandidates({ model: 'Claude (sonnet/medium)', fallback: 'Antigravity (gemini-3.8-flash-low)' }, 'Claude (sonnet/medium)', false, snap({}), P, NO_HOST);
  assert.match(mid.excluded.find(e => e.label === 'Antigravity (gemini-3.8-flash-low)')!.reason, /rank 1 is below the slice's need 2/);
  assert.ok(!DEFAULT_POLICY.pool.some(x => /antigravity/i.test(x)), 'the pool is unchanged');
  const s = parseSnapshot({ agents: { Antigravity: quota(90), 'Antigravity (gemini-3.8-flash-low)': { limits: [{ kind: 'rate', usedPct: 10 }] } } });
  assert.deepEqual(s.ignored, []); assert.equal(s.agents.Antigravity.limits!.length, 2);
  assert.equal(assessAgent('Antigravity', s.agents.Antigravity, P).level, 'prepare');
});

test('a named Codex model keeps the Codex rank and its own agent key', () => {
  const r = rankCandidates({ model: 'Codex (gpt-6.1-terra/low)', fallback: 'Antigravity (gemini-3.8-flash-low)' }, 'Codex (gpt-6.1-terra/low)', false, snap({}), P, NO_HOST);
  assert.equal(r.need, 3);
  assert.match(r.excluded.find(e => e.label === 'Antigravity (gemini-3.8-flash-low)')!.reason, /below the slice's need 3/);
  assert.equal(parseSnapshot({ agents: { 'Codex (gpt-6.1-terra/low)': quota(10) } }).agents.Codex.limits!.length, 1);
});

// ---- slice 5 (master plan): review 9 findings, re-checked. Every secret here is a harmless fake. ----
// Joined at run time, so the secret scanner sees no key block in this file.
const FAKE_PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----'].join(' ');
test('S5 review 9 M1: a secret in an unknown code is redacted as written, so case-sensitive shapes cannot escape', () => {
  for (const [code, leak] of [['AKIAIOSFODNN7EXAMPLE', /AKIAIOSFODNN7EXAMPLE/i], [FAKE_PEM, /MIIFAKE|PRIVATE KEY-----/i], [` ${FAKE_PEM} `, /MIIFAKE/i],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /ghp_/i]] as [string, RegExp][]) {
    const s = parseSnapshot({ agents: { Codex: { code } } });
    assert.doesNotMatch(JSON.stringify(s), leak, code);
    assert.equal(s.ignored.length, 1, 'the unknown code is listed as ignored');
    assert.equal(assessAgent('Codex', s.agents.Codex, P).level, 'unknown', 'an unknown code sets no limit');
  }
});

test('S5 review 9 M2: a reached mark at a level the engine does not read is refused, never dropped', () => {
  // top level, beside "agents"
  for (const raw of [{ agents: {}, Codex: { code: 'usage_limit_reached' } }, { agents: { Codex: {} }, reached: true }])
    assert.throws(() => parseSnapshot(raw), /unknown top-level field/, JSON.stringify(raw));
  // agent level and limit level
  assert.throws(() => parseSnapshot({ agents: { Codex: { reached: true } } }), /unknown field "reached"/);
  assert.throws(() => parseSnapshot({ agents: { Codex: { limits: [{ kind: 'quota', code: 'usage_limit_reached' }] } } }), /limit 0: unknown field "code"/);
  assert.throws(() => parseSnapshot({ agents: { Codex: { limits: [{ kind: 'quota', reached: 'yes' }] } } }), /"reached" must be true or false/);
  // the right levels still work
  assert.equal(assessAgent('Codex', parseSnapshot({ agents: { Codex: { code: 'usage_limit_reached' } } }).agents.Codex, P).level, 'exhausted');
  assert.equal(assessAgent('Codex', parseSnapshot({ agents: { Codex: { limits: [{ kind: 'rate', reached: true }] } } }).agents.Codex, P).level, 'exhausted');
});

test('S5 review 9 L1: every limit code in the engine.md table sets its own kind; other codes set no limit', () => {
  const table: [string, string][] = [['usage_limit_reached', 'quota'], ['insufficient_quota', 'quota'], ['rate_limit_exceeded', 'rate'], ['rate_limited', 'rate'],
    ['rate_limit_error', 'rate'], ['context_length_exceeded', 'context'], ['context_window_exceeded', 'context']];
  for (const [code, kind] of table) {
    const a = assessAgent('Codex', snap({ Codex: { code } }).agents.Codex, P);
    assert.equal(a.level, 'exhausted', code);
    assert.equal(a.limiting!.kind, kind, code);
    assert.equal(a.freshSession, kind === 'context', code);
  }
  for (const code of ['api_error', 'overloaded_error', 'server_error', 'authentication_error', 'invalid_api_key', 'permission_error']) {
    const s = snap({ Codex: { code } });
    assert.equal(assessAgent('Codex', s.agents.Codex, P).level, 'unknown', code);
    assert.deepEqual(s.ignored, [code], code);
  }
});
