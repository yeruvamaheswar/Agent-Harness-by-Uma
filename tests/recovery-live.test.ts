import { createHash } from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendRow, cliRun, gradeOnly, insideGitWorktree, scaffold, transcriptItems, commandIdentity, commandEffort, redactCommand, workerEnvironment, groupLifecycle, reaskCount, isReportHeading,
  t3Begin, t3Attach, t3Wait, t3Stop, t3Takeover, t3Finish, planLabel, parseWorker } from '../evals/recovery/live.ts';
import { grade } from '../evals/recovery/grade.ts';

const root = mkdtempSync(join(tmpdir(), 'recovery-live-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const engine = resolve('tools/agents/skills/autonomous-engineering/scripts/ae.ts');
const tool = resolve('evals/recovery/live.ts');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
function call(args: string[]) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', tool, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.stderr, '');
  return { code: r.status, value: JSON.parse(r.stdout) };
}
// Lead writes use the current lease holder (recovery-live, or the successor after a T3 takeover).
function ae(dir: string, cmd: string, args: string[]) {
  const holder = read(join(dir, 'plans/sandbox.run.json')).lead?.id ?? 'recovery-live';
  const r = spawnSync(process.execPath, ['--experimental-strip-types', engine, cmd, 'plans/sandbox.md', '1', '--lead-id', holder, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
const shim = join(root, 'worker.cjs');
writeFileSync(shim, `const fs = require('fs'); const mode = process.argv[2];
const write = n => fs.writeFileSync('src/m'+n+'.txt', 'milestone '+n+'\\n');
if (mode === 'a' || mode === 'partial') { write(1); write(2); if(mode === 'partial') fs.writeFileSync('src/m3.txt','milestone '); setTimeout(()=>write(3),10000); }
else if(mode === 'killed') { fs.writeFileSync('src/m3.txt','partial'); setTimeout(()=>write(3),10000); }
else if(mode === 'all') { write(1); write(2); write(3); }
else if(mode === 'exact-wait') { write(3); setTimeout(()=>{},20000); }
else if(mode === 'empty-m2') { write(1); fs.writeFileSync('src/m2.txt',''); }
else if(mode === 'fail-leak') { write(3); require('child_process').spawn(process.execPath, ['-e', "setTimeout(()=>require('fs').writeFileSync('leaked.txt','LEAKED'),300)"], {stdio:'ignore'}).unref(); process.exit(3); }
else if(mode === 'split-utf8') { write(3); const b = Buffer.from(JSON.stringify({type:'assistant_message',text:'Done \u20ac kept.'})+'\\n'); const k = b.indexOf(0xe2)+1; process.stdout.write(b.subarray(0,k)); setTimeout(()=>process.stdout.write(b.subarray(k)),1500); }
else if(mode === 'claude-finish') { if (!process.env.AE_PACKET.includes('Settled, do not re-ask')) process.exit(9); write(3); const t = 'I preserved the finished files and completed milestone 3.';
  for (const v of [{type:'system',subtype:'init',model:'claude-sonnet-4-6'},{type:'assistant',message:{content:[{type:'text',text:t}]}},{type:'result',result:t,usage:{input_tokens:30,output_tokens:12}}]) console.log(JSON.stringify(v)); }
else { if (!process.env.AE_PACKET.includes('Settled, do not re-ask')) process.exit(9); write(3); if(mode === 'bad-model') console.log(JSON.stringify({type:'system',subtype:'init',model:'wrong-model'})); console.log(JSON.stringify({type:'assistant_message',text:'I preserved the finished files and completed milestone 3.',usage:{total_tokens:42}})); }
`);
const cmd = (mode: string) => `${process.execPath} ${shim} ${mode}`;
// Fake claude and codex executables: the command identity is real (basename and model flag), the model is a shim.
const bin = join(root, 'bin'); mkdirSync(bin);
for (const [name, mode] of [['claude', 'claude-finish'], ['codex', 'finish']]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${shim}" ${mode}\n`); chmodSync(join(bin, name), 0o755);
}
const claudeProbe = `${join(bin, 'claude')} -p probe --model sonnet --effort low --output-format stream-json --verbose`;
const codexProbe = `${join(bin, 'codex')} exec --json -m gpt-6.1-terra -c model_reasoning_effort=low probe`;
const jr = (dir: string) => join(dir, 'plans/sandbox.run.json');
const rec = (dir: string) => join(dir, 'plans/sandbox.record.json');
const fixtureReview = (dir: string) => {
  // This is a fixture review, explicitly permitted by the test contract; no live model session.
  ae(dir, 'review', ['--by', 'Claude (opus/medium)', '--note', 'fixture files checked independently', '--exception', 'fake CLI shim regression fixture, no live reviewer']);
  ae(dir, 'verify', ['--by', 'fixture-lead']);
};
const scenarios = new Map<string, string>();

// ---- T3 step mode fixtures: the test plays the lead; the shim is the delegated worker ----
const codexW = 'codex|gpt-6.1-terra|low', claudeW = 'claudeAgent|claude-sonnet-5-5|low';
type ExportItem = { type: string; creationSource: string; text: string; textTruncated?: boolean };
// The field names of a real t3_thread_read (view messages) result, observed 2026-11-08; the values are fixtures.
function t3ExportFixture(threadId: string, worker: string, items: ExportItem[], o: { runStatus?: string; startedAt?: string; completedAt?: string | null; hasMore?: boolean; pending?: number } = {}) {
  const { provider, model } = parseWorker(worker), runId = `run:${threadId}:ordinal:1`, at = new Date().toISOString();
  return {
    thread: { threadId, projectId: 'fixture-project', title: 'fixture worker', link: `<t3-thread://fixture/${threadId}>`, createdBy: 'agent', creationSource: 'mcp',
      status: o.runStatus ?? 'completed', latestRunId: runId, activeRunId: null, providerInstanceId: provider, model, runtimeMode: 'full-access', interactionMode: 'default',
      linkedPullRequest: null, pullRequests: [], titleRegeneration: null, branch: null, worktreePath: null, parentThreadId: 'fixture-lead', relationshipToParent: 'subagent',
      runCount: 1, itemCount: items.length + 1, pendingRequestCount: o.pending ?? 0, archived: false, settled: false, settledAt: null, snoozed: false, snoozedUntil: null, createdAt: o.startedAt ?? at, updatedAt: at },
    recentRuns: [{ runId, ordinal: 1, status: o.runStatus ?? 'completed', providerInstanceId: provider, model, requestedAt: o.startedAt ?? at, startedAt: o.startedAt ?? at, completedAt: o.completedAt === undefined ? at : o.completedAt }],
    items: [{ type: 'user_message', creationSource: 'mcp', text: 'Act as the implementation sub-agent. Which file comes first?' }, ...items].map((it, i) => ({
      position: i, visibility: 'local', sourceThreadId: threadId, itemId: `turn-item:${i}`, runId, messageId: `message:${i}`, createdBy: 'agent', creationSource: it.creationSource,
      type: it.type, status: 'completed', title: null, text: it.text, textTruncated: it.textTruncated ?? false, nextTextOffset: it.textTruncated ? 10 : null, updatedAt: at })),
    nextPosition: items.length, hasMore: o.hasMore ?? false,
  };
}
const assistant = (text: string): ExportItem => ({ type: 'assistant_message', creationSource: 'provider', text });
const exportsDir = join(root, 't3-exports'); mkdirSync(exportsDir);
const writeExport = (name: string, value: unknown) => { const p = join(exportsDir, name); writeFileSync(p, JSON.stringify(value)); return p; };
const startWorker = (dir: string, mode: string, packet: string) => {
  const child = spawn(process.execPath, [shim, mode], { cwd: dir, env: { ...process.env, AE_PACKET: packet }, stdio: 'ignore' });
  const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
  return { pid: child.pid!, exited };
};
// One T3 run: A (and B in scenario 5) is stopped by the lead; the last worker completes. Scenario 10 adds a takeover.
async function t3Run(dir: string, scenario: '5' | '10') {
  scaffold(dir, engine);
  const ids = scenario === '5' ? [codexW, claudeW, codexW] : [codexW, claudeW], modes = scenario === '5' ? ['a', 'killed', 'finish'] : ['a', 'finish'];
  let packet = t3Begin(dir, engine, scenario, ids[0]).packet;
  const killed: { pid: number; killed: number[] }[] = [];
  for (let i = 0; i < ids.length; i++) {
    const thread = `thread:delegated-task:fixture-${scenario}-${i + 1}-${dir.length}`, worker = startWorker(dir, modes[i], packet);
    t3Attach(dir, engine, thread);
    if (i < ids.length - 1) {
      await t3Wait(dir, 30);
      if (scenario === '10') t3Takeover(dir, engine, 'successor-lead', `interrupted@${new Date().toISOString()}`, 'lead thread stopped answering');
      const exp = writeExport(`${scenario}-${i + 1}-${dir.length}.json`, t3ExportFixture(thread, ids[i], [assistant('I wrote milestones 1 and 2.')], { runStatus: 'interrupted', completedAt: null }));
      const r = await t3Stop(dir, engine, 'interrupted', exp, ids[i + 1]); packet = r.packet;
      killed.push({ pid: worker.pid, killed: r.killed });
    } else {
      assert.equal(await worker.exited, 0);
      const exp = writeExport(`${scenario}-final-${dir.length}.json`, t3ExportFixture(thread, ids[i], [assistant('I preserved the finished files and completed milestone 3.')]));
      const w = parseWorker(ids[i]); t3Finish(dir, engine, exp, w.provider, w.model, w.effort);
    }
  }
  fixtureReview(dir);
  return killed;
}

// One parent test keeps the four real-engine sandboxes ordered and shares only retained fixture evidence.
test('real engine and fake CLI workers implement scenarios and retained-evidence gates', { timeout: 300000 }, async t => {
  for (const s of ['2', '3', '5', '6']) await t.test(`scenario ${s}: scaffold, interrupt, transfer, finish, lead review and verify`, async () => {
    const dir = join(root, `scenario-${s}`); scenarios.set(s, dir);
    if (s === '2') {
      const r = call(['scaffold', '--dir', dir, '--engine', engine]);
      assert.equal(r.code, 0); assert.equal(r.value.journal, join(dir, 'plans/sandbox.run.json'));
    } else scaffold(dir, engine);
    const before = read(join(dir, 'plans/sandbox.run.json'));
    assert.equal(before.lead.id, 'recovery-live');
    assert.deepEqual(before.decisions.map((d: { id: string; status: string }) => [d.id, d.status]), [['D1', 'assumed'], ['D2', 'proposed']]);
    const r = s === '2'
      ? call(['cli-run', '--dir', dir, '--engine', engine, '--scenario', s, '--a', cmd('a'), '--b', cmd('finish')]).value
      : await cliRun(dir, engine, s, [cmd(s === '3' ? 'partial' : 'a'), cmd(s === '5' ? 'killed' : 'finish'), ...(s === '5' ? [cmd('finish')] : [])]);
    assert.equal(r.state, 'AGENT_FINISHED');
    let j = read(join(dir, 'plans/sandbox.run.json'));
    assert.equal(j.slices['1'].state, 'AGENT_FINISHED');
    const work = j.slices['1'].attempts.filter((a: { kind: string }) => a.kind === 'work');
    assert.equal(work.length, s === '5' ? 3 : 2);
    assert.ok(work.slice(0, -1).every((a: { interruptions: unknown[]; outcome: string }) => a.interruptions.length === 1 && a.outcome === 'handed-off'));
    if (s === '5') {
      for (const n of [1, 2]) {
        const disarm = read(join(dir, `plans/disarm-evidence-${n}.json`));
        assert.ok(disarm.processSamples.length >= 3);
        assert.ok(disarm.processSamples.every((p: { alive: boolean }) => !p.alive));
        assert.equal(disarm.filesAfterStop.length, 2);
      }
    }
    assert.equal(j.slices['1'].checkpoints[0].role, 'lead');
    if (s === '3') {
      assert.ok(j.slices['1'].checkpoints[0].delta.includes('src/m3.txt'));
      assert.notEqual(j.slices['1'].checkpoints[0].check.exitCode, 0);
      assert.match(readFileSync(join(dir, 'plans/replacement-packet.txt'), 'utf8'), /write src\/m3.txt/);
    }
    if (s === '6') { assert.notEqual(work[0].provider, work[1].provider); assert.equal(j.slices['1'].handoffs[0].mode, 'cli'); }
    const record = read(join(dir, 'plans/sandbox.record.json'));
    assert.equal(record.pendingQuestionCount, undefined);
    assert.equal(Object.keys(record.finishedFiles).length, 2);
    fixtureReview(dir);
    const g = grade(join(dir, 'plans/sandbox.run.json'));
    assert.equal(g.pass, true, JSON.stringify(g.checks));
    j = read(join(dir, 'plans/sandbox.run.json')); assert.equal(j.slices['1'].state, 'VERIFIED');
    const cliGrade = call(['grade', '--dir', dir]); assert.equal(cliGrade.code, 0);
  });
  const base = scenarios.get('2')!;
  const results = join(root, 'results.jsonl');
  const row = (s: string, p: 'cli' | 't3' | 'combined' | 'probe', dir: string) => appendRow(results, s, p, dir);
  for (const [s, dir] of scenarios) row(s, 'cli', dir);
  // T3 rows come from the step subcommands with fixture exports and a fake worker. They make no live-host claim.
  for (const scenario of ['5', '10'] as const) await t.test(`T3 step mode scenario ${scenario}: lead stops, kills, transfers and finishes`, async () => {
    const dir = join(root, `t3-${scenario}`), killed = await t3Run(dir, scenario);
    // task_cancel does not kill a running shell command: t3-stop killed the worker by its cwd and kept its pid.
    for (const [n, k] of killed.entries()) {
      assert.ok(k.killed.includes(k.pid), `stop ${n + 1} killed the live worker`);
      const d = read(join(dir, `plans/disarm-evidence-${n + 1}.json`));
      assert.ok(d.killed.includes(k.pid)); assert.ok(d.processSamples.length >= 3 && d.processSamples.every((x: { pids: number[]; alive: boolean }) => !x.pids.length && !x.alive));
    }
    const r = read(rec(dir));
    assert.equal(r.labels.tokens, 'unknown'); assert.equal(r.tokensReported, false); assert.ok(r.workers.every((w: { identity: string }) => w.identity === 't3-status'));
    const j = read(jr(dir)); assert.equal(j.slices['1'].state, 'VERIFIED');
    if (scenario === '10') { assert.equal(j.lead.id, 'successor-lead'); assert.deepEqual(read(join(dir, 'plans/lead-takeover.json')).refused, true); }
    const g = row(scenario, 't3', dir); assert.equal(g.status, 'pass', JSON.stringify(gradeOnly(results).checks.filter(c => !c.pass)));
    const passed = gradeOnly(results).rows.find(x => x.path === 't3' && String(x.scenario) === scenario)!.checks.filter(c => c.pass).map(c => c.name);
    const want = ['one-live-writer', 'no-question-about-settled-key', 'transcript-integrity', 'raw-transcript-items', 'A-milestone-boundary', 'disarm-1-group', 'disarm-1-files', 'worker-1-t3-export', 'worker-2-t3-export',
      ...(scenario === '5' ? ['scenario-5-attempts', 'disarm-2-group', 'disarm-2-files', 'disarm-2-keeps-earlier', 'worker-3-t3-export'] : ['scenario-10-attempts', 'scenario-10-takeover'])];
    for (const n of want) assert.ok(passed.includes(n), n);
  });
  await t.test('t3:10 without lead-takeover.json, or with a refusal that changed the journal, fails', () => {
    for (const [name, change] of [['no-file', (d: string) => rmSync(join(d, 'plans/lead-takeover.json'))], ['changed', (d: string) => {
      const p = join(d, 'plans/lead-takeover.json'), v = read(p); v.journalUnchanged = false; save(p, v);
    }], ['not-refused', (d: string) => { const p = join(d, 'plans/lead-takeover.json'), v = read(p); v.refused = false; save(p, v); }]] as const) {
      const copy = join(root, `t3-10-${name}`); cpSync(join(root, 't3-10'), copy, { recursive: true }); change(copy);
      const out = join(root, `t3-10-${name}.jsonl`), r = appendRow(out, '10', 't3', copy);
      assert.equal(r.status, 'fail', name);
      assert.equal(gradeOnly(out).rows[0].checks.find(c => c.name === 'scenario-10-takeover')?.pass, false, name);
    }
  });
  await t.test('a t3 row fails on CLI disarm evidence, and a cli row fails on T3 disarm evidence', () => {
    const asT3 = join(root, 't3-from-cli'), out = join(root, 't3-from-cli.jsonl'); cpSync(scenarios.get('5')!, asT3, { recursive: true });
    const names = (file: string) => gradeOnly(file).rows[0].checks.filter(c => !c.pass).map(c => c.name);
    assert.equal(appendRow(out, '5', 't3', asT3).status, 'fail'); assert.ok(names(out).includes('disarm-1-group') && names(out).includes('worker-1-t3-export'));
    const asCli = join(root, 'cli-from-t3'), out2 = join(root, 'cli-from-t3.jsonl'); cpSync(join(root, 't3-5'), asCli, { recursive: true });
    assert.equal(appendRow(out2, '5', 'cli', asCli).status, 'fail'); assert.ok(names(out2).includes('disarm-1-group'));
  });
  // The combined row needs its own physical folder, separate from cli:2.
  const comb = join(root, 'combined'); cpSync(base, comb, { recursive: true }); row('combined', 'combined', comb);
  // Probes are real fake-CLI runs: B is the fake claude (sonnet, stream-json) or codex (gpt-6.1-terra) executable.
  for (let i = 0; i < 6; i++) await t.test(`probe ${i}: ${i < 3 ? 'Claude sonnet' : 'Codex gpt-6.1-terra'} command identity`, async () => {
    const dir = join(root, `probe-${i}`); scaffold(dir, engine);
    await cliRun(dir, engine, '2', [cmd('a'), i < 3 ? claudeProbe : codexProbe]);
    fixtureReview(dir);
    const p = rec(dir), r = read(p);
    assert.deepEqual({ ...r.workers.at(-1), attempt: 0, stdout: '', sha256: '' }, { attempt: 0, stdout: '', sha256: '', provider: i < 3 ? 'claude' : 'codex', model: i < 3 ? 'sonnet' : 'gpt-6.1-terra', identity: 'command', command: i < 3 ? claudeProbe : codexProbe, effort: 'low' });
    r.probe = { label: 'probe', provider: i < 3 ? 'Claude' : 'Codex', reaskCount: 0 }; save(p, r);
    row(String(i), 'probe', dir);
  });
  appendRow(results, 'gate', 'avx', base, 'blocked', 'AVX lab gate not yet verified');
  const original = readFileSync(results, 'utf8');
  const rewrite = (f: (rows: ReturnType<typeof JSON.parse>[]) => unknown[]) => writeFileSync(results, f(original.trim().split('\n').map(l => JSON.parse(l))).map(r => JSON.stringify(r)).join('\n') + '\n');
  const verify = (code: number, extra: string[] = []) => { const r = call(['--grade-only', results, ...extra]); assert.equal(r.code, code, JSON.stringify(r.value.checks.filter((c: { pass: boolean }) => !c.pass))); return r.value; };
  const reviewMutations: [string, () => () => void][] = [
    ['review: record and row token forgery without stdout evidence', () => {
      const p = join(scenarios.get('3')!, 'plans/sandbox.record.json'), old = readFileSync(p), rec = read(p);
      rec.labels.tokens = 77; rec.tokensReported = true; rec.labels.tokensReported = true; save(p, rec);
      rewrite(rs => rs.map(r => r.path === 'cli' && r.scenario === '3' ? { ...r, tokens: 77, tokensReported: true } : r));
      return () => writeFileSync(p, old);
    }],
    ['review: claimed probe reaskCount differs from clean transcript', () => {
      const p = join(root, 'probe-4/plans/sandbox.record.json'), old = readFileSync(p), rec = read(p);
      rec.probe.reaskCount = 3; save(p, rec); return () => writeFileSync(p, old);
    }],
    ...['6', '5', '3'].map(s => [`review: cli:${s} substitutes scenario 2 evidence`, () => {
      rewrite(rs => rs.map(r => r.path === 'cli' && r.scenario === s ? { ...r, dir: base } : r)); return () => {};
    }] satisfies [string, () => () => void]),
    ['review: all required rows share scenario 2 evidence', () => {
      rewrite(rs => rs.map(r => ['cli', 't3'].includes(r.path) ? { ...r, dir: base } : r)); return () => {};
    }],
    ['review: scenario 5 first disarm evidence missing', () => {
      const p = join(scenarios.get('5')!, 'plans/disarm-evidence-1.json'), old = readFileSync(p); rmSync(p);
      return () => writeFileSync(p, old);
    }],
  ];
  for (const [name, mutate] of reviewMutations) await t.test(name, () => {
    const restore = mutate(); try { verify(1); } finally { restore(); writeFileSync(results, original); }
  });
  const sc3 = scenarios.get('3')!, sc5 = scenarios.get('5')!, sc6 = scenarios.get('6')!;
  const touched = new Map<string, Buffer>();
  const edit = (p: string, f: (value: ReturnType<typeof read>) => void) => {
    if (!touched.has(p)) touched.set(p, readFileSync(p));
    const value = read(p); f(value); save(p, value);
  };
  const created: string[] = [];
  const shaOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const rowIs = (path: string, scenario: string) => (r: { path: string; scenario: string | number }) => r.path === path && String(r.scenario) === scenario;
  // Point a folder's replacement stdout at another path, consistently in record and rows.
  const repointStdout = (dir: string, rel: string, sha: string) => {
    edit(rec(dir), r => { r.replacementStdout = rel; r.workers.at(-1).stdout = rel; r.workers.at(-1).sha256 = sha; r.replacementStdoutSha256 = sha; });
    const r = read(rec(dir));
    rewrite(rs => rs.map(row => row.dir === dir ? { ...row, workers: r.workers, replacementStdout: rel, replacementStdoutSha256: sha } : row));
  };
  const probe = (i: number) => join(root, `probe-${i}`);
  const ownMutations: [string, () => void, string | string[]][] = [
    ['scenario 2 has an extra work attempt', () => edit(jr(base), j => j.slices['1'].attempts.push({ ...j.slices['1'].attempts[1], n: 9 })), 'scenario-2-attempts'],
    ['scenario 3 delta drops partial m3', () => edit(jr(sc3), j => { j.slices['1'].checkpoints[0].delta = ['src/m1.txt', 'src/m2.txt']; }), 'scenario-3-partial'],
    ['scenario 3 engine check claims success', () => edit(jr(sc3), j => { j.slices['1'].checkpoints[0].check.exitCode = 0; }), 'scenario-3-partial'],
    ['scenario 5 first stopped group is alive', () => edit(join(sc5, 'plans/disarm-evidence-1.json'), d => { d.processSamples.at(-1).groupAlive = true; }), 'disarm-1-group'],
    ['scenario 5 first file snapshot hash changes', () => edit(join(sc5, 'plans/disarm-evidence-1.json'), d => { d.filesAfterStop[0].sha256['src/m1.txt'] = '0'.repeat(64); }), 'disarm-1-files'],
    ['scenario 5 second disarm file is missing', () => { const p = join(sc5, 'plans/disarm-evidence-2.json'); touched.set(p, readFileSync(p)); rmSync(p); }, 'disarm-2'],
    ['scenario 5 interruption count is three', () => edit(jr(sc5), j => { j.slices['1'].attempts[0].interruptions.push(j.slices['1'].attempts[0].interruptions[0]); }), 'scenario-5-attempts'],
    ['scenario 6 consistent same-provider replacement', () => {
      edit(jr(sc6), j => { j.slices['1'].attempts[1].provider = 'codex'; });
      edit(rec(sc6), r => { r.workers[1].provider = 'codex'; });
      edit(join(sc6, 'plans/replacement-transcript.json'), tr => { tr.provider = 'codex'; });
      rewrite(rs => rs.map(r => r.path === 'cli' && r.scenario === '6' ? { ...r, models: r.models.map((m: {provider: string}, i: number) => i === 1 ? { ...m, provider: 'codex' } : m) } : r));
    }, 'scenario-6-provider'],
    ['scenario 6 is a new-child handoff', () => edit(jr(sc6), j => { j.slices['1'].handoffs[0].mode = 'new'; }), 'scenario-6-provider'],
    ['combined first checkpoint includes m3', () => edit(jr(comb), j => { j.slices['1'].checkpoints[0].delta.push('src/m3.txt'); }), 'combined-preserved-files'],
    ['combined finished hashes include m3', () => edit(rec(comb), r => { r.finishedFiles['src/m3.txt'] = createHash('sha256').update(readFileSync(join(comb, 'src/m3.txt'))).digest('hex'); }), 'combined-preserved-files'],
    ['raw stdout is changed after anchoring', () => {
      const p = join(sc3, 'plans/replacement-stdout.jsonl'); touched.set(p, readFileSync(p)); writeFileSync(p, 'Changed raw stdout.\n');
    }, 'replacement-raw-anchor'],
    ['friendly transcript is substituted', () => edit(join(sc3, 'plans/replacement-transcript.json'), tr => { tr.items = [{type:'assistant_message',text:'Friendly replacement.'}]; }), 'raw-transcript-items'],
    ['row raw digest is forged', () => rewrite(rs => rs.map(r => r.path === 'cli' && r.scenario === '3' ? { ...r, replacementStdoutSha256: 'f'.repeat(64) } : r)), 'replacement-raw-anchor'],
    ['probe row alone claims a reask', () => rewrite(rs => rs.map(r => r.path === 'probe' && r.scenario === '0' ? { ...r, reaskCount: 1 } : r)), 'probe-count-observed'],
    ['probe completed export has no status', () => edit(join(root, 'probe-0/plans/replacement-transcript.json'), tr => { delete tr.status; }), 'tool-error'],
    ['A observation lies about m2 bytes', () => edit(join(base, 'plans/disarm-evidence-1.json'), d => { d.milestoneObservation.sha256['src/m2.txt'] = 'a'.repeat(64); }), 'A-milestone-boundary'],
    ['A observation already has complete m3', () => edit(join(base, 'plans/disarm-evidence-1.json'), d => { d.stoppedMilestones.m3 = 'complete'; }), 'A-milestone-boundary'],
    // Item 1: probe labels must equal the last worker's command identity.
    ['six Codex probes labeled 3 Claude + 3 Codex', () => {
      for (let k = 0; k < 3; k++) {
        const fake = join(root, `probe-codex-as-claude-${k}`); rmSync(fake, { recursive: true, force: true }); cpSync(probe(3 + k), fake, { recursive: true }); created.push(fake);
        const r = read(rec(fake)); r.probe.provider = 'Claude'; save(rec(fake), r);
        rewrite(rs => rs.map(row => rowIs('probe', String(k))(row) ? { ...row, dir: fake } : row));
      }
    }, ['probe-identity', 'six-probes']],
    ['Claude-labeled probe has an asserted worker identity', () => {
      edit(rec(probe(0)), r => { r.workers.at(-1).identity = 'asserted'; });
      const w = read(rec(probe(0))).workers;
      rewrite(rs => rs.map(row => rowIs('probe', '0')(row) ? { ...row, workers: w, models: row.models.map((m: object, i: number) => i === row.models.length - 1 ? { ...m, identity: 'asserted' } : m) } : row));
    }, ['probe-identity', 'six-probes']],
    ['probe model is neither sonnet nor gpt-6.1-terra', () => {
      const d = probe(3), model = 'gpt-6.1-sol';
      edit(jr(d), j => { j.slices['1'].attempts.filter((a: { kind: string }) => a.kind === 'work').at(-1).model = model; });
      edit(rec(d), r => { r.workers.at(-1).model = model; });
      edit(join(d, 'plans/replacement-transcript.json'), tr => { tr.model = model; });
      const w = read(rec(d)).workers;
      rewrite(rs => rs.map(row => rowIs('probe', '3')(row) ? { ...row, workers: w, models: row.models.map((m: object, i: number) => i === row.models.length - 1 ? { ...m, model } : m) } : row));
    }, ['probe-identity', 'six-probes']],
    // Item 5: probe, t3 and combined folders join the separation check.
    ['probe row reuses the cli:2 folder', () => {
      edit(rec(base), r => { r.probe = { label: 'probe', provider: 'Codex', reaskCount: 0 }; });
      rewrite(rs => rs.map(row => rowIs('probe', '3')(row) ? { ...row, dir: base } : row));
    }, 'separate-evidence-dirs'],
    ['combined row reuses the cli:2 folder', () => rewrite(rs => rs.map(row => row.path === 'combined' ? { ...row, dir: base } : row)), 'separate-evidence-dirs'],
    ['t3:10 row reuses a probe folder', () => rewrite(rs => rs.map(row => rowIs('t3', '10')(row) ? { ...row, dir: probe(0) } : row)), 'separate-evidence-dirs'],
    ['t3:5 second cwd sample shows a live process', () => edit(join(root, 't3-5/plans/disarm-evidence-2.json'), d => { d.processSamples[1].pids = [4242]; d.processSamples[1].alive = true; }), 'disarm-2-group'],
    ['t3:10 B attempt starts before the takeover', () => edit(jr(join(root, 't3-10')), j => { j.lead.history.find((h: { event: string }) => h.event === 'takeover').at = new Date(Date.now() + 3600e3).toISOString(); }), 'scenario-10-takeover'],
    ['t3:5 worker export is from another thread', () => {
      const d = join(root, 't3-5'), p = join(d, 'plans/worker-1-export.json'), v = read(p); v.thread.threadId = 'thread:other'; touched.set(p, readFileSync(p)); save(p, v);
      edit(rec(d), r => { r.workers[0].sha256 = shaOf(p); });
      const w = read(rec(d)).workers; rewrite(rs => rs.map(row => row.dir === d ? { ...row, workers: w } : row));
    }, 'worker-1-t3-export'],
    // Item 6: evidence paths stay inside the row's plans folder.
    ['replacement stdout escapes with ..', () => {
      repointStdout(base, '../../scenario-3/plans/replacement-stdout.jsonl', shaOf(join(sc3, 'plans/replacement-stdout.jsonl')));
    }, 'evidence-paths'],
    ['replacement stdout escapes through a symlink', () => {
      const link = join(base, 'plans/alias-stdout.jsonl'); symlinkSync(join(sc3, 'plans/replacement-stdout.jsonl'), link); created.push(link);
      repointStdout(base, 'alias-stdout.jsonl', shaOf(link));
    }, 'evidence-paths'],
    ['worker stdout escapes with ..', () => {
      edit(rec(sc5), r => { r.workers[0].stdout = '../../scenario-6/plans/worker-1-stdout.jsonl'; r.workers[0].sha256 = shaOf(join(sc6, 'plans/worker-1-stdout.jsonl')); });
      const w = read(rec(sc5)).workers; rewrite(rs => rs.map(row => row.dir === sc5 ? { ...row, workers: w } : row));
    }, 'evidence-paths'],
    // Item 7: a cli row must bind the disarm pid to a cli:<pid>@ thread id.
    ['cli row thread id is not cli:<pid>@ and the disarm pid is forged', () => {
      edit(jr(sc6), j => { j.slices['1'].attempts.filter((a: { kind: string }) => a.kind === 'work')[0].threadId = 't3:abc'; });
      edit(join(sc6, 'plans/disarm-evidence-1.json'), d => { d.processSamples.forEach((s: { pid: number; pgid: number }) => { s.pid = 999999; s.pgid = 999999; }); });
    }, 'disarm-1-group'],
  ];
  for (const [name, mutate, expected] of ownMutations) await t.test(`mutation: ${name}`, () => {
    try {
      mutate(); const result = verify(1);
      for (const e of [expected].flat()) assert.ok(result.checks.some((c: {name: string; pass: boolean}) => c.name.endsWith(e) && !c.pass), e);
    } finally {
      for (const [p, bytes] of touched) writeFileSync(p, bytes); touched.clear(); writeFileSync(results, original);
      for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true });
    }
  });
  await t.test('a row with an unknown field fails the strict row schema', () => {
    try {
      rewrite(rs => rs.map(r => rowIs('cli', '2')(r) ? { ...r, verified: true, extra: { x: 1 } } : r));
      const result = verify(1); assert.equal(result.checks[0].name, 'tool-error'); assert.match(result.checks[0].detail, /line 1 does not match the strict row schema/);
      rewrite(rs => rs.map(r => rowIs('cli', '2')(r) ? { ...r, labels: { ...r.labels, trusted: true } } : r)); verify(1);
    } finally { writeFileSync(results, original); }
  });
  await t.test('physical folder aliases cannot stand in for separate required evidence', () => {
    const alias = join(root, 'scenario-alias'); symlinkSync(base, alias);
    try {
      rewrite(rs => rs.map(r => r.path === 'cli' && r.scenario === '6' ? { ...r, dir: alias } : r));
      const result = verify(1); assert.ok(result.checks.some((c: {name: string; pass: boolean}) => c.name === 'separate-evidence-dirs' && !c.pass));
    } finally { unlinkSync(alias); writeFileSync(results, original); }
  });
  await t.test('a real observed probe reask passes with a measured count and intact raw evidence', () => {
    const dir = join(root, 'probe-4'), p = rec(dir), transcript = join(dir, 'plans/replacement-transcript.json');
    const raw = join(dir, 'plans/replacement-stdout.jsonl'), saved = [p, transcript, raw].map(p => [p, readFileSync(p)] satisfies [string, Buffer]);
    try {
      const stdout = JSON.stringify({ type:'assistant_message', text:'Please confirm deploy-target before I continue.', usage:{total_tokens:42} }) + '\n';
      writeFileSync(raw, stdout); const sha = createHash('sha256').update(stdout).digest('hex'), r = read(p), tr = read(transcript);
      tr.items = transcriptItems(stdout).items; save(transcript, tr); r.replacementStdoutSha256 = sha; r.workers.at(-1).sha256 = sha; r.probe.reaskCount = 1; save(p, r);
      rewrite(rs => rs.map(row => row.dir === dir ? { ...row, workers:r.workers, reaskCount:1, replacementStdoutSha256:sha } : row));
      assert.equal(grade(join(dir, 'plans/sandbox.run.json')).pass, false, 'generic grader still rejects questions');
      verify(0);
      rewrite(rs => rs.map(row => row.dir === dir ? { ...row, workers:r.workers, reaskCount:0, replacementStdoutSha256:sha } : row)); verify(1);
    } finally { for (const [p, data] of saved) writeFileSync(p, data); writeFileSync(results, original); }
  });
  await t.test('full retained set passes grade-only and prints AVX gate note', () => {
    const g = gradeOnly(results); assert.equal(g.pass, true, JSON.stringify(g.checks.filter(c => !c.pass)));
    const g2 = verify(0); assert.match(g2.notes[0], /^avx: BLOCKED \(gate\):/); assert.equal(g2.rows.length, 14);
  });
  await t.test('missing scenario fails', () => { rewrite(rs => rs.filter(r => !(r.path === 'cli' && r.scenario === '3'))); verify(1); writeFileSync(results, original); });
  await t.test('retained evidence is re-graded after the row was written', () => {
    const p = join(base, 'src/m1.txt'), old = readFileSync(p); writeFileSync(p, 'tampered\n'); verify(1); writeFileSync(p, old);
  });
  await t.test('numeric tokens without record provenance fail even with a trusted-looking row', () => {
    const p = join(base, 'plans/sandbox.record.json'), old = readFileSync(p), rec = read(p); rec.labels.tokens = 42; delete rec.tokensReported; delete rec.labels.tokensReported; save(p, rec);
    rewrite(rs => rs.map(r => r.dir === base && r.status !== 'blocked' ? { ...r, tokens: 42, tokensReported: true, labels: { ...r.labels, tokensReported: true } } : r));
    verify(1); writeFileSync(p, old); writeFileSync(results, original);
  });
  await t.test('reported numeric replacement tokens pass with retained provenance', () => {
    const p = join(base, 'plans/sandbox.record.json'), old = readFileSync(p), rec = read(p);
    rec.labels.tokens = 42; rec.tokensReported = true; save(p, rec);
    rewrite(rs => rs.map(r => r.dir === base && r.status !== 'blocked' ? { ...r, tokens: 42, tokensReported: true } : r));
    verify(0); writeFileSync(p, old); writeFileSync(results, original);
  });
  await t.test('five probes fail', () => { rewrite(rs => rs.filter(r => !(r.path === 'probe' && r.scenario === '5'))); verify(1); writeFileSync(results, original); });
  await t.test('combined transcript asking about D2 fails', () => {
    const p = join(comb, 'plans/replacement-transcript.json'), old = readFileSync(p), tr = read(p); tr.items.push({ type: 'assistant_message', text: 'Which deploy-target should I use for D2?' }); save(p, tr); verify(1); writeFileSync(p, old);
  });
  await t.test('combined packet without waiting D2 fails', () => {
    const p = join(comb, 'plans/replacement-packet.txt'), old = readFileSync(p, 'utf8'); writeFileSync(p, old.split('\n').filter(l => !l.startsWith('Waiting on the user')).join('\n')); verify(1); writeFileSync(p, old);
  });
  await t.test('AVX missing fails', () => { rewrite(rs => rs.filter(r => r.path !== 'avx')); const r = verify(1); assert.ok(r.notes.includes('avx: MISSING')); writeFileSync(results, original); });
  await t.test('require-avx refuses a blocked gate', () => { verify(1, ['--require-avx']); });
  await t.test('AVX pass rechecks artifact fields and screenshot existence', () => {
    const dir = join(root, 'avx'); cpSync(base, dir, { recursive: true });
    const p = join(dir, 'plans/sandbox.record.json'), rec = read(p), j = read(join(dir, 'plans/sandbox.run.json'));
    rec.avx = { taskKeys: ['sandbox#1'], checkpointHead: j.slices['1'].checkpoints[0].gitHead, decisions: ['D1', 'D2'], state: 'VERIFIED', screenshots: { light: 'light.png', dark: 'dark.png' } }; save(p, rec);
    writeFileSync(join(dir, 'plans/light.png'), 'fixture'); writeFileSync(join(dir, 'plans/dark.png'), 'fixture');
    rewrite(rs => rs.filter(r => r.path !== 'avx')); appendRow(results, 'avx', 'avx', dir); verify(0, ['--require-avx']);
    rmSync(join(dir, 'plans/dark.png')); verify(1); writeFileSync(results, original);
  });
});

test('stdout export recognizes Claude and Codex lines without tool or plain text', () => {
  const r = transcriptItems([JSON.stringify({ type: 'result', result: 'Completed.', usage: { input_tokens: 10, output_tokens: 2 } }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Preserved files.' } }), JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'Which tool?' } }), 'Done.'].join('\n'));
  // The plain line is not JSON, so it is never assistant prose (review 3 F8).
  assert.equal(r.items.length, 2); assert.equal(r.tokens, 12);
});
test('top-level guard emits complete capped JSON without retained text', () => {
  const p = join(root, 'malformed.jsonl'); writeFileSync(p, 'TRANSCRIPT_SECRET');
  const r = call(['--grade-only', p]); assert.equal(r.code, 1); assert.equal(r.value.checks[0].name, 'tool-error');
  assert.ok(r.value.checks[0].detail.length <= 200); assert.ok(!JSON.stringify(r.value).includes('TRANSCRIPT_SECRET'));
});
test('usage errors exit 2', () => { assert.equal(call(['cli-run']).code, 2); });

test('command identities use CLI model flags, preserve quoted prompts, and label missing models asserted', () => {
  assert.deepEqual(commandIdentity('codex exec --json -m gpt-6.1-sol "literal --model is prompt text"'), { provider:'codex', model:'gpt-6.1-sol', identity:'command' });
  assert.deepEqual(commandIdentity('claude -p "hello" --model=sonnet --output-format stream-json --verbose'), { provider:'claude', model:'sonnet', identity:'command' });
  assert.equal(commandIdentity('codex exec --json "hello"').identity, 'asserted');
});
test('Claude commands must preserve the whole assistant stream', () => {
  for (const command of ['claude -p hi --output-format json', 'claude -p hi --output-format stream-json'])
    assert.throws(() => commandIdentity(command), /requires --output-format stream-json --verbose/);
  const r = transcriptItems([
    {type:'system',subtype:'init',model:'claude-sonnet-4-6'},
    {type:'assistant',message:{content:[{type:'text',text:'Which deploy-target should I use?'}]}},
    {type:'result',result:'Completed.',modelUsage:{'claude-sonnet-4-6':{}},usage:{input_tokens:3,output_tokens:4,cache_read_input_tokens:99}},
  ].map(v => JSON.stringify(v)).join('\n'));
  assert.equal(reaskCount(r.items), 1); assert.equal(r.tokens, 7); assert.deepEqual(r.models, ['claude-sonnet-4-6']);
});
test('probe reask counter uses normalized forms and adjacent assistant joins', () => {
  assert.equal(reaskCount([{type:'assistant_message',text:'I need'}, {type:'assistant_message',text:'your decision for deploy-target'}]), 1);
  assert.equal(reaskCount([{type:'assistant_message',text:'**Please confirm** deploy-target.'}]), 1);
  assert.equal(reaskCount([{type:'assistant_message',text:'The files are complete.'}]), 0);
});
test('worker environment strips Claude nesting and session markers', () => {
  const env = workerEnvironment('packet', { CLAUDECODE:'1', CLAUDE_CODE_ENTRYPOINT:'test', CLAUDE_SESSION_ID:'secret', CLAUDE_FOO_SESSION_TOKEN:'secret', KEEP:'retained' });
  assert.deepEqual(env, {KEEP:'retained',AE_PACKET:'packet'});
});
test('group lifecycle never signals a reaped leader and checks the captured group for normal-exit descendants', () => {
  const signals: number[] = [], existsCalls: number[] = [];
  const lifecycle = groupLifecycle(123, id => { existsCalls.push(id); return true; }, id => { signals.push(id); return true; });
  lifecycle.cancel(); lifecycle.onExit(null); lifecycle.cancel(); assert.deepEqual(signals, [123]); assert.deepEqual(existsCalls, [123]);
  const descendants = groupLifecycle(456, () => true, id => { signals.push(id); return true; });
  descendants.onExit(0); descendants.cancel(); descendants.onExit(0); assert.deepEqual(signals, [123,456]);
  const gone = groupLifecycle(789, () => false, id => { signals.push(id); return true; }); gone.onExit(0); gone.cancel(); assert.deepEqual(signals, [123,456]);
});
test('live path rejects an all-three-files-at-once A and an empty m2', {timeout:15000}, () => {
  for (const mode of ['all','empty-m2']) {
    const dir = join(root, `invalid-A-${mode}`); scaffold(dir,engine);
    const r = call(['cli-run','--dir',dir,'--engine',engine,'--scenario','2','--a',cmd(mode),'--b',cmd('finish')]);
    assert.equal(r.code,1); assert.match(r.value.checks[0].detail, /A did not stop after milestone 2/);
    assert.equal(read(join(dir,'plans/sandbox.run.json')).slices['1'].attempts.length,1);
    assert.ok(!existsSync(join(dir,'plans/sandbox.record.json')));
  }
});
test('live path refuses CLI-reported model mismatches', {timeout:10000}, async () => {
  const dir = join(root,'wrong-model'); scaffold(dir,engine);
  await assert.rejects(cliRun(dir,engine,'2',[cmd('a')+' --model gpt-6.1-terra',cmd('bad-model')+' -m gpt-6.1-terra']), /CLI reported model differs/);
});
// Item 3: Claude stream-json repeats the last assistant text in its result event.
test('a Claude result event that repeats the assistant text counts one question once', () => {
  const q = 'Which deploy-target should I use?';
  const r = transcriptItems([{type:'assistant',message:{content:[{type:'text',text:q}]}}, {type:'result',result:q,usage:{input_tokens:1,output_tokens:1}}].map(v => JSON.stringify(v)).join('\n'));
  assert.equal(r.items.length, 1); assert.equal(reaskCount(r.items), 1); assert.equal(r.tokens, 2);
});
// Item 4: every CLAUDE* variable is removed except the explicit allowlist.
test('worker environment removes every CLAUDE* variable except CLAUDE_CONFIG_DIR', () => {
  const env = workerEnvironment('packet', { CLAUDE_PID:'1', CLAUDE_EFFORT:'high', CLAUDE_AGENT_SDK_VERSION:'9', claude_lower:'x', ClaudeMixed:'y', CLAUDE_CONFIG_DIR:'/cfg', KEEP:'retained', MY_CLAUDE:'kept' });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR:'/cfg', KEEP:'retained', MY_CLAUDE:'kept', AE_PACKET:'packet' });
});
// Item 2: cleanup on any exit code or signal, not only 0.
test('group lifecycle kills the remaining group after a non-zero or signal exit', () => {
  const signals: number[] = [];
  groupLifecycle(11, () => true, id => { signals.push(id); return true; }).onExit(3);
  groupLifecycle(12, () => true, id => { signals.push(id); return true; }).onExit(null);
  assert.deepEqual(signals, [11, 12]);
});
test('a replacement that exits 3 leaves no child writing after cliRun returns', { timeout: 15000 }, async () => {
  const dir = join(root, 'fail-leak'); scaffold(dir, engine);
  await assert.rejects(cliRun(dir, engine, '2', [cmd('a'), cmd('fail-leak')]), /replacement worker exited unsuccessfully/);
  await new Promise(r => setTimeout(r, 800));
  assert.ok(!existsSync(join(dir, 'leaked.txt')), 'backgrounded child of the failed replacement must be killed');
});
// Item 8: known wrappers are unwrapped; unknown executables are refused on the CLI path.
test('command identity unwraps wrappers and refuses unrecognized executables', () => {
  const stream = '--output-format stream-json --verbose';
  assert.deepEqual(commandIdentity(`timeout -s KILL 600 claude -p hi --model sonnet ${stream}`), { provider:'claude', model:'sonnet', identity:'command' });
  assert.deepEqual(commandIdentity('env -i FOO=1 nice -n 5 codex exec --json -m gpt-6.1-terra hi'), { provider:'codex', model:'gpt-6.1-terra', identity:'command' });
  assert.deepEqual(commandIdentity('npx -y @openai/codex@1.2.3 exec --json -m gpt-6.1-terra hi'), { provider:'codex', model:'gpt-6.1-terra', identity:'command' });
  assert.deepEqual(commandIdentity(`npx @anthropic-ai/claude-code -p hi --model=sonnet ${stream}`), { provider:'claude', model:'sonnet', identity:'command' });
  assert.throws(() => commandIdentity('timeout 600 claude -p hi --model sonnet'), /requires --output-format stream-json --verbose/);
  assert.equal(commandIdentity(`${process.execPath} script.cjs`).identity, 'asserted');
  for (const c of ['bash -c "claude -p hi"', 'python3 worker.py', 'stdbuf -o0 claude -p hi'])
    assert.throws(() => commandIdentity(c), /unrecognized worker executable/);
  assert.throws(() => commandIdentity('env -S "claude -p hi"'), /hides the worker executable/);
});
// Item 9: raw stdout is byte-exact when a multi-byte character is split across writes.
test('retained stdout keeps a multi-byte character split across chunks', { timeout: 15000 }, async () => {
  const dir = join(root, 'split-utf8'); scaffold(dir, engine);
  await cliRun(dir, engine, '2', [cmd('a'), cmd('split-utf8')]);
  const expected = Buffer.from(JSON.stringify({ type:'assistant_message', text:'Done € kept.' }) + '\n');
  const raw = readFileSync(join(dir, 'plans/replacement-stdout.jsonl'));
  assert.ok(raw.equals(expected), 'raw bytes must equal what the worker wrote');
  assert.equal(read(join(dir, 'plans/sandbox.record.json')).replacementStdoutSha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(read(join(dir, 'plans/replacement-transcript.json')).items[0].text, 'Done € kept.');
});

// Review 3 regressions (tool review of slice 14, 2026-11-08).
test('review 3 F1: scenario 5 passes when B writes m3 exactly before its stop', { timeout: 60000 }, async () => {
  const dir = join(root, 'f1-b-exact'); scaffold(dir, engine);
  await cliRun(dir, engine, '5', [cmd('a'), cmd('exact-wait'), cmd('finish')]);
  fixtureReview(dir);
  const results = join(root, 'f1.jsonl'), row = appendRow(results, '5', 'cli', dir);
  const names = (pass: boolean) => gradeOnly(results).rows[0].checks.filter(c => c.pass === pass).map(c => c.name);
  assert.equal(row.status, 'pass', JSON.stringify(names(false)));
  for (const n of ['disarm-1-files', 'disarm-2-files', 'disarm-2-keeps-earlier']) assert.ok(names(true).includes(n), n);
});
test('review 3 F2: shell operators and substitutions are refused; quoted ones are prompt text', () => {
  const stream = '--output-format stream-json --verbose';
  for (const c of [`claude -p hi --model sonnet ${stream} >/dev/null; codex exec --json -m x hi`, `codex exec --json -m gpt-6.1-terra hi && claude --model opus ${stream}`,
    `claude -p hi --model sonnet ${stream} | tee out`, `claude -p \`id\` --model sonnet ${stream}`, `claude -p "$(id)" --model sonnet ${stream}`, `codex exec --json -m x hi &`, `codex exec --json -m x - < in`])
    assert.throws(() => commandIdentity(c), /shell operators/, c);
  assert.equal(commandIdentity(`claude -p "a; b && c | d > e" --model sonnet ${stream}`).model, 'sonnet');
  assert.equal(commandIdentity(`claude -p 'no $(sub) here' --model sonnet ${stream}`).model, 'sonnet');
});
test('review 3 F3: effort comes from the command, and the kept command is redacted', () => {
  assert.equal(commandEffort('claude -p hi --model sonnet --effort low --output-format stream-json --verbose'), 'low');
  assert.equal(commandEffort('claude -p hi --model sonnet --output-format stream-json --verbose'), undefined);
  assert.equal(commandEffort('codex exec --json -m gpt-6.1-terra -c model_reasoning_effort=low -'), 'low');
  assert.equal(commandEffort('codex exec --json -m gpt-6.1-terra -c model_reasoning_effort="high" -'), 'high');
  assert.equal(commandEffort('codex exec --json -m gpt-6.1-terra -'), undefined);
  assert.equal(redactCommand('API_KEY=sk-secret env TOKEN="a b" codex exec --json -c model_reasoning_effort=low -'), 'API_KEY=REDACTED env TOKEN=REDACTED codex exec --json -c model_reasoning_effort=low -');
});
test('review 3 F4: scaffold refuses a folder inside a git worktree', () => {
  const dir = join(process.cwd(), 'tmp-review3-f4-sandbox');
  assert.throws(() => scaffold(dir, engine), /inside a git worktree/); assert.equal(existsSync(dir), false);
});
test('review 3 F5: scenario 6 keeps a refused unauthorized target; without it the row fails', () => {
  const dir = scenarios.get('6')!, u = read(join(dir, 'plans/unauthorized-target.json'));
  assert.equal(u.refused, true); assert.equal(u.journalUnchanged, true);
  const copy = join(root, 'f5-no-refusal'); cpSync(dir, copy, { recursive: true }); rmSync(join(copy, 'plans/unauthorized-target.json'));
  const results = join(root, 'f5.jsonl'); appendRow(results, '6', 'cli', copy);
  const c = gradeOnly(results).rows[0].checks.find(x => x.name === 'scenario-6-unauthorized-refused');
  assert.equal(c?.pass, false);
});
test('review 3 F6 and F8: one assistant event with two blocks plus its result counts once; codex needs --json', () => {
  const q = 'Should I deploy?';
  const r = transcriptItems([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }, { type: 'text', text: q }] } }, { type: 'result', result: `Done.\n\n${q}` }].map(v => JSON.stringify(v)).join('\n'));
  assert.equal(r.items.length, 1); assert.equal(reaskCount(r.items), 1);
  assert.throws(() => commandIdentity('codex exec -m gpt-6.1-terra hi'), /requires exec --json/);
});
test('review 3 F10: append-row writes fail when the grade-only row checks fail', () => {
  const results = join(root, 'f10.jsonl'), row = appendRow(results, 'combined', 'combined', scenarios.get('5')!);
  assert.equal(row.gradePass, true); assert.equal(row.status, 'fail');
});
test('probe count skips report headings but keeps real questions (live probe 2026-11-08)', () => {
  for (const h of ['What I found:', 'What changed: I created src/m3.txt with milestone 3.', 'What I changed: I created src/m3.txt.', 'How I verified: ran the check.'])
    assert.equal(isReportHeading(h), true, h);
  for (const q of ['What should I use: A or B', 'Which target is right: prod', 'What do you want: the deploy', 'What changed?', 'What is the deploy target'])
    assert.equal(isReportHeading(q), false, q);
  assert.equal(reaskCount([{ type: 'assistant_message', text: 'What I found: m1 and m2 were done.\nWhat changed: I created m3.' }]), 0);
  assert.equal(reaskCount([{ type: 'assistant_message', text: 'What I found: m1 was done. Which deploy target should I use?' }]), 1);
});

