// Identity of attempts and interruptions. Slice 1 holds the tracer part: the launch key recorded at start and at
// transfer, the refusal of an event that carries another attempt's key, and `ae interrupt`.
// Slice 8 adds attach, aliases, event binding without a key, the lead lease, and the zombie gate.
import { MAX_INTERRUPTIONS } from './contract.ts';
import type { FailureClass, Interruption, InterruptionSource } from './contract.ts';
import { register } from './hooks.ts';
import type { Attempt, SliceRecord } from './journal.ts';

// ae:<slug>#<slice>/a<n>. The lead passes it to delegate_task as clientRequestId and to the worker in its packet.
export const launchKeyFor = (slug: string, slice: string, n: number) => `ae:${slug}#${slice}/a${n}`;

export const openInterruptions = (a: Attempt | undefined) => (a?.interruptions ?? []).filter(i => !i.resolved);

// The first line of a checkpoint's `next` when the open attempt is interrupted (ACC shows `next` as text).
export const interruptionLine = (a: Attempt, i: Interruption) =>
  `interrupted: ${i.class}${i.code ? ` (${i.code})` : ''} at ${i.at}, source ${i.source}; attempt ${a.n} stays open`;

export type InterruptInput = {
  class: FailureClass; code?: string; source: InterruptionSource; retryable?: boolean; resetAt?: string; operation?: string;
  fingerprint: string; at: string;
};

// Annotates the open attempt. The attempt stays open and the fix budget does not move: an interruption is not a failure.
export function addInterruption(slice: string, open: Attempt | undefined, input: InterruptInput): Interruption {
  if (!open) throw new Error(`interrupt: slice ${slice} has no open work attempt; nothing was written`);
  const list = open.interruptions ?? [];
  if (list.length >= MAX_INTERRUPTIONS) throw new Error(`interrupt: attempt ${open.n} of slice ${slice} already has ${MAX_INTERRUPTIONS} interruptions; checkpoint and transfer it, or block the slice. Nothing was written`);
  const i: Interruption = {
    at: input.at, class: input.class, source: input.source, fingerprint: input.fingerprint,
    ...(input.code ? { code: input.code } : {}), ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.resetAt ? { resetAt: input.resetAt } : {}), ...(input.operation ? { operation: input.operation } : {}),
  };
  open.interruptions = [...list, i];
  return i;
}

// The attempt that holds a launch key: the latest one, so a worker that continues after unblock keeps its key.
const holder = (rec: SliceRecord, key: string) => [...rec.attempts].reverse().find(a => a.launchKey === key);

register('failover', {
  attemptOpened(c, attempt, how, prev) {
    // the same worker continues after unblock, so it keeps its key
    attempt.launchKey = how === 'unblock' && prev?.outcome === 'blocked' && prev.launchKey ? prev.launchKey : launchKeyFor(c.slug, c.s.id, attempt.n);
  },
  // An event that names a launch key must name the open attempt's key. A stale worker's event is refused.
  guardEvent(c, event, open) {
    const key = c.flags.get('launch-key');
    if (!key || (open && open.launchKey === key)) return;
    const owner = holder(c.rec, key);
    const whose = owner ? `belongs to attempt ${owner.n}, which is ${owner.outcome ?? 'open'}` : `matches no attempt of slice ${c.s.id}`;
    const now = open ? `attempt ${open.n}${open.launchKey ? ` (${open.launchKey})` : ''}` : 'none';
    throw new Error(`${event} refused: launch key ${key} ${whose}; the open attempt is ${now}. A replaced worker must stop. Nothing was written`);
  },
  checkpointTaken(c, cp, open) {
    const i = openInterruptions(open).at(-1);
    if (open && i) cp.next = interruptionLine(open, i) + (cp.next ? `\n${cp.next}` : '');
  },
  transferred(c, h, from, to) {
    for (const i of from?.interruptions ?? []) i.resolved ??= 'handed-off';
    if (to.launchKey) h.launchKey = to.launchKey;
  },
});
