// Failure classes, recovery options, and authority (Slice 9: REQ-11, REQ-15, REQ-16, REQ-17; DEC-11, DEC-22, DEC-23,
// DEC-29; review-1 F17). A class is always set by the lead from what it observed: T3 gives only a status and free text
// (probe P4). One code table maps exact provider codes; free text maps to nothing (NOT-3).
//
// This module plugs in through hooks.ts only:
//  - guardEvent (interrupt): a code of the table must agree with --class
//  - guardWrite (prepare, transfer): the target must be the slice's Model (or its escalation), its Fallback, an entry of
//    the approved pool, or the current worker; after a refusal, another agent needs an approved `provider-change`
//    decision for the slice, approved after the refusal (DEC-22, NOT-4)
//  - guardWrite (review): a reviewer whose model family has a work attempt on the slice needs --exception (REQ-17).
//    Compatibility: without a lead lease, a review that names no model (no model text in --by, no --model or
//    --provider) is not checked, as before slice 9; under a lease the slice's Review line names the reviewer
//  - interrupted: a refusal blocks the slice; three stops in a row with one fingerprint block it (REQ-16)
//  - result (interrupt, review) and recoverSection: the ranked recovery options; the recorded review exception
// Nothing here moves a worker. The Claude lead picks an option (DEC-11), and nothing switches back by itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAILURE_CLASSES, INTERRUPTION_SOURCES } from './contract.ts';
import type { Decision, FailureClass, Interruption, InterruptionSource } from './contract.ts';
import { isActive, isStale } from './decisions.ts';
import { escalate, familyOf, familyOfProvider, familyOfText, modelKey, parseModelRef } from './dispatch.ts';
import type { Family, ModelRef } from './dispatch.ts';
import { cliWorker, leaseActive, openInterruptions } from './failover.ts';
import { register } from './hooks.ts';
import type { HookCtx, Hooks, RunCtx } from './hooks.ts';
import { failures, handoffOpen } from './journal.ts';
import type { Attempt, Journal, SliceRecord } from './journal.ts';
import type { Slice } from './plan.ts';
import { DEFAULT_POLICY, parsePolicy, rankCandidates } from './usage.ts';

export function parseFailureClass(v: string | undefined): FailureClass {
  if (!v) throw new Error(`interrupt: --class is required; use ${FAILURE_CLASSES.join(', ')}. Set it from what you observed; an exact --code of the code table must agree with it`);
  if (!(FAILURE_CLASSES as readonly string[]).includes(v)) throw new Error(`interrupt: unknown --class "${v}"; use ${FAILURE_CLASSES.join(', ')}`);
  return v as FailureClass;
}

export function parseInterruptionSource(v: string | undefined): InterruptionSource {
  if (v === undefined) return 'lead';
  if (!(INTERRUPTION_SOURCES as readonly string[]).includes(v)) throw new Error(`interrupt: unknown --source "${v}"; use ${INTERRUPTION_SOURCES.join(', ')}`);
  return v as InterruptionSource;
}

export function parseRetryable(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v !== 'true' && v !== 'false') throw new Error('interrupt: --retryable must be true or false');
  return v === 'true';
}

// An ISO time as the engine stores it, or an error. A reset time is copied from an observed field, never guessed.
export function parseIsoTime(flag: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`--${flag} must be an ISO date and time, such as 2026-11-08T08:21:00Z`);
  return new Date(t).toISOString();
}

