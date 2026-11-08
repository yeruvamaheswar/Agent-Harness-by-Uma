// Slice 9 (plans/unified-agent-harness-master.md): recovery options and authority. Accept 1 to 8, REQ-11, REQ-15,
// REQ-16, REQ-17, DEC-22, DEC-23, DEC-29, review-1 F17, probes P3-P6 (P5 and P6 worst case). Each test has its own repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Journal, SliceRecord } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import type { Interruption } from '../tools/agents/skills/autonomous-engineering/scripts/contract.ts';
import type { Slice } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';
import {
  CODE_CLASS, classForCode, isAuthorized, rankOptions, reviewerProblem, workFamilies,
} from '../tools/agents/skills/autonomous-engineering/scripts/options.ts';
import { familyOf, familyOfText, parseModelRef } from '../tools/agents/skills/autonomous-engineering/scripts/dispatch.ts';
import { assessAgent, DEFAULT_POLICY, parseSnapshot } from '../tools/agents/skills/autonomous-engineering/scripts/usage.ts';

const LEAD = 'Claude (opus/high)';
const MODEL = 'Codex (gpt-6.1-sol/medium)', FALLBACK = 'Codex (gpt-6-astra/medium)', REVIEW = 'Claude (opus/medium)';
const planText = (model = MODEL, fallback = FALLBACK, review = REVIEW) => [
  '---', 'kind: plan', 'title: t', 'status: active', 'updated: 2026-11-08', 'planner: multi-agent-slice-planner', 'mode: standard', '---', 'Summary: test', '',
  '## Slices', '### Slice 1: s1', '- Goal: goal 1', `- Model: ${model}`, `- Review: ${review}`, `- Fallback: ${fallback}`,
  '- Wave: 1 parallel', '- Depends on: none', '- Files: f1.txt', '- Out of scope: src/', '- Accept: accept 1', '- Verify: `true`', '- State: PLANNED', '- Evidence: none',
  `- [ ] do it · ${model} · Verify command passes · revert`, '', '## Open', '- none', '',
].join('\n');

function repo(text = planText()) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-options-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, text);
  writeFileSync(join(dir, 'f1.txt'), 'start\n');
  let t = Date.UTC(2026, 10, 8, 5);
  return {
    dir, plan,
    run: (...argv: string[]) => main(argv, { cwd: dir, now: () => new Date((t += 1000)) }) as Promise<any>,
    advance: (ms: number) => { t += ms; },
    now: () => new Date(t).toISOString(),
    journal: () => JSON.parse(readFileSync(journalPath(plan), 'utf8')) as Journal,
    raw: () => readFileSync(journalPath(plan), 'utf8'),
    put: (rel: string, body: string) => writeFileSync(join(dir, rel), body),
  };
}
type R = ReturnType<typeof repo>;
async function started(r: R, ...startFlags: string[]) {
  await r.run('init', r.plan);
  await r.run('next', r.plan);
  return (await r.run('start', r.plan, '1', ...startFlags)).launchKey as string;
}
const interrupt = (r: R, cls: string, ...more: string[]) => r.run('interrupt', r.plan, '1', '--class', cls, '--lead', LEAD, ...more);
// post-mortem, prepare, transfer: the open attempt moves to `to`
async function handOff(r: R, to: string) {
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  await r.run('prepare', r.plan, '1', '--to', to, '--lead', LEAD, '--reason', 'stopped');
  return r.run('transfer', r.plan, '1', '--lead', LEAD);
}
const approve = (r: R, ...more: string[]) => r.run('decide', r.plan, '1', '--key', 'provider-change', '--risk', 'red', '--status', 'approved',
  '--question', 'May slice 1 move to another provider?', '--answer', 'yes', '--source', 'user-cli', '--lead', LEAD, ...more);
const ns = (n: number[]) => n.join(',');
const stop = (cls: Interruption['class'], more: Partial<Interruption> = {}): Interruption => ({ at: '2026-11-08T05:00:00.000Z', class: cls, source: 'lead', fingerprint: 'fp', ...more });

