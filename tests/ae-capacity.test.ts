import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath, PROFILES } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { definitionDigest, parsePlan } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';
import { MAX_SAMPLES, parseSwapouts, probeMachine, SWAP_WINDOW_S, swapTrend } from '../tools/agents/skills/autonomous-engineering/scripts/capacity.ts';
import type { ProbeReading } from '../tools/agents/skills/autonomous-engineering/scripts/capacity.ts';

// plans/adaptive-concurrency.md, EVAL-1 to EVAL-11. Every test uses its own temp repo and an injected probe:
// no test runs sysctl or vm_stat. The clock is injected too, so a 60 s swap window is a tick, not a wait.
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools/agents/skills/autonomous-engineering/scripts');
const AE = join(SCRIPTS, 'ae.ts');

type S = { n: number; files?: string; wave?: string; deps?: string; verify?: string; cls?: string; review?: string; state?: string };
const slice = (s: S) => [
  `### Slice ${s.n}: s${s.n}`,
  `- Goal: goal ${s.n}`, '- Model: Claude (sonnet/high)', `- Review: ${s.review ?? 'Codex (auto)'}`, '- Fallback: Claude (opus/high)',
  `- Wave: ${s.wave ?? '1 parallel'}`, `- Depends on: ${s.deps ?? 'none'}`, `- Files: ${s.files ?? `f${s.n}.txt`}`,
  ...(s.cls ? [`- Class: ${s.cls}`] : []),
  `- Accept: accept ${s.n}`, `- Verify: ${s.verify ?? '`true`'}`, `- State: ${s.state ?? 'PLANNED'}`, '- Evidence: none', '',
].join('\n');
const planText = (slices: S[]) => `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-06\nplanner: multi-agent-planning\nmode: standard\n---\nSummary: test\n\n## Slices\n${slices.map(slice).join('\n')}\n## Open\n- none\n`;
const heavy = (...ns: number[]) => ns.map(n => ({ n, cls: 'heavy' }));
const SLEEPER = '`node -e "setTimeout(() => {}, 20000)"`';

// A healthy macOS reading: pressure normal, 8192 MB free of 16384 MB.
const HEALTHY: ProbeReading = { platform: 'darwin', pressure: 'normal', swapouts: 1000, freeMB: 8192, totalMB: 16384, load: [3, 3, 3], cpus: 10 };

function repo(slices: S[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-capacity-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, planText(slices));
  let t = Date.UTC(2026, 10, 6, 12), reading: ProbeReading = { ...HEALTHY }, probes = 0;
  const run = (...argv: string[]) => main(argv, { cwd: dir, now: () => new Date((t += 1000)), probe: () => { probes++; return { ...reading }; } }) as Promise<any>;
  const api = {
    dir, plan, run, jfile: journalPath(plan),
    probes: () => probes,
    read: (r: Partial<ProbeReading>) => { reading = { ...reading, ...r }; },
    tick: (seconds: number) => { t += seconds * 1000; },
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    raw: () => readFileSync(journalPath(plan), 'utf8'),
    state: (id: string) => api.journal().slices[id].state,
    edit: (fn: (text: string) => string) => writeFileSync(plan, fn(readFileSync(plan, 'utf8'))),
    next: async () => { const out = await run('next', plan); return { out, ids: out.batch.map((b: any) => b.id) as string[], why: (id: string) => out.deferred.find((d: any) => d.id === id)?.reason as string | undefined }; },
    // READY -> VERIFIED (or a failed verify) for one slice
    drive: async (id: string, ...flags: string[]) => {
      await run('start', plan, id);
      await run('finish', plan, id);
      await run('review', plan, id, '--by', 'rev', '--note', 'diff read');
      return run('verify', plan, id, ...flags);
    },
    // init adaptive, then a first reading and one 61 s later, so the swap window is known
    warm: async () => { await run('init', plan, '--profile', 'adaptive'); await run('next', plan); t += 61_000; },
  };
  return api;
}

// ---- EVAL-10: the probe ----
const VM_STAT = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                     4911.\nPageouts:                                      25941.\nSwapins:                                       54646.\nSwapouts:                                     140892.\n';

