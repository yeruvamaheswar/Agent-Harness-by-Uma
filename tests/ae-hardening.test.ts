// Slice 18: regressions at the actual CLI, filesystem, and process boundaries. All writes use disposable repos.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { JOURNAL_HARD_BYTES, journalPath, journalText, loadJournal, saveJournal, withLock, writeAtomic } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '../tools/agents/skills/autonomous-engineering/scripts');
const LEAD = 'Claude (opus/high)', ISO = '2026-11-08T08:30:00Z';
const env = { ...process.env, AE_FAULT_POINT: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean, label: string) {
  const deadline = Date.now() + 20_000;
  while (!fn()) { if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await sleep(10); }
}
function repo(command = 'true') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-hardening-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans/p.md'), jfile = journalPath(plan);
  writeFileSync(plan, [
    '---', 'kind: plan', 'title: test', 'status: active', 'updated: 2026-11-08', 'planner: multi-agent-planning', 'mode: standard', '---',
    'Summary: hardening fixture', '', '## Slices', '### Slice 1: one', '- Goal: original goal', '- Model: Claude (sonnet/high)',
    '- Review: Codex (auto)', '- Fallback: Claude (opus/high)', '- Wave: 1 sequential', '- Depends on: none', '- Files: f.txt',
    '- Accept: check behavior', `- Verify: \`${command}\``, '- State: PLANNED', '- Evidence: none', '', '## Open', '- none', '',
  ].join('\n'));
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  let clock = Date.UTC(2026, 10, 8, 8);
  const run = (command: string, ...args: string[]) => main([command, plan, ...args], { cwd: dir, now: () => new Date(clock += 1000) });
  const raw = () => readFileSync(jfile, 'utf8');
  const journal = (): Journal => JSON.parse(raw());
  const put = (path: string, data = '') => writeFileSync(join(dir, path), data);
  const started = async () => { await run('init'); await run('next'); await run('start', '1'); };
  const reviewed = async () => { await started(); await run('finish', '1'); await run('review', '1', '--by', 'reviewer', '--note', 'ok'); };
  return { dir, plan, jfile, git, run, raw, journal, put, started, reviewed };
}
function nullPaths(value: unknown, path = '$'): string[] {
  if (value === null) return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nullPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => nullPaths(v, `${path}.${k}`));
  return [];
}

for (const mode of ['timeout', 'signal'] as const) {
  for (const operation of ['verify', 'run-check'] as const) {
    test(`Accept 1 (R1): ${operation} ${mode} omits exitCode and writes termination strings, never null`, async () => {
      const r = repo('sh gate.sh');
      r.put('gate.sh', mode === 'timeout' ? 'sleep 5\n' : 'kill -TERM $$\n');
      if (operation === 'verify') await r.reviewed(); else await r.started();
      await r.run(operation === 'verify' ? 'verify' : 'checkpoint', '1', ...(operation === 'run-check' ? ['--run-check'] : []), '--timeout', mode === 'timeout' ? '0.05' : '5');
      const j = r.journal(), result = operation === 'verify' ? j.slices['1'].attempts.at(-1)! : j.slices['1'].checkpoints!.at(-1)!.check!;
      assert.equal('exitCode' in result, false);
      assert.equal(Reflect.get(result, 'signal'), mode === 'timeout' ? 'SIGKILL' : 'SIGTERM');
      if (mode === 'timeout') assert.equal(Reflect.get(result, 'timeout'), '50ms');
      for (const path of [r.jfile, r.jfile + '.bak']) assert.deepEqual(nullPaths(JSON.parse(readFileSync(path, 'utf8'))), [], path);
      assert.equal(j.slices['1'].evidence.length, 0);
    });
  }
}

function child(script: string, args: string[], cwd: string) {
  const process = spawn(globalThis.process.execPath, ['--experimental-strip-types', script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`child timed out: ${script}: ${stderr}`)); }, 25_000);
    process.on('error', e => { clearTimeout(timer); reject(e); });
    process.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { process, done };
}

