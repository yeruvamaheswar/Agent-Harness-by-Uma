// Identity of attempts and interruptions, the lead lease, and the zombie gate.
// Slice 1 holds the tracer part: the launch key recorded at start and at transfer, the refusal of an event that
// carries another attempt's key, and `ae interrupt`. Slice 8 adds `attach` (thread, task, and task aliases), event
// binding by thread and task id, the lead lease (`ae lead`), the disarm gate on transfer, and the `recover` lists.
//
// Compatibility: a journal with no lease and attempts with no thread behave as before slice 8. The identity regime
// (journal nonce in new launch keys, lease checks on every write, disarm gate) starts when a lead claims the lease,
// or, for the disarm gate, when a thread is bound to the attempt that is transferred away.
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { MAX_INTERRUPTIONS, MAX_TASK_ALIASES } from './contract.ts';
import type { FailureClass, HandoffMode, Interruption, InterruptionSource, LeadLease } from './contract.ts';
import { register } from './hooks.ts';
import type { HookCtx, Hooks, RunCtx } from './hooks.ts';
import { fingerprint, pidAlive } from './journal.ts';
import type { Attempt, Journal, SliceRecord } from './journal.ts';

// ae:<slug>#<slice>/a<n>, or ae:<slug>~<nonce>#<slice>/a<n> under a lease (review-1 F4). The lead passes it to
// delegate_task as clientRequestId and to the worker in its packet.
export const launchKeyFor = (slug: string, slice: string, n: number, nonce?: string) => `ae:${slug}${nonce ? `~${nonce}` : ''}#${slice}/a${n}`;
// T3 dedupes a clientRequestId only inside one MCP session (probe P1), so a key must not repeat across journals.
// 6 hex of the journal's creation time and plan name: a re-created journal, or a same-named plan elsewhere, differs.
export const journalNonce = (j: Journal) => createHash('sha256').update(`${j.createdAt}\0${j.plan}`).digest('hex').slice(0, 6);
// The clientRequestId of resend k of an attempt (t3_thread_send makes a new task under the same thread, probe P2).
export const resendKey = (key: string, k: number) => `${key}/r${k}`;

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

// ---- lead lease (REQ-21, NOT-12, DEC-18) ----
export const LEASE_TTL_S = 2 * 60 * 60;
const MAX_LEASE_HISTORY = 20;
const LEAD_ID = /^[A-Za-z0-9._:@/-]{1,200}$/;
// A released lease is kept for its history, but nobody holds it.
export const leaseActive = (l: LeadLease | undefined): l is LeadLease => !!l && l.history.at(-1)?.event !== 'release';
export const leaseStale = (l: LeadLease, at: string) => Date.parse(at) - Date.parse(l.renewedAt) > l.ttlS * 1000;
const staleAt = (l: LeadLease) => new Date(Date.parse(l.renewedAt) + l.ttlS * 1000).toISOString();
// `at` is the command's clock. A read-only section has no clock, so it shows staleAt only.
const leaseView = (l: LeadLease, at?: string) => ({ id: l.id, label: l.label, claimedAt: l.claimedAt, renewedAt: l.renewedAt, staleAt: staleAt(l), ...(at ? { stale: leaseStale(l, at) } : {}), ...(leaseActive(l) ? {} : { released: true }) });
const pushHistory = (l: LeadLease, e: LeadLease['history'][number]) => { l.history = [...l.history, e].slice(-MAX_LEASE_HISTORY); };
// `status` only reads (its one write is the same housekeeping sync as every command). `lead` checks the lease itself.
const LEASE_FREE = new Set(['status', 'lead']);

function leadId(c: RunCtx, what: string): string {
  const id = c.flags.get('lead-id')?.trim();
  if (!id) throw new Error(`${what}: --lead-id ID is required (the T3 parentThreadId or the Claude Code session id). Nothing was written`);
  if (!LEAD_ID.test(id)) throw new Error(`${what}: --lead-id "${id}" must be 1 to 200 letters, digits, or . _ : @ / -. Nothing was written`);
  return id;
}

