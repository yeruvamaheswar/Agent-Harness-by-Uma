import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan, setSliceFields, verifyCommand, definitionDigest, PlanError, STATES } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';
import { loadJournal, saveJournal, withLock, fingerprint, journalPath, PROFILES, outputTail, failureSignature, overlap, writeAtomic } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';

const AE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools/agents/skills/autonomous-engineering/scripts/ae.ts');

// ---- fixtures: every test uses its own temp repo; nothing touches the real repo or home ----
type S = { n: number; name?: string; deps?: string; files?: string; wave?: string; verify?: string; review?: string; state?: string; goal?: string };
const slice = (s: S) => [
  `### Slice ${s.n}: ${s.name ?? `s${s.n}`}`,
  `- Goal: ${s.goal ?? `goal ${s.n}`}`, '- Model: Claude (sonnet/high)', `- Review: ${s.review ?? 'Codex (auto)'}`, '- Fallback: Claude (opus/high)',
  `- Wave: ${s.wave ?? '1 sequential'}`, `- Depends on: ${s.deps ?? 'none'}`, `- Files: ${s.files ?? `f${s.n}.txt`}`, '- Out of scope: src/',
  `- Accept: accept ${s.n}`, `- Verify: ${s.verify ?? '`true`'}`, `- State: ${s.state ?? 'PLANNED'}`, '- Evidence: none',
  `- [ ] do it · Claude (sonnet/high) · Verify command passes · revert`, '',
].join('\n');
const planText = (slices: S[], mode = 'standard') => `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-10-25\nplanner: multi-agent-slice-planner\nmode: ${mode}\n---\nSummary: test\n\n## Slices\n${slices.map(slice).join('\n')}\n## Open\n- none\n`;

function gitInit(dir: string) { execFileSync('git', ['init', '-q'], { cwd: dir }); }
function commit(dir: string) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function repo(slices: S[], opts: { mode?: string; init?: string[]; noInit?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-engine-')));
  gitInit(dir);
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, planText(slices, opts.mode));
  let t = Date.UTC(2026, 9, 25);
  const now = () => new Date((t += 1000));
  const run = (...argv: string[]) => main(argv, { cwd: dir, now }) as Promise<any>;
  const api = {
    dir, plan, run, jfile: journalPath(plan),
    text: () => readFileSync(plan, 'utf8'),
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    parsed: () => parsePlan(readFileSync(plan, 'utf8'), plan),
    put: (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); },
    edit: (fn: (text: string) => string) => writeFileSync(plan, fn(readFileSync(plan, 'utf8'))),
    state: (id: string) => api.journal().slices[id].state,
    // READY -> VERIFIED for one slice with a passing command
    drive: async (id: string, ...flags: string[]) => {
      await api.run('start', plan, id);
      await api.run('finish', plan, id);
      await api.run('review', plan, id, '--by', 'rev', '--note', 'looks right');
      return api.run('verify', plan, id, ...flags);
    },
  };
  return api;
}
const initArgs = (r: { plan: string }, ...flags: string[]) => ['init', r.plan, ...flags];

// ---- plan.ts ----
test('parsePlan reads slices, deps, files and mode', () => {
  const p = parsePlan(planText([{ n: 1, files: 'a.ts, b/' }, { n: 2, deps: 'slice 1', wave: '2 parallel', files: '`c.ts`, d/' }], 'sprint'), 'x.md');
  assert.equal(p.slug, 'x');
  assert.equal(p.mode, 'sprint');
  assert.deepEqual(p.slices[1].dependsOn, ['1']);
  assert.deepEqual(p.slices[1].wave, { n: 2, kind: 'parallel' });
  assert.deepEqual(p.slices[0].files, ['a.ts', 'b/']);
  assert.deepEqual(p.slices[1].files, ['c.ts', 'd/']);
  assert.deepEqual(p.slices[0].outOfScope, ['src/']);
  assert.equal(STATES.length, 10);
  assert.ok(STATES.includes('ACCEPTED'));
});

test('parsePlan reads the real autonomous-engineering plan format', () => {
  const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'plans', 'autonomous-engineering.md');
  if (!existsSync(real)) return;
  const p = parsePlan(readFileSync(real, 'utf8'), real);
  assert.ok(p.slices.length >= 7);
  assert.deepEqual(p.slices.find(s => s.id === '5')!.dependsOn, ['2', '3', '4']);
  assert.equal(verifyCommand(p.slices[0]), 'node --experimental-strip-types --test tests/ae-engine.test.ts');
  assert.equal(verifyCommand(p.slices.find(s => s.id === '6')!), null);
});

test('parsePlan lists every problem in one error', () => {
  const bad = planText([{ n: 1, deps: 'slice 1' }, { n: 2, wave: 'soon', state: 'DONE', deps: 'slice 9' }, { n: 2 }])
    .replace('- Accept: accept 1\n', '');
  assert.throws(() => parsePlan(bad, 'x.md'), (e: unknown) => {
    assert.ok(e instanceof PlanError);
    const m = e.problems.join('\n');
    for (const want of ['Slice 1: missing field Accept', 'Slice 1: depends on itself', 'Slice 2: bad Wave "soon"', 'Slice 2: unknown state "DONE"', 'Slice 2: depends on unknown slice 9', 'Slice 2: duplicate slice number'])
      assert.ok(m.includes(want), `missing problem: ${want}\n${m}`);
    assert.ok(e.problems.length >= 6);
    assert.ok(e.message.includes('6 problems') || e.message.includes('problems'));
    return true;
  });
});

test('parsePlan rejects a dependency cycle', () => {
  assert.throws(() => parsePlan(planText([{ n: 1, deps: 'slice 2' }, { n: 2, deps: 'slice 1' }]), 'x.md'), /dependency cycle/);
});

test('verifyCommand takes the first backticked span; a manual step gives null', () => {
  const p = parsePlan(planText([{ n: 1, verify: 'run `npm test` then `echo x`' }, { n: 2, verify: 'check the page by eye' }]), 'x.md');
  assert.equal(verifyCommand(p.slices[0]), 'npm test');
  assert.equal(verifyCommand(p.slices[1]), null);
});

test('definitionDigest ignores State and Evidence, and sees every other field', () => {
  const [a] = parsePlan(planText([{ n: 1 }]), 'x.md').slices;
  assert.match(definitionDigest(a), /^[0-9a-f]{12}$/);
  assert.equal(definitionDigest({ ...a, state: 'VERIFIED', evidence: 'proof' }), definitionDigest(a));
  assert.notEqual(definitionDigest({ ...a, accept: 'other' }), definitionDigest(a));
  assert.notEqual(definitionDigest({ ...a, wave: { n: 2, kind: 'parallel' } }), definitionDigest(a));
});

test('setSliceFields changes only the target slice State and Evidence lines', () => {
  const before = planText([{ n: 1 }, { n: 2 }, { n: 3 }]);
  const after = setSliceFields(before, '2', { state: 'VERIFIED', evidence: 'verify exit 0:\n true' });
  const a = before.split('\n'), b = after.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter(i => i >= 0);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed.map(i => b[i]), ['- State: VERIFIED', '- Evidence: verify exit 0: true']);
  const heading = a.findIndex(l => l.startsWith('### Slice 2:')), next = a.findIndex(l => l.startsWith('### Slice 3:'));
  assert.ok(changed.every(i => i > heading && i < next));
  assert.throws(() => setSliceFields(before, '9', { state: 'READY' }), /not found/);
});

