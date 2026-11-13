// Dispatch: turn a slice's Model/Fallback text into a target (REQ-7, REQ-8, DEC-8). Pure functions; no I/O.

export type ModelRef = {
  agent: 'Claude' | 'Codex' | 'Antigravity' | 'Cursor' | 'Grok' | 'user' | 'CI';
  mode: 'tier' | 'auto' | 'default' | 'model' | 'none';
  tier?: string; effort?: string; modelId?: string; unverified?: boolean; extras: string[]; label: string;
};
export type Option = { id: string; value: string | boolean };
export type Target = {
  dispatch: 't3-delegate' | 'native-subagent' | 'handoff' | 'user' | 'ci';
  agent: string; label: string; providerInstanceId?: string; model?: string; options?: Option[]; reason: string; notes: string[];
};
export type Unavailable = { unavailable: true; reason: string };
export type CapModel = { id: string; label?: string; options?: { id: string; values: (string | boolean)[]; default?: string | boolean }[] };
export type Caps = { providers: { providerInstanceId: string; driverKind: string; models: CapModel[]; canRunChildTask?: boolean; constraints?: string[] }[] };
export type Opts = { caps?: Caps | null; host: string };
export type Step = { ref: string; result: 'ok' | 'unavailable' | 'exhausted'; reason: string };

// Agent name -> T3 driverKind. Observed in T3 orchestrator_capabilities on 2026-10-25; not a model id.
const DRIVER: Record<string, string> = { Claude: 'claudeAgent', Codex: 'codex', Antigravity: 'antigravity', Cursor: 'cursor', Grok: 'grok' };
const EFFORT_OPTION_IDS = ['effort', 'reasoningEffort', 'reasoning_effort'];
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh']; // escalation never reaches max
const TIER_WEIGHT: Record<string, number> = { haiku: 1, sonnet: 3, opus: 8, fable: 12 }; // fable: AA cost per task at medium is about 1.5x opus (2026-11-10)
const EFFORT_WEIGHT: Record<string, number> = { low: 0.5, medium: 1, high: 1.5, xhigh: 2 };

export function parseModelRef(text: string): ModelRef {
  const t = String(text ?? '').trim();
  if (/^user$/i.test(t)) return { agent: 'user', mode: 'none', extras: [], label: 'user' };
  if (/^ci$/i.test(t)) return { agent: 'CI', mode: 'none', extras: [], label: 'CI' };
  const m = /^(Claude|Codex|Antigravity|Cursor|Grok)\s*\(([^()]*)\)$/i.exec(t);
  if (!m) throw new Error(`Cannot parse model text "${t}". Expected "Claude (opus/high)", "Codex (gpt-6.1-terra/low)", "Antigravity (gemini-3.8-flash-low)", "Cursor (auto)", "Grok (default)", "user", or "CI".`);
  const agent = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as ModelRef['agent'];
  const parts = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`Cannot parse model text "${t}": empty parentheses.`);
  const first = parts[0];
  const extras = parts.slice(1).filter((p) => p.toLowerCase() !== 'unverified');
  const unverified = parts.slice(1).some((p) => p.toLowerCase() === 'unverified');
  const label = `${agent} (${parts.join(', ')})`;
  const base = { agent, extras, label, ...(unverified ? { unverified } : {}) };
  if (agent === 'Claude') {
    const [tier, effort, ...rest] = first.split('/').map((s) => s.trim().toLowerCase());
    if (!tier || rest.length || effort === '') throw new Error(`Cannot parse Claude model "${first}". Expected tier/effort, for example "opus/high".`);
    return { ...base, mode: 'tier', tier, ...(effort ? { effort } : {}) };
  }
  const lower = first.toLowerCase();
  if (lower === 'auto' && (agent === 'Codex' || agent === 'Cursor')) return { ...base, mode: 'auto' };
  if (lower === 'default' && agent === 'Grok') return { ...base, mode: 'default' };
  // A named Codex model may carry an effort: "gpt-6.1-terra/low". A value without "/" keeps the whole text as the model id.
  if (agent === 'Codex') {
    const [modelId, effort, ...rest] = first.split('/').map((x) => x.trim());
    if (!modelId || rest.length || effort === '' || (effort && modelId.toLowerCase() === 'auto')) throw new Error(`Cannot parse Codex model "${first}". Expected model-id/effort, for example "gpt-6.1-terra/low".`);
    return { ...base, mode: 'model', modelId, ...(effort ? { effort: effort.toLowerCase() } : {}) };
  }
  return { ...base, mode: 'model', modelId: first };
}

