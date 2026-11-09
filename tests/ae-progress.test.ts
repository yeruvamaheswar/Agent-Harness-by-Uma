// Slice 7 (plans/unified-agent-harness-master.md): progress capture. Base tree, delta, diffStat, the hidden snapshot
// ref, health findings, the engine-run check, and worker milestones (DEC-5, DEC-6; review-1 F13, F14).
// Every test uses its own temp Git repo; nothing touches the real repo or its plans/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { healthCodes, ownedFiles, restoreSnapshot, snapshotFiles, snapshotRefs } from '../tools/agents/skills/autonomous-engineering/scripts/progress.ts';

const LEAD = 'Claude (opus/high)';
type S = { files: string; verify?: string };
const planText = (s: S) => `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-08\nplanner: multi-agent-slice-planner\nmode: standard\n---\nSummary: progress\n\n## Slices\n${[
  '### Slice 1: progress', '- Goal: capture progress', '- Model: Codex (gpt-6.1-sol/medium)', '- Review: Claude (opus/medium, fresh session)',
  '- Fallback: Codex (gpt-6-astra/medium)', '- Wave: 1 sequential', '- Depends on: none', `- Files: ${s.files}`, '- Out of scope: src/',
  '- Accept: files complete', `- Verify: ${s.verify ?? '`true`'}`, '- State: PLANNED', '- Evidence: none', '',
].join('\n')}\n## Open\n- none\n`;

function repo(s: S) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-progress-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, planText(s));
  let t = Date.UTC(2026, 10, 8, 6);
  const now = () => new Date((t += 1000));
  const api = {
    dir, plan, git,
    run: (...argv: string[]) => main(argv, { cwd: dir, now }) as Promise<any>,
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    raw: () => readFileSync(journalPath(plan), 'utf8'),
    put: (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); },
    read: (rel: string) => readFileSync(join(dir, rel), 'utf8'),
    begin: async () => { await api.run('init', plan); await api.run('next', plan); return api.run('start', plan, '1'); },
    // the lead's handoff to a replacement: post-mortem checkpoint, prepare, transfer
    handOff: async (to: string, ...cpFlags: string[]) => {
      const cp = (await api.run('checkpoint', plan, '1', '--kind', 'post-mortem', ...cpFlags)).checkpoint;
      await api.run('prepare', plan, '1', '--to', to, '--lead', LEAD, '--reason', 'usage limit');
      await api.run('transfer', plan, '1', '--lead', LEAD);
      return cp;
    },
  };
  return api;
}
const nullPaths = (v: unknown, at = '$'): string[] => v === null ? [at]
  : Array.isArray(v) ? v.flatMap((x, i) => nullPaths(x, `${at}[${i}]`))
  : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => nullPaths(x, `${at}.${k}`)) : [];
// the real index, HEAD, and branches: a snapshot never changes them
const gitState = (r: ReturnType<typeof repo>) => ({
  status: r.git('status', '--porcelain', '--untracked-files=all'), staged: r.git('diff', '--cached', '--name-only'),
  heads: r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes'),
  head: r.git('symbolic-ref', '-q', 'HEAD'),
});

// ---- Accept 1: scenario 1, a usage limit before any work ----
test('Accept 1: a stop before work gives an empty delta, "nothing written yet", no snapshot, and no failure counted', async () => {
  const r = repo({ files: 'a.ts, b.ts' });
  await r.begin();
  const it = await r.run('interrupt', r.plan, '1', '--class', 'quota', '--code', 'usage_limit', '--source', 't3', '--lead', LEAD);
  assert.equal(it.failures, 0);
  const cp = await r.handOff('Claude (opus/high)', '--next', 'start a.ts');
  assert.deepEqual(cp.delta, []);
  assert.equal(cp.deltaCount, 0);
  assert.equal('diffStat' in cp, false);
  assert.equal('snapshot' in cp, false, 'nothing done needs no snapshot');
  assert.deepEqual(snapshotRefs(r.dir, 'p', '1'), []);
  const h = await r.run('handoff', r.plan, '1');
  assert.match(h.text, /^Changed so far: none \(nothing written yet\)\.$/m);
  assert.doesNotMatch(h.text, /Snapshot of the owned files/);
  const rec = r.journal().slices['1'];
  assert.equal(rec.state, 'IN_PROGRESS');
  assert.equal(rec.attempts.filter(a => a.outcome === 'failed').length, 0, 'no failure counted');
  assert.equal(rec.attempts[0].outcome, 'handed-off');
  assert.deepEqual(nullPaths(r.journal()), []);
});