// ---- journal.ts ----
test('journal save keeps a .bak; load falls back to it on corrupt JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-journal-')), file = join(dir, 'j.run.json');
  // a save needs the journal lock (R1-5), so the whole test holds it
  await withLock(file, () => {
    const j: Journal = { schemaVersion: 1, plan: 'p.md', profile: 'balanced', authority: { allow: [], grantedBy: 'user', at: 'x' }, createdAt: 'x', updatedAt: 'x', slices: {} };
    saveJournal(file, j);
    assert.equal(existsSync(file + '.bak'), false);
    j.profile = 'sprint';
    saveJournal(file, j);
    assert.equal(JSON.parse(readFileSync(file + '.bak', 'utf8')).profile, 'balanced');
    assert.equal(loadJournal(file).recoveredFromBackup, false);
    writeFileSync(file, '{ not json');
    const rec = loadJournal(file);
    assert.equal(rec.recoveredFromBackup, true);
    assert.equal(rec.journal.profile, 'balanced');
    // saving after recovery heals the main file and does not replace the good .bak with the corrupt file
    saveJournal(file, rec.journal);
    assert.equal(JSON.parse(readFileSync(file + '.bak', 'utf8')).profile, 'balanced');
    assert.equal(loadJournal(file).recoveredFromBackup, false);
    writeFileSync(file, 'garbage');
    writeFileSync(file + '.bak', 'garbage');
    assert.throws(() => loadJournal(file), /corrupt/);
    assert.throws(() => loadJournal(join(dir, 'none.run.json')), /run init first/);
  });
});

test('a corrupt journal recovers from .bak through the CLI function and says so', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  writeFileSync(r.jfile, '{ broken');
  const out = await r.run('status', r.plan);
  assert.equal(out.recoveredFromBackup, true);
  assert.equal((await r.run('status', r.plan)).recoveredFromBackup, undefined);
  JSON.parse(readFileSync(r.jfile, 'utf8'));
});

test('a lock held by a live pid errors; a dead pid lock is taken over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-lock-')), file = join(dir, 'j.run.json');
  writeFileSync(file + '.lock', String(process.pid));
  await assert.rejects(withLock(file, () => 'x'), /locked by live pid/);
  assert.equal(readFileSync(file + '.lock', 'utf8'), String(process.pid), 'a refused lock stays');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(file + '.lock', String(dead));
  assert.equal(await withLock(file, () => 'ran'), 'ran');
  assert.equal(existsSync(file + '.lock'), false, 'lock released');
  writeFileSync(file + '.lock', 'not a pid');
  assert.equal(await withLock(file, () => 'ran'), 'ran');
});

test('a command refuses to run while a live pid holds the journal lock', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  writeFileSync(r.jfile + '.lock', String(process.pid));
  await assert.rejects(r.run('status', r.plan), /locked by live pid/);
});

test('fingerprint walks folders, skips .git and node_modules, and marks missing paths', () => {
  const r = repo([{ n: 1 }]);
  r.put('d/a.txt', 'a'); r.put('d/node_modules/x.js', '1'); r.put('d/.git/HEAD', 'h');
  const base = fingerprint(r.dir, ['d/', 'gone.txt']);
  assert.match(base, /^[0-9a-f]{12}$/);
  r.put('d/node_modules/x.js', '2'); r.put('d/.git/HEAD', 'other');
  assert.equal(fingerprint(r.dir, ['d/', 'gone.txt']), base);
  r.put('d/a.txt', 'changed');
  assert.notEqual(fingerprint(r.dir, ['d/', 'gone.txt']), base);
  r.put('gone.txt', '');
  assert.notEqual(fingerprint(r.dir, ['d/', 'gone.txt']), fingerprint(r.dir, ['d/']));
});