// ---- the code table (REQ-11) ----
// The one table of exact provider codes. usage.ts reads its limit codes (quota, rate, context) from here too.
// Case and outer spaces are ignored; anything else that is not an entry maps to nothing: free text is never classified.
export const CODE_CLASS: ReadonlyMap<string, FailureClass> = new Map<string, FailureClass>([
  ['usage_limit_reached', 'quota'], ['insufficient_quota', 'quota'], // Codex CLI, OpenAI
  ['rate_limit_exceeded', 'rate'], ['rate_limited', 'rate'], ['rate_limit_error', 'rate'], // OpenAI, Anthropic
  ['context_length_exceeded', 'context'], ['context_window_exceeded', 'context'], // OpenAI, Codex CLI
  ['api_error', 'api'], ['overloaded_error', 'api'], ['server_error', 'api'], // Anthropic, OpenAI
  ['authentication_error', 'auth'], ['invalid_api_key', 'auth'], // Anthropic, OpenAI
  ['permission_error', 'refusal'], // DEC-29: a refusal until probe P4 says otherwise
]);
// A function declaration, so usage.ts can import it through the options -> usage import cycle.
export function classForCode(code: string | undefined): FailureClass | undefined {
  return typeof code === 'string' ? CODE_CLASS.get(code.trim().toLowerCase()) : undefined;
}

function guardClass(c: HookCtx) {
  const code = c.flags.get('code'), cls = c.flags.get('class'), mapped = classForCode(code);
  if (mapped && cls !== undefined && cls !== mapped) {
    throw new Error(`interrupt refused: code ${code!.trim()} maps to class ${mapped} in the code table (REQ-11${mapped === 'refusal' ? ', DEC-29' : ''}); --class ${cls} contradicts it. Pass --class ${mapped}. Nothing was written`);
  }
}

// ---- labels ----
const openWork = (rec: SliceRecord) => [...rec.attempts].reverse().find(a => a.kind === 'work' && !a.outcome);
// Who works the slice now, as ae.ts says it: the replacement while its transfer owns the open attempt, else the Model.
export function currentLabel(s: Slice, rec: SliceRecord): string {
  const a = openWork(rec), h = a?.handoff === undefined ? undefined : rec.handoffs?.[a.handoff];
  return h?.phase === 'TRANSFERRED' ? h.to : s.model;
}
// Who is really working: the open work attempt's own provider, model and effort when `ae start` recorded them and no handoff
// names the worker; else currentLabel. For the "from" label, the self-check and the ranking only. The authorization list
// keeps currentLabel: a worker the lead substituted does not widen what a replacement may be (slice 15 review F4).
export function workerLabel(s: Slice, rec: SliceRecord): string {
  const base = currentLabel(s, rec), a = openWork(rec);
  return a && a.handoff === undefined ? recordedLabel(a) ?? base : base;
}
// The agent label an attempt recorded for itself at `ae start` (provider, model, effort), or undefined when it recorded none
// or an unknown provider. Claude keeps its tier (opus, sonnet, haiku); Codex keeps the model id.
function recordedLabel(a: Attempt): string | undefined {
  if (!a.provider || !a.model) return undefined;
  const family = familyOfProvider(a.provider), agent = family === 'Claude' ? 'Claude' : family === 'OpenAI' ? 'Codex' : undefined;
  if (!agent) return undefined;
  const model = agent === 'Claude' ? /(opus|sonnet|haiku)/i.exec(a.model)?.[1].toLowerCase() : a.model;
  if (!model) return undefined;
  const label = `${agent} (${model}${a.effort ? `/${a.effort}` : ''})`;
  return tryRef(label) ? label : undefined;
}
// The agent an attempt recorded for itself at `ae start`, from its provider; an unknown provider keeps its own text, so a
// refusal by it never counts as a refusal by the planned agent (fail closed).
function recordedAgent(a: { provider?: string; model?: string }): string | undefined {
  const t = a.provider?.trim().toLowerCase();
  if (!t) {
    // a model with no provider: the model's family names the agent; an unknown model keeps its own text (fail closed)
    const m = a.model?.trim();
    if (!m) return undefined;
    const f = familyOfText(m);
    return f === 'Claude' ? 'Claude' : f === 'OpenAI' ? 'Codex' : f === 'Gemini' ? 'Antigravity' : m.toLowerCase();
  }
  if (['claude', 'claudeagent', 'anthropic'].includes(t)) return 'Claude';
  if (['codex', 'openai'].includes(t)) return 'Codex';
  if (t === 'cursor') return 'Cursor';
  if (['antigravity', 'gemini', 'google'].includes(t)) return 'Antigravity';
  if (['grok', 'xai'].includes(t)) return 'Grok';
  return t;
}
// Who ran one attempt, for messages: what the attempt recorded for itself, else the replacement named by its handoff, else the slice's Model.
const attemptLabel = (s: Slice, rec: SliceRecord, a: Attempt) => recordedLabel(a)
  ?? (recordedAgent(a) ? `${recordedAgent(a)}${a.model ? ` (${a.model})` : ''}` : undefined)
  ?? (a.handoff === undefined ? undefined : rec.handoffs?.[a.handoff]?.to) ?? s.model;
