// Slice 3 (plans/unified-agent-harness-master.md): the kernel. Two-phase verify and run-check, --wait-lock, fsync and
// crash safety of the save, the journal size guard, and the review-1 F1/F2 hook wiring of ae.ts.
// Every test uses its own temp repo; nothing touches the real repo or home.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { JOURNAL_CAP_BYTES, JOURNAL_WARN_BYTES, journalPath, loadJournal, saveJournal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { register } from '../tools/agents/skills/autonomous-engineering/scripts/hooks.ts';
import type { Hooks } from '../tools/agents/skills/autonomous-engineering/scripts/hooks.ts';

const AE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools/agents/skills/autonomous-engineering/scripts/ae.ts');
const LEAD = 'Claude (opus/high)';

type S = { n: number; files?: string; verify?: string; review?: string };
const slice = (s: S) => [
  `### Slice ${s.n}: s${s.n}`, `- Goal: goal ${s.n}`, '- Model: Claude (sonnet/high)', `- Review: ${s.review ?? 'Codex (auto)'}`, '- Fallback: Claude (opus/high)',
  '- Wave: 1 sequential', '- Depends on: none', `- Files: ${s.files ?? `f${s.n}.txt`}`, '- Out of scope: src/',
  `- Accept: accept ${s.n}`, `- Verify: ${s.verify ?? '`true`'}`, '- State: PLANNED', '- Evidence: none',
  '- [ ] do it · Claude (sonnet/high) · Verify command passes · revert', '',
].join('\n');
const planText = (slices: S[]) => `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-07\nplanner: multi-agent-slice-planner\nmode: standard\n---\nSummary: test\n\n## Slices\n${slices.map(slice).join('\n')}\n## Open\n- none\n`;

function repo(slices: S[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-kernel-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, planText(slices));
  let t = Date.UTC(2026, 10, 7);
  const now = () => new Date((t += 1000));
  const api = {
    dir, plan, jfile: journalPath(plan),
    run: (...argv: string[]) => main(argv, { cwd: dir, now }) as Promise<any>,
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    raw: () => readFileSync(journalPath(plan), 'utf8'),
    put: (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); },
    has: (rel: string) => existsSync(join(dir, rel)),
    // READY -> REVIEWED for one slice
    toReviewed: async (id: string) => {
      await api.run('start', plan, id);
      await api.run('finish', plan, id);
      await api.run('review', plan, id, '--by', 'rev', '--note', 'looks right');
    },
  };
  return api;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}
// A Verify command that marks it started, then waits for `go`, then runs `after` (a shell line).
const gate = (after = 'exit 0') => `touch started\nwhile [ ! -f go ]; do sleep 0.02; done\n${after}\n`;