// Every journal write carries the holder's --lead-id while a lease is held, and renews it. A worker's own checkpoint
// (--launch-key) is the one write a non-holder makes; guardEvent checks its key.
function guardLease(c: RunCtx) {
  const l = c.journal.lead;
  if (!leaseActive(l) || LEASE_FREE.has(c.command)) return;
  if (c.command === 'checkpoint' && c.flags.has('launch-key')) return;
  const id = c.flags.get('lead-id')?.trim();
  const who = `the lead lease is held by ${l.id} (${l.label}, renewed ${l.renewedAt}${leaseStale(l, c.at) ? ', stale' : ''})`;
  if (!id) throw new Error(`${c.command} refused: ${who}; every write needs --lead-id ${l.id}. A worker runs only ae checkpoint --launch-key K. Nothing was written`);
  if (id !== l.id) throw new Error(`${c.command} refused: ${who}; --lead-id ${id} is not the holder. A replaced lead writes nothing; a successor runs ae lead --takeover first. Nothing was written`);
  l.renewedAt = c.at;
}

function leadCommand(c: RunCtx) {
  if ('s' in c) throw new Error('lead: takes no SLICE; run ae lead PLAN --claim --lead-id ID --label L. Nothing was written');
  const f = c.flags, l = c.journal.lead;
  const acts = (['claim', 'takeover', 'release'] as const).filter(x => f.has(x));
  if (acts.length > 1) throw new Error(`lead: use one of --claim, --takeover, --release, not ${acts.map(x => `--${x}`).join(' and ')}. Nothing was written`);
  if (!acts.length) return { ...(l ? { lease: leaseView(l, c.at) } : {}), next: l ? 'ae lead --claim renews it (holder only)' : 'ae lead PLAN --claim --lead-id ID --label L' };
  const id = leadId(c, `lead --${acts[0]}`), label = f.get('label')?.trim();
  if (acts[0] === 'release') {
    if (!leaseActive(l)) throw new Error('lead --release: no lead holds the lease. Nothing was written');
    if (l.id !== id) throw new Error(`lead --release refused: the lease is held by ${l.id}, not ${id}. Nothing was written`);
    pushHistory(l, { at: c.at, id, event: 'release' });
    return { lease: leaseView(l, c.at), released: true, next: 'writes need no --lead-id until a lead claims the lease again' };
  }
  if (acts[0] === 'claim') {
    if (leaseActive(l) && l.id !== id) {
      throw new Error(`lead --claim refused: the lease is held by ${l.id} (${l.label}), renewed ${l.renewedAt}, ${leaseStale(l, c.at) ? 'stale' : `fresh until ${staleAt(l)}`}. One lead at a time (NOT-12). A successor checks that the predecessor is not running, then runs ae lead --takeover --lead-id ${id} --reason R --observed "<predecessor status and time>". Nothing was written`);
    }
    if (leaseActive(l)) { l.renewedAt = c.at; if (label) l.label = label; return { lease: leaseView(l, c.at), renewed: true }; }
    if (!label) throw new Error('lead --claim: --label is required, such as "Claude (opus/high)". Nothing was written');
    const lease: LeadLease = { id, label, claimedAt: c.at, renewedAt: c.at, ttlS: LEASE_TTL_S, history: [...(c.journal.lead?.history ?? []), { at: c.at, id, event: 'claim' as const }].slice(-MAX_LEASE_HISTORY) };
    c.journal.lead = lease;
    return { lease: leaseView(lease, c.at), claimed: true, next: 'pass --lead-id with every write; new launch keys carry the journal nonce' };
  }
  // takeover: with a reason and the observed predecessor status, fresh or stale (Accept 3, Continuity charter step 4)
  const reason = f.get('reason')?.trim(), observed = f.get('observed')?.trim();
  if (!reason || !observed) throw new Error('lead --takeover: --reason R and --observed "<predecessor status and time>" are both required. Nothing was written');
  if (leaseActive(l) && l.id === id) { l.renewedAt = c.at; return { lease: leaseView(l, c.at), renewed: true, note: 'you already hold the lease' }; }
  const prev = leaseActive(l) ? { id: l.id, label: l.label, renewedAt: l.renewedAt, stale: leaseStale(l, c.at) } : null;
  const lease: LeadLease = {
    id, label: label ?? id, claimedAt: c.at, renewedAt: c.at, ttlS: LEASE_TTL_S,
    history: [...(l?.history ?? []), { at: c.at, id, event: 'takeover' as const, reason: `${reason}; observed: ${observed}${prev ? `; from ${prev.id}${prev.stale ? ' (stale)' : ' (fresh)'}` : ''}`.slice(0, 400) }].slice(-MAX_LEASE_HISTORY),
  };
  c.journal.lead = lease;
  return { lease: leaseView(lease, c.at), takeover: true, ...(prev ? { from: prev } : {}), next: 'the predecessor writes nothing more: its --lead-id is refused. Run ae status, ae recover, then ae next' };
}