// Every agent the journal names for one attempt: what it recorded, the handoff target, and the planned Model and Fallback only when
// neither exists. A refusal binds all of them: a switch away from any of them needs the provider-change decision (DEC-22).
const attemptAgents = (s: Slice, rec: SliceRecord, a: Attempt): string[] => {
  const out = [recordedAgent(a), a.handoff === undefined ? undefined : agentOf(rec.handoffs?.[a.handoff]?.to ?? '')].filter((x): x is string => !!x);
  if (out.length) return [...new Set(out)];
  // nothing recorded: the fix ladder may have launched the Model or the Fallback, so a refusal binds both (fail closed)
  return [...new Set([agentOf(s.model) ?? s.model, ...(s.fallback ? [agentOf(s.fallback) ?? s.fallback] : [])])];
};
const tryRef = (text: string | undefined): ModelRef | undefined => { try { return text?.trim() ? parseModelRef(text) : undefined; } catch { return undefined; } };

// ---- authorization (REQ-15) ----
// The pool is the approved pool of the policy: DEFAULT_POLICY, or the --policy file (read from the repo root), the
// same file `ae usage` ranks with.
function poolFor(c: RunCtx): string[] {
  const p = c.flags.get('policy');
  if (p === undefined) return DEFAULT_POLICY.pool;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve((c as { cwd?: string }).cwd ?? c.root, p), 'utf8')); } catch (e) {
    throw new Error(`${c.command}: cannot read --policy ${p}: ${e instanceof Error ? e.message : String(e)}. Nothing was written`);
  }
  return parsePolicy(raw).pool;
}

// The model texts that may work the slice: its Model and the Model's escalations, its Fallback, the pool, and the
// current worker (which got there by one of these). "fresh session" and other extras do not change the model.
export function authorizedLabels(s: Slice, rec: SliceRecord, pool: readonly string[]): string[] {
  const out = [s.model], m = tryRef(s.model);
  for (let k = 1; m && k <= 8; k++) { const e = escalate(m, k); if (!e) break; out.push(e.label); }
  if (tryRef(s.fallback)) out.push(s.fallback);
  out.push(...pool, currentLabel(s, rec));
  return [...new Set(out)];
}

export function isAuthorized(label: string, s: Slice, rec: SliceRecord, pool: readonly string[]): boolean {
  const ref = tryRef(label);
  if (!ref) return false;
  const keys = new Set(authorizedLabels(s, rec, pool).flatMap(x => { const r = tryRef(x); return r ? [modelKey(r)] : []; }));
  return keys.has(modelKey(ref));
}

function checkAuthorized(c: RunCtx, s: Slice, rec: SliceRecord, label: string, what: string) {
  const ref = tryRef(label);
  // the core reports text it cannot parse, and refuses user, CI, and Grok with its own message
  if (!ref || ref.agent === 'user' || ref.agent === 'CI' || ref.agent === 'Grok') return;
  const pool = poolFor(c);
  if (isAuthorized(label, s, rec, pool)) return;
  throw new Error(`${what} refused: ${ref.label} is not authorized for slice ${s.id}. Only the slice's Model (${s.model}, or its escalation), its Fallback (${s.fallback || 'none'}), the approved pool (${pool.join(', ')}), or the current worker qualify (REQ-15). Nothing was written`);
}