test('outputTail keeps 40 lines and 4000 chars; the signature ignores digits', () => {
  const t = outputTail(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n\n');
  assert.equal(t.split('\n').length, 40);
  assert.ok(t.endsWith('line 99'));
  assert.equal(outputTail('x'.repeat(9000)).length, 4000);
  assert.equal(failureSignature('boom 12 at 5ms'), failureSignature('boom 999 at 77ms'));
  assert.notEqual(failureSignature('boom'), failureSignature('bang'));
  assert.deepEqual(PROFILES, { economy: { maxParallel: 1 }, balanced: { maxParallel: 2 }, sprint: { maxParallel: 4 } }, 'profiles change width only');
});

// ---- init ----
test('init picks the profile from the plan mode, records authority, and refuses an existing journal', async () => {
  const r = repo([{ n: 1 }], { mode: 'quick' });
  const out = await r.run(...initArgs(r, '--allow', 'deps,ci'));
  assert.equal(out.profile, 'economy');
  const j = r.journal();
  assert.deepEqual(j.authority.allow, ['deps', 'ci']);
  assert.equal(j.authority.grantedBy, 'user');
  assert.equal(j.schemaVersion, 1);
  await assert.rejects(r.run(...initArgs(r)), /already exists/);
  const r2 = repo([{ n: 1 }]);
  await assert.rejects(r2.run(...initArgs(r2, '--allow', 'push')), /unknown --allow/);
  assert.equal(existsSync(r2.jfile), false);
  const sp = repo([{ n: 1 }], { mode: 'sprint' });
  assert.equal((await sp.run(...initArgs(sp))).profile, 'sprint');
  const ov = repo([{ n: 1 }], { mode: 'sprint' });
  assert.equal((await ov.run(...initArgs(ov, '--profile', 'economy'))).profile, 'economy');
});

test('init imports plan states: in-progress restarts, finished-or-later claims need verify', async () => {
  const r = repo([
    { n: 1, state: 'PLANNED' }, { n: 2, state: 'READY' }, { n: 3, state: 'IN_PROGRESS' }, { n: 4, state: 'AGENT_FINISHED' },
    { n: 5, state: 'REVIEWED' }, { n: 6, state: 'VERIFIED' }, { n: 7, state: 'INTEGRATED' }, { n: 8, state: 'BLOCKED' }, { n: 9, state: 'FAILED' },
  ]);
  const out = await r.run(...initArgs(r));
  const want = ['PLANNED', 'READY', 'READY', 'AGENT_FINISHED', 'AGENT_FINISHED', 'AGENT_FINISHED', 'AGENT_FINISHED', 'BLOCKED', 'FAILED'];
  assert.deepEqual(out.slices.map((s: any) => s.state), want);
  const j = r.journal();
  assert.equal(j.slices['6'].history.at(-1)!.reason, 'imported claim; needs verify');
  assert.equal(j.slices['6'].history.at(-1)!.claim!.state, 'VERIFIED');
  assert.equal(j.slices['3'].history.at(-1)!.to, 'READY');
  assert.deepEqual(r.parsed().slices.map(s => s.state), want, 'plan State lines follow the journal');
  assert.equal(out.rebuild, `~/.agents/bin/md-view.sh ${r.plan}`);
});

test('init reports a plan with parse errors and writes no journal', async () => {
  const r = repo([{ n: 1, wave: 'bad' }]);
  await assert.rejects(r.run(...initArgs(r)), /bad Wave/);
  assert.equal(existsSync(r.jfile), false);
});

// ---- EVAL-2, EVAL-3: next ----
test('EVAL-2: a slice with an unverified dependency is not in next', async () => {
  const r = repo([{ n: 1 }, { n: 2, deps: 'slice 1', wave: '2 parallel' }]);
  await r.run(...initArgs(r));
  let out = await r.run('next', r.plan);
  assert.deepEqual(out.batch.map((s: any) => s.id), ['1']);
  assert.deepEqual(out.waiting, [{ id: '2', waitingOn: ['1'] }]);
  assert.equal(r.state('2'), 'PLANNED');
  await r.run('start', r.plan, '1');
  await r.run('finish', r.plan, '1');
  out = await r.run('next', r.plan);
  assert.deepEqual(out.batch, [], 'AGENT_FINISHED is not VERIFIED');
  assert.equal(r.state('2'), 'PLANNED');
  await assert.rejects(r.run('start', r.plan, '2'), /needs READY/);
  await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  assert.deepEqual((await r.run('next', r.plan)).batch, []);
  await r.run('verify', r.plan, '1');
  out = await r.run('next', r.plan);
  assert.deepEqual(out.batch.map((s: any) => s.id), ['2']);
  assert.deepEqual(out.promoted, ['2']);
});

test('EVAL-3: parallel slices with separate files come in one batch; overlapping files do not', async () => {
  const r = repo([
    { n: 1, files: 'a.ts', wave: '1 parallel' }, { n: 2, files: 'b.ts', wave: '1 parallel' }, { n: 3, files: 'src/x.ts', wave: '1 parallel' },
    { n: 4, files: 'src/', wave: '1 parallel' }, { n: 5, files: 'a.ts', wave: '1 parallel' },
  ], { mode: 'sprint' });
  await r.run(...initArgs(r));
  const out = await r.run('next', r.plan);
  assert.deepEqual(out.batch.map((s: any) => s.id), ['1', '2', '3'], 'sprint width 4; 4 overlaps 3 (folder), 5 overlaps 1');
  assert.deepEqual(out.deferred.map((d: any) => d.id).sort(), ['4', '5']);
  assert.match(out.deferred.find((d: any) => d.id === '5').reason, /overlap slice 1/);
  assert.match(out.deferred.find((d: any) => d.id === '4').reason, /overlap slice 3/);
});

test('next respects profile width, running slices, and sequential or integration slices run alone', async () => {
  const r = repo([{ n: 1, files: 'a', wave: '1 parallel' }, { n: 2, files: 'b', wave: '1 parallel' }, { n: 3, files: 'c', wave: '1 parallel' }]);
  await r.run(...initArgs(r));
  let out = await r.run('next', r.plan);
  assert.deepEqual(out.batch.map((s: any) => s.id), ['1', '2'], 'balanced width 2');
  assert.equal(out.deferred[0].id, '3');
  await r.run('start', r.plan, '1');
  out = await r.run('next', r.plan);
  assert.deepEqual(out.batch.map((s: any) => s.id), ['2'], 'one slot left');
  await r.run('start', r.plan, '2');
  out = await r.run('next', r.plan);
  assert.deepEqual(out.batch, []);
  assert.equal(out.slots, 0);

  const s = repo([{ n: 1, files: 'a', wave: '1 sequential' }, { n: 2, files: 'b', wave: '1 parallel' }], { mode: 'sprint' });
  await s.run(...initArgs(s));
  assert.deepEqual((await s.run('next', s.plan)).batch.map((x: any) => x.id), ['1'], 'sequential goes alone');
  await s.run('start', s.plan, '1');
  assert.deepEqual((await s.run('next', s.plan)).batch, []);

  const q = repo([{ n: 1, files: 'a', wave: '1 parallel' }, { n: 2, files: 'b', wave: '1 parallel' }], { mode: 'quick' });
  await q.run(...initArgs(q));
  assert.deepEqual((await q.run('next', q.plan)).batch.map((x: any) => x.id), ['1'], 'economy width 1');
});

// ---- EVAL-4, EVAL-5: finish and verify ----
test('EVAL-4: finish gives AGENT_FINISHED; nothing reaches VERIFIED without verify', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await assert.rejects(r.run('start', r.plan, '1'), /needs READY/, 'PLANNED cannot start');
  await r.run('next', r.plan);
  await assert.rejects(r.run('finish', r.plan, '1'), /needs IN_PROGRESS/);
  const started = await r.run('start', r.plan, '1', '--provider', 'claudeAgent', '--model', 'sonnet', '--effort', 'high', '--task-id', 'T1');
  assert.equal(started.state, 'IN_PROGRESS');
  await assert.rejects(r.run('start', r.plan, '1'), /needs READY/);
  const fin = await r.run('finish', r.plan, '1', '--summary', 'done');
  assert.equal(fin.state, 'AGENT_FINISHED');
  assert.equal(r.parsed().slices[0].state, 'AGENT_FINISHED');
  assert.equal(r.parsed().slices[0].evidence, 'none');
  const a = r.journal().slices['1'].attempts[0];
  assert.deepEqual([a.provider, a.model, a.effort, a.taskId, a.outcome, a.summary], ['claudeAgent', 'sonnet', 'high', 'T1', 'finished', 'done']);
  for (const cmd of ['finish', 'block', 'fail', 'unblock', 'integrate']) await assert.rejects(r.run(cmd, r.plan, '1', '--reason', 'x', '--ref', 'x'), /needs/, cmd);
  await assert.rejects(r.run('verify', r.plan, '1'), /run review first/);
  assert.equal(r.state('1'), 'AGENT_FINISHED');
  await assert.rejects(r.run('review', r.plan, '1', '--by', 'T1', '--note', 'self'), /independent/);
  await r.run('review', r.plan, '1', '--by', 'codex', '--note', 'diff read');
  assert.equal(r.state('1'), 'REVIEWED');
  assert.match(r.parsed().slices[0].evidence, /^reviewed by codex/);
  await r.run('verify', r.plan, '1');
  assert.equal(r.state('1'), 'VERIFIED');
});

test('EVAL-5: verify records exit 0, output tail, git head, fingerprint; the plan shows both', async () => {
  const r = repo([{ n: 1, files: 'a.txt, dir/', verify: '`echo hello-from-verify`' }]);
  r.put('a.txt', 'one'); r.put('dir/b.txt', 'two');
  const head = commit(r.dir);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const out = await r.drive('1');
  assert.equal(out.verified, true);
  assert.equal(out.state, 'VERIFIED');
  const [e] = r.journal().slices['1'].evidence;
  assert.equal(e.kind, 'command');
  assert.equal(e.command, 'echo hello-from-verify');
  assert.equal(e.exitCode, 0);
  assert.equal(e.outputTail, 'hello-from-verify');
  assert.equal(e.gitHead, head);
  assert.equal(e.fingerprint, fingerprint(r.dir, ['a.txt', 'dir/']));
  assert.equal(typeof e.durationMs, 'number');
  const p = r.parsed().slices[0];
  assert.equal(p.state, 'VERIFIED');
  assert.ok(p.evidence.includes('verify exit 0: echo hello-from-verify') && p.evidence.includes(head.slice(0, 9)) && p.evidence.includes(e.fingerprint), p.evidence);
  assert.equal(out.rebuild, `~/.agents/bin/md-view.sh ${r.plan}`);
  // editing an owned file changes the fingerprint, so the recorded one no longer matches
  r.put('dir/b.txt', 'changed');
  assert.notEqual(fingerprint(r.dir, ['a.txt', 'dir/']), e.fingerprint);
});

