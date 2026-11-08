// Slice 8 (plans/unified-agent-harness-master.md): identity, the lead lease, and the zombie gates.
// Accept 1 to 5, review-1 F4, F8, F10, F11, F15, and probes P1, P2, P5 (worst case). Every test uses its own temp repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { journalNonce, launchKeyFor, LEASE_TTL_S } from '../tools/agents/skills/autonomous-engineering/scripts/failover.ts';

const LEAD = 'Claude (opus/high)';
const TO = 'Claude (sonnet/high)';
const slice = (n: number) => [
  `### Slice ${n}: s${n}`, `- Goal: goal ${n}`, '- Model: Codex (gpt-6-astra/medium)', '- Review: Claude (opus/medium)', '- Fallback: Claude (opus/high)',
  '- Wave: 1 parallel', '- Depends on: none', `- Files: f${n}.txt`, '- Out of scope: src/',
  `- Accept: accept ${n}`, '- Verify: `true`', '- State: PLANNED', '- Evidence: none',
  `- [ ] do it · Codex (gpt-6-astra/medium) · Verify command passes · revert`, '',
].join('\n');
const planText = (n: number) => `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-08\nplanner: multi-agent-slice-planner\nmode: standard\n---\nSummary: test\n\n## Slices\n${Array.from({ length: n }, (_, i) => slice(i + 1)).join('\n')}\n## Open\n- none\n`;

function repo(slices = 1, base = Date.UTC(2026, 10, 8)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-identity-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, planText(slices));
  for (let i = 1; i <= slices; i++) writeFileSync(join(dir, `f${i}.txt`), 'start\n');
  let t = base;
  return {
    dir, plan,
    run: (...argv: string[]) => main(argv, { cwd: dir, now: () => new Date((t += 1000)) }) as Promise<any>,
    advance: (ms: number) => { t += ms; },
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    raw: () => readFileSync(journalPath(plan), 'utf8'),
    put: (rel: string, body: string) => writeFileSync(join(dir, rel), body),
  };
}
type R = ReturnType<typeof repo>;
// A lease held by L1 and slice 1 started under it.
async function leased(r: R) {
  await r.run('init', r.plan);
  await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
  await r.run('next', r.plan, '--lead-id', 'L1');
  return (await r.run('start', r.plan, '1', '--lead-id', 'L1')).launchKey as string;
}