// ---- refusal (DEC-22, NOT-4, review-1 F17) ----
export const PROVIDER_CHANGE = 'provider-change';
const agentOf = (label: string) => tryRef(label)?.agent;

// The latest refusal on the slice and the agent that refused.
export function lastRefusal(s: Slice, rec: SliceRecord): { at: string; label: string; agent: string; agents: string[] } | undefined {
  let hit: { at: string; label: string; agents: string[] } | undefined;
  for (const a of rec.attempts) {
    if (a.kind !== 'work') continue;
    for (const i of a.interruptions ?? []) if (i.class === 'refusal' && (!hit || i.at >= hit.at)) hit = { at: i.at, label: attemptLabel(s, rec, a), agents: attemptAgents(s, rec, a) };
  }
  return hit && { ...hit, agent: hit.agents[0] };
}

const approvedAt = (d: Decision) => d.history.filter(h => h.status === 'approved').at(-1)?.at ?? d.updatedAt;
// An active, approved, not stale `provider-change` decision for this slice, approved at or after `since`.
export function providerChangeApproval(journal: Journal, slice: string, since: string, root?: string): Decision | undefined {
  return (journal.decisions ?? []).find(d => isActive(d) && d.key === PROVIDER_CHANGE && d.scope === `slice:${slice}` && d.status === 'approved'
    && approvedAt(d) >= since && !isStale(journal, d, root));
}

function checkRefusal(c: RunCtx, s: Slice, rec: SliceRecord, label: string, what: string) {
  const r = lastRefusal(s, rec), to = agentOf(label);
  if (!r || !to || r.agents.every(a => a.toLowerCase() === to.toLowerCase())) return;
  if (providerChangeApproval(c.journal, s.id, r.at, c.root)) return;
  throw new Error(`${what} refused: ${r.label} refused slice ${s.id} at ${r.at}. A switch to another provider (${label}) needs an approved RED decision ${PROVIDER_CHANGE} for slice:${s.id}, approved after the refusal (DEC-22). Ask the user; record the answer with ae decide PLAN ${s.id} --key ${PROVIDER_CHANGE} --risk red --status approved --source S; then prepare again. Nothing was written`);
}

// ---- reviewer families (REQ-17) ----
type ReviewerFamily = { family: Family | 'human' | undefined; from: string };
// --by as model text first; then --model or --provider (a family, or unknown); with none of these, the Review line.
// Compatibility (as slice 8): without a lead lease, a review that names no model is not checked, as before slice 9.
// Under a lease the Review line names the reviewer, so every review is checked.
function reviewerFamily(c: RunCtx, s: Slice): ReviewerFamily | undefined {
  const by = tryRef(c.flags.get('by'));
  if (by) return { family: familyOf(by), from: `--by ${by.label}` };
  const model = c.flags.get('model')?.trim(), provider = c.flags.get('provider')?.trim();
  if (model || provider) {
    const f = familyOfText(model) ?? familyOfProvider(provider);
    return { family: f, from: [model ? `--model ${model}` : '', provider ? `--provider ${provider}` : ''].filter(Boolean).join(' ') };
  }
  if (!leaseActive(c.journal.lead)) return undefined;
  return { family: familyOfText(s.review), from: `the slice's Review line (${s.review})` };
}

// The family of each work attempt: its recorded model, then its recorded provider, then the model text that ran it.
export function workFamilies(s: Slice, rec: SliceRecord): { n: number; label: string; family: Family | 'human' | undefined }[] {
  return rec.attempts.filter(a => a.kind === 'work').map(a => {
    const label = attemptLabel(s, rec, a);
    return { n: a.n, label, family: familyOfText(a.model) ?? familyOfProvider(a.provider) ?? familyOfText(label) };
  });
}

