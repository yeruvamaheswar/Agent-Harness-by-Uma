// Typed hooks the core (ae.ts) calls. Each hook defaults to "do nothing": with no registered module, the engine
// behaves as at 66c3cd6. A track module (decisions.ts, failover.ts, progress.ts, options.ts) registers its hooks when
// it loads, so later tracks plug in without editing ae.ts. Slice 2 freezes this file.
import type { Attempt, Checkpoint, Handoff, Journal, SliceRecord } from './journal.ts';
import type { Plan, Slice } from './plan.ts';

// What every slice hook sees. `flags` are the parsed command flags (free text is already redacted).
// `skip` holds the engine's own files (plan, page, journal): they never count as slice work.
export type HookCtx = {
  journal: Journal; plan: Plan; slug: string; root: string; s: Slice; rec: SliceRecord; at: string;
  command: string; flags: ReadonlyMap<string, string>; skip: ReadonlySet<string>;
};
// Events that a worker or the lead reports about one attempt. A guard may refuse one by throwing; nothing is written then.
export type EventName = 'finish' | 'fail' | 'block' | 'interrupt' | 'checkpoint' | 'attach' | 'transfer';
export type OpenHow = 'start' | 'transfer' | 'unblock';

export interface Hooks {
  guardEvent?(c: HookCtx, event: EventName, open: Attempt | undefined): void;
  attemptOpened?(c: HookCtx, attempt: Attempt, how: OpenHow, prev: Attempt | undefined): void;
  attemptEnded?(c: HookCtx, attempt: Attempt): void;
  checkpointTaken?(c: HookCtx, cp: Checkpoint, open: Attempt | undefined): void;
  transferred?(c: HookCtx, h: Handoff, from: Attempt | undefined, to: Attempt): void;
  blocked?(c: HookCtx, reason: string): void;
  unblocked?(c: HookCtx, reason: string): void;
  // Read-only projections. A section with nothing to say returns undefined, so old outputs stay unchanged.
  statusSection?(journal: Journal): Record<string, unknown> | undefined;
  reportSection?(journal: Journal): Record<string, unknown> | undefined;
  recoverSection?(journal: Journal): Record<string, unknown> | undefined;
}

type SliceHook = Exclude<keyof Hooks, 'statusSection' | 'reportSection' | 'recoverSection'>;
type SectionHook = Exclude<keyof Hooks, SliceHook>;

const registered: { name: string; hooks: Hooks }[] = [];

// One registration per module name. Registering a name again replaces it (a test can load a module twice).
export function register(name: string, hooks: Hooks) {
  const i = registered.findIndex(r => r.name === name);
  if (i >= 0) registered[i] = { name, hooks }; else registered.push({ name, hooks });
}

export function runHook<K extends SliceHook>(name: K, ...args: Parameters<NonNullable<Hooks[K]>>) {
  for (const r of registered) (r.hooks[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
}

// Merges every module's section. Two modules that return the same key are a programming error.
export function sections(name: SectionHook, journal: Journal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of registered) {
    const part = r.hooks[name]?.(journal);
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (Object.hasOwn(out, k)) throw new Error(`hook ${name}: modules both return "${k}"`);
      out[k] = v;
    }
  }
  return out;
}