// ---- Accept 1: the lead sets the class; one code table; free text maps to nothing; permission_error is a refusal ----
test('Accept 1: exact provider codes map through one table; free text maps to nothing; permission_error maps to refusal', () => {
  assert.equal(classForCode('permission_error'), 'refusal', 'DEC-29');
  assert.equal(classForCode(' Usage_Limit_Reached '), 'quota', 'case and outer spaces are ignored');
  assert.equal(classForCode('api_error'), 'api');
  assert.equal(classForCode('authentication_error'), 'auth');
  assert.equal(classForCode('context_length_exceeded'), 'context');
  // the free text T3 gives (probe P4) is never classified
  for (const text of ['The ChatGPT user has reached their Subscription Sharing usage limit', 'HTTP 429', 'usage limit reached', 'Provider retry', 'constructor', '']) {
    assert.equal(classForCode(text), undefined, text);
  }
  assert.equal(classForCode(undefined), undefined);
  // usage.ts reads the same table: a limit code sets its limit, a code of another class sets none
  assert.equal(assessAgent('Codex', parseSnapshot({ agents: { Codex: { code: 'rate_limit_error' } } }).agents.Codex, DEFAULT_POLICY).level, 'exhausted');
  const refusal = parseSnapshot({ agents: { Codex: { code: 'permission_error' } } });
  assert.deepEqual(refusal.agents.Codex.limits, [], 'a refusal is no usage limit');
  assert.equal(refusal.ignored.length, 1);
  for (const [code, cls] of CODE_CLASS) assert.equal(classForCode(code.toUpperCase()), cls, code);
});

test('Accept 1: the lead sets the class at interrupt; a table code that contradicts it is refused; free text keeps the lead class', async () => {
  const r = repo();
  await started(r);
  const before = r.raw();
  await assert.rejects(interrupt(r, 'unknown', '--code', 'permission_error'), /code permission_error maps to class refusal .*DEC-29.*Pass --class refusal/);
  await assert.rejects(interrupt(r, 'api', '--code', 'usage_limit_reached'), /maps to class quota/);
  await assert.rejects(r.run('interrupt', r.plan, '1', '--code', 'permission_error', '--lead', LEAD), /--class is required/, 'the code never sets the class by itself');
  assert.equal(r.raw(), before, 'nothing was written');
  // free text in --code maps to nothing: the lead's class stands
  const out = await interrupt(r, 'api', '--code', 'Provider retry: upstream hiccup', '--source', 't3');
  assert.equal(out.interruption.class, 'api');
  assert.equal(out.state, 'IN_PROGRESS');
  // a matching table code is accepted
  const q = await interrupt(r, 'quota', '--code', 'usage_limit_reached', '--source', 'cli', '--reset-at', '2026-11-08T08:21:00Z');
  assert.deepEqual([q.interruption.class, q.interruption.code, q.interruption.resetAt], ['quota', 'usage_limit_reached', '2026-11-08T08:21:00.000Z']);
});

// ---- Accept 2: ranking ----
test('Accept 2: quota with a reset of 60 minutes or less ranks wait first; over 60, after the deadline, or unknown, it does not', () => {
  const slice = { id: '1', model: MODEL, fallback: FALLBACK };
  const soon = rankOptions({ slice, current: MODEL, i: stop('quota', { resetAt: '2026-11-08T05:45:00.000Z' }), threadId: 'T1' });
  assert.equal(ns(soon.options.map(o => o.n)), '1,4,5');
  assert.match(soon.options[0].when, /45 minutes away/);
  // option 2 is never ranked: auto-resume may still own the thread (P5, P6 worst case)
  assert.match(soon.excluded.find(x => x.n === 2)!.reason, /auto-resume may still own the thread/);
  assert.match(soon.excluded.find(x => x.n === 3)!.reason, /shares the account limit/);
  // option 4 and 5 name only other agents: the Fallback is Codex and shares the account
  assert.ok(soon.options[1].candidates!.every(c => !c.startsWith('Codex')), soon.options[1].candidates!.join());
  const exact = rankOptions({ slice, current: MODEL, i: stop('quota', { resetAt: '2026-11-08T06:00:00.000Z' }) });
  assert.equal(exact.options[0].n, 1, 'exactly 60 minutes waits');
  const late = rankOptions({ slice, current: MODEL, i: stop('quota', { resetAt: '2026-11-08T08:21:00.000Z' }), threadId: 'T1' });
  assert.equal(ns(late.options.map(o => o.n)), '4,5');
  assert.match(late.excluded.find(x => x.n === 1)!.reason, /201 minutes away, over 60/);
  const deadline = rankOptions({ slice, current: MODEL, i: stop('quota', { resetAt: '2026-11-08T05:30:00.000Z' }), deadline: '2026-11-08T05:20:00.000Z' });
  assert.match(deadline.excluded.find(x => x.n === 1)!.reason, /not before the charter deadline/);
  const unknown = rankOptions({ slice, current: MODEL, i: stop('quota') });
  assert.match(unknown.excluded.find(x => x.n === 1)!.reason, /no reset time was observed/);
  assert.match(unknown.excluded.find(x => x.n === 4)!.reason, /no T3 thread is bound/);
  assert.equal(ns(unknown.options.map(o => o.n)), '5');
});

