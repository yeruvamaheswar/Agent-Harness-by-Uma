import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { failures, loadJournal, pidAlive } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';

const AE = join(dirname(fileURLToPath(import.meta.url)), '../tools/agents/skills/autonomous-engineering/scripts/ae.ts');
const DEADLINE = '2030-11-05T19:00:00-06:00';
const LEAD = 'Claude (opus/high)';
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-run-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = 'plans/p.md', jfile = join(dir, 'plans/p.run.json');
  const text = `---\nkind: plan\ntitle: Run fixture\nstatus: active\nupdated: 2026-11-05\nplanner: multi-agent-planning\nmode: standard\n---\nGoal: Bound an unattended run\n\n## Slices\n` + [1, 2, 3].map(n => `
### Slice ${n}: work ${n}
- Goal: work ${n}
- Model: Codex (auto)
- Review: Claude (opus/high)
- Fallback: Cursor (auto)
- Wave: 1 parallel
- Depends on: none
- Files: f${n}.txt
- Out of scope: src/
- Accept: check ${n}
- Verify: \`echo checked\`
- State: PLANNED
- Evidence: none
- [ ] build · Codex (auto) · check passes · revert
`).join('\n');
  writeFileSync(join(dir, plan), text);
  writeFileSync(join(dir, 'approval.md'), 'Approval\nLocal commits on the run branch are approved.\n');
  let time = new Date('2030-11-05T12:00:00Z');
  const run = (...args: string[]) => main(args, { cwd: dir, now: () => time });
  const charter = (...args: string[]) => run('charter', plan, '--approval', 'approval.md:2', '--deadline', DEADLINE, ...args);
  const journal = () => loadJournal(jfile).journal;
  const start = (id: string) => run('start', plan, id, '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  const finish = (id: string) => run('finish', plan, id, '--summary', 'completed by worker');
  const review = (id: string, ...args: string[]) => run('review', plan, id, '--by', 'independent-task', '--note', 'diff inspected', '--provider', 'claude', '--model', 'opus', '--effort', 'high', ...args);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', AE, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, plan, jfile, run, charter, journal, start, finish, review, cli, setTime: (date: string) => { time = new Date(date); } };
}
const initialized = async () => {
  const r = fixture();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  return r;
};

test('charter CLI stores the repo approval line, deadline, repeated caps, optional branch and explicit commit grant', async () => {
  const r = await initialized();
  const out = r.cli('charter', r.plan, '--approval', 'approval.md:2', '--deadline', DEADLINE, '--branch', 'overnight/test', '--grant', 'commit', '--cap', 'claude/opus/high=8', '--cap', 'codex/auto/auto=4');
  assert.equal(out.status, 0, out.stderr);
  const run = r.journal().run;
  assert.ok(run);
  assert.deepEqual(run.approval, { path: 'approval.md', line: 2, text: 'Local commits on the run branch are approved.' });
  assert.equal(run.deadline, '2030-11-06T01:00:00.000Z');
  assert.equal(run.branch, 'overnight/test');
  assert.deepEqual(run.grants, ['commit']);
  assert.deepEqual(run.caps, [{ provider: 'claude', model: 'opus', effort: 'high', limit: 8 }, { provider: 'codex', model: 'auto', effort: 'auto', limit: 4 }]);
  assert.equal(r.journal().authority.allow.includes('commit'), false);
  const before = readFileSync(r.jfile);
  await assert.rejects(r.charter(), /--replace --reason/);
  await assert.rejects(r.charter('--replace'), /--replace --reason/);
  await assert.rejects(r.charter('--reason', 'new scope'), /--replace --reason/);
  assert.deepEqual(readFileSync(r.jfile), before);
  await r.charter('--replace', '--reason', 'user reduced scope');
  assert.deepEqual(r.journal().run?.grants, [], 'branch or approval alone never grants commit');
  assert.equal(r.journal().run?.reason, 'user reduced scope');
  assert.equal(r.journal().run?.branch, undefined);
});

