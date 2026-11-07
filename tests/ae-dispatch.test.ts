import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRef, resolveTarget, escalate, chooseTarget, intensity } from '../tools/agents/skills/autonomous-engineering/scripts/dispatch.ts';
import type { Caps, Target, Unavailable } from '../tools/agents/skills/autonomous-engineering/scripts/dispatch.ts';

// Trimmed from a real T3 orchestrator_capabilities output, 2026-10-25.
const eff = (values: string[], d: string) => [{ id: 'effort', values, default: d }];
const caps = (): Caps => ({ providers: [
  { providerInstanceId: 'codex', driverKind: 'codex', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol', options: [{ id: 'reasoningEffort', values: ['low', 'medium', 'high'] }] }], canRunChildTask: true, constraints: [] },
  { providerInstanceId: 'claudeAgent', driverKind: 'claudeAgent', models: [
    { id: 'claude-opus-5-5', options: [...eff(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), { id: 'fastMode', values: [false, true] }] },
    { id: 'claude-sonnet-5-5', options: eff(['low', 'medium', 'high', 'xhigh', 'max'], 'high') },
    { id: 'claude-haiku-5-5', options: eff(['low', 'medium', 'high'], 'medium') },
  ], canRunChildTask: true, constraints: [] },
  { providerInstanceId: 'cursor', driverKind: 'cursor', models: [{ id: 'default', label: 'Auto' }, { id: 'grok-4.7' }], canRunChildTask: true, constraints: [] },
  { providerInstanceId: 'grok', driverKind: 'grok', models: [{ id: 'grok-4.7' }], canRunChildTask: true, constraints: [] },
  { providerInstanceId: 'antigravity', driverKind: 'antigravity', models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.8-flash-high' }], canRunChildTask: true, constraints: [] },
  { providerInstanceId: 'opencode', driverKind: 'opencode', models: [], canRunChildTask: false, constraints: ['Provider instance is disabled.'] },
] });
const t3 = { caps: caps(), host: 't3' };
const res = (text: string, o = t3) => resolveTarget(parseModelRef(text), o) as Target;

test('parseModelRef: every contract form', () => {
  assert.deepEqual(parseModelRef('Claude (opus/high)'), { agent: 'Claude', mode: 'tier', tier: 'opus', effort: 'high', extras: [], label: 'Claude (opus/high)' });
  assert.deepEqual(parseModelRef('Claude (opus/high, fresh session)').extras, ['fresh session']);
  assert.equal(parseModelRef('Codex (auto)').mode, 'auto');
  assert.equal(parseModelRef('Cursor (auto)').mode, 'auto');
  assert.equal(parseModelRef('Grok (default)').mode, 'default');
  const u = parseModelRef('Codex (gpt-x, unverified)');
  assert.equal(u.modelId, 'gpt-x'); assert.equal(u.unverified, true);
  assert.equal(parseModelRef('user').agent, 'user');
  assert.equal(parseModelRef('CI').agent, 'CI');
  assert.throws(() => parseModelRef('Gemini (pro)'), /Cannot parse model text "Gemini \(pro\)"/);
  assert.throws(() => parseModelRef('Claude (opus/)'), /Cannot parse Claude model/);
  assert.throws(() => parseModelRef('Codex ()'), /empty parentheses/);
});

test('Claude tiers resolve to listed ids with options.effort', () => {
  for (const [text, id, effort] of [['Claude (opus/high)', 'claude-opus-5-5', 'high'], ['Claude (sonnet/medium)', 'claude-sonnet-5-5', 'medium'], ['Claude (haiku/medium)', 'claude-haiku-5-5', 'medium']]) {
    const r = res(text);
    assert.equal(r.dispatch, 't3-delegate'); assert.equal(r.providerInstanceId, 'claudeAgent');
    assert.equal(r.model, id); assert.deepEqual(r.options, [{ id: 'effort', value: effort }]);
  }
});

test('Codex, Cursor, Grok auto/default never override the model (DEC-8)', () => {
  const c = res('Codex (auto)'); assert.equal(c.providerInstanceId, 'codex'); assert.equal(c.model, undefined); assert.equal(c.options, undefined);
  const u = res('Cursor (auto)'); assert.equal(u.providerInstanceId, 'cursor'); assert.equal(u.model, 'default');
  const g = res('Grok (default)'); assert.equal(g.providerInstanceId, 'grok'); assert.equal(g.model, undefined);
  assert.equal(res('user').dispatch, 'user'); assert.equal(res('CI').dispatch, 'ci');
});

test('unlisted tier, effort, or model; unverified model', () => {
  const noHaiku = caps(); noHaiku.providers[1].models.pop();
  const r = resolveTarget(parseModelRef('Claude (haiku/medium)'), { caps: noHaiku, host: 't3' }) as Unavailable;
  assert.equal(r.unavailable, true); assert.match(r.reason, /no haiku model/);
  const x = res('Claude (haiku/xhigh)'); // haiku lists no xhigh
  assert.equal(x.model, 'claude-haiku-5-5'); assert.equal(x.options, undefined); assert.match(x.notes[0], /not advertised/);
  assert.equal((resolveTarget(parseModelRef('Codex (gpt-x)'), t3) as Unavailable).unavailable, true);
  const v = res('Codex (gpt-x, unverified)'); assert.equal(v.model, 'gpt-x'); assert.match(v.notes[0], /unverified/);
  assert.equal(res('Codex (gpt-6-sol)').model, 'gpt-6-sol');
});

test('constrained or disabled provider is unavailable with its reason', () => {
  const c = caps(); c.providers[0].constraints = ['quota exhausted'];
  assert.match((resolveTarget(parseModelRef('Codex (auto)'), { caps: c, host: 't3' }) as Unavailable).reason, /quota exhausted/);
  const d = caps(); d.providers[0].canRunChildTask = false;
  assert.match((resolveTarget(parseModelRef('Codex (auto)'), { caps: d, host: 't3' }) as Unavailable).reason, /cannot run child tasks/);
});

test('no caps: claude-code runs Claude natively; others hand off', () => {
  const n = resolveTarget(parseModelRef('Claude (sonnet/medium)'), { host: 'claude-code' }) as Target;
  assert.equal(n.dispatch, 'native-subagent'); assert.equal(n.model, 'sonnet');
  assert.equal((resolveTarget(parseModelRef('Codex (auto)'), { host: 'claude-code' }) as Target).dispatch, 'handoff');
  assert.equal((resolveTarget(parseModelRef('Claude (opus/high)'), { host: 'other' }) as Target).dispatch, 'handoff');
});

test('escalation ladder: one level per failure, never max', () => {
  const lab = (t: string, f: number) => escalate(parseModelRef(t), f)?.label ?? null;
  assert.equal(lab('Claude (sonnet/medium)', 0), 'Claude (sonnet/medium)');
  assert.equal(lab('Claude (sonnet/medium)', 1), 'Claude (sonnet/high)');
  assert.equal(lab('Claude (sonnet/medium)', 2), 'Claude (sonnet/xhigh)');
  assert.equal(lab('Claude (sonnet/medium)', 3), 'Claude (opus/high)');
  assert.equal(lab('Claude (sonnet/medium)', 4), 'Claude (opus/xhigh)');
  assert.equal(lab('Claude (sonnet/medium)', 5), null);
  assert.equal(lab('Claude (haiku/xhigh)', 1), 'Claude (sonnet/high)');
  assert.equal(lab('Claude (opus/xhigh)', 1), null);
  assert.equal(lab('Claude (opus/max)', 1), null);
  assert.equal(lab('Codex (auto)', 1), null);
  assert.equal(lab('Grok (default)', 1), null);
  assert.equal(lab('user', 1), null);
});

test('chooseTarget: Model, escalated, Fallback, handoff', () => {
  const slice = { model: 'Codex (auto)', fallback: 'Claude (opus/high)' };
  const a = chooseTarget(slice, 0, t3);
  assert.equal(a.used, 'model'); assert.equal(a.target.providerInstanceId, 'codex');
  const c = caps(); c.providers[0].constraints = ['disabled'];
  const b = chooseTarget(slice, 0, { caps: c, host: 't3' });
  assert.equal(b.used, 'fallback'); assert.equal(b.target.model, 'claude-opus-5-5');
  assert.equal(b.chain[0].result, 'unavailable'); assert.match(b.chain[0].reason, /disabled/); assert.equal(b.chain[1].result, 'ok');
  const e = chooseTarget({ model: 'Claude (sonnet/medium)', fallback: 'Claude (opus/high)' }, 1, t3);
  assert.equal(e.used, 'escalated'); assert.deepEqual(e.target.options, [{ id: 'effort', value: 'high' }]);
  const f = chooseTarget(slice, 1, t3); // auto cannot escalate
  assert.equal(f.used, 'fallback'); assert.equal(f.chain[0].result, 'exhausted');
  const both = caps(); both.providers[0].canRunChildTask = false; both.providers[1].constraints = ['down'];
  const h = chooseTarget(slice, 0, { caps: both, host: 't3' });
  assert.equal(h.used, 'handoff'); assert.equal(h.target.dispatch, 'handoff'); assert.equal(h.chain.length, 3);
  const n = chooseTarget(slice, 0, { host: 'claude-code' }); // Codex handoff, Claude native
  assert.equal(n.used, 'fallback'); assert.equal(n.target.dispatch, 'native-subagent');
  assert.equal(chooseTarget(slice, 0, { host: 'other' }).used, 'handoff');
  assert.equal(chooseTarget({ model: 'user', fallback: 'CI' }, 0, t3).target.dispatch, 'user');
});

test('intensity is a labeled relative estimate', () => {
  assert.equal(intensity(parseModelRef('Claude (opus/high)')).value, 12);
  assert.equal(intensity(parseModelRef('Claude (haiku/low)')).value, 0.5);
  assert.equal(intensity(parseModelRef('Codex (auto)')).value, 3);
  assert.match(intensity(parseModelRef('Grok (default)')).label, /relative estimate, not measured quota/);
});

test('EVAL-1: Codex (model-id/effort) splits into model and effort; old Codex lines still parse', () => {
  const r = parseModelRef('Codex (gpt-6.1-terra/low)');
  assert.equal(r.modelId, 'gpt-6.1-terra'); assert.equal(r.effort, 'low'); assert.equal(r.mode, 'model'); assert.equal(r.label, 'Codex (gpt-6.1-terra/low)');
  assert.equal(parseModelRef('Codex (gpt-6.1-terra/low, unverified)').unverified, true);
  assert.equal(parseModelRef('Codex (gpt-6-sol)').effort, undefined); // no "/": today's behavior
  assert.equal(parseModelRef('Codex (gpt-6-sol)').modelId, 'gpt-6-sol');
  assert.equal(parseModelRef('Codex (auto)').mode, 'auto');
  assert.equal(parseModelRef('Cursor (auto)').mode, 'auto');
  assert.equal(parseModelRef('Grok (default)').mode, 'default');
  assert.throws(() => parseModelRef('Codex (gpt-6-sol/)'), /Cannot parse Codex model/);
  assert.throws(() => parseModelRef('Codex (a/b/c)'), /Cannot parse Codex model/);
});

test('EVAL-2: a named Codex model sets the advertised effort option, else adds a note', () => {
  const ok = res('Codex (gpt-6-sol/low)');
  assert.equal(ok.model, 'gpt-6-sol'); assert.deepEqual(ok.options, [{ id: 'reasoningEffort', value: 'low' }]); assert.deepEqual(ok.notes, []);
  const unadvertised = res('Codex (gpt-6-sol/xhigh)'); // gpt-6-sol lists low, medium, high
  assert.equal(unadvertised.model, 'gpt-6-sol'); assert.equal(unadvertised.options, undefined); assert.match(unadvertised.notes[0], /effort "xhigh" is not advertised by gpt-6-sol/);
  const none = res('Codex (gpt-6.1-sol/low)'); // this model lists no effort option
  assert.equal(none.options, undefined); assert.match(none.notes[0], /not advertised/);
  const c = caps(); c.providers[0].models[1].options = [{ id: 'effort', values: ['low'] }];
  assert.deepEqual((resolveTarget(parseModelRef('Codex (gpt-6-sol/low)'), { caps: c, host: 't3' }) as Target).options, [{ id: 'effort', value: 'low' }]);
  c.providers[0].models[1].options = [{ id: 'reasoning_effort', values: ['low'] }];
  assert.deepEqual((resolveTarget(parseModelRef('Codex (gpt-6-sol/low)'), { caps: c, host: 't3' }) as Target).options, [{ id: 'reasoning_effort', value: 'low' }]);
});

test('EVAL-3: Antigravity (model-id) resolves to the antigravity provider with the model id unchanged', () => {
  const r = parseModelRef('Antigravity (gemini-3.8-flash-low)');
  assert.equal(r.agent, 'Antigravity'); assert.equal(r.mode, 'model'); assert.equal(r.modelId, 'gemini-3.8-flash-low'); assert.equal(r.effort, undefined);
  const t = res('Antigravity (gemini-3.8-flash-low)');
  assert.equal(t.dispatch, 't3-delegate'); assert.equal(t.providerInstanceId, 'antigravity'); assert.equal(t.model, 'gemini-3.8-flash-low'); assert.equal(t.options, undefined);
  const missing = resolveTarget(parseModelRef('Antigravity (gemini-9)'), t3) as Unavailable;
  assert.equal(missing.unavailable, true); assert.match(missing.reason, /not listed for Antigravity/);
  const noProvider = caps(); noProvider.providers = noProvider.providers.filter(p => p.driverKind !== 'antigravity');
  assert.match((resolveTarget(parseModelRef('Antigravity (gemini-3.8-flash-low)'), { caps: noProvider, host: 't3' }) as Unavailable).reason, /provider for Antigravity/);
});

test('EVAL-4: a named Codex model escalates effort only, then returns null; Antigravity returns null', () => {
  const lab = (t: string, f: number) => escalate(parseModelRef(t), f)?.label ?? null;
  assert.equal(lab('Codex (gpt-6-sol/low)', 0), 'Codex (gpt-6-sol/low)');
  assert.equal(lab('Codex (gpt-6-sol/low)', 1), 'Codex (gpt-6-sol/medium)');
  assert.equal(lab('Codex (gpt-6-sol/low)', 2), 'Codex (gpt-6-sol/high)');
  assert.equal(lab('Codex (gpt-6-sol/low)', 3), 'Codex (gpt-6-sol/xhigh)');
  assert.equal(lab('Codex (gpt-6-sol/low)', 4), null);
  assert.equal(lab('Codex (gpt-6-sol/xhigh)', 1), null);
  assert.equal(lab('Codex (gpt-6-sol/low, unverified)', 1), 'Codex (gpt-6-sol/medium, unverified)');
  assert.equal(lab('Codex (gpt-6-sol)', 1), null); // no effort to raise
  assert.equal(lab('Antigravity (gemini-3.8-flash-low)', 1), null);
  assert.equal(lab('Claude (sonnet/medium)', 1), 'Claude (sonnet/high)'); // Claude is unchanged
});

test('EVAL-5: a named model missing from the host list is unavailable, and chooseTarget takes Fallback', () => {
  const slice = { model: 'Codex (gpt-9-nova/low)', fallback: 'Claude (sonnet/high)' };
  const a = chooseTarget(slice, 0, t3);
  assert.equal(a.used, 'fallback'); assert.equal(a.chain[0].result, 'unavailable'); assert.match(a.chain[0].reason, /model "gpt-9-nova" is not listed for Codex/);
  const g = chooseTarget({ model: 'Antigravity (gemini-9)', fallback: 'Claude (sonnet/high)' }, 0, t3);
  assert.equal(g.used, 'fallback');
  // a named model at its last effort escalates to nothing, so Fallback runs
  const last = chooseTarget({ model: 'Codex (gpt-6-sol/xhigh)', fallback: 'Claude (sonnet/high)' }, 1, t3);
  assert.equal(last.used, 'fallback'); assert.equal(last.chain[0].result, 'exhausted');
  const next = chooseTarget({ model: 'Codex (gpt-6-sol/low)', fallback: 'Claude (sonnet/high)' }, 1, t3);
  assert.equal(next.used, 'escalated'); assert.deepEqual(next.target.options, [{ id: 'reasoningEffort', value: 'medium' }]);
  // gpt-6-sol lists low, medium, high: an escalation to xhigh is not advertised, so Fallback runs (review F1)
  const unadv = chooseTarget({ model: 'Codex (gpt-6-sol/high)', fallback: 'Claude (sonnet/high)' }, 1, t3);
  assert.equal(unadv.used, 'fallback'); assert.equal(unadv.chain[0].result, 'unavailable'); assert.match(unadv.chain[0].reason, /effort "xhigh" is not advertised by gpt-6-sol/);
  // a first attempt with an unadvertised effort still runs with a note (EVAL-2)
  assert.equal(chooseTarget({ model: 'Codex (gpt-6-sol/xhigh)', fallback: 'Claude (sonnet/high)' }, 0, t3).used, 'model');
});

test('Codex (auto/effort) is a parse error (review F7)', () => {
  assert.throws(() => parseModelRef('Codex (auto/low)'), /Cannot parse Codex model/);
});