test('Accept 2: api and auth rank the same thread, then the CLI, then another provider; context ranks a fresh session of the same agent first', () => {
  const slice = { id: '1', model: MODEL, fallback: FALLBACK };
  for (const cls of ['api', 'auth'] as const) {
    const r = rankOptions({ slice, current: MODEL, i: stop(cls), threadId: 'T1' });
    assert.equal(ns(r.options.map(o => o.n)), '2,3,5', cls);
    assert.deepEqual(r.options[1].candidates, [MODEL], `${cls}: the same agent's CLI`);
    assert.equal(r.options[1].identity, 'handoff cli');
    assert.ok(r.options[2].candidates!.length && r.options[2].candidates!.every(c => !c.startsWith('Codex')), `${cls}: another provider`);
  }
  const ctx = rankOptions({ slice, current: MODEL, i: stop('context'), threadId: 'T1' });
  assert.equal(ns(ctx.options.map(o => o.n)), '5');
  assert.equal(ctx.options[0].candidates![0], 'Codex (gpt-6.1-sol/medium, fresh session)');
  const rate = rankOptions({ slice, current: MODEL, i: stop('rate'), threadId: 'T1' });
  assert.equal(ns(rate.options.map(o => o.n)), '2,4,5');
  assert.equal(ns(rankOptions({ slice, current: MODEL, i: stop('process') }).options.map(o => o.n)), '2,5');
  // a CLI worker has no T3 thread to keep
  assert.match(rankOptions({ slice, current: MODEL, i: stop('rate'), threadId: 'cli:42@host' }).excluded.find(x => x.n === 4)!.reason, /CLI process/);
});

test('Accept 2: interrupt and recover show the ranked options for the open interruption', async () => {
  const r = repo();
  const key = await started(r);
  await r.run('attach', r.plan, '1', '--launch-key', key, '--thread-id', 'T1', '--task-id', 'X1');
  const out = await interrupt(r, 'quota', '--source', 'cli', '--reset-at', new Date(Date.parse(r.now()) + 30 * 60000).toISOString());
  assert.equal(ns(out.recovery.options.map((o: any) => o.n)), '1,4,5');
  assert.match(out.recovery.decidedBy, /Claude lead/);
  const rec = await r.run('recover', r.plan);
  assert.deepEqual(rec.recovery.map((x: any) => [x.slice, x.class, x.options[0].n]), [['1', 'quota', 1]]);
});

// ---- Accept 3: authorization ----
test('Accept 3: an agent not in Model, Fallback, or the pool is refused', async () => {
  const r = repo();
  await started(r);
  await interrupt(r, 'quota');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  const before = r.raw();
  for (const to of ['Antigravity (gemini-3.8-flash-low)', 'Claude (haiku/low)', 'Codex (gpt-5/high)']) {
    await assert.rejects(r.run('prepare', r.plan, '1', '--to', to, '--lead', LEAD, '--reason', 'r'), /is not authorized for slice 1.*REQ-15/, to);
  }
  assert.equal(r.raw(), before, 'nothing was written');
  // the Fallback, an escalation of the Model, and a pool entry qualify
  for (const to of [FALLBACK, 'Codex (gpt-6.1-sol/high)', 'Cursor (auto)']) {
    assert.equal((await r.run('prepare', r.plan, '1', '--to', to, '--lead', LEAD, '--reason', 'r')).handoff.to, to, to);
  }
  // a pool approved in the policy file qualifies too, the same file `ae usage` ranks with
  r.put('policy.json', JSON.stringify({ pool: ['Claude (haiku/high)'] }));
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Claude (haiku/high)', '--lead', LEAD, '--reason', 'r'), /not authorized/);
  assert.equal((await r.run('prepare', r.plan, '1', '--to', 'Claude (haiku/high)', '--lead', LEAD, '--reason', 'r', '--policy', 'policy.json')).handoff.to, 'Claude (haiku/high)');
  // unit: extras do not change the model
  const s = { id: '1', model: MODEL, fallback: FALLBACK, review: REVIEW } as Slice, rec = { attempts: [] } as unknown as SliceRecord;
  assert.ok(isAuthorized('Codex (gpt-6.1-sol/medium, fresh session)', s, rec, DEFAULT_POLICY.pool));
  assert.ok(!isAuthorized('Grok (default)', s, rec, DEFAULT_POLICY.pool));
});