// Why a reviewer is not independent, or undefined when it is. A person is always independent of model work.
export function reviewerProblem(reviewer: ReviewerFamily, builders: ReturnType<typeof workFamilies>, slice: string): string | undefined {
  const rf = reviewer.family;
  if (rf === 'human') return undefined;
  if (!rf) return `the reviewer's model family is unknown (${reviewer.from}); Cursor (auto) and an unnamed model have no known family`;
  const same = builders.filter(b => b.family === rf);
  if (same.length) return `the reviewer's family ${rf} (${reviewer.from}) has work attempt ${same.map(b => `${b.n} (${b.label})`).join(', ')} on slice ${slice}`;
  const unknown = builders.filter(b => b.family === undefined);
  if (unknown.length) return `work attempt ${unknown.map(b => `${b.n} (${b.label})`).join(', ')} has no known model family, so independence cannot be shown`;
  return undefined;
}

// The exception given with a review, kept from guardWrite to the result hook of the same command.
const pendingException = new WeakMap<SliceRecord, { reason: string; problem: string }>();

function guardReviewer(c: RunCtx, s: Slice, rec: SliceRecord) {
  pendingException.delete(rec);
  // the core refuses a CI review and a slice in the wrong state with its own messages
  if (s.review === 'CI' || !(rec.state === 'AGENT_FINISHED' || (rec.state === 'REVIEWED' && c.flags.has('reject')))) return;
  const reviewer = reviewerFamily(c, s);
  const problem = reviewer && reviewerProblem(reviewer, workFamilies(s, rec), s.id);
  if (!problem) return;
  const reason = c.flags.get('exception')?.trim();
  if (!reason) throw new Error(`review refused: ${problem}. REQ-17 needs a reviewer of another model family; name it with --by "Claude (opus/medium)" or --model, or record why not with --exception REASON. Nothing was written`);
  pendingException.set(rec, { reason, problem });
}

// ---- stops with no progress (REQ-16) ----
export const NO_PROGRESS_STOPS = 3;
// The interruptions since the last unblock, oldest first, across every work attempt: a handoff keeps them (A to B to C).
const stopsSince = (rec: SliceRecord) => rec.attempts.slice(rec.budgetFrom ?? 0).filter(a => a.kind === 'work').flatMap(a => a.interruptions ?? []);

// ---- recovery options (Design "Recovery options"; DEC-11, DEC-23) ----
export const WAIT_MAX_MIN = 60;
// P3 passed (same thread, other provider is real). P5 and P6 are unknown, so they are assumed worst case (DEC-29).
export const PROBES = { P3: 'passed', P5: 'unknown', P6: 'unknown' } as const;
export type OptionNo = 1 | 2 | 3 | 4 | 5;
export type RecoveryOption = { n: OptionNo; name: string; identity: string; when: string; candidates?: string[] };
export type Recovery = {
  class: FailureClass; current: string; options: RecoveryOption[]; excluded: { n: OptionNo; reason: string }[];
  block?: string; decidedBy: string; switchBack: string;
};
const NAMES: Record<OptionNo, string> = {
  1: 'wait for T3 auto-resume', 2: 'resume the same thread', 3: "the same agent's CLI in the same workspace",
  4: 'same thread, other provider', 5: 'new child in the same workspace',
};
const IDENTITY: Record<OptionNo, string> = {
  1: 'same attempt', 2: 'same attempt; attach the new task as an alias', 3: 'handoff cli', 4: 'handoff resume-cross', 5: 'handoff new',
};
const RESUME_WHEN = 'after task_status is terminal (never working); t3_thread_send, then ae attach the new task id as an alias. Never while auto-resume may be armed (P5, P6 unknown)';
const SWITCH_BACK = 'never automatic: a return to an earlier agent is a new ae prepare by the Claude lead';

export type RankInput = {
  slice: { id?: string; model: string; fallback?: string }; current: string; i: Interruption;
  threadId?: string; deadline?: string; pool?: readonly string[];
  // Keeps only the labels the slice may use (the unchanged REQ-15 rules); a substituted worker's fresh session is not one of them.
  authorize?: (label: string) => boolean;
};