// Both contenders see the same dead owner. A pauses immediately before removing it. B must wait for A
// rather than displace the lock. A then pauses after temp fsync and before rename; B still cannot enter.
test('Accept 3 (R3, F5): two real contenders recover a killed holder and serialize across the save/rename gap', async () => {
  const r = repo(); await r.started();
  const url = pathToFileURL(join(SCRIPTS, 'journal.ts')).href;
  r.put('holder.mjs', `import {withLock} from ${JSON.stringify(url)}; import {writeFileSync} from 'node:fs'; await withLock(process.argv[2], async()=>{writeFileSync('holder-ready',''); await new Promise(()=>{setInterval(()=>{},1000);});});`);
  const holder = child(join(r.dir, 'holder.mjs'), [r.jfile], r.dir);
  await until(() => existsSync(join(r.dir, 'holder-ready')), 'holder');
  holder.process.kill('SIGKILL'); assert.equal((await holder.done).signal, 'SIGKILL');
  r.put('writer.mjs', `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const [file,id]=process.argv.slice(2), lock=file+'.lock';
    const read=fs.readFileSync, sync=fs.fsyncSync, open=fs.openSync, close=fs.closeSync, unlink=fs.unlinkSync, link=fs.linkSync;
    const paths=new Map(); let observed=false, paused=false;
    function gate(name){const end=Date.now()+15000; while(!fs.existsSync(name)){if(Date.now()>end)throw Error('gate '+name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
    fs.readFileSync=function(p,...a){const value=read(p,...a);if(p===lock&&!observed){observed=true;fs.writeFileSync('seen-'+id,'');}return value;};
    fs.unlinkSync=function(p){if(id==='a'&&p===lock){fs.writeFileSync('reaping-a','');gate('reap-go');}return unlink(p);};
    fs.linkSync=function(src,dst){try{return link(src,dst);}catch(e){if(id==='b'&&dst.startsWith(lock+'.takeover.'))fs.writeFileSync('blocked-b','');throw e;}};
    fs.openSync=function(p,...a){const fd=open(p,...a);paths.set(fd,String(p));return fd;};
    fs.closeSync=function(fd){paths.delete(fd);return close(fd);};
    fs.fsyncSync=function(fd){const out=sync(fd);if(!paused&&paths.get(fd)?.startsWith(file+'.')&&paths.get(fd)?.endsWith('.tmp')&&!paths.get(fd)?.startsWith(file+'.bak.')){paused=true;fs.writeFileSync('saving-'+id,'');gate('rename');}return out;};
    syncBuiltinESMExports();
    const {withLock,loadJournal,saveJournal}=await import(${JSON.stringify(url)});
    fs.writeFileSync('ready-'+id,'');gate('start');if(id==='b')gate('reaping-a');
    await withLock(file, async()=>{
      const sentinel=fs.openSync('active','wx');fs.writeFileSync('entered-'+id,'');
      try {const j=loadJournal(file).journal;j.slices['1'].history.push({at:'${ISO}',from:'IN_PROGRESS',to:'IN_PROGRESS',reason:id});saveJournal(file,j);}
      finally {fs.closeSync(sentinel);fs.unlinkSync('active');}
    },10000);
  `);
  const writers = ['a', 'b'].map(id => child(join(r.dir, 'writer.mjs'), [r.jfile, id], r.dir));
  try {
    await until(() => ['a', 'b'].every(id => existsSync(join(r.dir, 'ready-' + id))), 'both writers ready'); r.put('start');
    await until(() => existsSync(join(r.dir, 'seen-b')), 'both saw dead holder');
    await until(() => existsSync(join(r.dir, 'blocked-b')) || existsSync(join(r.dir, 'saving-b')), 'B tried the stale takeover');
    r.put('reap-go');
    let finishedA = false; void writers[0].done.then(() => { finishedA = true; });
    await until(() => existsSync(join(r.dir, 'saving-a')) || finishedA, 'A reaches save/rename gap');
    assert.equal(finishedA, false, 'A must own the save while B waits');
    assert.equal(['a', 'b'].filter(id => existsSync(join(r.dir, 'entered-' + id))).length, 1, 'only the elected holder enters');
    r.put('rename');
    const results = await Promise.all(writers.map(w => w.done));
    for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); }
  } finally { for (const writer of writers) writer.process.kill('SIGKILL'); }
  const j = r.journal();
  assert.deepEqual(j.slices['1'].history.filter(h => ['a', 'b'].includes(h.reason)).map(h => h.reason).sort(), ['a', 'b']);
  assert.equal(loadJournal(r.jfile).recoveredFromBackup, false, 'complete main journal');
  assert.ok(JSON.parse(readFileSync(r.jfile + '.bak', 'utf8')).slices['1'].history.some((h: { reason: string }) => ['a', 'b'].includes(h.reason)));
  assert.equal(existsSync(r.jfile + '.lock'), false);
});