// ---- Accept 1: two-phase verify ----
test('Accept 1: during a slow verify in another process, status and decide succeed; the verify then lands', async () => {
  const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
  r.put('gate.sh', gate());
  await r.run('init', r.plan); await r.run('next', r.plan); await r.toReviewed('1');
  const child = spawn(process.execPath, ['--experimental-strip-types', AE, 'verify', r.plan, '1'], { cwd: r.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const exited = new Promise<number | null>(res => child.on('close', res));
  try {
    await until(() => r.has('started'), 'the verify command to start');
    assert.equal(existsSync(r.jfile + '.lock'), false, 'no lock is held while the command runs');
    const st = await r.run('status', r.plan);
    assert.equal(st.slices[0].state, 'REVIEWED');
    const d = await r.run('decide', r.plan, '--key', 'kernel.check', '--risk', 'green', '--status', 'assumed', '--question', 'q?', '--answer', 'yes', '--lead', LEAD);
    assert.equal(d.created, true);
    r.put('go', '');
    assert.equal(await exited, 0, err);
  } finally { child.kill(); }
  const v = JSON.parse(out);
  assert.equal(v.verified, true);
  assert.equal(v.unstable, undefined);
  const j = r.journal();
  assert.equal(j.slices['1'].state, 'VERIFIED');
  assert.equal(j.decisions?.[0].key, 'kernel.check', 'the decision written during the run is kept');
});

test('Accept 1: a fingerprint change during verify records nothing, returns unstable: true, and takes no budget step', async () => {
  for (const exit of ['0', '1']) {
    const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
    r.put('gate.sh', `echo more >> f1.txt\nexit ${exit}\n`);
    await r.run('init', r.plan); await r.run('next', r.plan); await r.toReviewed('1');
    const before = r.raw();
    const v = await r.run('verify', r.plan, '1');
    assert.equal(v.unstable, true, `exit ${exit}`);
    assert.equal(v.verified, false);
    assert.deepEqual(v.changed, ['slice files (fingerprint)']);
    assert.equal(v.failures, 0, 'no budget step');
    assert.equal(r.raw(), before, `exit ${exit}: the journal is unchanged`);
    assert.equal(r.journal().slices['1'].state, 'REVIEWED');
  }
});

test('Accept 1: an attempt change during verify (a review rejection) records nothing from the verify', async () => {
  const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
  r.put('gate.sh', gate('exit 1'));
  await r.run('init', r.plan); await r.run('next', r.plan); await r.toReviewed('1');
  const running = r.run('verify', r.plan, '1');
  await until(() => r.has('started'), 'the verify command to start');
  const rej = await r.run('review', r.plan, '1', '--reject', '--by', 'rev2', '--note', 'a defect');
  assert.equal(rej.failures, 1);
  r.put('go', '');
  const v = await running;
  assert.equal(v.unstable, true);
  assert.ok(v.changed.includes('slice state') && v.changed.includes('attempts'), v.changed.join(', '));
  const rec = r.journal().slices['1'];
  assert.equal(rec.state, 'READY');
  assert.equal(rec.attempts.filter(a => a.outcome === 'failed').length, 1, 'only the rejection counts; the failing verify adds no step');
  assert.equal(rec.attempts.some(a => a.kind === 'verify'), false);
  assert.equal(rec.evidence.length, 0);
});

test('Accept 1: phase 3 reads the plan again, so a hand edit made during verify is kept', async () => {
  const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
  r.put('gate.sh', gate());
  await r.run('init', r.plan); await r.run('next', r.plan); await r.toReviewed('1');
  const running = r.run('verify', r.plan, '1');
  await until(() => r.has('started'), 'the verify command to start');
  writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace('## Open\n- none\n', '## Open\n- none\n- a note added by hand\n'));
  r.put('go', '');
  assert.equal((await running).verified, true);
  const text = readFileSync(r.plan, 'utf8');
  assert.match(text, /- a note added by hand/);
  assert.match(text, /- State: VERIFIED/);
});

test('Accept 1: a lock taken by another live process during the run discards the result after the relock wait', async () => {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const r = repo([{ n: 1, verify: `\`echo ${other.pid} > plans/p.run.json.lock\`` }]);
    await r.run('init', r.plan); await r.run('next', r.plan); await r.toReviewed('1');
    const before = r.raw();
    await assert.rejects(r.run('verify', r.plan, '1', '--wait-lock', '0.2'), /lost the journal lock while the command ran .*live pid .*Nothing was recorded/);
    assert.equal(r.raw(), before);
  } finally { other.kill(); }
});

// ---- run-check (slice 7 Accept 5 depends on it) ----
test('checkpoint --run-check runs without the lock and stores the check on the checkpoint, never in evidence', async () => {
  const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
  r.put('gate.sh', gate('echo checked; exit 3'));
  await r.run('init', r.plan); await r.run('next', r.plan); await r.run('start', r.plan, '1');
  const running = r.run('checkpoint', r.plan, '1', '--run-check');
  await until(() => r.has('started'), 'the check to start');
  assert.equal(existsSync(r.jfile + '.lock'), false, 'no lock is held while the check runs');
  r.put('go', '');
  const out = await running;
  const check = out.checkpoint.check;
  assert.equal(check.command, 'sh gate.sh');
  assert.equal(check.exitCode, 3);
  assert.equal(check.stable, true);
  assert.equal(check.fpBefore, check.fpAfter);
  assert.match(check.tail, /checked/);
  const rec = r.journal().slices['1'];
  assert.equal(rec.evidence.length, 0, 'never evidence');
  assert.equal(rec.attempts.filter(a => a.outcome === 'failed').length, 0, 'never a budget step');
  assert.equal(rec.state, 'IN_PROGRESS');
});