function waitable(i: Interruption, deadline?: string): { ok: boolean; why: string } {
  if (!i.resetAt) return { ok: false, why: 'no reset time was observed (T3 gives none, probe P4); a CLI JSON reset time maps with --reset-at' };
  const min = Math.ceil((Date.parse(i.resetAt) - Date.parse(i.at)) / 60000);
  if (min > WAIT_MAX_MIN) return { ok: false, why: `the reset ${i.resetAt} is ${min} minutes away, over ${WAIT_MAX_MIN}` };
  if (deadline && Date.parse(i.resetAt) >= Date.parse(deadline)) return { ok: false, why: `the reset ${i.resetAt} is not before the charter deadline ${deadline}` };
  return { ok: true, why: `the reset ${i.resetAt} is ${Math.max(0, min)} minutes away: wait, then read task_status; send nothing to the limited thread (P6)` };
}

// The options for one interruption, best first. Candidates come from rankCandidates (Fallback, then the pool, cheapest
// capable first; a fresh session of the same agent first where a new session helps). Every candidate is authorized.
export function rankOptions(input: RankInput): Recovery {
  const { slice, current, i, threadId, deadline } = input, cls = i.class;
  const policy = { ...DEFAULT_POLICY, pool: [...(input.pool ?? DEFAULT_POLICY.pool)] };
  const ranked = (fresh: boolean) => rankCandidates(slice, current, fresh, { agents: {} }, policy, { caps: null, host: 't3' }).candidates.map(x => x.label).filter(l => input.authorize?.(l) ?? true);
  const options: RecoveryOption[] = [], excluded: Recovery['excluded'] = [];
  const add = (n: OptionNo, when: string, candidates?: string[]) => options.push({ n, name: NAMES[n], identity: IDENTITY[n], when, ...(candidates ? { candidates } : {}) });
  const no = (n: OptionNo, reason: string) => excluded.push({ n, reason });
  const withCandidates = (n: OptionNo, when: string, list: string[]) => list.length ? add(n, when, list) : no(n, 'no authorized candidate qualifies (rank, capacity, or same agent)');
  const out = (block?: string): Recovery => ({
    class: cls, current, options, excluded: excluded.sort((a, b) => a.n - b.n), ...(block ? { block } : {}),
    decidedBy: 'the Claude lead (DEC-11): ae prepare --lead "Claude (...)"', switchBack: SWITCH_BACK,
  });
  const notQuota = () => no(1, 'option 1 is for a quota limit only');
  const accountLimit = () => {
    const others = ranked(false);
    if (threadId && !cliWorker(threadId)) withCandidates(4, `probe P3 passed: ae prepare, ae checkpoint, ae transfer --mode resume-cross; send the full packet (whether the new provider sees the earlier turns is unknown)`, others);
    else no(4, threadId ? 'the worker is a CLI process, not a T3 thread' : 'no T3 thread is bound to the attempt (ae attach it first)');
    withCandidates(5, 'the Fallback, then the pool, cheapest capable first; ae transfer --mode new', others);
  };
  switch (cls) {
    case 'refusal':
      for (const n of [1, 2, 3, 4, 5] as OptionNo[]) no(n, 'a refusal blocks the slice');
      return out(`BLOCKED: another provider needs an approved RED decision ${PROVIDER_CHANGE} for slice ${slice.id ?? 'N'} (DEC-22)`);
    case 'quota': {
      const w = waitable(i, deadline);
      if (w.ok) add(1, w.why); else no(1, w.why);
      no(2, 'T3 auto-resume may still own the thread (probes P5 and P6 unknown: worst case); never send to a limited thread');
      no(3, "the same agent's CLI shares the account limit");
      accountLimit();
      break;
    }
    case 'rate':
      notQuota(); add(2, RESUME_WHEN); no(3, "the same agent's CLI shares the account limit"); accountLimit();
      break;
    case 'api': case 'auth':
      notQuota(); add(2, RESUME_WHEN);
      if (input.authorize?.(current) ?? true) add(3, `after option 2 fails (DEC-11): ae prepare --to "${current}", ae checkpoint, ae transfer --mode cli; attach cli:<pid>@<host>`, [current]);
      else no(3, 'the current worker is not an authorized label for this slice, so its own CLI is not a valid replacement');
      no(4, 'option 4 is for an account limit');
      withCandidates(5, 'after option 3 fails: another provider, the Fallback, then the pool, cheapest capable first', ranked(false));
      break;
    case 'context':
      notQuota();
      no(2, 'the context window is full: the same thread cannot continue');
      no(3, 'a fresh session of the same agent (option 5) comes first');
      no(4, 'the same thread keeps the full context window');
      withCandidates(5, 'a fresh session of the same agent first, then the Fallback, then the pool; ae transfer --mode new', ranked(true));
      break;
    default: // process, tool, unknown
      notQuota(); add(2, RESUME_WHEN);
      no(3, 'option 3 is for an api or auth error (DEC-11)');
      no(4, 'option 4 is for an account limit');
      // an unknown class may be an account limit: only another agent is safe
      withCandidates(5, cls === 'unknown' ? 'the class is unknown, so another agent: the Fallback, then the pool' : 'a fresh session of the same agent first, then the Fallback, then the pool', ranked(cls !== 'unknown'));
  }
  return out(options.length ? undefined : 'no option qualifies: ae checkpoint, then ae block, and tell the user');
}