test('Accept 3 (R3): a crash after election is recoverable without a second live reaper', async () => {
  const r = repo(); await r.started();
  const dead = '999999999:aa', reaper = '999999998:bb';
  writeFileSync(r.jfile + '.lock', dead);
  const election = r.jfile + '.lock.takeover.' + createHash('sha256').update(dead).digest('hex');
  writeFileSync(election, reaper);
  await withLock(r.jfile, () => {
    const j = r.journal(); j.slices['1'].history.push({ at: ISO, from: 'IN_PROGRESS', to: 'IN_PROGRESS', reason: 'recovered reaper' });
    saveJournal(r.jfile, j);
  });
  assert.equal(r.journal().slices['1'].history.at(-1)!.reason, 'recovered reaper');
  assert.equal(existsSync(election), false);
  assert.equal(readdirSync(dirname(r.jfile)).some(n => n.includes('.takeover.')), false);
});

for (const target of ['journal', 'backup', 'plan'] as const) {
  test(`Accept 3 (R3): lost ownership after temp fsync refuses the ${target} rename`, async () => {
    const r = repo(); await r.started();
    const file = target === 'journal' ? r.jfile : target === 'backup' ? r.jfile + '.bak' : r.plan;
    const before = readFileSync(file, 'utf8'), realSync = fs.fsyncSync;
    await withLock(r.jfile, () => {
      let replaced = false;
      const spy = mock.method(fs, 'fsyncSync', (fd: number) => {
        const result = realSync(fd);
        if (!replaced) { replaced = true; writeFileSync(r.jfile + '.lock', '999999999:abcdef'); }
        return result;
      });
      syncBuiltinESMExports();
      try { assert.throws(() => writeAtomic(file, 'new bytes', r.jfile), /lost the journal lock/); }
      finally { spy.mock.restore(); syncBuiltinESMExports(); }
    });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(readdirSync(dirname(file)).filter(f => f.endsWith('.tmp')).length, 0, 'refused temp is cleaned');
  });
}

for (const phase of ['initial', 'retake', 'recover'] as const) {
  test(`Accept 4 (R4): ${phase} lock wait reads the plan only after acquisition`, async () => {
    const r = repo('sh gate.sh'); r.put('gate.sh', 'touch started\nwhile [ ! -f go ]; do sleep 0.01; done\n');
    if (phase === 'retake') await r.reviewed(); else await r.started();
    const held = join(r.dir, 'lock-ready'), release = join(r.dir, 'lock-release');
    const url = pathToFileURL(join(SCRIPTS, 'journal.ts')).href;
    r.put('lock.mjs', `import {withLock} from ${JSON.stringify(url)};import {writeFileSync,existsSync} from 'node:fs';await withLock(process.argv[2],async()=>{writeFileSync(${JSON.stringify(held)},'');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));});`);
    const running = phase === 'retake' ? r.run('verify', '1') : undefined;
    if (running) await until(() => existsSync(join(r.dir, 'started')), 'verify running');
    const lock = child(join(r.dir, 'lock.mjs'), [r.jfile], r.dir);
    const realLink = fs.linkSync; let waited = false;
    const spy = mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
      try { return realLink(...args); } catch (e) { if (args[1] === r.jfile + '.lock') waited = true; throw e; }
    });
    syncBuiltinESMExports();
    try {
      await until(() => existsSync(held), 'other holder');
      const command = running ?? r.run(phase === 'recover' ? 'recover' : 'finish', ...(phase === 'recover' ? ['--apply'] : ['1']), '--wait-lock', '5');
      const checked = phase === 'initial' ? assert.rejects(command, /needs IN_PROGRESS/) : command;
      if (running) r.put('go');
      await until(() => waited, 'command blocked on the live lock');
      const edited = readFileSync(r.plan, 'utf8').replace('- Goal: original goal', '- Goal: changed while waiting');
      writeFileSync(r.plan, edited); r.put('lock-release');
      assert.equal((await lock.done).code, 0);
      if (phase === 'initial') await checked;
      else {
        const result = await command;
        if (phase === 'retake') { assert.equal(result.unstable, true); assert.ok(Array.isArray(result.changed) && result.changed.includes('slice definition')); }
      }
      assert.match(readFileSync(r.plan, 'utf8'), /Goal: changed while waiting/);
      assert.equal(r.journal().slices['1'].evidence.length, 0);
    } finally { spy.mock.restore(); syncBuiltinESMExports(); r.put('go'); r.put('lock-release'); lock.process.kill('SIGKILL'); }
  });
}