test('checkpoint --run-check: changed files give stable: false; a closed attempt gives unstable: true; a timeout writes no null', async () => {
  const r = repo([{ n: 1, verify: '`sh gate.sh`' }]);
  r.put('gate.sh', 'echo more >> f1.txt\n');
  await r.run('init', r.plan); await r.run('next', r.plan); await r.run('start', r.plan, '1');
  const moved = await r.run('checkpoint', r.plan, '1', '--run-check');
  assert.equal(moved.checkpoint.check.stable, false);
  assert.notEqual(moved.checkpoint.check.fpBefore, moved.checkpoint.check.fpAfter);

  r.put('gate.sh', gate());
  const before = r.journal().slices['1'].checkpoints!.length;
  const running = r.run('checkpoint', r.plan, '1', '--run-check');
  await until(() => r.has('started'), 'the check to start');
  await r.run('finish', r.plan, '1');
  r.put('go', '');
  const gone = await running;
  assert.equal(gone.unstable, true);
  assert.ok(gone.changed.includes('slice state'));
  assert.equal(r.journal().slices['1'].checkpoints!.length, before, 'nothing recorded');

  const t = repo([{ n: 1, verify: '`sleep 5`' }]);
  await t.run('init', t.plan); await t.run('next', t.plan); await t.run('start', t.plan, '1');
  const slow = await t.run('checkpoint', t.plan, '1', '--run-check', '--timeout', '0.3');
  assert.equal(slow.checkpoint.check.timedOut, true);
  assert.equal('exitCode' in slow.checkpoint.check, false, 'no exit code, never null');
  assert.doesNotMatch(t.raw(), /: null/);
});

// ---- Accept 2: --wait-lock ----
test('Accept 2: --wait-lock S waits for a live lock, then lands; fail-fast stays the default; S is 60 or less', async () => {
  const r = repo([{ n: 1 }]);
  await r.run('init', r.plan);
  writeFileSync(r.jfile + '.lock', String(process.pid));
  await assert.rejects(r.run('status', r.plan), /locked by live pid/, 'fail-fast by default');
  setTimeout(() => unlinkSync(r.jfile + '.lock'), 300);
  const started = Date.now();
  assert.equal((await r.run('next', r.plan, '--wait-lock', '5')).profile, 'balanced');
  assert.ok(Date.now() - started >= 250, 'it waited');
  assert.equal(existsSync(r.jfile + '.lock'), false, 'released');

  writeFileSync(r.jfile + '.lock', String(process.pid));
  await assert.rejects(r.run('status', r.plan, '--wait-lock', '0.3'), /locked by live pid .*waited/);
  unlinkSync(r.jfile + '.lock');
  await assert.rejects(r.run('status', r.plan, '--wait-lock', '61'), /--wait-lock must be a number of seconds from 0 to 60/);
  await assert.rejects(r.run('status', r.plan, '--wait-lock', 'soon'), /--wait-lock must be/);
});

// ---- Accept 3: fsync and crash safety ----
const FS_OPS = ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'] as const;
function fsSpy() {
  const log: { op: string; arg: string }[] = [], paths = new Map<number, string>();
  let armed = false, crashAt = -1, crashBefore = false, n = 0;
  const mocks = FS_OPS.map(op => {
    const real = (fs as any)[op].bind(fs);
    return mock.method(fs, op, (...a: any[]) => {
      if (!armed) return real(...a);
      const i = n++, arg = op === 'openSync' || op === 'renameSync' ? String(a[op === 'renameSync' ? 1 : 0]) : paths.get(a[0]) ?? String(a[0]);
      if (i === crashAt && crashBefore) throw new Error(`crash before ${op}`);
      const res = real(...a);
      if (op === 'openSync') paths.set(res, String(a[0]));
      log.push({ op, arg: op === 'renameSync' ? `${a[0]} -> ${a[1]}` : arg });
      if (i === crashAt) throw new Error(`crash after ${op}`);
      return res;
    });
  });
  syncBuiltinESMExports();
  return {
    log, count: () => n,
    arm(at = -1, before = false) { log.length = 0; paths.clear(); n = 0; crashAt = at; crashBefore = before; armed = true; },
    disarm() { armed = false; },
    restore() { armed = false; for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); },
  };
}

