import { intensity, isUnavailable, parseModelRef, resolveTarget } from './dispatch.ts';
import type { ModelRef, Opts } from './dispatch.ts';
import { redact } from './guard.ts';
import { classForCode } from './options.ts';

// Usage risk and replacement ranking (plans/usage-continuity.md). Pure functions; no I/O, no provider calls.
// The lead writes the snapshot from what it observed. A missing or unusable number is `unknown`, never a guess.

export const LIMIT_KINDS = ['quota', 'rate', 'context'] as const;
export type LimitKind = typeof LIMIT_KINDS[number];
export type Limit = { kind: LimitKind; usedPct?: number | null; reached?: boolean; resetAt?: string; source?: string };
export type AgentUsage = { limits?: Limit[]; observedAt?: string };
export type Snapshot = { agents: Record<string, AgentUsage> };
export type Thresholds = { assess: number; prepare: number; transfer: number };
export type Policy = { thresholds: Record<string, Thresholds>; ranks: Record<string, number>; pool: string[] };
export type Level = 'normal' | 'unknown' | 'assess' | 'prepare' | 'transfer' | 'exhausted';
export type Assessment = { agent: string; level: Level; limiting: { kind: LimitKind; usedPct: number; resetAt?: string } | null; reasons: string[] };
export type Candidate = { label: string; source: 'fresh-session' | 'fallback' | 'pool'; rank: number; cost: number; capacity: Level; notes: string[] };

export const DEFAULT_POLICY: Policy = {
  thresholds: { default: { assess: 70, prepare: 85, transfer: 95 } },
  // Capability rank per agent, or per Claude tier. A replacement needs a rank at least that of the slice's Model.
  // Grok is 0: the planner uses Grok for review only. Antigravity is 1: the agent key cannot tell its models apart, so it gets the lowest build rank.
  ranks: { 'Claude haiku': 1, 'Claude sonnet': 2, 'Claude opus': 3, 'Claude fable': 3, Codex: 3, Antigravity: 1, Cursor: 2, Grok: 0 },
  pool: ['Cursor (auto)', 'Codex (auto)', 'Claude (sonnet/high)', 'Claude (opus/high)'],
};

const ORDER: Level[] = ['normal', 'unknown', 'assess', 'prepare', 'transfer', 'exhausted'];
const worse = (a: Level, b: Level) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const BUSY: Level[] = ['prepare', 'transfer', 'exhausted']; // too close to a limit to take on a slice
// Exact provider codes only, through the one code table in options.ts (REQ-11). Free text is never read: the lead
// says which kind of limit it is, with `reached`. A code of a class that is no limit (api, auth, refusal) sets no limit.
const codeKind = (code: string): LimitKind | undefined => {
  const k = classForCode(code);
  return k && (LIMIT_KINDS as readonly string[]).includes(k) ? k as LimitKind : undefined;
};
// Every other field is refused, so a limit the lead meant to set cannot be dropped in silence.
const AGENT_FIELDS = ['limits', 'code', 'observedAt'], LIMIT_FIELDS = ['kind', 'usedPct', 'reached', 'resetAt', 'source'];

export const ACTIONS: Record<Level | 'block', { action: string; text: string }> = {
  normal: { action: 'continue', text: 'keep the current worker; checkpoint at milestones' },
  unknown: { action: 'continue', text: 'usage is unknown: keep the worker, checkpoint at milestones, and watch for reached limits' },
  assess: { action: 'assess', text: 'keep working; the candidates are listed for reference only' },
  prepare: { action: 'prepare', text: 'Claude lead: pick a candidate, run ae prepare, then ae checkpoint' },
  transfer: { action: 'transfer', text: 'transfer at the next safe checkpoint when completion is at risk: ae prepare, ae checkpoint, stop the old worker, ae transfer, ae handoff, delegate, ae transfer --task-id' },
  exhausted: { action: 'transfer-now', text: 'the worker cannot continue: ae prepare, ae checkpoint, ae transfer, ae handoff, delegate, ae transfer --task-id' },
  block: { action: 'block', text: 'no replacement qualifies: run ae checkpoint, then ae block, and tell the user' },
};