// ---- Accept 4 and 8 (review-1 F17): a refusal blocks; another provider needs an approved provider-change ----
test('Accept 4 and 8: a refusal gives BLOCKED; only an approved provider-change decision unblocks it to another provider', async () => {
  const r = repo();
  await started(r);
  const out = await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  assert.equal(out.state, 'BLOCKED');
  assert.equal(out.blocked.cause, 'refusal');
  assert.match(out.blocked.reason, /refusal by Codex \(gpt-6\.1-sol\/medium\) \(permission_error\).*provider-change.*DEC-22/);
  assert.equal(out.failures, 0, 'not a failed attempt');
  assert.equal(out.recovery.block, out.blocked.reason);
  assert.deepEqual(out.recovery.options, [], 'a refusal has no recovery option');
  let j = r.journal().slices['1'];
  assert.deepEqual([j.blocker!.cause, j.attempts[0].outcome], ['refusal', 'blocked']);
  // the same worker may continue after the user's answer (no provider switch)
  assert.equal((await r.run('unblock', r.plan, '1', '--reason', 'the user reworded the task')).to, 'IN_PROGRESS');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  // another provider is refused, nothing is written
  const before = r.raw();
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', LEAD, '--lead', LEAD, '--reason', 'switch'), /refused slice 1 .*approved RED decision provider-change for slice:1.*DEC-22/);
  assert.equal(r.raw(), before);
  // the same provider (the Fallback is Codex) needs no decision
  assert.equal((await r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'same provider')).handoff.to, FALLBACK);
  // a proposed decision is not enough; an approved one is
  await r.run('decide', r.plan, '1', '--key', 'provider-change', '--risk', 'red', '--question', 'May slice 1 move to another provider?', '--lead', LEAD);
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', LEAD, '--lead', LEAD, '--reason', 'switch'), /provider-change/);
  await r.run('decide', r.plan, '1', '--key', 'provider-change', '--status', 'approved', '--answer', 'yes, Claude', '--source', 'user-cli', '--lead', LEAD);
  assert.equal((await r.run('prepare', r.plan, '1', '--to', LEAD, '--lead', LEAD, '--reason', 'approved switch')).handoff.to, LEAD);
  await r.run('checkpoint', r.plan, '1', '--kind', 'pre-handoff');
  // the claim step checks again: a revoked approval stops the transfer
  await r.run('decide', r.plan, '1', '--key', 'provider-change', '--status', 'blocked', '--source', 'user-cli', '--lead', LEAD);
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD), /transfer refused: .*provider-change/);
  j = r.journal().slices['1'];
  assert.equal(j.handoffs!.at(-1)!.phase, 'CHECKPOINTED', 'ownership did not move');
});

test('Accept 4 and 8: an approval from before a refusal does not cover a later refusal', async () => {
  const r = repo();
  await started(r);
  await interrupt(r, 'refusal');
  await r.run('unblock', r.plan, '1', '--reason', 'the user approved a switch');
  const d1 = (await approve(r)).decision.id;
  assert.equal((await handOff(r, LEAD)).handoff.to, LEAD);
  // Claude now refuses too: the old approval predates this refusal
  assert.equal((await interrupt(r, 'refusal')).state, 'BLOCKED');
  await r.run('unblock', r.plan, '1', '--reason', 'retry');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'r'), /Claude \(opus\/high\) refused slice 1/);
  await approve(r, '--supersedes', d1);
  assert.equal((await r.run('prepare', r.plan, '1', '--to', 'Cursor (auto)', '--lead', LEAD, '--reason', 'r')).handoff.to, 'Cursor (auto)');
});