test('Accept 3: save fsyncs the temp file before the rename and the folder after it', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-fsync-'))), file = join(dir, 'p.run.json');
  const j = { schemaVersion: 1, plan: 'p.md', slices: {}, marker: 'old' } as unknown as Journal;
  writeFileSync(file + '.lock', String(process.pid));
  writeFileSync(file, JSON.stringify(j));
  const spy = fsSpy();
  try {
    spy.arm();
    saveJournal(file, { ...j, marker: 'new' } as unknown as Journal);
    spy.disarm();
  } finally { spy.restore(); }
  // two atomic writes: the .bak, then the journal
  for (const target of [file + '.bak', file]) {
    const ren = spy.log.findIndex(e => e.op === 'renameSync' && e.arg.endsWith(` -> ${target}`));
    assert.ok(ren >= 0, `renamed onto ${target}`);
    const tmp = spy.log[ren].arg.split(' -> ')[0];
    assert.match(tmp, /\.\d+\.[0-9a-f]+\.tmp$/);
    const synced = spy.log.findIndex(e => e.op === 'fsyncSync' && e.arg === tmp);
    assert.ok(synced >= 0 && synced < ren, `the temp file of ${target} is fsynced before its rename`);
    const dirSync = spy.log.findIndex((e, i) => i > ren && e.op === 'fsyncSync' && e.arg === dir);
    assert.ok(dirSync > ren, `the folder is fsynced after the rename onto ${target}`);
  }
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).marker, 'new');
});

test('Accept 3: a crash at any step of the save leaves a whole journal (old or new) and a whole .bak', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-crash-'))), file = join(dir, 'p.run.json');
  const old = { schemaVersion: 1, plan: 'p.md', slices: {}, marker: 'old' } as unknown as Journal;
  const reset = () => {
    for (const n of readdirSync(dir)) if (n.endsWith('.tmp')) unlinkSync(join(dir, n));
    writeFileSync(file, JSON.stringify(old)); writeFileSync(file + '.bak', JSON.stringify({ ...old, marker: 'older' }));
    writeFileSync(file + '.lock', String(process.pid));
  };
  const spy = fsSpy();
  let steps = 0, crashes = 0;
  try {
    reset(); spy.arm(); saveJournal(file, { ...old, marker: 'new' } as unknown as Journal); spy.disarm();
    steps = spy.count();
    const ref = spy.log.map(e => e.op);
    assert.ok(steps >= 2 * 8, `two atomic writes of about 8 fs steps each (saw ${steps})`);
    for (let at = 0; at < steps; at++) {
      for (const before of [true, false]) {
        if (before && ref[at] === 'closeSync') continue; // a crash before close would leak the descriptor in this process
        spy.disarm(); reset(); spy.arm(at, before);
        assert.throws(() => saveJournal(file, { ...old, marker: 'new' } as unknown as Journal), /crash/);
        spy.disarm(); crashes++;
        const main = JSON.parse(readFileSync(file, 'utf8')), bak = JSON.parse(readFileSync(file + '.bak', 'utf8'));
        assert.ok(['old', 'new'].includes(main.marker), `step ${at}: the journal is whole (${main.marker})`);
        assert.ok(['older', 'old'].includes(bak.marker), `step ${at}: the .bak is whole (${bak.marker})`);
        assert.equal(loadJournal(file).recoveredFromBackup, false, `step ${at}: the journal loads without the .bak`);
      }
    }
  } finally { spy.restore(); }
  assert.ok(crashes > steps, `crashed at ${crashes} points`);
});

// ---- Accept 5: journal size ----
// Pads the journal on disk with a history row of `bytes` characters (plain words, so redaction keeps it).
function pad(r: ReturnType<typeof repo>, bytes: number) {
  const j = r.journal();
  j.slices['1'].history.unshift({ at: '2026-11-07T00:00:00.000Z', from: 'PLANNED', to: 'READY', reason: 'pad '.repeat(Math.ceil(bytes / 4)) });
  writeFileSync(r.jfile, JSON.stringify(j, null, 2) + '\n');
}