const tgt = (ref: ModelRef, dispatch: Target['dispatch'], reason: string, more: Partial<Target> = {}): Target =>
  ({ dispatch, agent: ref.agent, label: ref.label, reason, notes: [], ...more });
const unavailable = (reason: string): Unavailable => ({ unavailable: true, reason });
export const isUnavailable = (r: Target | Unavailable): r is Unavailable => 'unavailable' in r;

export function resolveTarget(ref: ModelRef, { caps, host }: Opts): Target | Unavailable {
  if (ref.agent === 'user') return tgt(ref, 'user', 'a person does this step');
  if (ref.agent === 'CI') return tgt(ref, 'ci', 'CI runs this step');
  if (!caps) {
    if (host === 'claude-code' && ref.agent === 'Claude') {
      const notes: string[] = [];
      const options: Option[] = ref.effort ? [{ id: 'effort', value: ref.effort }] : [];
      return tgt(ref, 'native-subagent', 'no T3 capabilities; host is claude-code', { model: ref.tier, ...(options.length ? { options } : {}), notes });
    }
    return tgt(ref, 'handoff', host === 'claude-code' ? 'no T3 capabilities; only Claude runs natively in claude-code' : `no T3 capabilities; host "${host}" cannot run a subagent`);
  }
  const p = caps.providers.find((x) => x.driverKind === DRIVER[ref.agent]);
  if (!p) return unavailable(`provider for ${ref.agent} (driverKind ${DRIVER[ref.agent]}) is not listed`);
  if (p.canRunChildTask === false) return unavailable(`${ref.agent} provider cannot run child tasks`);
  if (p.constraints?.length) return unavailable(`${ref.agent} provider is constrained: ${p.constraints.join('; ')}`);
  const base: Partial<Target> = { providerInstanceId: p.providerInstanceId };
  const ok = (more: Partial<Target>, notes: string[] = []) => tgt(ref, 't3-delegate', `T3 provider ${p.providerInstanceId}`, { ...base, ...more, notes });
  if (ref.mode === 'tier') {
    // The newest listed id of that tier, for example claude-fable-5-2 over claude-fable-5-1.
    const model = p.models.filter((x) => x.id.includes(`-${ref.tier}-`)).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0];
    if (!model) return unavailable(`no ${ref.tier} model is listed for ${ref.agent}`);
    const notes: string[] = [];
    let options: Option[] | undefined;
    if (ref.effort) {
      const adv = model.options?.find((o) => o.id === 'effort');
      if (adv?.values.includes(ref.effort)) options = [{ id: 'effort', value: ref.effort }];
      else notes.push(`effort "${ref.effort}" is not advertised by ${model.id}; no effort option set`);
    }
    return ok({ model: model.id, ...(options ? { options } : {}) }, notes);
  }
  if (ref.mode === 'auto' || ref.mode === 'default') { // DEC-8: no model override
    if (ref.agent === 'Cursor') {
      if (p.models.some((x) => x.id === 'default')) return ok({ model: 'default' });
      return ok({}, ['Cursor "default" (Auto) model is not listed; no model override set']);
    }
    return ok({});
  }
  const listed = p.models.find((x) => x.id === ref.modelId);
  if (!listed && !ref.unverified) return unavailable(`model "${ref.modelId}" is not listed for ${ref.agent}`);
  const notes = listed ? [] : [`model "${ref.modelId}" is unverified: the host did not list it`];
  let options: Option[] | undefined;
  if (ref.effort) { // named model with an effort: set the advertised option, else note it (REQ-4)
    const adv = listed?.options?.find((o) => EFFORT_OPTION_IDS.includes(o.id) && o.values.includes(ref.effort!));
    if (adv) options = [{ id: adv.id, value: ref.effort }];
    else notes.push(`effort "${ref.effort}" is not advertised by ${ref.modelId}; no effort option set`);
  }
  return ok({ model: ref.modelId, ...(options ? { options } : {}) }, notes);
}