const pct = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const fail = (what: string): never => { throw new Error(`usage: ${redact(what)}`); };
const AGENTS = ['Claude', 'Codex', 'Antigravity', 'Cursor', 'Grok'];
// "codex", "Codex", and "Codex (auto)" all name Codex. Anything else is not an agent key.
function agentKey(name: string): string | null {
  const plain = AGENTS.find(a => a.toLowerCase() === name.trim().toLowerCase());
  if (plain) return plain;
  try { const a = parseModelRef(name).agent; return AGENTS.includes(a) ? a : null; } catch { return null; }
}

// Snapshot shape: {"agents": {"Codex": {"limits": [{"kind": "quota", "usedPct": 88}, {"kind": "quota", "reached": true}], "code": "usage_limit_reached"}}}
// `reached: true` means the limit is at 100 percent. `code` must be an exact limit code of the code table; any other code is ignored.
// Free text is redacted here, before anything can store or print it. Unknown keys are listed in `ignored`, redacted.
export function parseSnapshot(raw: unknown): Snapshot & { ignored: string[] } {
  const agents = (raw as Snapshot)?.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) fail('the snapshot needs an "agents" object keyed by agent name');
  const out: Snapshot & { ignored: string[] } = { agents: {}, ignored: [] };
  // the raw input may carry fields the engine no longer reads; they are rejected below, not typed
  for (const [name, u] of Object.entries(agents) as [string, AgentUsage & { limitReached?: unknown; error?: unknown; code?: unknown }][]) {
    const key = agentKey(name);
    if (!key) { out.ignored.push(redact(name).slice(0, 60)); continue; }
    if (!u || typeof u !== 'object') fail(`agent "${key}" must be an object`);
    if (u.limitReached !== undefined || u.error !== undefined) fail(`agent "${key}": "limitReached" and "error" are not read; use "reached": true on a limit, or an exact "code"`);
    for (const field of Object.keys(u)) if (!AGENT_FIELDS.includes(field)) fail(`agent "${key}": unknown field "${field}"; allowed: ${AGENT_FIELDS.join(', ')}`);
    if (u.code !== undefined && typeof u.code !== 'string') fail(`agent "${key}": "code" must be text`);
    const limits = u.limits ?? [];
    if (!Array.isArray(limits)) fail(`agent "${key}": "limits" must be a list`);
    // redact the text as written; lower-casing first would hide case-sensitive secret shapes such as AKIA keys
    const raw = (typeof u.code === 'string' ? u.code : '').trim(), fromCode = codeKind(raw);
    if (raw && !fromCode) out.ignored.push(redact(raw).slice(0, 60));
    const code = raw.toLowerCase();
    const prev = out.agents[key] ?? { limits: [] };
    out.agents[key] = {
      limits: [...prev.limits!, ...(fromCode ? [{ kind: fromCode, reached: true, source: `code ${code}` }] : []), ...limits.map((l, i) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) fail(`agent "${key}" limit ${i} must be an object`);
        for (const field of Object.keys(l)) if (!LIMIT_FIELDS.includes(field)) fail(`agent "${key}" limit ${i}: unknown field "${field}"; allowed: ${LIMIT_FIELDS.join(', ')}`);
        if (!LIMIT_KINDS.includes(l.kind)) fail(`agent "${key}" limit ${i}: kind must be ${LIMIT_KINDS.join(', ')}`);
        if (l.reached !== undefined && typeof l.reached !== 'boolean') fail(`agent "${key}" limit ${i}: "reached" must be true or false`);
        // a value that is not a usable number is kept as null: it is never echoed, so it cannot leak
        return { kind: l.kind, usedPct: pct(l.usedPct) ? l.usedPct : null, reached: l.reached === true, ...(l.resetAt ? { resetAt: redact(String(l.resetAt)).slice(0, 60) } : {}), ...(l.source ? { source: redact(String(l.source)).slice(0, 100) } : {}) };
      })],
      ...(u.observedAt ? { observedAt: redact(String(u.observedAt)).slice(0, 40) } : {}),
    };
  }
  return out;
}