test('EVAL-10: the macOS probe parses sysctl and vm_stat through an injected exec, and never throws', () => {
  const calls: string[] = [];
  const values: Record<string, string> = { 'kern.memorystatus_vm_pressure_level': '2\n', 'kern.memorystatus_level': '47\n' };
  const exec = (file: string, args: string[]) => { calls.push([file, ...args].join(' ')); return file === '/usr/bin/vm_stat' ? VM_STAT : file === '/usr/sbin/sysctl' ? values[args[1]] ?? null : null; };
  const base = { load: () => [4.314, 5.22, 6.33], cpus: () => 10, total: () => 17179869184 };
  const r = probeMachine({ platform: 'darwin', exec, ...base });
  assert.deepEqual(r, { platform: 'darwin', pressure: 'warn', swapouts: 140892, freeMB: 7700, totalMB: 16384, load: [4.31, 5.22, 6.33], cpus: 10 });
  assert.deepEqual(calls.sort(), ['/usr/bin/vm_stat', '/usr/sbin/sysctl -n kern.memorystatus_level', '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level'], 'fixed programs by absolute path');
  for (const [raw, want] of [['1', 'normal'], ['4', 'critical'], ['3', 'unknown'], ['0', 'unknown'], ['', 'unknown'], ['constructor', 'unknown']]) {
    values['kern.memorystatus_vm_pressure_level'] = raw;
    assert.equal(probeMachine({ platform: 'darwin', exec, ...base }).pressure, want, `level "${raw}"`);
  }
  for (const raw of ['101', '-1', 'x', '']) {
    values['kern.memorystatus_level'] = raw;
    assert.equal(probeMachine({ platform: 'darwin', exec, ...base }).freeMB, null, `free percent "${raw}"`);
  }
  const failing = probeMachine({ platform: 'darwin', exec: () => null, ...base });
  assert.deepEqual([failing.pressure, failing.swapouts, failing.freeMB, failing.totalMB], ['unknown', null, null, 16384]);
  let called = 0;
  const linux = probeMachine({ platform: 'linux', exec: () => { called++; return '1'; }, ...base });
  assert.equal(called, 0, 'no command runs off macOS');
  assert.deepEqual([linux.pressure, linux.swapouts, linux.freeMB], ['unknown', null, null]);
  assert.equal(parseSwapouts('Swapouts:   12.\n'), 12);
  assert.equal(parseSwapouts('Pageouts: 5.\n'), null);
  assert.equal(parseSwapouts(null), null);
});

test('EVAL-9: the probe never uses the Node free-memory call; it misreads macOS', () => {
  for (const f of ['capacity.ts', 'journal.ts', 'ae.ts']) assert.doesNotMatch(readFileSync(join(SCRIPTS, f), 'utf8'), /freemem/, f);
});

test('swapTrend uses the newest sample 60 s old or more; a counter that went down is unknown', () => {
  const now = new Date(Date.UTC(2026, 10, 6, 12, 10));
  const at = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  const samples = [{ at: at(300), swapouts: 100, pressure: 'normal' as const }, { at: at(70), swapouts: 150, pressure: 'normal' as const }, { at: at(20), swapouts: 160, pressure: 'normal' as const }];
  assert.deepEqual(swapTrend(samples, 150, now), { state: 'flat', pages: 0, windowS: 70 }, 'the 20 s sample is too young; the 70 s one is the base');
  assert.deepEqual(swapTrend(samples, 175, now), { state: 'grew', pages: 25, windowS: 70 });
  assert.equal(swapTrend(samples.slice(2), 160, now).state, 'unknown');
  assert.equal(swapTrend(samples, 90, now).note, 'the counter went down, as after a restart');
  assert.equal(swapTrend(samples, null, now).state, 'unavailable');
});