// One level per failure. Claude: effort low, medium, high; past high, the next tier at medium (haiku, sonnet, opus, fable).
// An xhigh Claude ref counts as past high. Past fable/high, null = go to Fallback. Named non-Claude models step through EFFORTS.
export function escalate(ref: ModelRef, failures: number): ModelRef | null {
  if (failures <= 0) return ref;
  // A named model with an effort steps through the efforts only. A model change goes through Fallback (DEC-7).
  if (ref.mode === 'model' && ref.agent !== 'Claude') {
    if (!ref.effort || !EFFORTS.includes(ref.effort)) return null;
    const e = EFFORTS.indexOf(ref.effort) + failures;
    if (e >= EFFORTS.length) return null;
    const effort = EFFORTS[e];
    return { ...ref, effort, label: `${ref.agent} (${[`${ref.modelId}/${effort}`, ...ref.extras, ...(ref.unverified ? ['unverified'] : [])].join(', ')})` };
  }
  if (ref.agent !== 'Claude' || ref.mode !== 'tier' || !ref.tier || !TIERS.includes(ref.tier)) return null;
  let tier = ref.tier;
  let effort = ref.effort ?? 'medium';
  if (!EFFORTS.includes(effort)) return null;
  const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
  for (let i = 0; i < failures; i++) {
    const e = CLAUDE_EFFORTS.indexOf(effort);
    if (e >= 0 && e < CLAUDE_EFFORTS.length - 1) effort = CLAUDE_EFFORTS[e + 1];
    else if (tier !== TIERS[TIERS.length - 1]) { tier = TIERS[TIERS.indexOf(tier) + 1]; effort = 'medium'; }
    else return null;
  }
  return { ...ref, tier, effort, label: `Claude (${[`${tier}/${effort}`, ...ref.extras, ...(ref.unverified ? ['unverified'] : [])].join(', ')})` };
}

export function chooseTarget(slice: { model: string; fallback?: string }, failures: number, opts: Opts) {
  const chain: Step[] = [];
  let firstHandoff: Target | null = null;
  const attempt = (ref: ModelRef | null, name: string, used: 'model' | 'escalated' | 'fallback') => {
    if (!ref) return null;
    const r = resolveTarget(ref, opts);
    if (isUnavailable(r)) { chain.push({ ref: ref.label, result: 'unavailable', reason: `${name}: ${r.reason}` }); return null; }
    // An escalated named model must get its new effort; else the retry runs at the host default, so go to Fallback (REQ-6).
    if (used === 'escalated' && ref.mode === 'model' && ref.effort && !r.options?.length) {
      chain.push({ ref: ref.label, result: 'unavailable', reason: `${name}: effort "${ref.effort}" is not advertised by ${ref.modelId}` });
      return null;
    }
    if (r.dispatch === 'handoff') { firstHandoff ??= r; chain.push({ ref: ref.label, result: 'unavailable', reason: `${name}: ${r.reason}` }); return null; }
    chain.push({ ref: ref.label, result: 'ok', reason: `${name}: ${r.reason}` });
    return { target: r, used };
  };
  const model = parseModelRef(slice.model);
  const esc = escalate(model, failures);
  if (failures > 0 && !esc) chain.push({ ref: model.label, result: 'exhausted', reason: `Model: no escalation left after ${failures} failure(s)` });
  const hit = attempt(esc, failures > 0 ? 'Model (escalated)' : 'Model', failures > 0 ? 'escalated' : 'model')
    ?? (slice.fallback ? attempt(parseModelRef(slice.fallback), 'Fallback', 'fallback') : null);
  if (hit) return { ...hit, chain };
  const ref = esc ?? model;
  const target = firstHandoff ?? tgt(ref, 'handoff', 'no Model or Fallback target is available');
  chain.push({ ref: target.label, result: 'ok', reason: 'handoff: no target could run the slice' });
  return { target, used: 'handoff' as const, chain };
}

