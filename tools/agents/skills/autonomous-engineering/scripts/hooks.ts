// Typed hooks the core (ae.ts) calls. Each hook defaults to "do nothing": with no registered module, the engine
// behaves as at 66c3cd6. A track module (decisions.ts, failover.ts, progress.ts, options.ts) registers its hooks when
// it loads, so later tracks plug in without editing ae.ts. Slice 2 freezes this file (tests/ae-freeze.test.ts).
//
// Order: modules run in registration order, which is import order. No hook may depend on another module's hook
// having run first. Two modules that need an order are one module.
//
// Wiring (review-1 finding F1): slice 1 calls guardEvent, attemptOpened, attemptEnded, checkpointTaken, transferred,
// blocked, unblocked, and the three sections. guardWrite, commands, decided, interrupted, result, decisionStale, and
// the section env are frozen here and wired into ae.ts and packet.ts by one lead patch before wave 3.
import type { BlockerCause, Decision, Interruption } from './contract.ts';
import type { Attempt, Checkpoint, Handoff, Journal, SliceRecord } from './journal.ts';
import type { Plan, Slice } from './plan.ts';

// What every hook sees. `flags` are the parsed command flags (free text is already redacted).
// `skip` holds the engine's own files (plan, page, journal): they never count as slice work.
export type RunCtx = {
  journal: Journal; plan: Plan; slug: string; root: string; at: string;
  command: string; flags: ReadonlyMap<string, string>; skip: ReadonlySet<string>;
};
// What a slice hook sees.
export type HookCtx = RunCtx & { s: Slice; rec: SliceRecord };
// What a read-only section sees, when the caller has it (decision staleness by watched file needs the root).
export type SectionEnv = { root: string; plan: Plan; skip: ReadonlySet<string> };
// Events that a worker or the lead reports about one attempt. A guard may refuse one by throwing; nothing is written then.
export type EventName = 'finish' | 'fail' | 'block' | 'interrupt' | 'checkpoint' | 'attach' | 'transfer';
export type OpenHow = 'start' | 'transfer' | 'unblock';
// Commands whose handler a track module provides. ae.ts keeps a stub that refuses when no module provides one.
export type ModuleCommand = 'attach' | 'lead';
export type CommandResult = Record<string, unknown>;

export interface Hooks {
  // Before any command that writes the journal, before its handler runs (lead lease, authorization, reviewer family).
  guardWrite?(c: RunCtx, slice: { s: Slice; rec: SliceRecord } | undefined): void;
  guardEvent?(c: HookCtx, event: EventName, open: Attempt | undefined): void;
  attemptOpened?(c: HookCtx, attempt: Attempt, how: OpenHow, prev: Attempt | undefined): void;
  attemptEnded?(c: HookCtx, attempt: Attempt): void;
  checkpointTaken?(c: HookCtx, cp: Checkpoint, open: Attempt | undefined): void;
  transferred?(c: HookCtx, h: Handoff, from: Attempt | undefined, to: Attempt): void;
  blocked?(c: HookCtx, reason: string): void;
  unblocked?(c: HookCtx, reason: string): void;
  // After `ae decide` writes: a module reads its own flags (watch, supersedes, evidence) and fills the decision.
  decided?(c: RunCtx, d: Decision, created: boolean): void;
  // After an interruption is recorded. A module may ask the engine to block the slice (a refusal, or no progress).
  interrupted?(c: HookCtx, open: Attempt, i: Interruption): { block: { reason: string; cause: BlockerCause } } | undefined;
  // Extra output fields of a slice command (such as `loop: 'same-blocker'`). They never replace the core's fields.
  result?(c: HookCtx, out: Readonly<CommandResult>): CommandResult | undefined;
  commands?: Partial<Record<ModuleCommand, (c: RunCtx) => CommandResult>>;
  // The packet and `ae decisions` mark a settled decision "re-check" when any module says it is stale.
  decisionStale?(journal: Journal, d: Decision, root: string): boolean;
  // Read-only projections. A section with nothing to say returns undefined, so old outputs stay unchanged.
  statusSection?(journal: Journal, env?: SectionEnv): Record<string, unknown> | undefined;
  reportSection?(journal: Journal, env?: SectionEnv): Record<string, unknown> | undefined;
  recoverSection?(journal: Journal, env?: SectionEnv): Record<string, unknown> | undefined;
}

type VoidHook = 'guardWrite' | 'guardEvent' | 'attemptOpened' | 'attemptEnded' | 'checkpointTaken' | 'transferred' | 'blocked' | 'unblocked' | 'decided';
type SectionHook = 'statusSection' | 'reportSection' | 'recoverSection';

const registered: { name: string; hooks: Hooks }[] = [];

// One registration per module name. Registering a name again replaces it (a test can load a module twice).
export function register(name: string, hooks: Hooks) {
  const i = registered.findIndex(r => r.name === name);
  if (i >= 0) registered[i] = { name, hooks }; else registered.push({ name, hooks });
}

export function runHook<K extends VoidHook>(name: K, ...args: Parameters<NonNullable<Hooks[K]>>) {
  for (const r of registered) (r.hooks[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
}

// Merges every module's section. Two modules that return the same key are a programming error.
export function sections(name: SectionHook, journal: Journal, env?: SectionEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of registered) merge(out, r.hooks[name]?.(journal, env), `hook ${name}`);
  return out;
}

// The first block request of any module, or undefined.
export function interruptedHook(c: HookCtx, open: Attempt, i: Interruption) {
  for (const r of registered) { const x = r.hooks.interrupted?.(c, open, i); if (x) return x; }
  return undefined;
}

// Extra fields for a command's output. A field the core already returns, or two modules return, is an error.
export function resultFields(c: HookCtx, out: Readonly<CommandResult>): CommandResult {
  const extra: CommandResult = {};
  for (const r of registered) {
    const part = r.hooks.result?.(c, out);
    if (part) for (const k of Object.keys(part)) if (Object.hasOwn(out, k)) throw new Error(`hook result: module ${r.name} returns "${k}", which ${c.command} already returns`);
    merge(extra, part, 'hook result');
  }
  return extra;
}

// The handler of a module command, or undefined when no module provides it. Two providers are an error.
export function moduleCommand(name: ModuleCommand): ((c: RunCtx) => CommandResult) | undefined {
  const found = registered.filter(r => r.hooks.commands?.[name]);
  if (found.length > 1) throw new Error(`hook commands: modules ${found.map(r => r.name).join(' and ')} both provide ${name}`);
  return found[0]?.hooks.commands?.[name];
}

export const decisionStale = (journal: Journal, d: Decision, root: string) => registered.some(r => r.hooks.decisionStale?.(journal, d, root) === true);

function merge(out: Record<string, unknown>, part: Record<string, unknown> | undefined, what: string) {
  if (!part) return;
  for (const [k, v] of Object.entries(part)) {
    if (Object.hasOwn(out, k)) throw new Error(`${what}: modules both return "${k}"`);
    out[k] = v;
  }
}