// ---- EVAL-1 and EVAL-11: init, Class, and the fixed profiles ----
test('EVAL-1: init --profile adaptive writes an adaptive journal; fixed profiles keep 1, 2, and 4', async () => {
  const r = repo([{ n: 1 }]);
  assert.equal((await r.run('init', r.plan, '--profile', 'adaptive')).profile, 'adaptive');
  assert.equal(r.journal().profile, 'adaptive');
  assert.deepEqual(r.journal().capacity, { samples: [], pressureEpisodes: [] });
  assert.equal(r.probes(), 0, 'init reads no signals');
  const bad = repo([{ n: 1 }]);
  await assert.rejects(bad.run('init', bad.plan, '--profile', 'turbo'), /unknown profile "turbo"; use economy, balanced, sprint, adaptive/);
  await assert.rejects(bad.run('init', bad.plan, '--profile', 'sprint', '--heavy-rss-mb', '3000'), /--heavy-rss-mb applies to the adaptive profile only/);
  await assert.rejects(bad.run('init', bad.plan, '--profile', 'adaptive', '--heavy-rss-mb', '2.5'), /whole number of MB/);
  assert.equal(existsSync(bad.jfile), false, 'a refused init writes no journal');
  const rss = repo([{ n: 1 }]);
  await rss.run('init', rss.plan, '--profile', 'adaptive', '--heavy-rss-mb', '3000');
  assert.equal(rss.journal().capacity!.heavyRssMB, 3000);
  assert.deepEqual(PROFILES, { economy: { maxParallel: 1 }, balanced: { maxParallel: 2 }, sprint: { maxParallel: 4 } });
});

test('EVAL-11: Class is optional and checked, and it stays out of the definition digest', async () => {
  const p = parsePlan(planText([{ n: 1, cls: 'heavy' }, { n: 2 }, { n: 3, cls: 'Normal' }]), 'x.md');
  assert.deepEqual(p.slices.map(s => s.class), ['heavy', 'normal', 'normal']);
  assert.throws(() => parsePlan(planText([{ n: 1, cls: 'huge' }]), 'x.md'), /Slice 1: unknown Class "huge" \(want heavy or normal\)/);
  const [withClass] = parsePlan(planText([{ n: 1, cls: 'heavy' }]), 'x.md').slices, [without] = parsePlan(planText([{ n: 1 }]), 'x.md').slices;
  assert.equal(definitionDigest(withClass), definitionDigest(without));
  // The engine before Class existed (origin/main f23c0d4) gave this digest for the same slice: existing journals keep theirs.
  assert.equal(definitionDigest(without), '6857aff15c04');
  // Adding Class: heavy to a VERIFIED slice changes scheduling only: it stays VERIFIED with live evidence.
  const r = repo([{ n: 1 }]);
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  assert.equal((await r.drive('1')).state, 'VERIFIED');
  r.edit(t => t.replace('- Accept: accept 1', '- Class: heavy\n- Accept: accept 1'));
  const st = await r.run('status', r.plan);
  assert.equal(st.slices[0].state, 'VERIFIED');
  assert.equal(st.slices[0].class, 'heavy', 'the slice brief names a heavy class');
  assert.equal(r.journal().slices['1'].evidence[0].stale, undefined);
});

test('EVAL-11: fixed profiles never call the probe, and Class changes nothing for them', async () => {
  for (const profile of ['economy', 'balanced', 'sprint'] as const) {
    const r = repo([...heavy(1, 2), { n: 3 }, { n: 4 }, { n: 5 }]);
    await r.run('init', r.plan, '--profile', profile);
    const { out, ids } = await r.next();
    const width = PROFILES[profile].maxParallel;
    assert.deepEqual(ids, ['1', '2', '3', '4', '5'].slice(0, width), profile);
    assert.equal(out.slots, width);
    assert.equal(out.deferred[0].reason, `profile width ${width} reached`);
    assert.equal(out.capacity, undefined);
    assert.equal(r.journal().capacity, undefined);
    assert.equal(r.probes(), 0, `${profile} reads no signals`);
  }
});