function recoveryFor(journal: Journal, s: Slice, rec: SliceRecord, pool: readonly string[] = DEFAULT_POLICY.pool): Recovery | undefined {
  const open = openWork(rec), i = openInterruptions(open).at(-1);
  if (!open || !i) return undefined;
  return rankOptions({ slice: s, current: workerLabel(s, rec), i, threadId: open.threadId, deadline: journal.run?.deadline, pool, authorize: l => isAuthorized(l, s, rec, pool) });
}

export const optionHooks: Hooks = {
  guardWrite(c, slice) {
    if (!slice) return;
    const { s, rec } = slice;
    if (c.command === 'prepare' && rec.state === 'IN_PROGRESS') {
      const to = c.flags.get('to');
      if (to) { checkAuthorized(c, s, rec, to, 'prepare'); checkRefusal(c, s, rec, to, 'prepare'); }
    }
    // the claim step moves ownership; the decision may have been superseded since prepare
    if (c.command === 'transfer' && rec.state === 'IN_PROGRESS') {
      const h = rec.handoffs?.at(-1);
      if (h && handoffOpen(h)) checkRefusal(c, s, rec, h.to, 'transfer');
    }
    // A refusal is recorded only by `ae interrupt --class refusal`: block and fail would drop it and leave the guard blind (slice 15 R3).
    if ((c.command === 'block' || c.command === 'fail') && (c.flags.get('class') === 'refusal' || (c.flags.get('code') !== undefined && classForCode(c.flags.get('code')!) === 'refusal'))) {
      throw new Error(`${c.command} refused: a refusal is recorded with ae interrupt --class refusal, which blocks the slice and arms the provider-change rule (DEC-22). Nothing was written`);
    }
    // The launch names the worker. After a refusal a launch as another provider is a provider switch (R4). With no launch flags the worker is
    // the one the fix ladder picks (failures 0 to 2: the Model, 3: the Fallback), so a bare `start` is checked too (slice 15 B1).
    // A transfer must launch the handoff target, also on the second call that attaches the task (N1).
    if (c.command === 'start' || c.command === 'transfer') {
      const flagged = c.flags.has('provider') || c.flags.has('model');
      if (c.command === 'start') {
        const launch = flagged ? recordedAgent({ provider: c.flags.get('provider'), model: c.flags.get('model') }) : agentOf(failures(rec).length >= 3 && s.fallback ? s.fallback : s.model);
        const r = launch ? lastRefusal(s, rec) : undefined;
        if (launch && r && !r.agents.every(a => a.toLowerCase() === launch.toLowerCase()) && !providerChangeApproval(c.journal, s.id, r.at, c.root)) {
          throw new Error(`start refused: ${r.label} refused slice ${s.id} at ${r.at}. A launch as ${launch}${flagged ? '' : ' (the fix ladder\'s pick; pass --provider and --model to name the worker)'} is a provider switch and needs an approved RED decision ${PROVIDER_CHANGE} for slice:${s.id}, approved after the refusal (DEC-22). Nothing was written`);
        }
      } else if (flagged) {
        const launch = recordedAgent({ provider: c.flags.get('provider'), model: c.flags.get('model') });
        const h = rec.handoffs?.at(-1), to = h && (handoffOpen(h) || h.phase === 'TRANSFERRED') ? agentOf(h.to) : undefined;
        if (launch && to && to.toLowerCase() !== launch.toLowerCase()) throw new Error(`transfer refused: the launch flags name ${launch}, but the handoff target is ${h!.to}. Launch the target, or prepare a new handoff. Nothing was written`);
      }
    }
    if (c.command === 'review') guardReviewer(c, s, rec);
  },

  guardEvent(c, event) { if (event === 'interrupt') guardClass(c); },

  interrupted(c, open, i) {
    if (!c.rec || !i) return undefined;
    if (i.class === 'refusal') {
      const who = attemptLabel(c.s, c.rec, open);
      return { block: { reason: `refusal by ${who}${i.code ? ` (${i.code})` : ''}: no provider switch until the user approves a ${PROVIDER_CHANGE} decision for slice ${c.s.id} (DEC-22)`, cause: 'refusal' } };
    }
    const last = stopsSince(c.rec).slice(-NO_PROGRESS_STOPS);
    if (last.length === NO_PROGRESS_STOPS && last.every(x => x.fingerprint === i.fingerprint)) {
      return { block: { reason: `escalate: ${NO_PROGRESS_STOPS} stops in a row with no fingerprint progress (${i.fingerprint}); tell the user the missing fact once, do not retry or transfer again`, cause: 'no-progress' } };
    }
    return undefined;
  },

  result(c) {
    if (c.command === 'interrupt') {
      if (c.rec.state === 'BLOCKED') {
        const i = c.rec.attempts.flatMap(a => a.interruptions ?? []).at(-1);
        return i ? { recovery: { class: i.class, current: workerLabel(c.s, c.rec), options: [], excluded: [], block: c.rec.blocker?.reason ?? 'BLOCKED', decidedBy: 'the user, then the Claude lead', switchBack: SWITCH_BACK } } : undefined;
      }
      const r = recoveryFor(c.journal, c.s, c.rec, poolFor(c));
      return r ? { recovery: r } : undefined;
    }
    if (c.command === 'review') {
      const x = pendingException.get(c.rec);
      if (!x) return undefined;
      pendingException.delete(c.rec);
      const a = [...c.rec.attempts].reverse().find(y => y.kind === 'review' && y.at === c.at);
      const note = `reviewer family exception: ${x.reason} (${x.problem})`.slice(0, 400);
      if (a) a.reason = a.reason ? `${a.reason}; ${note}`.slice(0, 600) : note;
      return { reviewerException: { reason: x.reason, problem: x.problem } };
    }
    return undefined;
  },

  recoverSection(journal, env) {
    if (!env) return undefined;
    const list = env.plan.slices.flatMap(s => {
      const rec = journal.slices[s.id];
      const r = rec && rec.state === 'IN_PROGRESS' ? recoveryFor(journal, s, rec) : undefined;
      return r ? [{ slice: s.id, ...r }] : [];
    });
    return list.length ? { recovery: list } : undefined;
  },
};
register('options', optionHooks);