// ---- Accept 1: scenario 8 ----
test('Accept 1 (scenario 8): a lead crash after launch and before attach makes no second child; a resend with the same key is found, not relaunched', async () => {
  const r = repo();
  const key = await leased(r);
  // the launch key is recorded at start, before delegate_task; then the lead "crashes"
  const rec = await r.run('recover', r.plan);
  assert.deepEqual(rec.unattached.map((u: any) => [u.slice, u.attempt, u.launchKey]), [['1', 1, key]]);
  assert.match(rec.unattached[0].next, /search T3 threads for .*Never relaunch blindly/);
  // a successor cannot open a second launch for the slice
  await assert.rejects(r.run('start', r.plan, '1', '--lead-id', 'L1'), /slice 1 is IN_PROGRESS/);
  // it finds the thread by the key and attaches it
  const a = await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X1');
  assert.equal(a.attached, 'bound');
  assert.equal((await r.run('recover', r.plan)).unattached, undefined, 'no launch without a task is left');
  // a resend with the same key: T3 returns the same task (P1), and the engine finds it
  const again = await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X1');
  assert.equal(again.attached, 'unchanged');
  assert.match(again.next, /found, not relaunched/);
  // a second child for the same launch is refused, and nothing is written
  const before = r.raw();
  await assert.rejects(r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T2'), /bound to thread T1; thread T2 would be a second child/);
  assert.equal(r.raw(), before);
  // a resend on the same thread makes a new task id (P2): an alias, and the next resend key
  const al = await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X2');
  assert.equal(al.attached, 'alias');
  assert.deepEqual(al.taskAliases, ['X2']);
  assert.equal(al.resendKey, `${key}/r2`);
  await assert.rejects(r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--task-id', 'X3'), /alias only on the bound thread/);
  await assert.rejects(r.run('attach', r.plan, '1', '--lead-id', 'L1', '--thread-id', 'T1'), /--launch-key .* is required/);
  const att = r.journal().slices['1'].attempts[0];
  assert.deepEqual([att.threadId, att.taskId, att.taskAliases], ['T1', 'X1', ['X2']]);
});

test('Accept 1: task aliases stop at 10', async () => {
  const r = repo();
  const key = await leased(r);
  await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X0');
  for (let i = 1; i <= 10; i++) await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', `X${i}`);
  await assert.rejects(r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X11'), /has 10 task aliases/);
});

// ---- Accept 2 and F10: event binding ----
test('Accept 2: events with a foreign launch key, thread id, or task id are refused; bound ids and aliases pass', async () => {
  const r = repo();
  const key = await leased(r);
  await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X1');
  await r.run('attach', r.plan, '1', '--lead-id', 'L1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X2');
  const before = r.raw();
  await assert.rejects(r.run('finish', r.plan, '1', '--lead-id', 'L1', '--launch-key', `${key.slice(0, -1)}7`), /finish refused: launch key .* matches no attempt/);
  await assert.rejects(r.run('finish', r.plan, '1', '--lead-id', 'L1', '--thread-id', 'T9'), /finish refused: thread T9 is not bound to slice 1/);
  await assert.rejects(r.run('fail', r.plan, '1', '--lead-id', 'L1', '--reason', 'x', '--task-id', 'X9'), /fail refused: task X9 is not bound to slice 1/);
  await assert.rejects(r.run('block', r.plan, '1', '--lead-id', 'L1', '--reason', 'x', '--thread-id', 'T9'), /block refused: thread T9/);
  assert.equal(r.raw(), before, 'nothing was written');
  const done = await r.run('finish', r.plan, '1', '--lead-id', 'L1', '--thread-id', 'T1', '--task-id', 'X2');
  assert.equal(done.state, 'AGENT_FINISHED');
});

test('Accept 2 and F10: with an open interruption, an outcome event with no identity is refused (no lease)', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  const key = (await r.run('start', r.plan, '1')).launchKey;
  assert.equal(key, 'ae:p#1/a1', 'no lease: the key is as before slice 8');
  await r.run('interrupt', r.plan, '1', '--class', 'api', '--source', 'lead', '--lead', LEAD);
  const before = r.raw();
  await assert.rejects(r.run('finish', r.plan, '1'), /finish refused: attempt 1 of slice 1 has an open interruption, and this event names no identity. Pass --launch-key ae:p#1\/a1/);
  await assert.rejects(r.run('fail', r.plan, '1', '--reason', 'x'), /fail refused: .*open interruption/);
  await assert.rejects(r.run('block', r.plan, '1', '--reason', 'x'), /block refused: .*open interruption/);
  assert.equal(r.raw(), before);
  // the lead's own post-mortem checkpoint still works without a key
  assert.equal((await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem')).checkpoint.role, 'lead');
  assert.equal((await r.run('finish', r.plan, '1', '--launch-key', key)).state, 'AGENT_FINISHED');
});

test('F10: under a lease, the holder\'s --lead-id is identity for an outcome event during an interruption', async () => {
  const r = repo();
  await leased(r);
  await r.run('interrupt', r.plan, '1', '--lead-id', 'L1', '--class', 'api', '--source', 'lead', '--lead', LEAD);
  assert.equal((await r.run('fail', r.plan, '1', '--lead-id', 'L1', '--reason', 'wrong result')).failures, 1);
});

// ---- Accept 3: scenario 10, the lease ----
test('Accept 3: claim stores the id; another id is refused; every write needs the holder; status stays free', async () => {
  const r = repo();
  await r.run('init', r.plan);
  const c = await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
  assert.equal(c.claimed, true);
  const l = r.journal().lead!;
  assert.deepEqual([l.id, l.label, l.ttlS, l.history.map(h => h.event)], ['L1', LEAD, LEASE_TTL_S, ['claim']]);
  assert.equal(LEASE_TTL_S, 7200);
  await assert.rejects(r.run('lead', r.plan, '--claim', '--lead-id', 'L2', '--label', 'Claude (sonnet/high)'), /lead --claim refused: the lease is held by L1 .*fresh until/);
  await assert.rejects(r.run('lead', r.plan, '--takeover', '--lead-id', 'L2', '--reason', 'r'), /--reason R and --observed .* are both required/);
  await assert.rejects(r.run('lead', r.plan, '1', '--claim', '--lead-id', 'L1', '--label', LEAD), /lead: takes no SLICE/);
  await assert.rejects(r.run('lead', r.plan, '--claim', '--lead-id', 'bad id', '--label', LEAD), /--lead-id "bad id" must be/);
  const before = r.raw();
  await assert.rejects(r.run('next', r.plan), /next refused: the lead lease is held by L1 .*every write needs --lead-id L1/);
  await assert.rejects(r.run('next', r.plan, '--lead-id', 'L2'), /next refused: .*--lead-id L2 is not the holder/);
  assert.equal(r.raw(), before, 'refused writes change nothing');
  assert.equal((await r.run('status', r.plan)).lease.id, 'L1', 'status needs no --lead-id and shows the lease');
  // a holder write renews the lease
  await r.run('next', r.plan, '--lead-id', 'L1');
  assert.ok(r.journal().lead!.renewedAt > l.renewedAt);
  // the same id claims again: a renewal, no new history row
  assert.equal((await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD)).renewed, true);
  assert.equal(r.journal().lead!.history.length, 1);
});

test('Accept 3 (scenario 10): a stale lease is taken over only with --takeover --reason --observed; the old lead\'s transfer and finish are refused', async () => {
  const r = repo();
  const key = await leased(r);
  await r.run('prepare', r.plan, '1', '--lead-id', 'L1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  await r.run('checkpoint', r.plan, '1', '--lead-id', 'L1');
  r.advance(LEASE_TTL_S * 1000 + 60_000);
  assert.equal((await r.run('lead', r.plan)).lease.stale, true);
  await assert.rejects(r.run('lead', r.plan, '--claim', '--lead-id', 'L2', '--label', TO), /lead --claim refused: .*stale.*ae lead --takeover/);
  const tk = await r.run('lead', r.plan, '--takeover', '--lead-id', 'L2', '--reason', 'predecessor context ran out', '--observed', 'thread L1 idle at 10:00Z');
  assert.equal(tk.takeover, true);
  assert.deepEqual(tk.from, { id: 'L1', label: LEAD, renewedAt: tk.from.renewedAt, stale: true });
  const l = r.journal().lead!;
  assert.deepEqual(l.history.map(h => `${h.event}:${h.id}`), ['claim:L1', 'takeover:L2']);
  assert.match(l.history[1].reason!, /predecessor context ran out; observed: thread L1 idle at 10:00Z; from L1 \(stale\)/);
  // an auto-resumed old lead: its transfer and its stale finish are refused, and nothing is written
  const before = r.raw();
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead-id', 'L1', '--lead', LEAD, '--disarmed', 'interrupted,cancel'), /transfer refused: the lead lease is held by L2.*--lead-id L1 is not the holder/);
  await assert.rejects(r.run('finish', r.plan, '1', '--lead-id', 'L1', '--launch-key', key), /finish refused: .*L1 is not the holder/);
  await assert.rejects(r.run('lead', r.plan, '--release', '--lead-id', 'L1'), /held by L2, not L1/);
  assert.equal(r.raw(), before);
  // the successor continues
  const tr = await r.run('transfer', r.plan, '1', '--lead-id', 'L2', '--lead', LEAD, '--disarmed', 'interrupted,cancel');
  assert.equal(tr.handoff.phase, 'TRANSFERRED');
});

test('Accept 3: a fresh lease is taken over with --takeover --reason --observed; release frees the journal', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
  const tk = await r.run('lead', r.plan, '--takeover', '--lead-id', 'L2', '--reason', 'successor', '--observed', 'L1 not running at 09:00Z', '--label', TO);
  assert.equal(tk.from.stale, false);
  assert.equal(r.journal().lead!.label, TO);
  const rel = await r.run('lead', r.plan, '--release', '--lead-id', 'L2');
  assert.equal(rel.released, true);
  assert.equal((await r.run('next', r.plan)).profile, 'balanced', 'a released lease asks for no --lead-id');
  assert.equal((await r.run('lead', r.plan, '--claim', '--lead-id', 'L3', '--label', LEAD)).claimed, true, 'anyone may claim a released lease');
  assert.deepEqual(r.journal().lead!.history.map(h => h.event), ['claim', 'takeover', 'release', 'claim']);
});

// ---- Accept 4 and F15: the zombie gate ----
test('Accept 4 and F15: a transfer away from a bound thread needs --disarmed; working and unknown values are refused', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  const key = (await r.run('start', r.plan, '1')).launchKey;
  await r.run('attach', r.plan, '1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X1');
  await r.run('prepare', r.plan, '1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  await r.run('checkpoint', r.plan, '1');
  const before = r.raw();
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD), /transfer refused: the old worker may resume .*--disarmed STATUS,METHOD/);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'working,cancel'), /task_status working means T3 is in a restart continuation/);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'pending,cancel'), /status "pending" is not terminal/);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'interrupted,hope'), /method "hope" is not one of/);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'interrupted,cancel,yesterday'), /read time "yesterday" is not an ISO time/);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'interrupted,cancel', '--mode', 'sideways'), /unknown --mode "sideways"/);
  assert.equal(r.raw(), before, 'refused transfers write nothing');
  const tr = await r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'interrupted,cancel,2026-11-08T08:30:00Z', '--mode', 'new');
  assert.equal(tr.handoff.phase, 'TRANSFERRED');
  const h = r.journal().slices['1'].handoffs![0];
  assert.deepEqual(h.disarmed, { status: 'interrupted', method: 'cancel', readAt: '2026-11-08T08:30:00.000Z' });
  assert.equal(h.mode, 'new');
  // the replaced worker's thread cannot be bound to the replacement
  await assert.rejects(r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a2', '--thread-id', 'T1'), /thread T1 belongs to attempt 1, which is handed-off; .*revive a replaced worker/);
  // and the replaced worker's thread and task are refused on events
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--thread-id', 'T1'), /checkpoint refused: thread T1 belongs to attempt 1, which is handed-off/);
  await assert.rejects(r.run('finish', r.plan, '1', '--task-id', 'X1'), /finish refused: task X1 belongs to attempt 1/);
});