// ---- EVAL-2 and EVAL-3: normal slices ----
test('EVAL-2: a healthy probe gives every disjoint parallel slice at once, wider than sprint', async () => {
  const r = repo([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7, files: 'f1.txt' }, { n: 8, wave: '1 sequential' }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  const { out, ids, why } = await r.next();
  assert.deepEqual(ids, ['1', '2', '3', '4', '5', '6'], 'six slices, more than the sprint width of 4');
  assert.equal(why('7'), 'files overlap slice 1');
  assert.equal(why('8'), 'sequential slice runs alone');
  assert.equal(out.profile, 'adaptive');
  assert.equal(out.slots, null, 'no numeric width');
  assert.deepEqual(out.capacity.normal, { starts: null, reason: null });
  assert.equal(out.capacity.signals.pressure, 'normal');
  assert.equal(r.probes(), 1);
  assert.equal(r.journal().capacity!.samples.length, 1, 'the reading is kept for the swap window');
  for (const id of ['1', '2', '3']) await r.run('start', r.plan, id);
  assert.deepEqual((await r.next()).ids, ['4', '5', '6'], 'running slices do not use up a fixed width');
});

test('EVAL-3: at warn, one normal slice starts only when none runs; at critical, none', async () => {
  const r = repo([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  r.read({ pressure: 'warn' });
  let n = await r.next();
  assert.deepEqual(n.ids, ['1'], 'a busy machine does not stall the run');
  assert.equal(n.why('2'), 'normal: memory pressure warn; one slice at a time');
  await r.run('start', r.plan, '1');
  n = await r.next();
  assert.deepEqual(n.ids, []);
  assert.equal(n.why('2'), 'normal: memory pressure warn; 1 running');
  r.read({ pressure: 'critical' });
  assert.equal((await r.next()).why('2'), 'normal: memory pressure critical');
  const c = repo([{ n: 1 }]);
  await c.run('init', c.plan, '--profile', 'adaptive');
  c.read({ pressure: 'critical' });
  const cn = await c.next();
  assert.deepEqual([cn.ids, cn.why('1')], [[], 'normal: memory pressure critical'], 'at critical nothing starts, also when none runs');
  r.read({ pressure: 'normal' });
  assert.deepEqual((await r.next()).ids, ['2', '3']);
});

test('adaptive keeps the sequential rule, and the lowest READY slice keeps its place while it waits', async () => {
  const r = repo([{ n: 1, wave: '1 sequential', cls: 'heavy' }, { n: 2, wave: '2 parallel' }, { n: 3, wave: '2 parallel' }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  let n = await r.next();
  assert.deepEqual(n.ids, []);
  assert.match(n.why('1')!, /^heavy: swap trend unknown/);
  assert.equal(n.why('2'), 'waits for slice 1 (1 sequential), which waits for capacity');
  r.tick(61);
  n = await r.next();
  assert.deepEqual(n.ids, ['1']);
  assert.equal(n.why('2'), 'different wave from running work');
  await r.run('start', r.plan, '1');
  assert.equal((await r.next()).why('3'), 'a sequential or integration slice is running');
  // a waiting parallel heavy slice lets its own wave start, and holds the other waves back
  const w = repo([{ n: 1, cls: 'heavy' }, { n: 2 }, { n: 3, wave: '2 parallel' }]);
  await w.run('init', w.plan, '--profile', 'adaptive');
  const wn = await w.next();
  assert.deepEqual(wn.ids, ['2']);
  assert.equal(wn.why('3'), 'different wave from running work');
  const alone = repo([{ n: 1, cls: 'heavy' }, { n: 3, wave: '2 parallel' }]);
  await alone.run('init', alone.plan, '--profile', 'adaptive');
  assert.equal((await alone.next()).why('3'), 'waits for slice 1 (1 parallel), which waits for capacity');
});

// ---- EVAL-4 and EVAL-5: heavy slices ----
test('EVAL-4: a heavy slice waits for a known swap window, flat swapouts, normal pressure, and free memory', async () => {
  const r = repo([...heavy(1), { n: 2 }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  let n = await r.next();
  assert.deepEqual(n.ids, ['2'], 'the normal slice starts at once');
  assert.equal(n.why('1'), 'heavy: swap trend unknown (no sample 60 s old yet); run ae next again in 60 s or more');
  r.tick(30);
  assert.match((await r.next()).why('1')!, /^heavy: swap trend unknown/, 'the first sample is only 31 s old');
  r.tick(31);
  n = await r.next();
  assert.deepEqual(n.ids, ['1', '2'], 'a flat window of 60 s or more lets the heavy slice start');
  assert.deepEqual(n.out.capacity.signals.swap, { state: 'flat', pages: 0, windowS: 63 });
  r.read({ swapouts: 1400 });
  r.tick(61);
  n = await r.next();
  assert.equal(n.why('1'), 'heavy: swapouts grew by 400 pages in 62 s (load 3 on 10 CPUs)', 'load is quoted with the memory signal');
  assert.deepEqual(n.ids, ['2'], 'swap growth holds heavy slices only');
  r.read({ swapouts: 1800 });
  r.tick(600);
  assert.equal((await r.next()).why('1'), 'heavy: swapouts grew by 400 pages in 601 s (load 3 on 10 CPUs); run ae next again in 60 s for a fresh window', 'growth in a long window asks for a fresh one');
  r.read({ pressure: 'warn' });
  assert.equal((await r.next()).why('1'), 'heavy: memory pressure warn (load 3 on 10 CPUs)');
  r.read({ pressure: 'normal', freeMB: 3000 });
  r.tick(61);
  n = await r.next();
  assert.equal(n.why('1'), 'heavy: 3000 MB free is under twice the 2048 MB heavy RSS estimate');
  assert.equal(n.out.capacity.heavy.starts, 0);
  r.read({ freeMB: 8192, load: [40, 30, 20] });
  r.tick(61);
  assert.deepEqual((await r.next()).ids, ['1', '2'], 'a high load alone defers nothing');
});

test('EVAL-4: frequent ae next calls keep the 60 s swap baseline, in bounded memory', async () => {
  const r = repo([...heavy(1), { n: 2 }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  let n: Awaited<ReturnType<typeof r.next>> | undefined;
  for (let i = 0; i < 90; i++) n = await r.next(); // one call each second for 90 s
  assert.equal(n!.out.capacity.signals.swap.state, 'flat', 'a sample 60 s old or more is still kept');
  assert.ok(n!.out.capacity.signals.swap.windowS <= 2 * SWAP_WINDOW_S, `a fresh window, not the first sample (${n!.out.capacity.signals.swap.windowS} s)`);
  assert.deepEqual(n!.ids, ['1', '2'], 'the heavy slice is offered');
  assert.ok(r.journal().capacity!.samples.length <= MAX_SAMPLES, 'memory stays bounded');
});

test('EVAL-5: free memory sets the heavy width; set-profile --heavy-rss-mb changes the estimate', async () => {
  const r = repo(heavy(1, 2, 3, 4));
  await r.warm();
  let n = await r.next();
  assert.deepEqual(n.ids, ['1', '2', '3'], '8192 MB fits 3 at 2048 MB each, plus a 2048 MB margin');
  assert.equal(n.why('4'), 'heavy: width 3 reached (8192 MB free fits 3 more at 2048 MB each, plus a 2048 MB margin)');
  assert.deepEqual([n.out.capacity.heavy.width, n.out.capacity.heavy.starts, n.out.capacity.heavy.rssMB, n.out.capacity.heavy.rssFrom], [3, 3, 2048, 'default']);
  const set = await r.run('set-profile', r.plan, '--profile', 'adaptive', '--heavy-rss-mb', '4096');
  assert.deepEqual([set.changed, set.change.heavyRssMB, set.heavyRssMB, set.heavyRssFrom], [true, 4096, 4096, 'set']);
  r.tick(61);
  n = await r.next();
  assert.deepEqual(n.ids, ['1']);
  assert.equal(n.why('2'), 'heavy: width 1 reached (8192 MB free fits 1 more at 4096 MB each, plus a 4096 MB margin)');
  await r.run('start', r.plan, '1');
  r.read({ freeMB: 4096 });
  r.tick(61);
  n = await r.next();
  assert.deepEqual([n.ids, n.out.capacity.heavy.running], [[], 1], 'the running heavy slice is in the reading');
  assert.equal(n.why('2'), 'heavy: 4096 MB free is under twice the 4096 MB heavy RSS estimate');
});

// ---- EVAL-6 and EVAL-7: back-off ----
test('EVAL-6: after a heavy verify timeout, heavy slices run one at a time until a heavy Verify passes', async () => {
  const r = repo([{ n: 1, cls: 'heavy', verify: SLEEPER }, ...heavy(2, 3)]);
  await r.warm();
  assert.deepEqual((await r.next()).ids, ['1', '2', '3']);
  const v = await r.drive('1', '--timeout', '0.4');
  assert.deepEqual([v.timedOut, v.state], [true, 'READY']);
  let n = await r.next();
  const serial = 'heavy: a Verify run of heavy slice 1 timed out; one heavy slice at a time until a heavy Verify passes';
  assert.deepEqual(n.ids, ['1'], 'the timed-out slice may run again, alone');
  assert.equal(n.why('2'), serial);
  assert.equal(n.out.capacity.heavy.serial, serial);
  assert.deepEqual(n.out.capacity.heavy.backoff.triggers.map((t: any) => t.text), ['verify timeout of slice 1']);
  await r.run('start', r.plan, '2');
  n = await r.next();
  assert.deepEqual([n.ids, n.why('1')], [[], serial], 'no other heavy slice while one runs');
  // a worker failure is not a Verify run: the timeout rule stays
  await r.run('fail', r.plan, '2', '--reason', 'worker lost');
  assert.equal((await r.next()).out.capacity.heavy.serial, serial);
  assert.equal((await r.drive('3')).state, 'VERIFIED');
  n = await r.next();
  assert.equal(n.out.capacity.heavy.serial, null);
  assert.equal(n.out.capacity.heavy.backoff.steps, 0, 'a passing heavy Verify clears the back-off');
  assert.deepEqual(n.ids, ['1', '2']);
});

test('EVAL-6: an ordinary failed retry after a heavy verify timeout keeps heavy slices one at a time', async () => {
  // The first Verify run times out; the retry exits 1 at once. No heavy Verify passes in between.
  const r = repo([{ n: 1, cls: 'heavy', verify: '`test -f t1 && exit 1; touch t1; sleep 20`' }, ...heavy(2, 3)]);
  await r.warm();
  assert.equal((await r.drive('1', '--timeout', '0.4')).timedOut, true);
  const retry = await r.drive('1', '--timeout', '5');
  assert.deepEqual([retry.timedOut, retry.state], [false, 'READY'], 'the retry failed without a timeout');
  r.tick(61);
  const n = await r.next();
  assert.match(n.out.capacity.heavy.serial ?? '', /slice 1 timed out/, 'serialization stays on until a heavy Verify passes');
  assert.equal(n.out.capacity.heavy.width, 1);
  assert.deepEqual(n.ids, ['1']);
});

test('EVAL-7: a pressure episode lowers the heavy width by one until a heavy Verify passes', async () => {
  const r = repo(heavy(1, 2, 3, 4));
  await r.warm();
  assert.equal((await r.next()).out.capacity.heavy.width, 3);
  r.read({ pressure: 'warn' });
  await r.next();
  await r.next();
  assert.deepEqual(r.journal().capacity!.pressureEpisodes.map(e => e.level), ['warn'], 'one episode, not one per reading');
  r.read({ pressure: 'normal' });
  r.tick(61);
  let n = await r.next();
  assert.deepEqual(n.ids, ['1', '2']);
  assert.equal(n.why('3'), 'heavy: width 2 reached (back-off 1: memory pressure warn)');
  assert.equal(n.out.capacity.heavy.backoff.steps, 1);
  assert.equal((await r.drive('1')).state, 'VERIFIED');
  r.tick(61);
  n = await r.next();
  assert.deepEqual([n.out.capacity.heavy.backoff.steps, n.out.capacity.heavy.width, n.ids], [0, 3, ['2', '3', '4']]);
  assert.deepEqual(r.journal().capacity!.pressureEpisodes, [], 'episodes before the clean heavy run are dropped');
});

test('EVAL-7: two failed slices in a row lower the heavy width by one; one slice failing twice does not', async () => {
  const r = repo([{ n: 1, verify: '`false`' }, { n: 2, verify: '`false`' }, ...heavy(3, 4, 5, 6)]);
  await r.warm();
  await r.drive('1');
  await r.drive('1');
  let n = await r.next();
  assert.equal(n.out.capacity.heavy.backoff.steps, 0, 'the same slice twice is not two failed slices');
  await r.drive('2');
  n = await r.next();
  assert.deepEqual(n.out.capacity.heavy.backoff.triggers.map((t: any) => t.text), ['slices 1 and 2 failed in a row']);
  assert.deepEqual(n.ids, ['1', '2', '3', '4'], 'normal slices still start; heavy width 3 - 1');
  assert.equal(n.why('5'), 'heavy: width 2 reached (back-off 1: slices 1 and 2 failed in a row)');
  // a review rejection is a judgment, not a measurement
  const j = repo([{ n: 1 }, { n: 2 }, ...heavy(3)]);
  await j.warm();
  for (const id of ['1', '2']) {
    await j.run('start', j.plan, id); await j.run('finish', j.plan, id);
    await j.run('review', j.plan, id, '--reject', '--by', 'rev', '--note', `defect in ${id}`);
  }
  assert.equal((await j.next()).out.capacity.heavy.backoff.steps, 0);
  // a passing Verify between two failures breaks the row
  const b = repo([{ n: 1, verify: '`false`' }, { n: 2 }, { n: 3, verify: '`false`' }, ...heavy(4)]);
  await b.warm();
  await b.drive('1'); await b.drive('2'); await b.drive('3');
  assert.equal((await b.next()).out.capacity.heavy.backoff.steps, 0);
  // recovery: a passing heavy Verify clears it
  assert.equal((await r.drive('3')).state, 'VERIFIED');
  r.tick(61);
  n = await r.next();
  assert.equal(n.out.capacity.heavy.backoff.steps, 0);
  assert.deepEqual(n.ids, ['1', '2', '4', '5', '6']);
});

// ---- EVAL-9: no measured signals ----
test('EVAL-9: without measured signals, adaptive runs like balanced, with one heavy slice at a time', async () => {
  const r = repo([...heavy(1, 2), { n: 3 }, { n: 4 }]);
  await r.run('init', r.plan, '--profile', 'adaptive');
  r.read({ platform: 'linux', pressure: 'unknown', swapouts: null, freeMB: null });
  const n = await r.next();
  assert.deepEqual(n.ids, ['1', '3']);
  assert.equal(n.why('2'), 'heavy: one heavy slice at a time (no measured memory signals)');
  assert.equal(n.why('4'), 'adaptive: no measured memory signals on linux; balanced width 2 reached');
  assert.deepEqual([n.out.slots, n.out.capacity.measured], [2, false]);
  // macOS with vm_stat missing is not measured either
  const m = repo([...heavy(1, 2), { n: 3 }, { n: 4 }]);
  await m.run('init', m.plan, '--profile', 'adaptive');
  m.read({ swapouts: null });
  assert.deepEqual((await m.next()).ids, ['1', '3']);
  m.read({ pressure: 'warn' });
  assert.equal((await m.next()).why('1'), 'heavy: memory pressure warn (load 3 on 10 CPUs)', 'a known warn level still holds heavy slices');
});

// ---- EVAL-8: set-profile ----
test('EVAL-8: set-profile changes the profile under the lock, keeps the old journal as .bak, and records the change', async () => {
  const r = repo([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await r.run('init', r.plan);
  const out = await r.run('set-profile', r.plan, '--profile', 'adaptive', '--reason', 'adopt adaptive width');
  assert.deepEqual([out.from, out.profile, out.changed, out.heavyRssMB, out.heavyRssFrom], ['balanced', 'adaptive', true, 2048, 'default']);
  const j = r.journal();
  assert.equal(j.profile, 'adaptive');
  assert.deepEqual(j.capacity, { samples: [], pressureEpisodes: [] });
  assert.deepEqual(j.profileChanges, [{ at: out.change.at, from: 'balanced', to: 'adaptive', reason: 'adopt adaptive width' }]);
  assert.equal(JSON.parse(readFileSync(r.jfile + '.bak', 'utf8')).profile, 'balanced', '.bak holds the journal before the change');
  assert.deepEqual((await r.next()).ids, ['1', '2', '3'], 'the next batch uses the new profile');
  const before = r.raw();
  const same = await r.run('set-profile', r.plan, '--profile', 'adaptive');
  assert.deepEqual([same.changed, r.raw()], [false, before], 'the same profile again writes nothing');
  await r.run('set-profile', r.plan, '--profile', 'economy');
  assert.deepEqual(r.journal().profileChanges!.map(c => `${c.from}>${c.to}`), ['balanced>adaptive', 'adaptive>economy']);
  const probes = r.probes(), e = await r.next();
  assert.deepEqual([e.ids, e.out.capacity, r.probes()], [['1'], undefined, probes], 'economy again: width 1, no probe');
  for (const [flags, want] of [
    [['--profile', 'warp'], /unknown profile "warp"; use economy, balanced, sprint, adaptive/],
    [[], /--profile is required/],
    [['--profile', 'sprint', '--heavy-rss-mb', '4096'], /adaptive profile only/],
    [['--profile', 'adaptive', '--heavy-rss-mb', '0'], /whole number of MB from 1 to/],
  ] as const) await assert.rejects(r.run('set-profile', r.plan, ...flags), want);
  assert.equal(r.journal().profile, 'economy', 'refused changes write nothing');
  const held = r.raw();
  writeFileSync(r.jfile + '.lock', String(process.pid));
  try {
    await assert.rejects(r.run('set-profile', r.plan, '--profile', 'sprint'), /locked by live pid/);
    assert.equal(r.raw(), held, 'a held lock leaves the journal byte-identical');
  } finally { unlinkSync(r.jfile + '.lock'); }
  const none = repo([{ n: 1 }]);
  await assert.rejects(none.run('set-profile', none.plan, '--profile', 'adaptive'), /no journal at .*; run init first/);
});

test('set-profile runs as a CLI command, and the usage text lists it', () => {
  const r = repo([{ n: 1 }]);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', AE, ...args], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(cli('init', 'plans/p.md').status, 0);
  const ok = cli('set-profile', 'plans/p.md', '--profile', 'adaptive');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).profile, 'adaptive');
  const bad = cli('set-profile', 'plans/p.md', '--profile', 'warp');
  assert.deepEqual([bad.status, bad.stdout], [1, '']);
  assert.match(bad.stderr, /^error: set-profile: unknown profile "warp"/);
  assert.match(cli().stderr, /commands: .*\bset-profile\b/);
});

// ---- slice 2: the engine reference and the skill README ----
test('engine.md documents set-profile and the adaptive profile; the README names them', () => {
  const skill = join(SCRIPTS, '..'), engine = readFileSync(join(skill, 'references/engine.md'), 'utf8'), readme = readFileSync(join(skill, 'README.md'), 'utf8');
  const rows = engine.split('\n').filter(l => l.startsWith('| `'));
  assert.ok(rows.some(l => l.startsWith('| `set-profile PLAN` | `--profile NAME` (required), `--heavy-rss-mb N`')), 'a set-profile row in the commands table');
  assert.match(rows.find(l => l.startsWith('| `init PLAN`'))!, /--profile economy\\\|balanced\\\|sprint\\\|adaptive`, `--heavy-rss-mb N` \(adaptive only\)/);
  assert.match(engine, /^\| adaptive \| No fixed number/m, 'an adaptive row in Profiles');
  const section = engine.slice(engine.indexOf('## Adaptive width'), engine.indexOf('## Attempt budget'));
  assert.ok(section.length > 1000, 'an Adaptive width section before the attempt budget');
  for (const want of ['kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', '"Swapouts"', '60 s', '2048 MB', '--heavy-rss-mb N', 'balanced width (2)', 'one heavy slice at a time', 'A review rejection does not count', 'os.freemem()', '### Limits'])
    assert.ok(section.includes(want), `the Adaptive width section names ${want}`);
  assert.match(readme, /with the adaptive profile/);
  assert.match(readme, /`ae set-profile PLAN --profile NAME`/);
});

// ---- recover ----
test('recover reads the probe for its next field on an adaptive journal and keeps no sample', async () => {
  const r = repo([...heavy(1), { n: 2 }]);
  await r.warm();
  const before = r.raw();
  r.read({ pressure: 'warn' });
  const rep = await r.run('recover', r.plan);
  assert.equal(rep.readOnly, true);
  assert.equal(rep.next.capacity.signals.pressure, 'warn');
  assert.deepEqual(rep.next.batch, ['2']);
  assert.deepEqual(rep.next.deferred, [{ id: '1', reason: 'heavy: memory pressure warn (load 3 on 10 CPUs)' }]);
  assert.equal(r.raw(), before, 'recover writes no sample and no episode');
  assert.equal((await r.run('recover', r.plan, '--apply')).next.capacity.signals.pressure, 'warn');
  assert.equal(r.raw(), before, 'recover --apply keeps no sample either: only ae next keeps one');
});