// ---- Accept 5: scenario 5 ----
test('Accept 5 (scenario 5): A to B to C keeps both interruptions; three stops with no fingerprint progress give BLOCKED with one escalation line', async () => {
  const r = repo();
  await started(r);
  await interrupt(r, 'quota', '--code', 'usage_limit_reached');
  await handOff(r, LEAD); // A (Codex) -> B (Claude)
  await interrupt(r, 'rate');
  await handOff(r, 'Cursor (auto)'); // B -> C
  const out = await interrupt(r, 'api');
  assert.equal(out.state, 'BLOCKED');
  assert.equal(out.blocked.cause, 'no-progress');
  assert.equal(out.blocked.reason.split('\n').length, 1, 'one escalation line');
  assert.match(out.blocked.reason, /^escalate: 3 stops in a row with no fingerprint progress/);
  assert.equal(out.failures, 0);
  const a = r.journal().slices['1'].attempts;
  assert.deepEqual(a.map(x => [x.n, x.outcome, (x.interruptions ?? []).map(i => `${i.class}:${i.resolved ?? 'open'}`).join()]), [
    [1, 'handed-off', 'quota:handed-off'], [2, 'handed-off', 'rate:handed-off'], [3, 'blocked', 'api:open'],
  ], 'A and B keep their interruptions');
  // after unblock the count starts again
  await r.run('unblock', r.plan, '1', '--reason', 'the user gave the missing fact');
  assert.equal((await interrupt(r, 'api')).state, 'IN_PROGRESS');
});

test('Accept 5: a stop after fingerprint progress does not count toward the cap', async () => {
  const r = repo();
  await started(r);
  await interrupt(r, 'tool');
  await interrupt(r, 'tool');
  r.put('f1.txt', 'progress\n');
  assert.equal((await interrupt(r, 'tool')).state, 'IN_PROGRESS', 'the files moved');
  await interrupt(r, 'tool');
  assert.equal((await interrupt(r, 'tool')).state, 'BLOCKED', 'three stops at the new fingerprint');
});