test('invalid approval pointers, unsafe paths, deadlines, caps and grants leave the journal unchanged', async () => {
  const r = await initialized(), before = readFileSync(r.jfile);
  for (const approval of ['approval.md', 'approval.md:0', 'approval.md:3', 'missing.md:1', '../outside.md:1', '.env:1', 'plans:1']) {
    await assert.rejects(r.run('charter', r.plan, '--approval', approval, '--deadline', DEADLINE));
    assert.deepEqual(readFileSync(r.jfile), before);
  }
  symlinkSync(join(r.dir, 'approval.md'), join(r.dir, 'approval-link.md'));
  await assert.rejects(r.run('charter', r.plan, '--approval', 'approval-link.md:2', '--deadline', DEADLINE), /refused/);
  for (const deadline of ['2030-11-05T19:00:00', '19:00 CST', 'invalidZ']) {
    await assert.rejects(r.run('charter', r.plan, '--approval', 'approval.md:2', '--deadline', deadline), /UTC offset/);
  }
  for (const cap of ['claude/opus/high=-1', 'claude/opus/high=1.5', 'opus=8', 'claude/opus/high=9007199254740992']) {
    await assert.rejects(r.charter('--cap', cap), /--cap/);
  }
  await assert.rejects(r.charter('--cap', 'claude/opus/high=1', '--cap', 'CLAUDE/opus/high=2'), /duplicate cap/);
  await assert.rejects(r.charter('--grant', 'push'), /commit only/);
  await assert.rejects(r.charter('--branch', '../main'), /branch name/);
  assert.deepEqual(readFileSync(r.jfile), before);
});

test('without a run block, next and start retain their existing behavior', async () => {
  const r = await initialized();
  r.setTime('2099-01-01T00:00:00Z');
  assert.equal((await r.run('next', r.plan)).stop, undefined);
  assert.equal((await r.start('1')).state, 'IN_PROGRESS');
  assert.equal(r.journal().run, undefined);
});

test('next and start stop at the exact deadline without changing attempts or slice state; report agrees', async () => {
  const r = await initialized();
  await r.charter();
  r.setTime('2030-11-06T00:59:59Z');
  assert.equal((await r.run('next', r.plan)).stop, undefined);
  r.setTime('2030-11-06T01:00:00Z');
  const before = readFileSync(r.jfile);
  const next = await r.run('next', r.plan);
  assert.equal(next.stop, 'deadline');
  assert.deepEqual(next.batch, []);
  assert.equal((await r.start('1')).stop, 'deadline');
  assert.deepEqual(readFileSync(r.jfile), before);
  assert.deepEqual((await r.run('report', r.plan, '--json')).stop, { stop: 'deadline', deadline: '2030-11-06T01:00:00.000Z' });
  r.setTime('2031-01-01T00:00:00Z');
  assert.equal((await r.start('2')).stop, 'deadline');
});

test('accepted and rejected reviews both count against a provider/model/effort cap; verifies do not', async () => {
  const r = await initialized();
  await r.charter('--cap', 'claude/opus/high=2');
  await r.start('1'); await r.finish('1'); await r.review('1');
  const accepted = r.journal().slices['1'].attempts.at(-1);
  assert.equal(accepted?.kind, 'review');
  assert.equal(accepted?.outcome, 'finished');
  assert.deepEqual([accepted?.provider, accepted?.model, accepted?.effort], ['claude', 'opus', 'high']);
  await r.run('verify', r.plan, '1');
  assert.equal((await r.run('next', r.plan)).stop, undefined);
  await r.start('2'); await r.finish('2'); await r.review('2', '--reject');
  const rejected = r.journal().slices['2'].attempts.at(-1);
  assert.equal(rejected?.kind, 'review');
  assert.equal(rejected?.outcome, 'failed');
  assert.deepEqual([rejected?.provider, rejected?.model, rejected?.effort], ['claude', 'opus', 'high']);
  assert.equal(failures(r.journal().slices['1']).length, 0);
  assert.equal(failures(r.journal().slices['2']).length, 1);
  const before = readFileSync(r.jfile), next = await r.run('next', r.plan);
  assert.equal(next.stop, 'budget');
  assert.equal(next.used, 2);
  assert.equal((await r.start('3')).stop, 'budget');
  assert.deepEqual(readFileSync(r.jfile), before);
  const report = await r.run('report', r.plan, '--json');
  assert.deepEqual(report.stop, { stop: 'budget', cap: { provider: 'claude', model: 'opus', effort: 'high', limit: 2 }, used: 2 });
});