test('Accept 4: with no lease and no bound thread, transfer works as before slice 8', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1');
  await r.run('prepare', r.plan, '1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  await r.run('checkpoint', r.plan, '1');
  const tr = await r.run('transfer', r.plan, '1', '--lead', LEAD);
  assert.equal(tr.handoff.phase, 'TRANSFERRED');
  assert.equal(r.journal().slices['1'].handoffs![0].disarmed, undefined);
});

test('Accept 4: under a lease, every transfer away needs --disarmed, even with no bound thread', async () => {
  const r = repo();
  await leased(r);
  await r.run('prepare', r.plan, '1', '--lead-id', 'L1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  await r.run('checkpoint', r.plan, '1', '--lead-id', 'L1');
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead-id', 'L1', '--lead', LEAD), /--disarmed STATUS,METHOD/);
  assert.equal((await r.run('transfer', r.plan, '1', '--lead-id', 'L1', '--lead', LEAD, '--disarmed', 'failed,cancel')).handoff.phase, 'TRANSFERRED');
});

test('Accept 4: attach re-checks the fingerprint against the transfer checkpoint', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  await r.run('start', r.plan, '1');
  await r.run('prepare', r.plan, '1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  await r.run('checkpoint', r.plan, '1');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  r.put('f1.txt', 'written after the checkpoint\n');
  const before = r.raw();
  await assert.rejects(r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a2', '--thread-id', 'T2'), /attach refused: slice 1 files changed after the checkpoint of the transfer .*The old worker may still be writing/);
  assert.equal(r.raw(), before);
  const a = await r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a2', '--thread-id', 'T2', '--observed', 'old task interrupted at 09:00Z; change is the new worker');
  assert.equal(a.attached, 'bound');
  const h = r.journal().slices['1'].handoffs![0];
  assert.equal(h.threadId, 'T2');
  assert.match(h.history.at(-1)!.note, /files changed since checkpoint .*lead observed: old task interrupted/);
});

test('Accept 4: a CLI worker is checked with pidAlive; a live one blocks the transfer even with --disarmed', async () => {
  const r = repo(2);
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  for (const id of ['1', '2']) await r.run('start', r.plan, id);
  const live = `cli:${process.pid}@${hostname()}`, dead = `cli:999999@${hostname()}`;
  await r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--thread-id', live);
  await r.run('attach', r.plan, '2', '--launch-key', 'ae:p#2/a1', '--thread-id', dead);
  const rec = await r.run('recover', r.plan);
  assert.deepEqual(rec.cliWorkers.map((w: any) => [w.slice, w.alive]), [['1', true], ['2', false]]);
  for (const id of ['1', '2']) {
    await r.run('prepare', r.plan, id, '--to', TO, '--lead', LEAD, '--reason', 'auth');
    await r.run('checkpoint', r.plan, id);
  }
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--disarmed', 'interrupted,exited'), /the CLI worker of attempt 1 .* is alive \(pidAlive\)/);
  assert.equal((await r.run('transfer', r.plan, '2', '--lead', LEAD, '--disarmed', 'interrupted,exited')).handoff.phase, 'TRANSFERRED');
  await assert.rejects(r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--thread-id', 'cli:5@h'), /bound to thread cli:/);
  await assert.rejects(r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--thread-id', 'cli:0@h'), /with a pid above 0/);
});

test('Accept 4: --mode resume-cross keeps the bound thread and needs no disarm; it needs a bound T3 thread', async () => {
  const r = repo(2);
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  for (const id of ['1', '2']) await r.run('start', r.plan, id);
  await r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--thread-id', 'T1');
  for (const id of ['1', '2']) {
    await r.run('prepare', r.plan, id, '--to', TO, '--lead', LEAD, '--reason', 'quota');
    await r.run('checkpoint', r.plan, id);
  }
  await assert.rejects(r.run('transfer', r.plan, '2', '--lead', LEAD, '--mode', 'resume-cross'), /resume-cross keeps the T3 thread of attempt 1, which has no bound thread/);
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--mode', 'resume-cross');
  const rec = r.journal().slices['1'];
  assert.equal(rec.attempts.at(-1)!.threadId, 'T1');
  assert.deepEqual([rec.handoffs![0].mode, rec.handoffs![0].threadId], ['resume-cross', 'T1']);
});

// ---- Accept 5: review-1 findings ----
test('F4: under a lease, launch keys carry a journal nonce, so two journals of the same plan name differ', async () => {
  const a = repo(1, Date.UTC(2026, 10, 8)), b = repo(1, Date.UTC(2026, 10, 9));
  const ka = await leased(a), kb = await leased(b);
  assert.match(ka, /^ae:p~[0-9a-f]{6}#1\/a1$/);
  assert.notEqual(ka, kb, 'same slug, slice, and attempt; different journals');
  assert.equal(ka, launchKeyFor('p', '1', 1, journalNonce(a.journal())));
  assert.equal(launchKeyFor('p', '1', 1), 'ae:p#1/a1', 'no nonce: the key as before slice 8');
  // the packet and the worker's checkpoint use the same key
  const w = await a.run('checkpoint', a.plan, '1', '--launch-key', ka, '--done', 'half');
  assert.equal(w.checkpoint.role, 'worker', 'a worker checkpoint needs no --lead-id');
});

test('F8: under a lease, a checkpoint without --launch-key or the holder\'s --lead-id cannot move a PREPARED handoff', async () => {
  const r = repo();
  const key = await leased(r);
  await r.run('prepare', r.plan, '1', '--lead-id', 'L1', '--to', TO, '--lead', LEAD, '--reason', 'quota');
  const before = r.raw();
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--done', 'x'), /checkpoint refused: the lead lease is held by L1/);
  await assert.rejects(r.run('checkpoint', r.plan, '1', '--launch-key', key, '--done', 'x'), /checkpoint refused: slice 1 has a PREPARED handoff; the worker stops/);
  assert.equal(r.raw(), before);
  assert.equal(r.journal().slices['1'].handoffs![0].phase, 'PREPARED');
  assert.equal((await r.run('checkpoint', r.plan, '1', '--lead-id', 'L1')).handoff.phase, 'CHECKPOINTED');
});

test('F11 (DEC-18): decide writes need the lease when one is held; lookups stay free', async () => {
  const r = repo();
  await r.run('init', r.plan);
  await r.run('lead', r.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
  const args = ['--key', 'store.kind', '--risk', 'green', '--status', 'assumed', '--question', 'which store?', '--answer', 'json', '--lead', LEAD];
  await assert.rejects(r.run('decide', r.plan, ...args), /decide refused: the lead lease is held by L1/);
  await assert.rejects(r.run('decide', r.plan, ...args, '--lead-id', 'L9'), /decide refused: .*L9 is not the holder/);
  assert.equal((await r.run('decide', r.plan, ...args, '--lead-id', 'L1')).created, true);
  assert.equal((await r.run('decide', r.plan, '--key', 'store.kind')).result, 'answered');
  assert.equal((await r.run('decisions', r.plan)).count, 1);
});

test('compatibility: a journal with no lease shows no lease section and keeps the old key', async () => {
  const r = repo();
  await r.run('init', r.plan);
  const st = await r.run('status', r.plan);
  assert.equal(st.lease, undefined);
  const rec = await r.run('recover', r.plan);
  assert.equal(rec.lease, undefined);
  assert.equal(rec.unattached, undefined);
  await r.run('next', r.plan);
  assert.equal((await r.run('start', r.plan, '1')).launchKey, 'ae:p#1/a1');
  assert.equal((await r.run('attach', r.plan, '1', '--launch-key', 'ae:p#1/a1', '--task-id', 'X1')).attached, 'bound');
  const att = r.journal().slices['1'].attempts[0];
  assert.equal(att.threadId, undefined, 'never null; absent');
  assert.ok(!r.raw().includes('null'), 'the journal holds no null');
});