// ---- Accept 2: scenario 3, an API error during a tool call ----
test('Accept 2: a half-written file is in the delta, the failing check tail and the interrupted operation are in the packet', async () => {
  const r = repo({ files: 'a.ts, b.ts', verify: '`sh check.sh`' });
  r.put('check.sh', 'grep -q complete b.ts || { echo "b.ts is incomplete: half written"; exit 1; }\n');
  await r.begin();
  r.put('a.ts', 'export const a = "complete";\n');
  r.put('b.ts', 'export const b = "hal');
  await r.run('interrupt', r.plan, '1', '--class', 'api', '--code', 'overloaded', '--source', 'lead', '--operation', 'Edit b.ts', '--lead', LEAD);
  const out = await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem', '--run-check', '--next', 'finish b.ts');
  const cp = out.checkpoint;
  assert.deepEqual(cp.delta, ['a.ts', 'b.ts']);
  assert.equal(cp.deltaCount, 2);
  assert.deepEqual(cp.diffStat, { files: 2, insertions: 2, deletions: 0 });
  assert.equal(cp.check.exitCode, 1);
  assert.equal(cp.check.stable, true);
  assert.match(cp.check.tail, /b\.ts is incomplete: half written/);
  await r.run('prepare', r.plan, '1', '--to', 'Claude (opus/high)', '--lead', LEAD, '--reason', 'api error');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  const h = await r.run('handoff', r.plan, '1');
  assert.match(h.text, /^Failure \(observed\): api code overloaded at .*, during: Edit b\.ts\.$/m);
  assert.match(h.text, /^Changed so far: a\.ts \(blob [0-9a-f]{8}\), b\.ts \(blob [0-9a-f]{8}\)\.$/m);
  assert.match(h.text, /^Engine check \(observed\): sh check\.sh: exit 1; tail: b\.ts is incomplete: half written\.$/m);
  assert.match(h.text, /^Snapshot of the owned files: refs\/ae\/snapshots\/p\/1\/1\.$/m);
  const observed = h.packet.sections.find((x: any) => x.key === 'observed').items;
  assert.ok(observed.some((i: any) => i.label === 'observed' && /^engine check: sh check\.sh: exit 1; tail: b\.ts is incomplete/.test(i.text)));
  assert.equal(r.journal().slices['1'].attempts.filter(a => a.outcome === 'failed').length, 0);
});