test('T3 export: a user message that asks is never assistant prose; tool items and cut-off text are caught', () => {
  const e = t3ExportFixture('thread:x', claudeW, [{ type: 'user_message', creationSource: 'mcp', text: 'Which deploy-target should I use?' }, assistant('Done.'),
    { type: 'tool_call', creationSource: 'provider', text: 'Should I deploy?' }, { type: 'assistant_message', creationSource: 'mcp', text: 'Please confirm deploy-target.' }]);
  const r = transcriptItems(JSON.stringify(e));
  assert.deepEqual(r.items, [{ type: 'assistant_message', text: 'Done.' }]); assert.equal(reaskCount(r.items), 0);
  assert.equal(r.format, 't3'); assert.equal(r.complete, true); assert.equal(r.tokens, 'unknown'); assert.deepEqual(r.models, ['claude-sonnet-5-5']);
  assert.equal(transcriptItems(JSON.stringify(t3ExportFixture('thread:x', claudeW, [{ ...assistant('Which'), textTruncated: true }]))).complete, false);
  assert.equal(transcriptItems(JSON.stringify(t3ExportFixture('thread:x', claudeW, [assistant('Done.')], { hasMore: true }))).complete, false);
  // A CLI JSONL line is still read by the CLI parser.
  assert.equal(transcriptItems(JSON.stringify({ type: 'assistant_message', text: 'Done.' })).format, 'jsonl');
});
test('T3 identities map to the plan labels the engine authorizes', () => {
  assert.equal(planLabel(parseWorker(claudeW)), 'Claude (sonnet/low, fresh session)');
  assert.equal(planLabel(parseWorker(codexW)), 'Codex (gpt-6.1-terra/low, fresh session)');
  assert.throws(() => parseWorker('claudeAgent|sonnet'), /PROVIDER\|MODEL\|EFFORT/);
});
test('T3 step usage errors exit 2 and a non-interrupted status is refused', { timeout: 60000 }, async () => {
  assert.equal(call(['t3-begin', '--dir', join(root, 'none')]).code, 2);
  const dir = join(root, 't3-refuse'); scaffold(dir, engine);
  assert.equal(call(['t3-begin', '--dir', dir, '--engine', engine, '--scenario', '7', '--worker', codexW]).code, 2);
  const begin = call(['t3-begin', '--dir', dir, '--engine', engine, '--scenario', '10', '--worker', codexW]);
  assert.equal(begin.code, 0); assert.match(begin.value.packet, /Settled, do not re-ask/);
  assert.equal(call(['t3-attach', '--dir', dir, '--engine', engine, '--thread-id', 'thread:refuse']).code, 0);
  writeFileSync(join(dir, 'src/m1.txt'), 'milestone 1\n'); writeFileSync(join(dir, 'src/m2.txt'), 'milestone 2\n');
  assert.equal(call(['t3-wait', '--dir', dir, '--timeout', '5']).code, 0);
  const exp = writeExport('refuse.json', t3ExportFixture('thread:refuse', codexW, [assistant('Stopped.')], { runStatus: 'interrupted' }));
  const r = call(['t3-stop', '--dir', dir, '--engine', engine, '--task-status', 'working', '--export', exp, '--to', claudeW]);
  assert.equal(r.code, 1); assert.match(r.value.checks[0].detail, /must be interrupted/);
  const noTakeover = call(['t3-stop', '--dir', dir, '--engine', engine, '--task-status', 'interrupted', '--export', exp, '--to', claudeW]);
  assert.equal(noTakeover.code, 1); assert.match(noTakeover.value.checks[0].detail, /t3-takeover before t3-stop/);
  const tk = call(['t3-takeover', '--dir', dir, '--engine', engine, '--successor-id', 'lead-2', '--observed', `interrupted@${new Date().toISOString()}`, '--reason', 'fixture']);
  assert.equal(tk.code, 0); assert.deepEqual([tk.value.refused, tk.value.journalUnchanged, tk.value.from], [true, true, 'recovery-live']);
  const other = writeExport('refuse-other.json', t3ExportFixture('thread:other', codexW, [assistant('Stopped.')]));
  const wrong = call(['t3-stop', '--dir', dir, '--engine', engine, '--task-status', 'interrupted', '--export', other, '--to', claudeW]);
  assert.equal(wrong.code, 1); assert.match(wrong.value.checks[0].detail, /thread differs/);
});