// Policy file: any subset of DEFAULT_POLICY. Threshold keys: "default", an agent ("Codex"), a kind ("context"), or "Codex.context".
export function parsePolicy(raw: unknown): Policy {
  const p = (raw ?? {}) as Partial<Policy>;
  const thresholds = { ...DEFAULT_POLICY.thresholds, ...(p.thresholds ?? {}) };
  for (const [k, t] of Object.entries(thresholds)) {
    if (!t || ![t.assess, t.prepare, t.transfer].every(pct) || !(t.assess <= t.prepare && t.prepare <= t.transfer)) fail(`policy thresholds "${k}" need assess <= prepare <= transfer, each 0 to 100`);
  }
  const ranks = { ...DEFAULT_POLICY.ranks, ...(p.ranks ?? {}) };
  for (const [k, r] of Object.entries(ranks)) if (typeof r !== 'number' || !Number.isFinite(r)) fail(`policy rank "${k}" must be a number`);
  const pool = p.pool ?? DEFAULT_POLICY.pool;
  if (!Array.isArray(pool)) fail('policy "pool" must be a list of model texts');
  return { thresholds, ranks, pool: pool.map(x => parseModelRef(redact(String(x))).label) }; // throws on bad text
}

export const thresholdsFor = (p: Policy, agent: string, kind: LimitKind) =>
  p.thresholds[`${agent}.${kind}`] ?? p.thresholds[agent] ?? p.thresholds[kind] ?? p.thresholds.default;

// null: the policy has no rank for it. The caller decides what unknown means; it is never 0 by accident.
export function rankOf(ref: ModelRef, p: Policy): number | null {
  if (ref.agent === 'user' || ref.agent === 'CI') return null;
  if (ref.agent === 'Claude') {
    const tier = ref.tier ?? ['haiku', 'sonnet', 'opus', 'fable'].find(t => ref.modelId?.includes(t));
    return p.ranks[`Claude ${tier}`] ?? p.ranks.Claude ?? null;
  }
  return p.ranks[ref.agent] ?? null;
}

const levelFor = (used: number, t: Thresholds): Level => used >= 100 ? 'exhausted' : used >= t.transfer ? 'transfer' : used >= t.prepare ? 'prepare' : used >= t.assess ? 'assess' : 'normal';
const ACCOUNT = (k: LimitKind) => k !== 'context';