test('Accept 2: health lists an interrupted Git operation, a stale index.lock, unmerged paths, and a moved HEAD, under Unknown', async () => {
  const r = repo({ files: 'a.ts' });
  r.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  await r.begin();
  r.put('a.ts', 'x\n');
  const first = (await r.run('checkpoint', r.plan, '1', '--note', 'clean')).checkpoint;
  assert.equal('health' in first, false, 'a clean repo has no health finding');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two');
  const gitDir = join(r.dir, '.git');
  writeFileSync(join(gitDir, 'index.lock'), '');
  writeFileSync(join(gitDir, 'MERGE_HEAD'), r.git('rev-parse', 'HEAD'));
  mkdirSync(join(gitDir, 'rebase-merge'));
  const cp = await r.handOff('Claude (opus/high)');
  assert.deepEqual(cp.health, ['merge-in-progress', 'rebase-in-progress', 'index-lock', 'head-moved']);
  const h = await r.run('handoff', r.plan, '1');
  assert.match(h.text, /^Unknown: health: merge-in-progress; health: rebase-in-progress/m);
  assert.ok(h.packet.sections.find((x: any) => x.key === 'unknown').items.some((i: any) => i.label === 'unknown' && i.text === 'health: index-lock'));

  // unmerged paths, from a real conflict in a second repo
  const u = repo({ files: 'c.txt' });
  const g = (...a: string[]) => u.git('-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
  u.put('c.txt', 'base\n'); g('add', 'c.txt'); g('commit', '-q', '-m', 'base');
  const main = u.git('symbolic-ref', '--short', 'HEAD').trim();
  g('checkout', '-q', '-b', 'other'); u.put('c.txt', 'other\n'); g('commit', '-q', '-am', 'other');
  g('checkout', '-q', main); u.put('c.txt', 'mine\n'); g('commit', '-q', '-am', 'mine');
  assert.throws(() => g('merge', '-q', 'other'));
  const head = u.git('rev-parse', 'HEAD').trim();
  assert.deepEqual(healthCodes(u.dir, head, head), ['merge-in-progress', 'unmerged-paths']);
});

// ---- Accept 3: scenario 9, uncommitted partial work ----
test('Accept 3: the snapshot holds every changed owned file, a restore reproduces them, and no plans/ file or journal is in it', async () => {
  const r = repo({ files: 'src2/, notes.md, plans/extra.md' });
  r.put('src2/keep.ts', 'export const keep = 1;\n');
  r.git('add', 'src2/keep.ts');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  await r.begin();
  r.put('src2/keep.ts', 'export const keep = 2; // edited, uncommitted\n');
  r.put('src2/deep/new.ts', 'export const fresh = true;\n');
  r.put('notes.md', '# notes, untracked\n');
  r.put('plans/extra.md', 'an owned plan file\n');
  const before = gitState(r);
  const cp = (await r.run('checkpoint', r.plan, '1', '--kind', 'milestone', '--note', 'partial')).checkpoint;
  assert.deepEqual(cp.delta, ['notes.md', 'plans/extra.md', 'src2/deep/new.ts', 'src2/keep.ts']);
  assert.equal(cp.snapshot, 'refs/ae/snapshots/p/1/1');
  assert.deepEqual(gitState(r), before, 'the real index, HEAD, and branches are untouched');

  const held = snapshotFiles(r.dir, cp.snapshot)!;
  assert.deepEqual(held, ['notes.md', 'src2/deep/new.ts', 'src2/keep.ts'], 'every changed owned file except plans/');
  assert.ok(!held.some(p => p.startsWith('plans/') || p.includes('.run.json')), 'no plans/ file and no journal');

  // the worker's files are lost; a restore from the snapshot brings them back byte for byte
  const into = realpathSync(mkdtempSync(join(tmpdir(), 'ae-restore-into-')));
  assert.deepEqual(restoreSnapshot(r.dir, cp.snapshot, into), held);
  for (const p of held) assert.equal(readFileSync(join(into, p), 'utf8'), r.read(p), p);
  assert.deepEqual(gitState(r), before, 'a restore touches nothing in the repo');

  // a second checkpoint takes the next number and never moves the first ref
  const firstSha = r.git('rev-parse', cp.snapshot).trim();
  r.put('src2/deep/new.ts', 'export const fresh = false;\n');
  const cp2 = (await r.run('checkpoint', r.plan, '1', '--note', 'more')).checkpoint;
  assert.equal(cp2.snapshot, 'refs/ae/snapshots/p/1/2');
  assert.equal(r.git('rev-parse', cp.snapshot).trim(), firstSha);
  assert.deepEqual(snapshotRefs(r.dir, 'p', '1'), ['refs/ae/snapshots/p/1/1', 'refs/ae/snapshots/p/1/2']);
  // the snapshot commit has no parent and no branch: it is reachable only from refs/ae/
  assert.equal(r.git('rev-list', '--parents', '-n', '1', cp2.snapshot).trim().split(' ').length, 1);
  assert.equal(r.git('branch', '--contains', cp2.snapshot).trim(), '');
  assert.deepEqual(nullPaths(r.journal()), []);
});

// ---- Accept 4: DEC-6 worker milestones ----
test('Accept 4: a worker checkpoint with a wrong or closed launch key is refused and never moves a handoff phase', async () => {
  const r = repo({ files: 'a.ts' });
  const st = await r.begin();
  assert.equal(st.launchKey, 'ae:p#1/a1');
  r.put('a.ts', 'one\n');

  // the right key: a milestone, role worker, a claim; the observed delta is the engine's
  const w = (await r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--done', 'a.ts started')).checkpoint;
  assert.equal(w.role, 'worker');
  assert.equal(w.kind, 'milestone');
  assert.deepEqual(w.delta, ['a.ts']);

  let raw = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a9', '--done', 'x'), /checkpoint refused: launch key ae:p#1\/a9/);
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--kind', 'post-mortem'), /checkpoint refused: a worker checkpoint is a milestone; --kind post-mortem belongs to the lead/);
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--kind', 'pre-handoff'), /belongs to the lead/);
  assert.equal(r.raw(), raw, 'a refused checkpoint writes nothing');

  // a PREPARED handoff: the worker stops and only the lead checkpoints; the phase stays PREPARED
  await r.run('prepare', r.plan, '1', '--to', 'Claude (opus/high)', '--lead', LEAD, '--reason', 'usage limit');
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'PREPARED');
  raw = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--done', 'x'), /checkpoint refused/);
  assert.equal(r.raw(), raw);
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'PREPARED');

  // after the transfer, attempt 1 is closed: its key is refused; attempt 2's key is accepted and keeps TRANSFERRED
  await r.run('checkpoint', r.plan, '1', '--kind', 'pre-handoff');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  raw = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--done', 'stale'), /checkpoint refused: launch key ae:p#1\/a1 belongs to attempt 1, which is handed-off/);
  assert.equal(r.raw(), raw);
  const w2 = (await r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a2', '--done', 'b done')).checkpoint;
  assert.equal(w2.attempt, 2);
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.phase, 'TRANSFERRED', 'a worker checkpoint never moves a phase');

  // a finished attempt: the slice is no longer IN_PROGRESS, so the worker's checkpoint is refused
  await r.run('finish', r.plan, '1', '--launch-key', 'ae:p#1/a2');
  raw = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a2', '--done', 'late'), /AGENT_FINISHED/);
  assert.equal(r.raw(), raw);
});