test('Accept 2 (R2): ae decide refuses an escaped multibyte ledger write that crosses 1 MiB', async () => {
  const r = repo(); await r.started();
  const j = r.journal();
  j.slices['1'].history.push({ at: ISO, from: 'IN_PROGRESS', to: 'IN_PROGRESS', reason: '' });
  j.slices['1'].history.at(-1)!.reason = 'x'.repeat(1024 * 1024 - Buffer.byteLength(journalText(j)) - 1000);
  writeFileSync(r.jfile, journalText(j));
  const before = r.raw(), backup = readFileSync(r.jfile + '.bak', 'utf8');
  await assert.rejects(r.run('decide', '--key', 'byte.boundary', '--risk', 'green', '--status', 'assumed',
    '--question', '界"\\'.repeat(125), '--answer', '界"\\'.repeat(125), '--lead', LEAD), /decision write refused: .*serialized UTF-8 bytes/);
  assert.equal(r.raw(), before); assert.equal(readFileSync(r.jfile + '.bak', 'utf8'), backup);
});

test('Accept 5 (R5): every save has a hard UTF-8 ceiling, including a state move and recover --apply; refusal writes nothing', async () => {
  const r = repo(); await r.started();
  const j = r.journal();
  j.slices['1'].history.push({ at: ISO, from: 'IN_PROGRESS', to: 'IN_PROGRESS', reason: '' });
  const room = JOURNAL_HARD_BYTES - Buffer.byteLength(journalText(j)) - 50;
  j.slices['1'].history.at(-1)!.reason = '界'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
  writeFileSync(r.jfile, journalText(j));
  const before = r.raw(), plan = readFileSync(r.plan, 'utf8'), bak = readFileSync(r.jfile + '.bak', 'utf8');
  assert.ok(Buffer.byteLength(before) < JOURNAL_HARD_BYTES);
  await assert.rejects(r.run('finish', '1', '--summary', 'a finished slice'), /hard ceiling/);
  // Direct saves and recovery use the same ceiling even though they bypass ae.ts's soft growth guard.
  j.slices['1'].history.at(-1)!.reason += '😀'.repeat(100);
  await assert.rejects(withLock(r.jfile, () => saveJournal(r.jfile, j)), /hard ceiling/);
  assert.equal(r.raw(), before); assert.equal(readFileSync(r.plan, 'utf8'), plan); assert.equal(readFileSync(r.jfile + '.bak', 'utf8'), bak);
  assert.equal(readdirSync(dirname(r.jfile)).some(n => n.endsWith('.tmp')), false);
  // Force recovery to demote stale evidence, a separate state-writing path.
  j.slices['1'].state = 'VERIFIED'; j.slices['1'].evidence = [];
  writeFileSync(r.jfile, journalText(j));
  const recoveryBefore = r.raw();
  await assert.rejects(r.run('recover', '--apply'), /hard ceiling/);
  assert.equal(r.raw(), recoveryBefore); assert.equal(readFileSync(r.plan, 'utf8'), plan); assert.equal(readFileSync(r.jfile + '.bak', 'utf8'), bak);
  j.slices['1'].history.at(-1)!.reason = 'small replacement';
  await assert.rejects(withLock(r.jfile, () => saveJournal(r.jfile, j)), /backup write refused: .*hard ceiling/);
  assert.equal(r.raw(), recoveryBefore); assert.equal(readFileSync(r.jfile + '.bak', 'utf8'), bak);
});

test('Accept 6 (R6): an unstable run-check records stable:false but never advances or refreshes a handoff', async () => {
  for (const phase of ['PREPARED', 'CHECKPOINTED']) {
    const r = repo('sh gate.sh'); await r.started();
    await r.run('prepare', '1', '--lead', LEAD, '--to', LEAD, '--reason', 'quota');
    if (phase === 'CHECKPOINTED') await r.run('checkpoint', '1');
    const before = r.journal().slices['1'].handoffs!.at(-1)!;
    r.put('gate.sh', 'echo changed >> f.txt\n');
    await r.run('checkpoint', '1', '--run-check');
    const rec = r.journal().slices['1'];
    assert.equal(rec.checkpoints!.at(-1)!.check!.stable, false);
    assert.deepEqual(rec.handoffs!.at(-1), before, `${phase}: phase, history, and checkpointAt are unchanged`);
    assert.equal(rec.evidence.length, 0);
  }
});