// One agent's risk. Quota and rate limits belong to the account; the context window belongs to the session.
// They are judged apart, and an account limit wins a tie. `remainingPct`: the lead's estimate of the work left,
// as a percent of this agent's allowance; it is compared with the scarcest quota or rate limit only.
// `freshSession`: true only when the context window alone is the problem, so a new session of the same agent helps.
export function assessAgent(agent: string, usage: AgentUsage | undefined, p: Policy, remainingPct?: number): Assessment & { freshSession: boolean } {
  if (!usage) return { agent, level: 'unknown', limiting: null, reasons: [`no usage data for ${agent}`], freshSession: false };
  const reasons: string[] = [];
  // a reached limit is at 100 percent by the lead's statement; it is not a number the engine invents
  const known = (usage.limits ?? []).filter(l => { if (!l.reached && !pct(l.usedPct)) reasons.push(`${l.kind}: no usable number`); return l.reached || pct(l.usedPct); })
    .map(l => { const usedPct = l.reached ? 100 : l.usedPct as number; return { kind: l.kind, usedPct, reached: !!l.reached, ...(l.resetAt ? { resetAt: l.resetAt } : {}), level: levelFor(usedPct, thresholdsFor(p, agent, l.kind)) }; });
  for (const l of known) { const t = thresholdsFor(p, agent, l.kind); reasons.push(l.reached ? `${l.kind} limit reached` : `${l.kind} ${l.usedPct}% used (thresholds ${t.assess}/${t.prepare}/${t.transfer})`); }
  const worst = (xs: typeof known) => xs.reduce<typeof known[number] | null>((a, b) => (!a || ORDER.indexOf(b.level) > ORDER.indexOf(a.level) ? b : a), null);
  let account = worst(known.filter(l => ACCOUNT(l.kind))), context = worst(known.filter(l => !ACCOUNT(l.kind)));
  let accountLevel: Level = account?.level ?? 'unknown', contextLevel: Level = context?.level ?? 'unknown';
  // shortfall: the work left does not fit in the scarcest account limit
  const scarce = known.filter(l => ACCOUNT(l.kind)).sort((a, b) => b.usedPct - a.usedPct)[0];
  if (remainingPct !== undefined && scarce && remainingPct > 100 - scarce.usedPct) {
    reasons.push(`predicted remaining work ${remainingPct}% exceeds free ${scarce.kind} capacity ${100 - scarce.usedPct}%`);
    const raised: Level = ORDER.indexOf(accountLevel) >= ORDER.indexOf('prepare') ? 'transfer' : 'prepare';
    if (ORDER.indexOf(raised) > ORDER.indexOf(accountLevel)) { accountLevel = raised; account = { ...scarce, level: raised }; }
  }
  // An account limit wins a tie. With no account number, only a context window at `assess` or worse decides:
  // a low context reading says nothing about the quota, so the level stays `unknown`.
  const accountWins = contextLevel === 'unknown' || (accountLevel === 'unknown' ? contextLevel === 'normal' : ORDER.indexOf(accountLevel) >= ORDER.indexOf(contextLevel));
  const level = accountWins ? accountLevel : contextLevel;
  const pick = accountWins ? account : context;
  // No number for the limiting window means no `limiting`: an error is never turned into a usedPct.
  const limiting = pick ? { kind: pick.kind, usedPct: pick.usedPct, ...(pick.resetAt ? { resetAt: pick.resetAt } : {}) } : null;
  const freshSession = !accountWins && BUSY.includes(contextLevel) && !BUSY.includes(accountLevel);
  return { agent, level, limiting: level === 'unknown' ? null : limiting, reasons, freshSession };
}

// A replacement starts a new session, so its old context window says nothing about taking the slice.
// Only its quota and rate limits decide its capacity.
function accountOnly(usage: AgentUsage | undefined): AgentUsage | undefined {
  return usage && { ...usage, limits: (usage.limits ?? []).filter(l => ACCOUNT(l.kind)) };
}