test('Accept 4: with the slice IN_PROGRESS but no open attempt, a worker checkpoint is refused as closed', async () => {
  const r = repo({ files: 'a.ts' });
  await r.begin();
  const j = r.journal();
  Object.assign(j.slices['1'].attempts[0], { outcome: 'finished', endedAt: j.updatedAt }); // a crash left the slice IN_PROGRESS
  writeFileSync(journalPath(r.plan), JSON.stringify(j, null, 2) + '\n');
  const raw = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--done', 'x'), /checkpoint refused: .*(closed|finished)/);
  assert.equal(r.raw(), raw);
});

// ---- Accept 5: run-check goes to checkpoint.check ----
test('Accept 5: run-check results go to checkpoint.check, never evidence; an unstable run is stable: false under Unknown', async () => {
  const r = repo({ files: 'a.ts', verify: '`sh check.sh`' });
  r.put('check.sh', 'echo "token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX"; echo more >> a.ts; exit 2\n');
  await r.begin();
  const cp = await r.handOff('Claude (opus/high)', '--run-check');
  assert.equal(cp.check.stable, false, 'the check wrote an owned file while it ran');
  assert.notEqual(cp.check.fpBefore, cp.check.fpAfter);
  assert.equal(cp.check.exitCode, 2);
  assert.doesNotMatch(cp.check.tail, /sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX/, 'the tail is redacted');
  assert.match(cp.check.tail, /\[REDACTED\]/);
  const rec = r.journal().slices['1'];
  assert.equal(rec.evidence.length, 0, 'never evidence');
  assert.equal(rec.attempts.filter(a => a.outcome === 'failed').length, 0);
  assert.doesNotMatch(r.raw(), /sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX/);
  const h = await r.run('handoff', r.plan, '1');
  assert.doesNotMatch(h.text, /Engine check \(observed\)/, 'an unstable check is never observed');
  const unknown = h.packet.sections.find((x: any) => x.key === 'unknown').items;
  assert.ok(unknown.some((i: any) => i.label === 'unknown' && /the engine check ran while slice files changed .*proves nothing/.test(i.text)));
});