test('Accept 5: status reports journalBytes and warns above 1 MiB', async () => {
  const r = repo([{ n: 1 }]);
  await r.run('init', r.plan);
  const small = await r.run('status', r.plan);
  assert.equal(small.journalBytes, Buffer.byteLength(r.raw()));
  assert.equal(small.journalWarning, undefined);
  pad(r, JOURNAL_WARN_BYTES + 1000);
  const big = await r.run('status', r.plan);
  assert.ok(big.journalBytes > JOURNAL_WARN_BYTES);
  assert.match(big.journalWarning, /above 1 MiB/);
});

test('Accept 5: above 1.5 MiB a write that grows the journal is refused, while state moves pass', async () => {
  const r = repo([{ n: 1 }, { n: 2 }]);
  await r.run('init', r.plan); await r.run('next', r.plan); await r.run('start', r.plan, '1');
  pad(r, JOURNAL_CAP_BYTES + 1000);
  const before = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--note', 'progress'), /checkpoint refused: the journal would grow to \d+ bytes, above the 1\.5 MiB cap .*Nothing was written/);
  await assert.rejects(r.run('decide', r.plan, '--key', 'a.b', '--risk', 'green', '--status', 'assumed', '--question', 'q', '--answer', 'a', '--lead', LEAD), /decide refused: the journal would grow/);
  assert.equal(r.raw(), before, 'nothing was written');
  assert.equal((await r.run('finish', r.plan, '1')).state, 'AGENT_FINISHED', 'a state move passes');
  assert.equal((await r.run('start', r.plan, '2')).state, 'IN_PROGRESS', 'a state move passes');
  assert.ok(Buffer.byteLength(r.raw()) > JOURNAL_CAP_BYTES);
});

// ---- Accept 6: review-1 F1 and F2 wiring ----
test('Accept 6: attach and lead keep their refusal when no module provides them', async () => {
  const r = repo([{ n: 1 }]);
  await r.run('init', r.plan);
  await assert.rejects(r.run('attach', r.plan, '1', '--thread-id', 'T1'), /attach: not built yet/);
  await assert.rejects(r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD), /lead: not built yet/);
});