test('a zero cap stops before any attempt, while a nonmatching provider, model or effort does not count', async () => {
  const r = await initialized();
  await r.charter('--cap', 'codex/auto/auto=0');
  assert.equal((await r.run('next', r.plan)).stop, 'budget');
  assert.equal((await r.start('1')).stop, 'budget');
  await r.charter('--replace', '--reason', 'new budget', '--cap', 'codex/auto/high=1', '--cap', 'claude/auto/auto=1', '--cap', 'codex/opus/auto=1');
  await r.start('1');
  assert.equal((await r.run('next', r.plan)).stop, undefined);
  await r.charter('--replace', '--reason', 'count existing work', '--cap', 'codex/auto/auto=1');
  assert.equal((await r.run('next', r.plan)).stop, 'budget');
});

test('outage recovery needs no usage call, preserves the prepare reason and done text, and counts handoff attempts without failures', async () => {
  const r = await initialized();
  await r.charter('--cap', 'codex/auto/auto=2');
  await r.start('1');
  const reason = 'provider login service unavailable';
  await r.run('prepare', r.plan, '1', '--to', 'Codex (auto, fresh session)', '--lead', LEAD, '--reason', reason);
  await r.run('checkpoint', r.plan, '1', '--done', 'Parser written and saved.', '--next', 'Add regression coverage.');
  const transfer = await r.run('transfer', r.plan, '1', '--lead', LEAD, '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  assert.equal(transfer.failures, 0);
  const rec = r.journal().slices['1'];
  assert.equal(rec.attempts[0].reason, reason);
  assert.equal(rec.attempts[0].outcome, 'handed-off');
  assert.equal(rec.attempts.length, 2);
  assert.equal(failures(rec).length, 0);
  const note = await r.run('handoff', r.plan, '1');
  assert.equal(typeof note.text, 'string');
  assert.match(String(note.text), /Done: Parser written and saved\./);
  assert.match(String(note.text), /provider login service unavailable/);
  const before = readFileSync(r.jfile);
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  assert.deepEqual(readFileSync(r.jfile), before, 'repeated transfer creates no attempt');
  assert.equal((await r.run('next', r.plan)).stop, 'budget');
  assert.equal((await r.start('2')).stop, 'budget');
});

test('recover retains orphan temp files, takes over a dead lock on apply, preserves live work and never redoes VERIFIED work', async () => {
  const r = await initialized();
  await r.start('1'); await r.finish('1'); await r.review('1'); await r.run('verify', r.plan, '1');
  await r.start('2');
  const verified = structuredClone(r.journal().slices['1']);
  let deadPid = 2147483647;
  while (pidAlive(deadPid)) deadPid--;
  const temps = [r.jfile + `.${deadPid}.abc123.tmp`, join(r.dir, r.plan) + `.${deadPid}.def456.tmp`];
  for (const temp of temps) writeFileSync(temp, 'interrupted atomic write');
  const liveTemp = r.jfile + `.${process.pid}.abc123.tmp`;
  writeFileSync(liveTemp, 'live writer');
  const other = 'unrelated.123.abc.tmp';
  writeFileSync(join(r.dir, other), 'unowned data');
  writeFileSync(r.jfile + '.lock', String(deadPid));
  const before = readFileSync(r.jfile);
  const readonly = r.cli('recover', r.plan);
  assert.equal(readonly.status, 0, readonly.stderr);
  const result = JSON.parse(readonly.stdout);
  assert.equal(result.lock.stale, true);
  assert.deepEqual(result.tempFiles, temps.map(p => relative(r.dir, p)).sort());
  for (const temp of result.tempFiles) assert.ok(!result.git.unowned.includes(temp));
  assert.ok(result.git.unowned.includes(other));
  assert.ok(result.git.unowned.includes(relative(r.dir, liveTemp)), 'live temp is not classified as an orphan');
  assert.deepEqual(result.inProgress.map((s: { slice: string }) => s.slice), ['2']);
  assert.deepEqual(readFileSync(r.jfile), before);
  const apply = await r.run('recover', r.plan, '--apply');
  assert.equal(apply.staleLockTakenOver, true);
  assert.deepEqual(r.journal().slices['1'], verified);
  assert.equal(r.journal().slices['2'].state, 'IN_PROGRESS');
  assert.equal(r.journal().slices['2'].attempts.length, 1);
  for (const temp of temps) assert.equal(readFileSync(temp, 'utf8'), 'interrupted atomic write');
  assert.equal(existsSync(r.jfile + '.lock'), false);
  const next = await r.run('next', r.plan);
  assert.equal(JSON.stringify(next.batch).includes('"id":"1"'), false);
});