test('verify runs in the git top level and records the tail of long output', async () => {
  const r = repo([{ n: 1, verify: '`pwd; for i in $(seq 1 100); do echo line$i; done`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const out = await r.drive('1');
  const tail: string = out.evidence.outputTail;
  assert.equal(tail.split('\n').length, 40);
  assert.ok(tail.endsWith('line100'));
  const out2 = repo([{ n: 1, verify: '`pwd`' }]);
  await out2.run(...initArgs(out2));
  await out2.run('next', out2.plan);
  assert.equal((await out2.drive('1')).evidence.outputTail, out2.dir);
});

test('verify with a failing command records the failure and returns the slice to READY', async () => {
  const r = repo([{ n: 1, verify: '`echo bad-news >&2; false`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const out = await r.drive('1');
  assert.equal(out.verified, false);
  assert.equal(out.exitCode, 1);
  assert.equal(out.state, 'READY');
  assert.equal(out.outputTail, 'bad-news');
  const rec = r.journal().slices['1'];
  assert.equal(rec.evidence.length, 0);
  assert.equal(rec.review, undefined, 'a failed check clears the review');
  assert.equal(rec.attempts.at(-1)!.kind, 'verify');
  assert.equal(rec.attempts.at(-1)!.outcome, 'failed');
  assert.equal(r.parsed().slices[0].state, 'READY');
});

test('verify timeout is injectable and counts as a failure', async () => {
  const r = repo([{ n: 1, verify: '`node -e "setTimeout(() => {}, 20000)"`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const t0 = Date.now();
  const out = await r.drive('1', '--timeout', '0.4');
  assert.ok(Date.now() - t0 < 10000, 'timeout killed the command');
  assert.equal(out.verified, false);
  assert.equal(out.timedOut, true);
  assert.match(out.outputTail, /timed out after 0.4s/);
  const r2 = repo([{ n: 1, review: 'CI' }]);
  await r2.run(...initArgs(r2));
  await r2.run('next', r2.plan);
  await r2.run('start', r2.plan, '1'); await r2.run('finish', r2.plan, '1');
  await assert.rejects(r2.run('verify', r2.plan, '1', '--timeout', '0'), /positive/);
  assert.equal(r2.state('1'), 'AGENT_FINISHED');
});

// ---- EVAL-6 signature part ----
test('EVAL-6: three identical failures give FAILED (no progress), digits ignored', async () => {
  const r = repo([{ n: 1, verify: '`node -e "process.stderr.write(require(\'fs\').readFileSync(\'out.txt\', \'utf8\')); process.exit(1)"`' }], { mode: 'sprint' });
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  r.put('out.txt', 'AssertionError at line 41 after 12ms');
  assert.equal((await r.drive('1')).state, 'READY');
  r.put('out.txt', 'AssertionError at line 87 after 9ms');
  assert.equal((await r.drive('1')).state, 'READY', 'two identical failures are not enough');
  await r.run('start', r.plan, '1');
  await r.run('finish', r.plan, '1');
  await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'again');
  r.put('out.txt', 'AssertionError at line 3 after 100ms');
  const out = await r.run('verify', r.plan, '1');
  assert.equal(out.state, 'FAILED');
  assert.match(out.why, /no progress: same failure 3 times/);
  assert.equal(r.parsed().slices[0].state, 'FAILED');
  assert.equal(out.failures, 3, 'budget 4 was not the reason');
  await assert.rejects(r.run('start', r.plan, '1'), /needs READY/);
});

test('different failures retry until failure 4 sets FAILED; unblock restarts the budget', async () => {
  const r = repo([{ n: 1, verify: '`node -e "process.stderr.write(require(\'fs\').readFileSync(\'out.txt\', \'utf8\')); process.exit(1)"`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const states: string[] = [];
  for (const t of ['first problem', 'second problem', 'third problem', 'fourth problem']) {
    r.put('out.txt', t);
    states.push((await r.drive('1')).state);
  }
  assert.deepEqual(states, ['READY', 'READY', 'READY', 'FAILED']);
  assert.match(r.journal().slices['1'].history.at(-1)!.reason, /fix budget spent \(4\/4\)/);
  await assert.rejects(r.run('unblock', r.plan, '1'), /--reason is required/);
  const un = await r.run('unblock', r.plan, '1', '--reason', 'user chose to retry');
  assert.equal(un.state, 'READY', 'FAILED returns to READY');
  assert.equal(r.journal().slices['1'].budgetFrom, r.journal().slices['1'].attempts.length);
  r.put('out.txt', 'fourth problem');
  assert.equal((await r.drive('1')).state, 'READY', 'the old window does not count: this is failure 1 again');
  assert.equal((await r.run('status', r.plan)).slices[0].failures, 1);
});

test('fail returns an interrupted slice to READY; failure 4 sets FAILED in every profile', async () => {
  for (const mode of ['quick', 'standard', 'sprint']) {
    const r = repo([{ n: 1 }], { mode });
    await r.run(...initArgs(r));
    await r.run('next', r.plan);
    await r.run('start', r.plan, '1');
    await assert.rejects(r.run('fail', r.plan, '1'), /--reason is required/);
    const states: string[] = [];
    for (const why of ['session interrupted', 'worker crashed', 'tool error', 'out of context']) {
      if (states.length) await r.run('start', r.plan, '1');
      states.push((await r.run('fail', r.plan, '1', '--reason', why)).state);
    }
    assert.deepEqual(states, ['READY', 'READY', 'READY', 'FAILED'], mode);
    assert.deepEqual(r.journal().slices['1'].attempts.map(x => x.outcome), ['failed', 'failed', 'failed', 'failed']);
  }
});

// ---- block, unblock, integrate ----
test('block, unblock, and integrate move the slice and update the plan', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1');
  await assert.rejects(r.run('block', r.plan, '1'), /--reason is required/);
  const b = await r.run('block', r.plan, '1', '--reason', 'needs a credential');
  assert.equal(b.state, 'BLOCKED');
  assert.equal(r.journal().slices['1'].blocker!.reason, 'needs a credential');
  assert.equal(r.parsed().slices[0].state, 'BLOCKED');
  assert.equal((await r.run('status', r.plan)).slices[0].blocker, 'needs a credential');
  assert.equal((await r.run('unblock', r.plan, '1', '--reason', 'user supplied it')).state, 'IN_PROGRESS', 'planner rule: BLOCKED returns to IN_PROGRESS');
  assert.equal(r.journal().slices['1'].blocker, undefined);
  assert.equal(r.parsed().slices[0].state, 'IN_PROGRESS');
  await assert.rejects(r.run('integrate', r.plan, '1', '--ref', 'abc'), /needs VERIFIED/);
  await r.run('finish', r.plan, '1');
  await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  await r.run('verify', r.plan, '1');
  await assert.rejects(r.run('integrate', r.plan, '1'), /--ref is required/);
  const i = await r.run('integrate', r.plan, '1', '--ref', 'main@abc1234');
  assert.equal(i.state, 'INTEGRATED');
  assert.match(r.parsed().slices[0].evidence, /integrated main@abc1234/);
  assert.equal((await r.run('status', r.plan)).done, true);
});

// ---- verify gates ----
test('verify --manual is refused when Verify has a backticked command', async () => {
  const r = repo([{ n: 1, verify: '`true`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1'); await r.run('finish', r.plan, '1'); await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  await assert.rejects(r.run('verify', r.plan, '1', '--manual', '--by', 'me', '--note', 'looked fine'), /--manual is refused/);
  assert.equal(r.state('1'), 'REVIEWED');
});

test('a manual Verify step needs --manual --by --note and records manual evidence', async () => {
  const r = repo([{ n: 1, verify: 'open the page and check the title' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1'); await r.run('finish', r.plan, '1'); await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  await assert.rejects(r.run('verify', r.plan, '1'), /manual Verify step/);
  await assert.rejects(r.run('verify', r.plan, '1', '--manual', '--by', 'Uma'), /--note is required/);
  const out = await r.run('verify', r.plan, '1', '--manual', '--by', 'Uma', '--note', 'title reads Hello');
  assert.equal(out.state, 'ACCEPTED', 'a person\'s sign-off is ACCEPTED, never VERIFIED');
  assert.equal(out.verified, false);
  assert.equal(r.journal().slices['1'].history.at(-1)!.reason, "accepted on a person's note: manual check by Uma");
  assert.equal(r.parsed().slices[0].state, 'ACCEPTED');
  assert.deepEqual((await r.run('status', r.plan)).counts, { ACCEPTED: 1 }, 'status shows ACCEPTED apart from VERIFIED');
  const [e] = r.journal().slices['1'].evidence;
  assert.deepEqual([e.kind, e.by, e.note], ['manual', 'Uma', 'title reads Hello']);
  assert.match(r.parsed().slices[0].evidence, /manual check by Uma: title reads Hello/);
});

test('ACCEPTED: a manual sign-off satisfies a dependency and can integrate', async () => {
  const r = repo([{ n: 1, verify: 'a person reads the page' }, { n: 2, deps: 'slice 1', wave: '2 sequential', files: 'g.txt' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1'); await r.run('finish', r.plan, '1'); await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  await r.run('next', r.plan);
  assert.equal(r.state('2'), 'PLANNED', 'REVIEWED does not satisfy a dependency');
  assert.equal((await r.run('verify', r.plan, '1', '--manual', '--by', 'Uma', '--note', 'page reads right')).state, 'ACCEPTED');
  const n = await r.run('next', r.plan);
  assert.deepEqual(n.batch.map((b: any) => b.id), ['2'], 'the dependent becomes READY');
  assert.equal(r.state('2'), 'READY');
  const i = await r.run('integrate', r.plan, '1', '--ref', 'main@abc');
  assert.equal(i.state, 'INTEGRATED');
  assert.deepEqual(r.journal().slices['1'].history.map(h => h.to), ['READY', 'IN_PROGRESS', 'AGENT_FINISHED', 'REVIEWED', 'ACCEPTED', 'INTEGRATED']);
});

test('ACCEPTED: a CI-reviewed manual slice is ACCEPTED from AGENT_FINISHED; the plan claim imports as AGENT_FINISHED', async () => {
  const r = repo([{ n: 1, review: 'CI', verify: 'a person checks the build' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1'); await r.run('finish', r.plan, '1');
  assert.equal((await r.run('verify', r.plan, '1', '--manual', '--by', 'Uma', '--note', 'fine')).state, 'ACCEPTED');
  const c = repo([{ n: 1, state: 'ACCEPTED' }]);
  await c.run(...initArgs(c));
  assert.equal(c.state('1'), 'AGENT_FINISHED', 'a claimed ACCEPTED needs a fresh sign-off');
  assert.equal(c.journal().slices['1'].history.at(-1)!.claim!.state, 'ACCEPTED');
});

test('ACCEPTED is reachable only from AGENT_FINISHED or REVIEWED', async () => {
  const { canTransition } = await import('../tools/agents/skills/autonomous-engineering/scripts/journal.ts');
  const from = STATES.filter(s => canTransition(s, 'ACCEPTED'));
  assert.deepEqual(from, ['AGENT_FINISHED', 'REVIEWED']);
  assert.deepEqual(STATES.filter(s => canTransition('ACCEPTED', s)), ['AGENT_FINISHED', 'INTEGRATED']);
  for (const s of ['FAILED', 'READY', 'PLANNED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'INTEGRATED'] as const) assert.equal(canTransition(s, 'ACCEPTED'), false, s);
  // through the CLI: verify --manual from READY or FAILED is refused and nothing moves
  const r = repo([{ n: 1, verify: 'a person reads the page' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await assert.rejects(r.run('verify', r.plan, '1', '--manual', '--by', 'Uma', '--note', 'x'), /is READY; this command needs/);
  await r.run('start', r.plan, '1');
  await r.run('fail', r.plan, '1', '--reason', 'r1'); await r.run('start', r.plan, '1');
  await r.run('fail', r.plan, '1', '--reason', 'r1'); await r.run('start', r.plan, '1');
  await r.run('fail', r.plan, '1', '--reason', 'r1');
  if (r.state('1') === 'FAILED') await assert.rejects(r.run('verify', r.plan, '1', '--manual', '--by', 'Uma', '--note', 'x'), /is FAILED; this command needs/);
  assert.notEqual(r.state('1'), 'ACCEPTED');
});

test('property: after any sequence of ae commands, a VERIFIED slice has no manual evidence', async () => {
  // a small seeded random walk over the commands, for a manual slice and a command slice
  let seed = 1; // mulberry32: deterministic, and every command gets picked. The coverage check below fails loudly if a change makes the walk vacuous
  const rand = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return (((x ^ (x >>> 14)) >>> 0) % n); };
  const r = repo([{ n: 1, verify: 'a person reads the page', review: 'CI' }, { n: 2, files: 'g.txt' }, { n: 3, verify: 'a person looks', files: 'h.txt' }]);
  await r.run(...initArgs(r));
  const cmds: string[][] = [];
  // forward commands are listed three times, so the walk also reaches the late states
  for (const id of ['1', '2', '3']) for (let k = 0; k < 3; k++) cmds.push(
    ['next'], ['start', id], ['finish', id], ['review', id, '--by', 'rev', '--note', 'ok'], ['verify', id], ['verify', id, '--manual', '--by', 'Uma', '--note', 'ok'],
    ...(k ? [] : [['review', id, '--reject', '--by', 'rev', '--note', 'bad'], ['fail', id, '--reason', 'x'], ['block', id, '--reason', 'x'],
      ['unblock', id, '--reason', 'y'], ['integrate', id, '--ref', 'r'], ['recover', '--apply']]));
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const [cmd, ...rest] = cmds[rand(cmds.length)];
    try { await r.run(cmd, r.plan, ...rest); } catch { /* refused commands are part of the walk */ }
    if (rand(10) === 0) r.put(['f1.txt', 'g.txt', 'h.txt'][rand(3)], `edit ${i}`);
    for (const [id, rec] of Object.entries(r.journal().slices)) {
      seen.add(rec.state);
      if (rec.state !== 'VERIFIED') continue;
      const live = rec.evidence.filter(e => !e.stale).at(-1)!;
      assert.equal(live.kind, 'command', `slice ${id} is VERIFIED on ${live.kind} evidence at step ${i}`);
      assert.notEqual(rec.history.filter(h => h.to === 'VERIFIED').at(-1)!.reason.includes('accepted'), true);
    }
  }
  for (const s of ['VERIFIED', 'ACCEPTED', 'INTEGRATED']) assert.ok(seen.has(s), `the walk reached ${s}: ${[...seen]}`);
});

test('VERIFIED requires REVIEWED unless Review is CI', async () => {
  const r = repo([{ n: 1, review: 'Codex (auto)' }, { n: 2, review: 'CI', files: 'g.txt' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  for (const id of ['1', '2']) { await r.run('start', r.plan, id); await r.run('finish', r.plan, id); }
  await assert.rejects(r.run('verify', r.plan, '1'), /run review first/);
  assert.equal(r.state('1'), 'AGENT_FINISHED');
  await assert.rejects(r.run('review', r.plan, '2', '--by', 'x', '--note', 'y'), /Review: CI/);
  const out = await r.run('verify', r.plan, '2');
  assert.equal(out.state, 'VERIFIED');
  assert.deepEqual(r.journal().slices['2'].history.map(h => h.to), ['READY', 'IN_PROGRESS', 'AGENT_FINISHED', 'VERIFIED']);
});

test('every transition is recorded in history with the injected clock', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.drive('1');
  const h = r.journal().slices['1'].history;
  assert.deepEqual(h.map(m => `${m.from}>${m.to}`), ['PLANNED>READY', 'READY>IN_PROGRESS', 'IN_PROGRESS>AGENT_FINISHED', 'AGENT_FINISHED>REVIEWED', 'REVIEWED>VERIFIED']);
  assert.ok(h.every((m, i) => i === 0 || m.at > h[i - 1].at));
  assert.ok(h[0].at.startsWith('2026-10-25T'));
});

// ---- sync ----
test('sync moves a slice whose definition changed back to READY and marks its evidence stale', async () => {
  const r = repo([{ n: 1 }, { n: 2, deps: 'slice 1', wave: '2 sequential' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.drive('1');
  assert.equal(r.state('1'), 'VERIFIED');
  assert.match(r.parsed().slices[0].evidence, /^verify exit 0/);
  r.edit(t => t.replace('- Accept: accept 1', '- Accept: a different acceptance'));
  const out = await r.run('status', r.plan);
  assert.equal(out.slices[0].state, 'READY');
  const rec = r.journal().slices['1'];
  assert.equal(rec.history.at(-1)!.reason, 'definition changed');
  assert.equal(rec.history.at(-1)!.from, 'VERIFIED');
  assert.equal(rec.evidence[0].stale, true);
  assert.equal(r.parsed().slices[0].state, 'READY');
  assert.equal(r.parsed().slices[0].evidence, 'none', 'stale evidence is not shown');
  assert.equal(r.state('2'), 'PLANNED');
});

test('sync adds a new slice as PLANNED and keeps a removed slice under removed', async () => {
  const r = repo([{ n: 1 }, { n: 2 }]);
  await r.run(...initArgs(r));
  r.edit(t => t.replace(/### Slice 2:[\s\S]*?(?=## Open)/, '') .replace('## Open', slice({ n: 3, state: 'VERIFIED' }) + '\n## Open'));
  const out = await r.run('status', r.plan);
  assert.deepEqual(out.slices.map((s: any) => [s.id, s.state]), [['1', 'PLANNED'], ['3', 'PLANNED']], 'a new slice ignores its claimed state');
  const j = r.journal();
  assert.deepEqual(Object.keys(j.slices), ['1', '3']);
  assert.deepEqual(Object.keys(j.removed!), ['2']);
  assert.equal(r.parsed().slices[1].state, 'PLANNED', 'the engine corrects the plan line');
});

test('a hand-edited State line is corrected from the journal', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  r.edit(t => t.replace('- State: READY', '- State: VERIFIED'));
  await r.run('status', r.plan);
  assert.equal(r.parsed().slices[0].state, 'READY');
});

test('status counts states and an unknown slice or command is an error', async () => {
  const r = repo([{ n: 1 }, { n: 2, deps: 'slice 1' }]);
  await r.run(...initArgs(r));
  const out = await r.run('status', r.plan);
  assert.deepEqual(out.counts, { PLANNED: 2 });
  assert.equal(out.done, false);
  assert.equal(out.profile, 'balanced');
  await assert.rejects(r.run('start', r.plan, '7'), /unknown slice 7/);
  await assert.rejects(r.run('start', r.plan), /SLICE number is required/);
  await assert.rejects(r.run('wobble', r.plan), /unknown command/);
  await assert.rejects(r.run('status', r.plan, '--bogus', 'x'), /unknown flag/);
  await assert.rejects(r.run('status', join(r.dir, 'plans', 'none.md')), /plan not found/);
  await assert.rejects(r.run('status', r.plan, '--timeout'), /needs a value/);
});

test('a full two-slice plan runs from PLANNED to VERIFIED', async () => {
  const r = repo([{ n: 1, files: 'a.ts', verify: '`echo one`' }, { n: 2, deps: 'slice 1', wave: '2 sequential', files: 'b.ts', verify: '`echo two`' }]);
  await r.run(...initArgs(r));
  assert.deepEqual((await r.run('next', r.plan)).batch.map((s: any) => s.id), ['1']);
  await r.drive('1');
  assert.deepEqual((await r.run('next', r.plan)).batch.map((s: any) => s.id), ['2']);
  await r.drive('2');
  const out = await r.run('next', r.plan);
  assert.equal(out.done, true);
  assert.deepEqual(r.parsed().slices.map(s => s.state), ['VERIFIED', 'VERIFIED']);
  assert.ok(r.parsed().slices.every(s => s.evidence.startsWith('verify exit 0')));
  assert.equal(r.text().split('\n').filter(l => l.startsWith('- State:')).length, 2);
});

// ---- real CLI process ----
test('ae.ts runs as a CLI: JSON on stdout, errors on stderr with exit 1', () => {
  const r = repo([{ n: 1 }]);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', AE, ...args], { cwd: r.dir, encoding: 'utf8' });
  const init = cli('init', 'plans/p.md');
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).profile, 'balanced');
  const again = cli('init', 'plans/p.md');
  assert.equal(again.status, 1);
  assert.equal(again.stdout, '');
  assert.match(again.stderr, /^error: journal already exists/);
  const next = cli('next', 'plans/p.md');
  assert.deepEqual(JSON.parse(next.stdout).batch.map((s: any) => s.id), ['1']);
  assert.equal(cli('bogus', 'plans/p.md').status, 1);
});

// ---- review round 1 regressions (plans/autonomous-engineering.md, "Review round 1") ----
const outsideFile = (body: string) => { const f = join(realpathSync(mkdtempSync(join(tmpdir(), 'ae-target-'))), 'target.txt'); writeFileSync(f, body); return f; };

test('R1-1: a symlink at the journal, .bak, .lock, or plan path is refused, and its target stays byte-identical', async () => {
  for (const which of ['.bak', '.lock', 'journal', 'plan'] as const) {
    const r = repo([{ n: 1 }]);
    await r.run(...initArgs(r));
    const target = outsideFile(`precious ${which}`);
    const link = which === 'journal' ? r.jfile : which === 'plan' ? r.plan : r.jfile + which;
    if (which === 'journal' || which === 'plan') writeFileSync(target, readFileSync(link));
    const bytes = readFileSync(target);
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(target, link);
    await assert.rejects(r.run('next', r.plan), /symlink/, which);
    assert.deepEqual(readFileSync(target), bytes, `${which} target unchanged`);
    assert.ok(lstatSync(link).isSymbolicLink(), `${which} link left in place`);
  }
});

test('R1-1: planted links at the old predictable temp names never change their targets; saves still work', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  const tJournal = outsideFile('journal temp target'), tPlan = outsideFile('plan temp target');
  symlinkSync(tJournal, `${r.jfile}.${process.pid}.tmp`);
  symlinkSync(tPlan, `${r.plan}.${process.pid}.tmp`);
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1');
  assert.equal(readFileSync(tJournal, 'utf8'), 'journal temp target');
  assert.equal(readFileSync(tPlan, 'utf8'), 'plan temp target');
  assert.ok(!lstatSync(r.jfile).isSymbolicLink() && !lstatSync(r.plan).isSymbolicLink() && !lstatSync(r.jfile + '.bak').isSymbolicLink());
  assert.equal(r.state('1'), 'IN_PROGRESS');
  assert.match(r.text(), /- State: IN_PROGRESS/);
  assert.deepEqual(readdirSync(join(r.dir, 'plans')).filter(n => n.endsWith('.tmp')).sort(), [`p.md.${process.pid}.tmp`, `p.run.json.${process.pid}.tmp`], 'no new temp file is left behind');
});

test('R1-1: a plans folder that resolves outside the repo root is refused', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-engine-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'ae-outside-')));
  gitInit(dir);
  writeFileSync(join(outside, 'p.md'), planText([{ n: 1 }]));
  symlinkSync(outside, join(dir, 'plans'));
  await assert.rejects(main(['init', join(dir, 'plans', 'p.md')], { cwd: dir }), /outside the repo/);
  assert.deepEqual(readdirSync(outside), ['p.md'], 'nothing written outside the repo');
});

test('R1-4: verify runs with pipefail, so `false | cat` fails', async () => {
  const r = repo([{ n: 1, verify: '`false | cat`' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  const out = await r.drive('1');
  assert.equal(out.verified, false);
  assert.equal(r.state('1'), 'READY');
});

test('R1-5: a save refuses when the lock is missing or another pid holds it ("lost the journal lock")', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-lock-'))), file = join(dir, 'j.run.json');
  const j: Journal = { schemaVersion: 1, plan: 'p.md', profile: 'balanced', authority: { allow: [], grantedBy: 'user', at: 'x' }, createdAt: 'x', updatedAt: 'x', slices: {} };
  assert.throws(() => saveJournal(file, j), /lost the journal lock/);
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await assert.rejects(withLock(file, () => { writeFileSync(file + '.lock', String(other.pid)); saveJournal(file, j); }), /lost the journal lock/);
    assert.equal(existsSync(file), false, 'nothing written');
    assert.equal(readFileSync(file + '.lock', 'utf8'), String(other.pid), 'the other process keeps its lock');
  } finally { other.kill(); }
});

test('R1-5: a lock taken over by another live pid during a command stops the journal write', async () => {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const r = repo([{ n: 1, verify: `\`echo ${other.pid} > plans/p.run.json.lock\`` }]);
    await r.run(...initArgs(r));
    await r.run('next', r.plan);
    await r.run('start', r.plan, '1');
    await r.run('finish', r.plan, '1');
    await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
    const journal = readFileSync(r.jfile, 'utf8'), plan = r.text();
    await assert.rejects(r.run('verify', r.plan, '1'), /lost the journal lock/);
    assert.equal(readFileSync(r.jfile, 'utf8'), journal, 'journal unchanged');
    assert.equal(r.text(), plan, 'plan unchanged');
    assert.equal(r.state('1'), 'REVIEWED');
  } finally { other.kill(); }
});

test('R1-6: overlap normalizes ./, trailing /, and repeated /; . or ./ owns the whole repo', async () => {
  assert.ok(overlap(['./src/'], ['src/cli.ts']));
  assert.ok(overlap(['src/cli.ts'], ['./src']));
  assert.ok(overlap(['src//cli.ts'], ['src/cli.ts']));
  for (const root of ['.', './', '']) assert.ok(overlap([root], ['docs/a.md']), `"${root}" overlaps everything`);
  assert.ok(overlap(['a.ts'], ['.']));
  assert.ok(!overlap(['src'], ['srcx/a.ts']));
  assert.ok(!overlap(['./src/'], ['lib/']));
  const r = repo([{ n: 1, files: './src/', wave: '1 parallel' }, { n: 2, files: 'src/cli.ts', wave: '1 parallel' }]);
  await r.run(...initArgs(r));
  const next = await r.run('next', r.plan);
  assert.deepEqual(next.batch.map((s: any) => s.id), ['1']);
  assert.match(next.deferred[0].reason, /files overlap slice 1/);
});

test('R1-9: recover and next list slices that wait for review or verify after an interruption', async () => {
  const r = repo([{ n: 1, wave: '1 parallel' }, { n: 2, wave: '1 parallel', review: 'CI' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  for (const id of ['1', '2']) { await r.run('start', r.plan, id); await r.run('finish', r.plan, id); }
  // interrupted after finish
  for (const out of [await r.run('recover', r.plan), await r.run('next', r.plan)]) {
    assert.deepEqual(out.needsReview, ['1']);
    assert.deepEqual(out.needsVerify, ['2']);
    assert.equal(out.done, false);
  }
  // interrupted after review
  await r.run('review', r.plan, '1', '--by', 'rev', '--note', 'ok');
  for (const out of [await r.run('recover', r.plan), await r.run('next', r.plan)]) {
    assert.deepEqual(out.needsReview, []);
    assert.deepEqual(out.needsVerify, ['1', '2']);
  }
  await r.run('verify', r.plan, '1');
  await r.run('verify', r.plan, '2');
  const done = await r.run('recover', r.plan);
  assert.deepEqual([done.needsReview, done.needsVerify, done.done], [[], [], true]);
});

// ---- review round 2 regressions ----
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) {
    if (n.name === '.git') continue;
    const p = join(d, n.name);
    if (n.isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8');
  } };
  walk(dir);
  return out;
};

test('R1-1 (round 2): a plans folder linked into another Git repo is refused; the other repo stays byte-identical', async () => {
  const a = realpathSync(mkdtempSync(join(tmpdir(), 'ae-repo-a-'))), b = realpathSync(mkdtempSync(join(tmpdir(), 'ae-repo-b-')));
  gitInit(a); gitInit(b);
  mkdirSync(join(b, 'plans'));
  writeFileSync(join(b, 'plans', 'p.md'), planText([{ n: 1 }]));
  symlinkSync(join(b, 'plans'), join(a, 'plans'));
  const before = tree(b);
  for (const argv of [['init', 'plans/p.md'], ['init', join(a, 'plans', 'p.md')]])
    await assert.rejects(main(argv, { cwd: a }), /outside the repo/);
  assert.deepEqual(tree(b), before, 'repo B unchanged');
});

test('R1-5 (round 2): the plan write also needs the journal lock', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  const plan = r.text(), other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await withLock(r.jfile, () => {
      writeFileSync(r.jfile + '.lock', String(other.pid));
      assert.throws(() => writeAtomic(r.plan, 'replaced', r.jfile), /lost the journal lock/);
    });
    assert.equal(r.text(), plan, 'plan unchanged');
  } finally { other.kill(); unlinkSync(r.jfile + '.lock'); }
});

test('R1-6 (round 2): an owned path that is a symlink, or runs through one, is refused at init', async () => {
  for (const files of ['alias.ts', 'linkdir/a.ts', 'linkdir/new.ts']) {
    const r = repo([{ n: 1, files }]);
    r.put('src/a.ts', 'x');
    symlinkSync('src/a.ts', join(r.dir, 'alias.ts'));
    symlinkSync('src', join(r.dir, 'linkdir'));
    await assert.rejects(r.run(...initArgs(r)), /symlink inside the repo/, files);
    assert.equal(existsSync(r.jfile), false);
  }
});

test('R1-7 (round 2): a symlink inside an owned folder counts by its link text only and is never read', () => {
  const r = repo([{ n: 1, files: 'src/' }]);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ae-private-'))), secret = join(outside, 'private');
  writeFileSync(secret, 'v1');
  r.put('src/a.ts', 'a');
  symlinkSync(secret, join(r.dir, 'src', 'link'));
  chmodSync(secret, 0o000);
  try {
    const base = fingerprint(r.dir, ['src/']);
    chmodSync(secret, 0o600); writeFileSync(secret, 'v2'); chmodSync(secret, 0o000);
    assert.equal(fingerprint(r.dir, ['src/']), base, 'the target content never counts');
    unlinkSync(join(r.dir, 'src', 'link'));
    symlinkSync(join(outside, 'other'), join(r.dir, 'src', 'link'));
    assert.notEqual(fingerprint(r.dir, ['src/']), base, 'the link text counts');
  } finally { chmodSync(secret, 0o600); }
});

test('review --reject sends the slice back to READY as a failed attempt on the same ladder', async () => {
  const r = repo([{ n: 1 }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1', '--task-id', 'builder');
  await r.run('finish', r.plan, '1');
  await assert.rejects(r.run('review', r.plan, '1', '--reject', '--by', 'rev'), /--note is required/);
  await assert.rejects(r.run('review', r.plan, '1', '--reject', '--by', 'builder', '--note', 'x'), /independent/);
  const out = await r.run('review', r.plan, '1', '--reject', '--by', 'rev', '--note', 'missing test for API_TOKEN=synthetic-secret');
  assert.deepEqual([out.from, out.to, out.failures], ['AGENT_FINISHED', 'READY', 1]);
  const rec = r.journal().slices['1'];
  const a = rec.attempts.at(-1)!;
  assert.equal(a.outcome, 'failed');
  assert.equal(a.signature, failureSignature('missing test for API_TOKEN=[REDACTED]'));
  assert.ok(!readFileSync(r.jfile, 'utf8').includes('synthetic-secret'));
  assert.equal((await r.run('dispatch', r.plan, '1')).failures, 1, 'dispatch sees the rejection');
  // from REVIEWED too; the same note three times in a row sets FAILED (no progress)
  for (const _ of [1, 2]) {
    await r.run('start', r.plan, '1'); await r.run('finish', r.plan, '1');
    await r.run('review', r.plan, '1', '--by', 'rev2', '--note', 'ok');
    const again = await r.run('review', r.plan, '1', '--reject', '--by', 'rev', '--note', 'missing test for API_TOKEN=synthetic-secret');
    assert.equal(again.from, 'REVIEWED');
  }
  assert.equal(r.state('1'), 'FAILED');
  assert.match(r.journal().slices['1'].history.at(-1)!.reason, /no progress/);
});

// ---- review round 3 regressions ----
test('the fingerprint walk never reads a protected path: it counts by its name only', async () => {
  const r = repo([{ n: 1, files: 'src/' }]);
  r.put('src/a.ts', 'a'); r.put('src/.env.example', 'A='); r.put('src/controls/x.ts', 'c');
  const locked = ['src/.env', 'src/.env.local', 'src/keys/server.pem', 'src/tls.key', 'src/.claude/settings.local.json', 'src/.state/x.json'];
  for (const p of locked) { r.put(p, 'SECRET=synthetic'); chmodSync(join(r.dir, p), 0o000); }
  const rewrite = (p: string, body: string) => { chmodSync(join(r.dir, p), 0o600); writeFileSync(join(r.dir, p), body); chmodSync(join(r.dir, p), 0o000); };
  try {
    const base = fingerprint(r.dir, ['src/']); // a read of any locked file throws EACCES
    for (const p of locked) rewrite(p, 'SECRET=changed');
    assert.equal(fingerprint(r.dir, ['src/']), base, 'protected content never counts');
    r.put('src/.env.example', 'B=');
    const example = fingerprint(r.dir, ['src/']);
    assert.notEqual(example, base, '.env.example is not protected');
    r.put('src/controls/x.ts', 'changed');
    assert.notEqual(fingerprint(r.dir, ['src/']), example, 'controls/ is protected only at the repo root');
    // through the engine: verify, then recover finds the evidence fresh
    await r.run(...initArgs(r));
    await r.run('next', r.plan);
    assert.equal((await r.drive('1')).state, 'VERIFIED');
    assert.deepEqual((await r.run('recover', r.plan)).staleEvidence, []);
  } finally { for (const p of locked) chmodSync(join(r.dir, p), 0o600); }
});

test('a slice that owns . stays fresh after verify: paths are normalized before the engine-file check', async () => {
  const r = repo([{ n: 1, files: '.' }]);
  r.put('other.txt', 'one'); r.put('src/a.ts', 'a');
  assert.equal(fingerprint(r.dir, ['./src//a.ts']), fingerprint(r.dir, ['src/a.ts']), './ and // give the same entries');
  assert.equal(fingerprint(r.dir, ['./']), fingerprint(r.dir, ['.']));
  // controls/ is protected at the repo root only, so the walk from . must see `controls`, not `./controls`
  r.put('controls/controls.json', '{}');
  chmodSync(join(r.dir, 'controls', 'controls.json'), 0o000);
  try { fingerprint(r.dir, ['.']); } finally { chmodSync(join(r.dir, 'controls', 'controls.json'), 0o600); }
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  assert.equal((await r.drive('1')).state, 'VERIFIED');
  assert.ok(existsSync(r.jfile + '.bak'));
  // the page and a held lock appear after the verify; neither counts
  r.put('plans/p.html', '<html>');
  writeFileSync(r.jfile + '.lock', String(process.pid));
  try {
    assert.deepEqual((await r.run('recover', r.plan)).staleEvidence, [], 'the plan, page, journal, .bak, and .lock never count');
    r.put('other.txt', 'two');
    const rep = await r.run('recover', r.plan);
    assert.deepEqual(rep.staleEvidence.map((x: any) => x.slice), ['1'], 'another file still counts');
  } finally { unlinkSync(r.jfile + '.lock'); }
});

// Ready-on-dependencies: wave labels never replace dependency or concurrency checks.
const crossWaveSlices: S[] = [
  { n: 1, wave: '1 parallel' }, { n: 2, wave: '1 parallel', files: 'work/' },
  { n: 3, wave: '1 parallel' }, { n: 4, wave: '2 parallel', deps: 'slices 1 and 3' },
];

test('T1: next offers a later-wave dependent while unrelated earlier work runs', async () => {
  const r = repo(crossWaveSlices, { mode: 'sprint' });
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '2');
  await r.drive('1');
  await r.drive('3');
  assert.deepEqual((await r.run('next', r.plan)).batch.map((s: any) => s.id), ['4']);
});

test('T2: finished and reviewed dependencies wait; ACCEPTED releases a cross-wave slice', async () => {
  const r = repo(crossWaveSlices.map(s => s.n === 3 ? { ...s, verify: 'read by a person' } : s), { mode: 'sprint' });
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '2');
  await r.drive('1');
  await r.run('start', r.plan, '3');
  await r.run('finish', r.plan, '3');
  for (const state of ['AGENT_FINISHED', 'REVIEWED']) {
    assert.equal(r.state('3'), state);
    const out = await r.run('next', r.plan);
    assert.deepEqual(out.batch, []);
    assert.deepEqual(out.waiting, [{ id: '4', waitingOn: ['3'] }]);
    await assert.rejects(r.run('start', r.plan, '4'), /needs READY/);
    if (state === 'AGENT_FINISHED') await r.run('review', r.plan, '3', '--by', 'rev', '--note', 'ok');
  }
  await r.run('verify', r.plan, '3', '--manual', '--by', 'Uma', '--note', 'read');
  assert.equal(r.state('3'), 'ACCEPTED');
  assert.deepEqual((await r.run('next', r.plan)).batch.map((s: any) => s.id), ['4']);
});

test('T3: overlap with an earlier-wave running folder still defers work', async () => {
  const r = repo(crossWaveSlices.map(s => s.n === 4 ? { ...s, files: 'work/child.ts' } : s), { mode: 'sprint' });
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '2');
  await r.drive('1');
  await r.drive('3');
  const out = await r.run('next', r.plan);
  assert.deepEqual(out.batch, []);
  assert.deepEqual(out.deferred, [{ id: '4', reason: 'files overlap slice 2' }]);
});

test('T4: two running slices fill balanced width across waves', async () => {
  const r = repo([{ n: 2, wave: '1 parallel' }, { n: 4, wave: '2 parallel' }, { n: 5, wave: '1 parallel' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '2');
  await r.run('start', r.plan, '5');
  const out = await r.run('next', r.plan);
  assert.deepEqual(out.batch, []);
  assert.deepEqual(out.deferred, [{ id: '4', reason: 'no free slot' }]);
});

test('T5: integration and sequential slices retain runs-alone rules across waves', async () => {
  for (const kind of ['sequential', 'integration']) {
    const r = repo([{ n: 1, wave: '1 parallel' }, { n: 2, wave: `2 ${kind}` }], { mode: 'sprint' });
    await r.run(...initArgs(r));
  await r.run('next', r.plan);
    await r.run('start', r.plan, '1');
    const out = await r.run('next', r.plan);
    assert.deepEqual(out.batch, []);
    assert.deepEqual(out.deferred, [{ id: '2', reason: `${kind} slice runs alone` }]);
    const q = repo([{ n: 1, wave: `1 ${kind}` }, { n: 2, wave: '2 parallel' }], { mode: 'sprint' });
    await q.run(...initArgs(q));
    await q.run('next', q.plan);
    await q.run('start', q.plan, '1');
    assert.deepEqual((await q.run('next', q.plan)).deferred, [{ id: '2', reason: 'a sequential or integration slice is running' }]);
  }
});

test('T6: one free slot chooses lowest wave then slice id', async () => {
  const r = repo([{ n: 1, wave: '1 parallel' }, { n: 2, wave: '3 parallel' }, { n: 4, wave: '2 parallel' }, { n: 3, wave: '2 parallel' }]);
  await r.run(...initArgs(r));
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1');
  assert.deepEqual((await r.run('next', r.plan)).batch.map((s: any) => s.id), ['3']);
});