test('Accept 5: a secret in the Verify command is redacted in checkpoint.check.command', async () => {
  const r = repo({ files: 'a.ts', verify: '`echo sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX`' });
  await r.begin();
  const cp = (await r.run('checkpoint', r.plan, '1', '--run-check')).checkpoint;
  assert.equal(cp.check.stable, true);
  assert.doesNotMatch(cp.check.command, /sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX/);
  assert.doesNotMatch(cp.check.tail, /sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX/);
  assert.doesNotMatch(r.raw(), /sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX/);
});

// ---- Accept 6: review-1 F13 and F14 ----
test('Accept 6 (F13): after A to B to C the base tree is A\'s, so A\'s finished files stay in the packet', async () => {
  const r = repo({ files: 'a.ts, b.ts, c.ts' });
  const st = await r.begin();
  r.put('a.ts', 'A finished\n');
  await r.run('interrupt', r.plan, '1', '--class', 'quota', '--lead', LEAD);
  await r.handOff('Claude (opus/high)', '--done', 'a.ts');
  r.put('b.ts', 'B finished\n');
  await r.run('interrupt', r.plan, '1', '--class', 'context', '--lead', LEAD);
  const cpB = await r.handOff('Codex (gpt-6-astra/medium)', '--done', 'b.ts');
  assert.deepEqual(cpB.delta, ['a.ts', 'b.ts']);
  const attempts = r.journal().slices['1'].attempts;
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(a => a.baseTree), [st.baseTree, st.baseTree, st.baseTree], 'every replacement inherits the first base');
  const h = await r.run('handoff', r.plan, '1');
  assert.match(h.text, /^Changed so far: a\.ts \(blob [0-9a-f]{8}\), b\.ts \(blob [0-9a-f]{8}\)\.$/m);
});

test('Accept 6 (F14): the trees skip git-ignored files in an owned folder; a path named in Files always counts', async () => {
  const r = repo({ files: 'lib/, build.log, out/' });
  r.put('.gitignore', 'lib/dist/\n*.log\nout/\n');
  r.put('lib/dist/bundle.js', 'old bundle\n');
  r.put('build.log', 'old log\n');
  r.put('out/report.txt', 'old report\n');
  const st = await r.begin();
  r.put('lib/src.ts', 'export const x = 1;\n');
  r.put('lib/dist/bundle.js', 'new bundle\n');
  r.put('lib/dist/extra.js', 'new chunk\n');
  r.put('build.log', 'new log\n');
  r.put('out/report.txt', 'new report\n');
  const cp = (await r.run('checkpoint', r.plan, '1', '--note', 'f14')).checkpoint;
  assert.deepEqual(cp.delta, ['build.log', 'lib/src.ts', 'out/report.txt'], 'ignored output under lib/ is not owned work');
  assert.ok(!r.git('ls-tree', '-r', '--name-only', st.baseTree).includes('lib/dist/'), 'the base tree holds no ignored blob');
  assert.deepEqual(snapshotFiles(r.dir, cp.snapshot), ['build.log', 'lib/src.ts', 'out/report.txt']);
  // the same rule as journal.ts fingerprint (PR #19): an ignored file below an owned folder does not change the fingerprint
  r.put('lib/dist/bundle.js', 'newer bundle\n');
  assert.equal((await r.run('checkpoint', r.plan, '1', '--note', 'again')).checkpoint.fingerprint, cp.fingerprint);
  assert.deepEqual(ownedFiles(r.dir, ['lib/', 'build.log', 'out/'], new Set()), ['build.log', 'lib/src.ts', 'out/report.txt']);
});