test('Accept 7 (R8): takeover requires a stopped STATUS@ISO-TIME, and refuses running and free text without writes', async () => {
  const r = repo(); await r.started(); await r.run('lead', '--claim', '--lead-id', 'L1', '--label', LEAD);
  const before = r.raw();
  for (const observed of ['working@' + ISO, 'running@' + ISO, 'idle@' + ISO, 'not running at 08:30', 'completed', 'failed@yesterday', 'exited@', 'completed@2026']) {
    await assert.rejects(r.run('lead', '--takeover', '--lead-id', 'L2', '--reason', 'successor', '--observed', observed), /STATUS@ISO-TIME/);
    assert.equal(r.raw(), before);
  }
  for (const status of ['completed', 'failed', 'interrupted', 'cancelled', 'exited']) {
    assert.equal((await r.run('lead', '--takeover', '--lead-id', status, '--reason', 'stopped predecessor', '--observed', status + '@' + ISO)).takeover, true);
  }
});

test('Accept 8 (R9): disarm needs an explicit READ_AT and refuses omitted, empty, extra, or invalid times', async () => {
  const r = repo(); await r.started();
  await r.run('attach', '1', '--launch-key', 'ae:p#1/a1', '--thread-id', 'T1');
  await r.run('prepare', '1', '--lead', LEAD, '--to', LEAD, '--reason', 'stopped'); await r.run('checkpoint', '1');
  const before = r.raw();
  for (const disarmed of ['interrupted,cancel', 'interrupted,cancel,', 'interrupted,cancel,yesterday', 'interrupted,cancel,' + ISO + ',extra']) {
    await assert.rejects(r.run('transfer', '1', '--lead', LEAD, '--disarmed', disarmed), /read time/);
    assert.equal(r.raw(), before);
  }
  await r.run('transfer', '1', '--lead', LEAD, '--disarmed', 'interrupted,cancel,' + ISO);
  assert.equal(r.journal().slices['1'].handoffs!.at(-1)!.disarmed!.readAt, '2026-11-08T08:30:00.000Z');
});

test('Accept 9 (R10): release preserves lease enforcement; re-claim enables lead writes; a never-leased journal keeps LD-5 behavior', async () => {
  const r = repo(); await r.started();
  await r.run('checkpoint', '1'); // Never leased: no new flags required (LD-5).
  await r.run('lead', '--claim', '--lead-id', 'L1', '--label', LEAD); await r.run('lead', '--release', '--lead-id', 'L1');
  const before = r.raw();
  for (const args of [[], ['--lead-id', 'L1'], ['--lead-id', 'L2']]) {
    await assert.rejects(r.run('finish', '1', ...args), /lease was released/); assert.equal(r.raw(), before);
  }
  // A worker's own checkpoint is still the explicit exception, even between lead claims.
  await r.run('checkpoint', '1', '--launch-key', 'ae:p#1/a1');
  await r.run('lead', '--claim', '--lead-id', 'L2', '--label', LEAD);
  assert.equal((await r.run('finish', '1', '--lead-id', 'L2')).state, 'AGENT_FINISHED');
});

test('Accept 10 (R11): recover separates crash orphans above the journal high-water mark from the five-checkpoint window', async () => {
  const r = repo(); await r.started();
  for (let i = 1; i <= 7; i++) { r.put('f.txt', `milestone ${i}\n`); await r.run('checkpoint', '1'); }
  const records = r.journal().slices['1'].checkpoints!;
  assert.equal(records.length, 5);
  const refs = r.git('for-each-ref', '--format=%(refname)', 'refs/ae/snapshots/p/1/').split('\n');
  assert.equal(refs.length, 7);
  r.put('f.txt', 'crash-only work\n');
  const killed = spawn(process.execPath, ['--experimental-strip-types', join(SCRIPTS, 'ae.ts'), 'checkpoint', r.plan, '1'], { cwd: r.dir, env: { ...env, AE_FAULT_POINT: 'checkpoint:taken' }, stdio: 'ignore' });
  const death = await new Promise<NodeJS.Signals | null>(resolve => killed.on('close', (_code, signal) => resolve(signal)));
  assert.equal(death, 'SIGKILL');
  const before = r.raw(), all = r.git('for-each-ref', '--format=%(refname)', 'refs/ae/snapshots/p/1/').split('\n');
  const orphan = all.filter(ref => !refs.includes(ref));
  assert.equal(orphan.length, 1);
  for (const args of [[], ['--apply']]) {
    const result = await r.run('recover', ...args);
    assert.deepEqual(result.orphanSnapshotRefs, orphan); assert.equal(result.orphanSnapshotCount, 1);
    assert.deepEqual(result.prunedSnapshotRefs, refs.slice(0, 2)); assert.equal(result.prunedSnapshotCount, 2);
    assert.equal(r.raw(), before);
  }
  assert.equal(r.git('show', `${orphan[0]}:f.txt`), 'crash-only work');
});
