// Slice 11: real CLI process death and contention. The kernel suite owns the low-level fs-step fault matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceLine, journalPath, loadJournal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { parsePlan } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';

const AE = join(dirname(fileURLToPath(import.meta.url)), '../tools/agents/skills/autonomous-engineering/scripts/ae.ts');
const LEAD = 'Claude (opus/high)', MODEL = 'Codex (gpt-6.1-sol/medium)';
const env = { ...process.env, AE_FAULT_POINT: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const slice = (n: number) => [
  `### Slice ${n}: s${n}`, `- Goal: goal ${n}`, `- Model: ${MODEL}`, '- Review: Claude (opus/medium)',
  '- Fallback: Codex (gpt-6-astra/medium)', '- Wave: 1 parallel', '- Depends on: none', `- Files: f${n}.txt`,
  '- Out of scope: src/', `- Accept: accept ${n}`, '- Verify: `true`', '- State: PLANNED', '- Evidence: none',
  `- [ ] do it · ${MODEL} · Verify command passes · revert`, '',
].join('\n');

function repo(count = 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-process-crash-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans/p.md'), jfile = journalPath(plan);
  writeFileSync(plan, [
    '---', 'kind: plan', 'title: t', 'status: active', 'updated: 2026-11-08', 'planner: multi-agent-slice-planner',
    'mode: standard', '---', 'Summary: test', '', '## Slices',
    ...Array.from({ length: count }, (_, i) => slice(i + 1)), '## Open', '- none', '',
  ].join('\n'));
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, `f${i}.txt`), `base ${i}\n`);
  // A real base commit, using fixture-only identity and no hooks or signing. Never commit in the source checkout.
  git('add', '.');
  git('-c', 'user.name=ae fixture', '-c', 'user.email=ae@localhost', '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  function launch(args: string[], fault = '') {
    const child = spawn(process.execPath, ['--experimental-strip-types', AE, ...args], {
      cwd: dir, env: { ...env, AE_FAULT_POINT: fault }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 60_000);
      child.on('error', e => { clearTimeout(timeout); reject(e); });
      child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
    });
  }
  const run = async (...args: string[]) => {
    const out = await launch([args[0], plan, ...args.slice(1), '--wait-lock', '30']);
    assert.equal(out.signal, null, out.stderr);
    assert.equal(out.code, 0, `${args.join(' ')}: ${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const raw = () => readFileSync(jfile, 'utf8');
  const journal = (): Journal => JSON.parse(raw());
  return { dir, plan, jfile, git, run, launch, raw, journal };
}
type Repo = ReturnType<typeof repo>;
async function start(r: Repo, count = 1) {
  await r.run('init'); await r.run('next');
  for (let i = 1; i <= count; i++) await r.run('start', String(i));
}
function reconciled(r: Repo) {
  const j = r.journal(), p = parsePlan(readFileSync(r.plan, 'utf8'), r.plan);
  for (const s of p.slices) {
    assert.equal(s.state, j.slices[s.id].state, `slice ${s.id} State line`);
    assert.equal(s.evidence, evidenceLine(j.slices[s.id]), `slice ${s.id} Evidence line`);
  }
  assert.equal(j.schemaVersion, 1);
  assert.doesNotMatch(r.raw(), /:\s*null\b/);
}

const SAVE_POINTS = [
  'save:before',
  ...['backup', 'journal'].flatMap(scope => ['temp-written', 'temp-synced', 'renamed', 'dir-synced'].map(step => `${scope}:${step}`)),
  'save:before-plan', 'save:after-plan',
];
for (const point of SAVE_POINTS) {
  test(`Accept 1: SIGKILL at ${point} leaves a whole journal; the next command repairs State and Evidence`, async () => {
    const r = repo();
    await start(r); await r.run('finish', '1'); await r.run('review', '1', '--by', 'Claude (opus/medium)', '--note', 'fixture review');
    const old = r.journal(), backup = JSON.parse(readFileSync(r.jfile + '.bak', 'utf8'));
    const killed = await r.launch(['verify', r.plan, '1'], point);
    assert.equal(killed.signal, 'SIGKILL', `${point} was reached: ${killed.stderr}`);
    assert.equal(killed.code, null);
    assert.ok(existsSync(r.jfile + '.lock'), 'a real kill leaves the lock behind');
    assert.equal(loadJournal(r.jfile).recoveredFromBackup, false);
    const current = r.journal(), bak = JSON.parse(readFileSync(r.jfile + '.bak', 'utf8'));
    if (current.slices['1'].state === 'REVIEWED') assert.deepEqual(current, old, 'the complete old journal');
    else {
      assert.equal(current.slices['1'].state, 'VERIFIED');
      assert.equal(current.slices['1'].evidence.length, 1);
      assert.equal(current.slices['1'].evidence[0].exitCode, 0);
      // Only the verify's state, evidence, and timestamp can differ from the old journal.
      assert.deepEqual({ ...current, updatedAt: old.updatedAt, slices: { ...current.slices, '1': old.slices['1'] } }, old);
    }
    assert.ok(JSON.stringify(bak) === JSON.stringify(old) || JSON.stringify(bak) === JSON.stringify(backup), 'whole backup');
    const inspection = await r.run('recover');
    assert.equal(inspection.lock.stale, true);
    if (current.slices['1'].state === 'VERIFIED' && point !== 'save:after-plan') {
      assert.deepEqual(inspection.planDrift.map((d: { field: string }) => d.field).sort(), ['Evidence', 'State']);
    }
    if (point.endsWith('temp-written') || point.endsWith('temp-synced')) assert.equal(inspection.tempFiles.length, 1);
    await r.run('status');
    assert.equal(existsSync(r.jfile + '.lock'), false);
    reconciled(r);
    assert.deepEqual(r.journal(), current, 'repair does not change the canonical journal');
  });
}

test('Accept 2: two real ae processes race 100 mixed commands without losing decisions or checkpoints', async () => {
  const r = repo(8);
  await start(r, 8);
  const keys: string[] = [], notes: string[] = [];
  let commands = 0;
  for (let i = 0; i < 50; i++) {
    const args = [0, 1].map(lane => {
      if (i % 3 === 0) {
        const key = `race.lane${lane}.step${i}`; keys.push(key);
        return ['decide', '--key', key, '--risk', 'green', '--status', 'assumed', '--question', `question ${lane} ${i}`,
          '--answer', `answer ${lane} ${i}`, '--lead', LEAD];
      }
      if (i % 3 === 1) {
        const note = `checkpoint lane ${lane} step ${i}`; notes.push(note);
        return ['checkpoint', String(1 + lane * 4 + Math.floor(i / 3) % 4), '--done', note];
      }
      return ['status'];
    });
    // Both OS processes start before either is awaited. Each CLI must acquire the same journal lock.
    await Promise.all(args.map(a => r.run(...a)));
    commands += 2;
  }
  assert.equal(commands, 100);
  const j = r.journal();
  assert.equal(keys.length, 34); assert.equal(notes.length, 34);
  assert.deepEqual(j.decisions?.map(d => d.key).sort(), keys.sort());
  assert.equal(new Set(j.decisions?.map(d => d.id)).size, keys.length, 'unique decision ids');
  const checkpoints = Object.values(j.slices).flatMap(s => s.checkpoints ?? []);
  assert.deepEqual(checkpoints.map(cp => cp.done).sort(), notes.sort(), 'all 34 checkpoints retained (at most five per slice)');
  assert.ok(Object.values(j.slices).every(s => s.attempts.length === 1 && s.state === 'IN_PROGRESS'));
  assert.equal(loadJournal(r.jfile).recoveredFromBackup, false);
  reconciled(r);
});

test('Accept 3: a kill after the snapshot ref and before the journal save is counted by recover', async () => {
  const r = repo(); await start(r);
  writeFileSync(join(r.dir, 'f1.txt'), 'first milestone\n');
  const recorded = (await r.run('checkpoint', '1')).checkpoint.snapshot;
  assert.ok(recorded);
  writeFileSync(join(r.dir, 'f1.txt'), 'second milestone\n');
  const before = r.raw();
  const killed = await r.launch(['checkpoint', r.plan, '1', '--done', 'second'], 'checkpoint:taken');
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(r.raw(), before, 'the checkpoint never reached the journal');
  const refs = r.git('for-each-ref', '--format=%(refname)', 'refs/ae/snapshots/p/1/').split('\n');
  assert.equal(refs.length, 2);
  const orphan = refs.find(ref => ref !== recorded)!;
  // A different plan's ref is neither named nor counted by this plan's recover.
  r.git('update-ref', 'refs/ae/snapshots/other/1/1', orphan);
  for (const apply of [false, true]) {
    const recovery = await r.run('recover', ...(apply ? ['--apply'] : []));
    assert.equal(recovery.orphanSnapshotCount, 1);
    assert.deepEqual(recovery.orphanSnapshotRefs, [orphan]);
    assert.equal(r.raw(), before, 'counting and stale-lock takeover do not rewrite the journal');
    assert.equal(r.git('show', `${orphan}:f1.txt`), 'second milestone', 'orphan still preserves the partial work');
  }
  assert.equal(existsSync(r.jfile + '.lock'), false);
});

test('Accept 4 (scenario 7): two interrupted slices recover independently and exclude the failing account', async () => {
  const r = repo(2); await start(r, 2);
  const original = r.journal();
  await Promise.all(['1', '2'].map(id => r.run('interrupt', id, '--class', 'quota', '--source', 'lead', '--lead', LEAD)));
  const recovery = await r.run('recover');
  assert.deepEqual(recovery.recovery.map((x: { slice: string }) => x.slice), ['1', '2']);
  for (const row of recovery.recovery) {
    const candidates: string[] = row.options.flatMap((o: { candidates?: string[] }) => o.candidates ?? []);
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(c => !c.startsWith('Codex')), `${row.slice}: the Codex fallback and pool candidates share the failing account`);
    assert.ok(row.excluded.some((x: { reason: string }) => /shares the account limit/.test(x.reason)));
  }
  const interrupted = r.journal().slices['2'];
  const saved = interrupted.attempts[0].interruptions?.[0];
  assert.ok(saved);
  for (const id of ['1', '2']) {
    await r.run('checkpoint', id, '--kind', 'post-mortem', '--done', `partial work ${id}`);
    await r.run('prepare', id, '--to', LEAD, '--reason', 'quota', '--lead', LEAD);
    await r.run('transfer', id, '--lead', LEAD);
    const current = r.journal().slices[id];
    assert.equal(current.attempts.length, 2);
    assert.equal(current.attempts[0].outcome, 'handed-off');
    assert.equal(current.attempts[1].baseTree, original.slices[id].attempts[0].baseTree);
    assert.equal(current.attempts[1].launchKey, `ae:p#${id}/a2`);
    assert.equal(current.attempts[1].outcome, undefined);
    assert.equal(current.handoffs?.at(-1)?.phase, 'TRANSFERRED');
    if (id === '1') {
      assert.deepEqual(r.journal().slices['2'], interrupted, 'recovering slice 1 never changes slice 2');
      const remaining = await r.run('recover');
      assert.deepEqual(remaining.recovery.map((x: { slice: string }) => x.slice), ['2']);
    }
  }
  assert.deepEqual(r.journal().slices['2'].attempts[0].interruptions?.[0], { ...saved, resolved: 'handed-off' });
  assert.equal((await r.run('recover')).recovery, undefined, 'both interruptions resolved by their own transfers');
  reconciled(r);
});