test('Accept 6: every hook in hooks.ts is called from ae.ts, and the F2 flags parse', async () => {
  const calls: string[] = [], env: Record<string, string | undefined> = {};
  const hooks: Hooks = {
    guardWrite(c, s) { calls.push(`guardWrite:${c.command}:${s?.s.id ?? '-'}`); if (c.flags.has('exception') && c.command === 'integrate') throw new Error('kernel test: refused'); },
    guardEvent(c, event) { calls.push(`guardEvent:${event}`); },
    decided(c, d, created) { calls.push(`decided:${d.id}:${created}`); const w = c.flags.get('watch'); if (w) d.watch = [{ path: w, fp: 'x', fpv: 2 }]; },
    interrupted(c, open, i) { calls.push(`interrupted:${open.n}:${i.class}`); return i.class === 'refusal' ? { block: { reason: 'refused by the provider', cause: 'refusal' } } : undefined; },
    result(c) { return { kernel: c.command }; },
    commands: {
      attach(c) { const h = c as typeof c & { s?: { id: string } }; return { attached: h.s?.id, thread: c.flags.get('thread-id') }; },
      lead(c) { c.journal.lead = { id: c.flags.get('lead-id')!, label: c.flags.get('label')!, claimedAt: c.at, renewedAt: c.at, ttlS: 7200, history: [{ at: c.at, id: c.flags.get('lead-id')!, event: 'claim' }] }; return { claimed: c.flags.get('claim') === 'true' }; },
    },
    decisionStale() { return true; },
    statusSection(j, e) { env.status = e?.root; return undefined; },
    reportSection(j, e) { return e ? { kernelReportRoot: e.root } : undefined; },
    recoverSection(j, e) { env.recover = e?.root; return undefined; },
  };
  register('kernel-test', hooks);
  try {
    const r = repo([{ n: 1 }, { n: 2 }]);
    await r.run('init', r.plan);
    assert.equal(calls.some(x => x.startsWith('guardWrite:init')), false, 'init runs no guardWrite');
    await r.run('next', r.plan);
    const st = await r.run('start', r.plan, '1');
    assert.equal(st.kernel, 'start', 'result fields reach slice command output');
    assert.ok(calls.includes('guardWrite:next:-') && calls.includes('guardWrite:start:1'));

    // decide: decided hook fills from its own flag; lookup is read-only and runs no guardWrite
    const d = await r.run('decide', r.plan, '1', '--key', 'a.b', '--risk', 'green', '--status', 'assumed', '--question', 'q', '--answer', 'yes', '--watch', 'f1.txt', '--lead', LEAD);
    assert.ok(calls.includes('decided:D1:true'));
    assert.deepEqual(r.journal().decisions![0].watch, [{ path: 'f1.txt', fp: 'x', fpv: 2 }]);
    const n = calls.length;
    await r.run('decide', r.plan, '--key', 'a.b');
    assert.equal(calls.slice(n).some(x => x.startsWith('guardWrite')), false, 'a lookup is read-only');
    assert.equal(d.kernel, undefined, 'decide is not a slice command');

    // interrupt: a module block moves the slice to BLOCKED; the attempt ends blocked; no budget step
    const it = await r.run('interrupt', r.plan, '1', '--class', 'refusal', '--source', 'lead', '--lead', LEAD);
    assert.ok(calls.includes('interrupted:1:refusal') && calls.includes('guardEvent:interrupt'));
    assert.equal(it.state, 'BLOCKED');
    assert.deepEqual(it.blocked, { reason: 'refused by the provider', cause: 'refusal' });
    assert.equal(it.failures, 0);
    const rec = r.journal().slices['1'];
    assert.equal(rec.blocker!.cause, 'refusal');
    assert.equal(rec.attempts.at(-1)!.outcome, 'blocked');
    const ub = await r.run('unblock', r.plan, '1', '--reason', 'user approved another provider');
    assert.equal(ub.to, 'IN_PROGRESS');
    assert.equal(ub.kernel, 'unblock');

    // transfer runs guardEvent('transfer')
    await r.run('prepare', r.plan, '1', '--to', LEAD, '--lead', LEAD, '--reason', 'quota');
    await r.run('checkpoint', r.plan, '1');
    const tr = await r.run('transfer', r.plan, '1', '--lead', LEAD);
    assert.ok(calls.includes('guardEvent:transfer'));
    assert.equal(tr.kernel, 'transfer');
    const cont = await r.run('handoff', r.plan, '1');
    assert.match(cont.text, /D1 a\.b = yes .*\[re-check, do not rely\]/, 'decisionStale gets the root through packetEnv');

    // attach and lead dispatch to the module command; attach runs guardEvent('attach') first
    const at = await r.run('attach', r.plan, '1', '--thread-id', 'T9');
    assert.deepEqual([at.attached, at.thread], ['1', 'T9']);
    assert.ok(calls.includes('guardEvent:attach') && calls.includes('guardWrite:attach:1'));
    const ld = await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
    assert.equal(ld.claimed, true);
    assert.equal(r.journal().lead!.id, 'L1', 'a module command write is saved');

    // guardWrite may refuse: nothing is written
    const before = r.raw();
    await assert.rejects(r.run('integrate', r.plan, '2', '--ref', 'x', '--exception', 'why'), /kernel test: refused/);
    assert.equal(r.raw(), before);

    // sections get the env
    await r.run('status', r.plan);
    assert.equal(env.status, r.dir);
    await r.run('recover', r.plan);
    assert.equal(env.recover, r.dir);
    assert.equal((await r.run('report', r.plan, '--json')).kernelReportRoot, r.dir);
    await r.run('recover', r.plan, '--apply');
    assert.ok(calls.includes('guardWrite:recover:-'), 'recover --apply runs guardWrite');
  } finally { register('kernel-test', {}); }
});

test('Accept 6: the other F2 flags parse (values and booleans) without a module', async () => {
  const r = repo([{ n: 1 }]);
  await r.run('init', r.plan);
  const st = await r.run('status', r.plan, '--workspace', 'w', '--mode', 'new', '--disarmed', 'idle', '--observed', 'idle at 08:00', '--decision', 'D1',
    '--supersedes', 'D1', '--evidence', 'file:a:1', '--takeover', '--release', '--run-check');
  assert.equal(st.plan, 'p.md');
  await assert.rejects(r.run('status', r.plan, '1', '--claim', 'x'), /unexpected argument "x"/, 'claim takes no value');
  await assert.rejects(r.run('status', r.plan, '--lead-id'), /flag --lead-id needs a value/);
});