// Slice 14 review 1 regressions (2026-11-08).
test('slice 14 review H1: a sandbox inside a git worktree is detected; the test root is not', () => {
  assert.equal(insideGitWorktree(join(process.cwd(), 'plans', 'some-sandbox')), true);
  assert.equal(insideGitWorktree(join(root, 'any-sandbox')), false);
});
test('slice 14 review M1: a stopped T3 export must show interrupted, in t3-stop and in the grader', () => {
  const src = join(root, 't3-10');
  assert.ok(existsSync(join(src, 'plans/worker-1-export.json')), 'needs the T3 scenario 10 run above');
  // Grader: flip worker 1's export to completed, re-anchor its hash, and the row must fail the new check.
  const dir = join(root, 'm1-completed-export'); cpSync(src, dir, { recursive: true });
  const ep = join(dir, 'plans/worker-1-export.json'), e = read(ep);
  e.thread.status = 'completed'; e.recentRuns[0].status = 'completed'; writeFileSync(ep, JSON.stringify(e));
  const rp = join(dir, 'plans/sandbox.record.json'), r = read(rp);
  r.workers[0].sha256 = createHash('sha256').update(readFileSync(ep)).digest('hex'); save(rp, r);
  const results = join(root, 'm1.jsonl'); appendRow(results, '10', 't3', dir);
  const c = gradeOnly(results).rows[0].checks.find(x => x.name === 'worker-1-t3-interrupted');
  assert.equal(c?.pass, false);
  // The untouched run still passes the same check.
  const okResults = join(root, 'm1-ok.jsonl'); appendRow(okResults, '10', 't3', src);
  assert.equal(gradeOnly(okResults).rows[0].checks.find(x => x.name === 'worker-1-t3-interrupted')?.pass, true);
});