// ---- binding: thread, task, and aliases (REQ-14) ----
// A CLI worker has no T3 thread. Its thread id is cli:<pid>@<host>, so `transfer` and `recover` can check pidAlive.
const CLI_THREAD = /^cli:(\d+)@(.+)$/;
export const cliWorker = (thread: string | undefined) => { const m = thread ? CLI_THREAD.exec(thread) : null; return m ? { pid: Number(m[1]), host: m[2] } : undefined; };
const cliAlive = (thread: string | undefined) => { const w = cliWorker(thread); return w && w.host === hostname() ? pidAlive(w.pid) : undefined; };
const IDENT = /^[A-Za-z0-9._:@/%#~+=-]{1,300}$/;
const ident = (name: string, v: string) => { if (!IDENT.test(v)) throw new Error(`attach: --${name} "${v}" is not an id (1 to 300 characters, no spaces). Nothing was written`); return v; };

// The attempt that holds a launch key, thread, or task: the latest one, so a worker that continues after unblock keeps its key.
const holder = (rec: SliceRecord, pick: (a: Attempt) => boolean) => [...rec.attempts].reverse().find(pick);
const ownsTask = (a: Attempt, t: string) => a.taskId === t || (a.taskAliases ?? []).includes(t);
const describe = (owner: Attempt | undefined, slice: string) => owner ? `belongs to attempt ${owner.n}, which is ${owner.outcome ?? 'open'}` : `matches no attempt of slice ${slice}`;
const openText = (open: Attempt | undefined) => open ? `attempt ${open.n}${open.launchKey ? ` (${open.launchKey})` : ''}` : 'none';

function attachCommand(c: RunCtx) {
  if (!('s' in c)) throw new Error('attach: SLICE is required: ae attach PLAN SLICE --launch-key K --thread-id T [--task-id X]. Nothing was written');
  const h = c as HookCtx, { s, rec } = h, f = c.flags;
  if (rec.state !== 'IN_PROGRESS') throw new Error(`attach: slice ${s.id} is ${rec.state}; only an open attempt of an IN_PROGRESS slice binds a thread. Nothing was written`);
  const open = [...rec.attempts].reverse().find(a => a.kind === 'work' && !a.outcome);
  if (!open) throw new Error(`attach: slice ${s.id} has no open work attempt. Nothing was written`);
  if (open.launchKey && !f.has('launch-key')) throw new Error(`attach: --launch-key ${open.launchKey} is required: it is the key you searched for. Nothing was written`);
  const thread = f.get('thread-id') ? ident('thread-id', f.get('thread-id')!) : undefined, task = f.get('task-id') ? ident('task-id', f.get('task-id')!) : undefined;
  if (!thread && !task) throw new Error('attach: give --thread-id T, --task-id X, or both. Nothing was written');
  if (cliWorker(thread) && !(cliWorker(thread)!.pid > 0)) throw new Error(`attach: --thread-id ${thread} must be cli:<pid>@<host> with a pid above 0. Nothing was written`);
  const ho = open.handoff === undefined ? undefined : rec.handoffs?.[open.handoff];
  let bound: 'bound' | 'alias' | 'unchanged' = 'unchanged';
  const notes: string[] = [];
  if (thread && open.threadId !== thread) {
    if (open.threadId) throw new Error(`attach refused: attempt ${open.n} is bound to thread ${open.threadId}; thread ${thread} would be a second child for launch ${open.launchKey ?? open.n}. Cancel the duplicate; attach never rebinds. Nothing was written`);
    const old = holder(rec, a => a !== open && a.threadId === thread);
    if (old && ho?.mode !== 'resume-cross') throw new Error(`attach refused: thread ${thread} ${describe(old, s.id)}; binding it to attempt ${open.n} would revive a replaced worker. Nothing was written`);
    // Zombie gate: a replacement binds only when the files still match the checkpoint the transfer used (Plan B).
    if (ho?.checkpointAt) {
      const cp = (rec.checkpoints ?? []).find(x => x.at === ho.checkpointAt), now = fingerprint(c.root, s.files, c.skip);
      if (cp && cp.fingerprint !== now) {
        const observed = f.get('observed')?.trim();
        if (!observed) throw new Error(`attach refused: slice ${s.id} files changed after the checkpoint of the transfer (${cp.fingerprint} -> ${now}). The old worker may still be writing. Check its task_status; if the change is the replacement's own work, attach again with --observed "<old task status and time>". Nothing was written`);
        notes.push(`files changed since checkpoint ${cp.at} (${cp.fingerprint} -> ${now}); lead observed: ${observed}`.slice(0, 400));
      }
    }
    open.threadId = thread; bound = 'bound';
    if (ho) ho.threadId = thread;
  }
  if (task && !ownsTask(open, task)) {
    const other = holder(rec, a => a !== open && ownsTask(a, task));
    if (other) throw new Error(`attach refused: task ${task} ${describe(other, s.id)}; the open attempt is ${openText(open)}. Nothing was written`);
    if (!open.taskId) { open.taskId = task; if (bound === 'unchanged') bound = 'bound'; }
    else {
      // A resend (t3_thread_send) runs the same attempt under a new task id (probe P2): an alias, on the bound thread only.
      if (!thread || thread !== open.threadId) throw new Error(`attach refused: attempt ${open.n} already has task ${open.taskId}; a new task ${task} is an alias only on the bound thread${open.threadId ? ` (pass --thread-id ${open.threadId})` : ' (bind the thread first)'}. Nothing was written`);
      const aliases = open.taskAliases ?? [];
      if (aliases.length >= MAX_TASK_ALIASES) throw new Error(`attach refused: attempt ${open.n} has ${MAX_TASK_ALIASES} task aliases; checkpoint and transfer it instead of another resend. Nothing was written`);
      open.taskAliases = [...aliases, task]; bound = 'alias';
    }
  }
  if (ho && notes.length) ho.history.push({ at: c.at, phase: ho.phase, note: notes[0] });
  const n = (open.taskAliases?.length ?? 0) + 1;
  return {
    slice: s.id, attempt: open.n, attached: bound, ...(open.launchKey ? { launchKey: open.launchKey } : {}),
    ...(open.threadId ? { threadId: open.threadId } : {}), ...(open.taskId ? { taskId: open.taskId } : {}), ...(open.taskAliases?.length ? { taskAliases: open.taskAliases } : {}),
    ...(open.launchKey ? { resendKey: resendKey(open.launchKey, n) } : {}), ...(notes.length ? { note: notes[0] } : {}),
    next: bound === 'unchanged' ? 'already bound: this launch was found, not relaunched' : 'events of this attempt may now name --thread-id or --task-id',
  };
}

// ---- event binding (REQ-14; review-1 F10) ----
const OUTCOME_EVENTS = new Set(['finish', 'fail', 'block']);
function guardIdentity(c: HookCtx, event: string, open: Attempt | undefined) {
  const f = c.flags, key = f.get('launch-key');
  if (key && !(open && open.launchKey === key)) {
    const owner = holder(c.rec, a => a.launchKey === key);
    throw new Error(`${event} refused: launch key ${key} ${describe(owner, c.s.id)}; the open attempt is ${openText(open)}. A replaced worker must stop. Nothing was written`);
  }
  // attach binds these values; transfer names the replacement's task
  if (event === 'attach' || event === 'transfer') return;
  const thread = f.get('thread-id'), task = f.get('task-id');
  if (thread && !(open && open.threadId === thread)) {
    const owner = holder(c.rec, a => a.threadId === thread);
    throw new Error(`${event} refused: thread ${thread} ${owner ? describe(owner, c.s.id) : `is not bound to slice ${c.s.id} (ae attach binds it)`}; the open attempt is ${openText(open)}. Nothing was written`);
  }
  if (task && !(open && ownsTask(open, task))) {
    const owner = holder(c.rec, a => ownsTask(a, task));
    throw new Error(`${event} refused: task ${task} ${owner ? describe(owner, c.s.id) : `is not bound to slice ${c.s.id} (ae attach binds it)`}; the open attempt is ${openText(open)}. Nothing was written`);
  }
  // While an interruption is open, an outcome needs identity: the attempt's key, thread, or task, or the lease holder.
  if (OUTCOME_EVENTS.has(event) && open?.launchKey && openInterruptions(open).length && !key && !thread && !task) {
    const l = c.journal.lead;
    if (!(leaseActive(l) && f.get('lead-id')?.trim() === l.id)) {
      throw new Error(`${event} refused: attempt ${open.n} of slice ${c.s.id} has an open interruption, and this event names no identity. Pass --launch-key ${open.launchKey}${open.threadId ? `, --thread-id ${open.threadId}` : ''}${leaseActive(l) ? `, or --lead-id ${l.id}` : ''}. A stale worker's report is refused. Nothing was written`);
    }
  }
}

// ---- zombie gate on transfer (review-1 F15; probe P5 is pending, so every old thread may resume) ----
const TERMINAL = ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'];
export const DISARM_METHODS = ['cancel', 'configure-away', 'exited'] as const;
const MODES: readonly HandoffMode[] = ['resume-cross', 'cli', 'new'];
const parseMode = (v: string | undefined): HandoffMode | undefined => {
  if (v === undefined) return undefined;
  if (!(MODES as readonly string[]).includes(v)) throw new Error(`transfer: unknown --mode "${v}"; use ${MODES.join(', ')}. Nothing was written`);
  return v as HandoffMode;
};
// --disarmed STATUS,METHOD[,READ_AT]: the old task's observed terminal task_status, how it was disarmed, and when it was read.
export function parseDisarmed(v: string | undefined, at: string): { status: string; method: string; readAt: string } {
  if (!v?.trim()) throw new Error(`transfer refused: the old worker may resume (every T3 thread may, until probe P5 says otherwise). Pass --disarmed STATUS,METHOD[,READ_AT]: the observed terminal task_status (${TERMINAL.join(', ')}) and the method (${DISARM_METHODS.join(', ')}). Nothing was written`);
  const [status = '', method = '', readAt] = v.split(',').map(x => x.trim());
  if (status === 'working') throw new Error('transfer refused: task_status working means T3 is in a restart continuation, so the old worker may still write. Wait for a terminal status, disarm it, then transfer. Nothing was written');
  if (!TERMINAL.includes(status)) throw new Error(`transfer refused: --disarmed status "${status}" is not terminal; use ${TERMINAL.join(', ')}. Nothing was written`);
  if (!(DISARM_METHODS as readonly string[]).includes(method)) throw new Error(`transfer refused: --disarmed method "${method}" is not one of ${DISARM_METHODS.join(', ')}. Nothing was written`);
  if (readAt !== undefined && Number.isNaN(Date.parse(readAt))) throw new Error(`transfer refused: --disarmed read time "${readAt}" is not an ISO time. Nothing was written`);
  return { status, method, readAt: readAt ? new Date(Date.parse(readAt)).toISOString() : at };
}

// Runs before ae.ts moves ownership. Only the claim step (a CHECKPOINTED handoff) is gated; the --task-id step is not.
function guardTransfer(c: HookCtx, open: Attempt | undefined) {
  const h = c.rec.handoffs?.at(-1), f = c.flags;
  if (h?.phase !== 'CHECKPOINTED') return;
  const mode = parseMode(f.get('mode')), alive = cliAlive(open?.threadId);
  if (alive) throw new Error(`transfer refused: the CLI worker of attempt ${open!.n} (${open!.threadId}) is alive (pidAlive). Stop it first; --disarmed does not override a live process. Nothing was written`);
  if (mode === 'resume-cross') {
    if (!open?.threadId || cliWorker(open.threadId)) throw new Error(`transfer: --mode resume-cross keeps the T3 thread of attempt ${open?.n ?? 'none'}, which has ${open?.threadId ? 'a CLI worker' : 'no bound thread (ae attach first)'}. Nothing was written`);
    if (f.has('disarmed')) parseDisarmed(f.get('disarmed'), c.at);
    return;
  }
  if (leaseActive(c.journal.lead) || open?.threadId || f.has('disarmed')) parseDisarmed(f.get('disarmed'), c.at);
}

// ---- recover and status ----
function unattached(journal: Journal) {
  return Object.entries(journal.slices).flatMap(([id, rec]) => {
    if (rec.state !== 'IN_PROGRESS') return [];
    const a = [...rec.attempts].reverse().find(x => x.kind === 'work' && !x.outcome);
    if (!a?.launchKey || a.threadId || a.taskId) return [];
    return [{ slice: id, attempt: a.n, launchKey: a.launchKey, since: a.at,
      next: `search T3 threads for ${a.launchKey} (in the same MCP session, the task id ends in delegate-task:<the key, URL-encoded>); attach it with ae attach PLAN ${id} --launch-key ${a.launchKey} --thread-id T --task-id X. Never relaunch blindly` }];
  });
}
function cliWorkers(journal: Journal) {
  return Object.entries(journal.slices).flatMap(([id, rec]) => rec.attempts.filter(a => a.kind === 'work' && !a.outcome && cliWorker(a.threadId)).map(a => {
    const w = cliWorker(a.threadId)!, alive = cliAlive(a.threadId);
    return { slice: id, attempt: a.n, pid: w.pid, host: w.host, alive: alive ?? 'unknown (another host)' };
  }));
}

export const identityHooks: Hooks = {
  guardWrite(c) { guardLease(c); },
  attemptOpened(c, attempt, how, prev) {
    // the same worker continues after unblock, so it keeps its key
    if (how === 'unblock' && prev?.outcome === 'blocked' && prev.launchKey) {
      attempt.launchKey = prev.launchKey;
      if (prev.threadId) attempt.threadId = prev.threadId;
      if (prev.taskId && !attempt.taskId) attempt.taskId = prev.taskId;
      if (prev.taskAliases?.length) attempt.taskAliases = [...prev.taskAliases];
      return;
    }
    attempt.launchKey = launchKeyFor(c.slug, c.s.id, attempt.n, c.journal.lead ? journalNonce(c.journal) : undefined);
  },
  // An event must name the open attempt's key, thread, or task. A stale worker's event is refused.
  guardEvent(c, event, open) {
    guardIdentity(c, event, open);
    if (event === 'transfer') guardTransfer(c, open);
  },
  checkpointTaken(c, cp, open) {
    const i = openInterruptions(open).at(-1);
    if (open && i) cp.next = interruptionLine(open, i) + (cp.next ? `\n${cp.next}` : '');
  },
  transferred(c, h, from, to) {
    for (const i of from?.interruptions ?? []) i.resolved ??= 'handed-off';
    if (to.launchKey) h.launchKey = to.launchKey;
    const mode = parseMode(c.flags.get('mode'));
    if (mode) h.mode = mode;
    if (c.flags.has('disarmed')) h.disarmed = parseDisarmed(c.flags.get('disarmed'), c.at);
    // the same thread runs on another provider: the new attempt owns it
    if (mode === 'resume-cross' && from?.threadId) { to.threadId = from.threadId; h.threadId = from.threadId; }
  },
  commands: { attach: attachCommand, lead: leadCommand },
  statusSection(journal) {
    return journal.lead ? { lease: leaseView(journal.lead) } : undefined;
  },
  recoverSection(journal) {
    const u = unattached(journal), w = cliWorkers(journal), l = journal.lead;
    if (!u.length && !w.length && !l) return undefined;
    return { ...(l ? { lease: leaseView(l) } : {}), ...(u.length ? { unattached: u } : {}), ...(w.length ? { cliWorkers: w } : {}) };
  },
};
register('failover', identityHooks);