// ---- Accept 6: reviewer families (REQ-17) ----
test('Accept 6: a reviewer from a family with a work attempt is refused without --exception; the exception is recorded', async () => {
  const r = repo();
  await started(r, '--provider', 'codex', '--model', 'gpt-6.1-sol');
  await interrupt(r, 'quota');
  await handOff(r, LEAD); // a Claude work attempt
  await r.run('finish', r.plan, '1');
  const before = r.raw();
  await assert.rejects(r.run('review', r.plan, '1', '--by', REVIEW, '--note', 'ok'), /review refused: the reviewer's family Claude .*work attempt 2 \(Claude \(opus\/high\)\).*--exception/);
  await assert.rejects(r.run('review', r.plan, '1', '--by', 'rev', '--model', 'gpt-6.1-sol', '--note', 'ok'), /family OpenAI .*work attempt 1/);
  await assert.rejects(r.run('review', r.plan, '1', '--by', 'Cursor (auto)', '--note', 'ok'), /model family is unknown/);
  assert.equal(r.raw(), before, 'nothing was written');
  const ok = await r.run('review', r.plan, '1', '--by', REVIEW, '--note', 'diff read', '--exception', 'only Claude has quota; a fresh session');
  assert.equal(ok.to, 'REVIEWED');
  assert.equal(ok.reviewerException.reason, 'only Claude has quota; a fresh session');
  assert.match(r.journal().slices['1'].attempts.at(-1)!.reason!, /^reviewer family exception: only Claude has quota/);
});

test('Accept 6: another family, a person, or an exception passes; an unknown builder family needs an exception; a lease checks the Review line', async () => {
  const r = repo();
  await started(r);
  await r.run('finish', r.plan, '1');
  assert.equal((await r.run('review', r.plan, '1', '--by', 'Antigravity (gemini-3-pro)', '--note', 'ok')).to, 'REVIEWED', 'Gemini did not build it');
  // unit rules
  const s = { id: '1', model: 'Cursor (auto)', fallback: '', review: REVIEW } as Slice;
  const rec = { attempts: [{ n: 1, kind: 'work', at: 'x' }] } as unknown as SliceRecord;
  assert.match(reviewerProblem({ family: 'Claude', from: '--by' }, workFamilies(s, rec), '1')!, /no known model family/);
  assert.equal(reviewerProblem({ family: 'human', from: '--by user' }, workFamilies(s, rec), '1'), undefined, 'a person is independent');
  assert.deepEqual(['Claude (opus/high)', 'Codex (auto)', 'Antigravity (gemini-3.8-flash-low)', 'Grok (default)', 'Cursor (auto)', 'user'].map(x => familyOf(parseModelRef(x))),
    ['Claude', 'OpenAI', 'Gemini', 'Grok', undefined, 'human']);
  assert.equal(familyOfText('claude-sonnet-5-5'), 'Claude');
  // under a lead lease a review that names no model is checked against the slice's Review line
  const l = repo(planText('Claude (sonnet/high)', 'Claude (opus/high)', REVIEW));
  await l.run('init', l.plan);
  await l.run('lead', l.plan, '--claim', '--lead-id', 'L1', '--label', LEAD);
  await l.run('next', l.plan, '--lead-id', 'L1');
  const key = (await l.run('start', l.plan, '1', '--lead-id', 'L1')).launchKey;
  await l.run('finish', l.plan, '1', '--launch-key', key, '--lead-id', 'L1');
  await assert.rejects(l.run('review', l.plan, '1', '--by', 'rev', '--note', 'ok', '--lead-id', 'L1'), /the slice's Review line \(Claude \(opus\/medium\)\)/);
  assert.equal((await l.run('review', l.plan, '1', '--by', 'rev', '--model', 'gpt-6.1-sol', '--note', 'ok', '--lead-id', 'L1')).to, 'REVIEWED');
});

// ---- Accept 7: nothing switches back by itself ----
test('Accept 7: no automatic switch back: after A resets, the replacement keeps the slice and A appears only as a lead choice', async () => {
  const r = repo();
  await started(r);
  const reset = new Date(Date.parse(r.now()) + 30 * 60000).toISOString();
  const first = await interrupt(r, 'quota', '--reset-at', reset);
  assert.match(first.recovery.switchBack, /never automatic/);
  await handOff(r, LEAD); // the lead chose not to wait
  r.advance(3 * 60 * 60000); // A's reset has passed
  const rec = await r.run('recover', r.plan);
  assert.equal(rec.recovery, undefined, "A's interruption is handed off: no option to resume A");
  const st = await r.run('status', r.plan);
  assert.equal(st.slices[0].handoff.to, LEAD);
  const j = r.journal().slices['1'];
  assert.equal(j.attempts.filter(a => !a.outcome).length, 1);
  assert.equal(j.handoffs!.length, 1, 'no second handoff was made');
  // when B stops, the options are for B; going back to Codex is a candidate the lead may pick, never a step the engine takes
  const b = await interrupt(r, 'quota', '--reset-at', new Date(Date.parse(r.now()) + 10 * 60000).toISOString());
  assert.equal(b.recovery.current, LEAD);
  assert.equal(b.recovery.options[0].n, 1, "wait for B's own reset first");
  assert.equal(r.journal().slices['1'].handoffs!.length, 1);
});

test('Accept 1 and 2: the class sets no switch: an option is a ranked list for the lead, and the open attempt stays open', async () => {
  const r = repo();
  await started(r);
  for (const cls of ['api', 'auth', 'process', 'unknown']) {
    r.put('f1.txt', `work before the ${cls} stop\n`); // progress, so the no-progress cap stays out of this test
    const out = await interrupt(r, cls);
    assert.equal(out.state, 'IN_PROGRESS', cls);
    assert.equal(out.recovery.options[0].n, 2, `${cls}: the same thread first`);
    if (cls === 'unknown') assert.ok(out.recovery.options.at(-1).candidates.every((c: string) => !c.startsWith('Codex')), 'unknown: only another agent');
  }
  assert.equal(r.journal().slices['1'].attempts.length, 1, 'no attempt was opened by the engine');
});

// Slice 15 whole-branch review F4: the continuation names the worker that really ran, not the slice's planned Model.
test('S15 F4: a substituted worker is named as the worker; the planned Model is a valid replacement, not "the current worker"', async () => {
  const r = repo();
  await started(r, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  await interrupt(r, 'quota');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  // the real worker is Claude sonnet: naming it as the replacement is "the current worker"
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', 'Claude (sonnet/high)', '--lead', LEAD, '--reason', 'r'), /is the current worker/);
  // the plan's Model (Codex) is not the current worker: it is allowed
  const p = await r.run('prepare', r.plan, '1', '--to', MODEL, '--lead', LEAD, '--reason', 'quota');
  assert.equal(p.handoff.from.label, 'Claude (sonnet/high)');
  await r.run('transfer', r.plan, '1', '--lead', LEAD);
  const h = await r.run('handoff', r.plan, '1');
  assert.match(h.text, /you take over slice 1 from Claude \(sonnet\/high\)/);
  assert.doesNotMatch(h.text, /take over slice 1 from Codex/);
});
test('S15 F4: without a recorded provider and model the label stays the slice Model (no change)', async () => {
  const r = repo();
  await started(r);
  await interrupt(r, 'quota');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  const p = await r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'quota');
  assert.equal(p.handoff.from.label, MODEL);
});

// Slice 15 fix-round review (Codex) R1 and R2.
test('S15 R1: a refusal by a substituted worker names that worker; moving to another provider needs the provider-change decision', async () => {
  const r = repo();
  await started(r, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  const out = await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  assert.match(out.blocked.reason, /refusal by Claude \(sonnet\/high\)/, 'not the planned Codex model');
  await r.run('unblock', r.plan, '1', '--reason', 'the user reworded the task');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  const before = r.raw();
  // the planned Fallback is Codex: another provider than the Claude worker that refused
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /Claude \(sonnet\/high\) refused slice 1 .*provider-change/);
  assert.equal(r.raw(), before, 'nothing was written');
  // the same provider as the refusing worker needs no decision
  assert.equal((await r.run('prepare', r.plan, '1', '--to', LEAD, '--lead', LEAD, '--reason', 'same provider')).handoff.to, LEAD);
});
test('S15 R2: recovery never recommends a label the slice may not use (a substituted worker is no new candidate)', async () => {
  const r = repo();
  await started(r, '--provider', 'codex', '--model', 'gpt-6.1-terra', '--effort', 'medium');
  const out = await interrupt(r, 'context', '--source', 't3');
  assert.equal(out.recovery.current, 'Codex (gpt-6.1-terra/medium)');
  const all = out.recovery.options.flatMap((o: any) => o.candidates ?? []);
  assert.ok(all.length > 0, 'some authorized candidate remains');
  assert.ok(all.every((c: string) => !/gpt-6\.1-terra/.test(c)), all.join());
});

// Slice 15 fix review 2 (Codex) R1a, R1b, R2.
const approveProviderChange = async (r: R) => {
  await r.run('decide', r.plan, '1', '--key', 'provider-change', '--risk', 'red', '--question', 'May slice 1 move to another provider?', '--lead', LEAD);
  await r.run('decide', r.plan, '1', '--key', 'provider-change', '--status', 'approved', '--answer', 'yes', '--source', 'user-cli', '--lead', LEAD);
};
test('S15 R1a: a transfer whose launch flags name another provider than the handoff target is refused; nothing is written', async () => {
  const r = repo();
  await started(r, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r.run('unblock', r.plan, '1', '--reason', 'reworded');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  await approveProviderChange(r);
  await r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'approved switch');
  await r.run('checkpoint', r.plan, '1', '--kind', 'pre-handoff');
  const before = r.raw();
  await assert.rejects(r.run('transfer', r.plan, '1', '--lead', LEAD, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high'), /launch flags name Claude, but the handoff target is Codex/);
  assert.equal(r.raw(), before);
  // the matching launch works
  await r.run('transfer', r.plan, '1', '--lead', LEAD, '--provider', 'codex', '--model', 'gpt-6-astra', '--effort', 'medium');
});
test('S15 R1b: a Cursor worker that refuses is not mistaken for the planned Codex agent', async () => {
  const r = repo();
  await started(r, '--provider', 'cursor', '--model', 'auto');
  await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r.run('unblock', r.plan, '1', '--reason', 'reworded');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /provider-change/);
  // an unknown provider text fails closed too
  const r2 = repo();
  await started(r2, '--provider', 'somethingnew', '--model', 'x');
  await interrupt(r2, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r2.run('unblock', r2.plan, '1', '--reason', 'reworded');
  await r2.run('checkpoint', r2.plan, '1', '--kind', 'post-mortem');
  await assert.rejects(r2.run('prepare', r2.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /provider-change/);
});
test('S15 R2: recovery after an interrupt uses the --policy pool, as prepare does', async () => {
  const r = repo();
  r.put('policy.json', JSON.stringify({ pool: [] }));
  await started(r);
  const out = await interrupt(r, 'context', '--source', 't3', '--policy', 'policy.json');
  const all = out.recovery.options.flatMap((o: any) => o.candidates ?? []);
  assert.ok(all.every((c: string) => !/^Claude \(opus\/high\)/.test(c)), all.join());
});

// Slice 15 fix review 3 (Codex) R1 to R4 and R6.
async function refusedThenUnblocked(r: R, ...startFlags: string[]) {
  await started(r, ...startFlags);
  await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r.run('unblock', r.plan, '1', '--reason', 'reworded');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
}
test('S15 R1: a worker that recorded only a model is attributed by its model family', async () => {
  const r = repo();
  await refusedThenUnblocked(r, '--model', 'claude-sonnet-5-5');
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /provider-change/);
  const r2 = repo();
  await refusedThenUnblocked(r2, '--model', 'some-unknown-model');
  await assert.rejects(r2.run('prepare', r2.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /provider-change/, 'an unknown model fails closed');
});
test('S15 R2: the worker that continues after unblock keeps its identity, so a second refusal is not blamed on the planned agent', async () => {
  const r = repo();
  await refusedThenUnblocked(r, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  const a = r.journal().slices['1'].attempts.filter(x => x.kind === 'work');
  assert.deepEqual([a[1].provider, a[1].model, a[1].effort], ['claudeAgent', 'claude-sonnet-5-5', 'high']);
  await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r.run('unblock', r.plan, '1', '--reason', 'reworded again');
  await r.run('checkpoint', r.plan, '1', '--kind', 'post-mortem');
  await assert.rejects(r.run('prepare', r.plan, '1', '--to', FALLBACK, '--lead', LEAD, '--reason', 'switch'), /Claude \(sonnet\/high\) refused slice 1 .*provider-change/);
});
test('S15 R3: block and fail refuse a refusal class; only interrupt records one', async () => {
  const r = repo();
  await started(r);
  const before = r.raw();
  await assert.rejects(r.run('block', r.plan, '1', '--reason', 'x', '--class', 'refusal', '--code', 'permission_error'), /ae interrupt --class refusal/);
  await assert.rejects(r.run('fail', r.plan, '1', '--reason', 'x', '--code', 'permission_error'), /ae interrupt --class refusal/);
  assert.equal(r.raw(), before);
});
test('S15 R4: after a refusal, a start with another provider needs the provider-change decision', async () => {
  const r = repo();
  await started(r, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--effort', 'high');
  await interrupt(r, 'refusal', '--code', 'permission_error', '--source', 't3');
  await r.run('unblock', r.plan, '1', '--reason', 'reworded');
  await r.run('fail', r.plan, '1', '--reason', 'tests failed');
  const before = r.raw();
  await assert.rejects(r.run('start', r.plan, '1', '--provider', 'OpenAI', '--model', 'gpt-6.1-terra'), /start refused: .* provider switch and needs an approved RED decision provider-change/);
  assert.equal(r.raw(), before);
  // the same provider, and a launch after the user approved, work
  await r.run('start', r.plan, '1', '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5');
});
test('S15 R6: api recovery does not recommend the CLI of a current worker that is not an authorized label', async () => {
  const r = repo();
  await started(r, '--provider', 'codex', '--model', 'gpt-6.1-terra', '--effort', 'medium');
  const out = await interrupt(r, 'api', '--source', 't3');
  assert.ok(!out.recovery.options.some((o: any) => o.n === 3), JSON.stringify(out.recovery.options.map((o: any) => o.n)));
  assert.match(out.recovery.excluded.find((x: any) => x.n === 3).reason, /not an authorized label/);
});