// Candidates in order: a fresh session of the same agent (context limit only), the slice's Fallback, then the pool,
// cheapest sufficiently capable first. Excluded entries say why. The Claude lead makes the choice; this only ranks.
export function rankCandidates(slice: { model: string; fallback?: string }, current: string, freshSession: boolean, snapshot: Snapshot, p: Policy, opts: Opts) {
  const known = rankOf(parseModelRef(slice.model), p), cur = parseModelRef(current);
  // an unranked slice Model needs the strongest ranked agent: a guess of 0 would let anything build it
  const need = known ?? Math.max(...Object.values(p.ranks)), notes = known === null ? [`slice Model "${slice.model}" has no rank in the policy; it needs rank ${need}, the highest`] : [];
  const seen = new Set<string>(), candidates: Candidate[] = [], excluded: { label: string; reason: string }[] = [];
  const entries: [string, Candidate['source']][] = [
    ...(freshSession ? [[current, 'fresh-session'] as [string, Candidate['source']]] : []),
    ...(slice.fallback ? [[slice.fallback, 'fallback'] as [string, Candidate['source']]] : []),
    ...p.pool.map(x => [x, 'pool'] as [string, Candidate['source']]),
  ];
  for (const [label, source] of entries) {
    const ref = parseModelRef(label), key = `${source === 'fresh-session' ? 'fresh:' : ''}${ref.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.agent === 'user' || ref.agent === 'CI') { excluded.push({ label: ref.label, reason: 'not an agent' }); continue; }
    if (ref.agent === 'Grok') { excluded.push({ label: ref.label, reason: 'Grok reviews only; it never builds' }); continue; }
    // A quota or rate limit belongs to the account, so another model of the same agent shares it.
    if (source !== 'fresh-session' && ref.agent === cur.agent) {
      const reason = freshSession ? `same agent as the current worker (${cur.agent}); its context window is per session, so a fresh session is listed first` : `same agent as the current worker (${cur.agent}); it shares the limit`;
      excluded.push({ label: ref.label, reason }); continue;
    }
    // a fresh session of the current worker meets the need by definition: it is the same model
    const rank = source === 'fresh-session' ? Math.max(rankOf(ref, p) ?? need, need) : rankOf(ref, p);
    if (rank === null) { excluded.push({ label: ref.label, reason: 'capability rank unknown; add it to the policy ranks' }); continue; }
    if (rank < need) { excluded.push({ label: ref.label, reason: `capability rank ${rank} is below the slice's need ${need}` }); continue; }
    const cap = source === 'fresh-session' ? null : assessAgent(ref.agent, accountOnly(snapshot.agents[ref.agent]), p);
    if (cap && BUSY.includes(cap.level)) { excluded.push({ label: ref.label, reason: `capacity ${cap.level}: ${cap.reasons.join('; ')}` }); continue; }
    if (opts.caps) {
      const r = resolveTarget(ref, opts);
      if (isUnavailable(r)) { excluded.push({ label: ref.label, reason: r.reason }); continue; }
    }
    const notes = source === 'fresh-session' ? ['context window limit only: a fresh session with the checkpoint, not a new agent'] : cap!.level === 'unknown' ? ['capacity unknown'] : [];
    const shown = source === 'fresh-session' && !ref.extras.includes('fresh session') ? ref.label.replace(/\)$/, ', fresh session)') : ref.label;
    candidates.push({ label: shown, source, rank, cost: intensity(ref).value, capacity: cap?.level ?? 'normal', notes });
  }
  const tier = (c: Candidate) => (c.source === 'fresh-session' ? 0 : c.source === 'fallback' ? 1 : 2);
  // known capacity before unknown at equal cost: an unknown agent may be the one that is nearly empty
  candidates.sort((a, b) => tier(a) - tier(b) || a.cost - b.cost || Number(a.capacity === 'unknown') - Number(b.capacity === 'unknown') || b.rank - a.rank);
  return { need, notes, candidates, excluded, costLabel: 'relative estimate, not measured quota' };
}

// The full answer for one slice: the current worker's risk, the action, and, from `assess` up, the ranked candidates.
export function assessSlice(slice: { model: string; fallback?: string }, current: string, snapshot: Snapshot & { ignored?: string[] }, p: Policy, opts: Opts, remainingPct?: number) {
  const agent = parseModelRef(current).agent, { freshSession, ...risk } = assessAgent(agent, snapshot.agents[agent], p, remainingPct);
  const ignored = snapshot.ignored?.length ? { ignored: snapshot.ignored } : {};
  const wants = ORDER.indexOf(risk.level) >= ORDER.indexOf('assess');
  if (!wants) return { current, risk, ...ACTIONS[risk.level], candidates: [], excluded: [], ...ignored };
  const ranked = rankCandidates(slice, current, freshSession, snapshot, p, opts);
  const none = !ranked.candidates.length && BUSY.includes(risk.level);
  return { current, risk, ...(none ? ACTIONS.block : ACTIONS[risk.level]), ...ranked, ...ignored, decidedBy: 'the Claude lead (ae prepare --lead "Claude (...)")' };
}