// One key per model choice: agent, then tier and effort, model id and effort, or auto/default. Extras such as
// "fresh session" or "unverified" do not change which model it is.
export function modelKey(ref: ModelRef): string {
  if (ref.mode === 'tier') return `${ref.agent}:${ref.tier}/${ref.effort ?? ''}`;
  if (ref.mode === 'model') return `${ref.agent}:${(ref.modelId ?? '').toLowerCase()}/${ref.effort ?? ''}`;
  return `${ref.agent}:${ref.mode}`;
}

// Model families for review independence (REQ-17). Codex is the OpenAI family; Antigravity and Cursor host models of
// several families, so only a model id tells; Cursor (auto) has no known family. `human` is a person, not a model.
export const FAMILIES = ['Claude', 'OpenAI', 'Gemini', 'Grok'] as const;
export type Family = typeof FAMILIES[number];
// Exact id prefixes only. Anything else is no known family, never a guess.
export function familyOfModelId(id: string | undefined): Family | undefined {
  const t = (id ?? '').trim().toLowerCase();
  if (/^(claude|opus|sonnet|haiku|fable)\b/.test(t)) return 'Claude';
  if (/^(gpt|codex)\b|^o\d/.test(t)) return 'OpenAI';
  if (/^gemini\b/.test(t)) return 'Gemini';
  if (/^grok\b/.test(t)) return 'Grok';
  return undefined;
}
// A recorded provider name (attempt.provider, --provider) or T3 driverKind.
export function familyOfProvider(p: string | undefined): Family | undefined {
  const t = (p ?? '').trim().toLowerCase();
  if (['claude', 'claudeagent', 'anthropic'].includes(t)) return 'Claude';
  if (['codex', 'openai'].includes(t)) return 'OpenAI';
  if (['gemini', 'google'].includes(t)) return 'Gemini';
  if (['grok', 'xai'].includes(t)) return 'Grok';
  return undefined;
}
export function familyOf(ref: ModelRef): Family | 'human' | undefined {
  if (ref.agent === 'user') return 'human';
  if (ref.agent === 'CI') return undefined;
  if (ref.agent === 'Claude') return 'Claude';
  if (ref.agent === 'Codex') return 'OpenAI';
  if (ref.agent === 'Grok') return 'Grok';
  return ref.mode === 'model' ? familyOfModelId(ref.modelId) : undefined;
}
// Model text ("Codex (gpt-6.1-sol/medium)") or a bare model id ("opus", "gemini-3.8-flash"), or undefined.
export function familyOfText(text: string | undefined): Family | 'human' | undefined {
  if (!text?.trim()) return undefined;
  try { return familyOf(parseModelRef(text)); } catch { return familyOfModelId(text); }
}

export function intensity(ref: ModelRef): { value: number; label: string } {
  const base = ref.mode === 'tier' ? TIER_WEIGHT[ref.tier ?? ''] ?? 3 : ref.agent === 'user' || ref.agent === 'CI' ? 0 : 3;
  const mult = ref.mode === 'tier' ? EFFORT_WEIGHT[ref.effort ?? 'medium'] ?? 1 : 1;
  return { value: base * mult, label: 'relative estimate, not measured quota' };
}
