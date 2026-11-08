// Journal contract additions (plans/unified-agent-harness-master.md, Design, "Journal contract").
// Every field here is optional and additive. `schemaVersion` stays 1. The engine never writes null.
// An absent field means the 66c3cd6 behavior. An old journal loads unchanged.
// Slice 1 implements this file; slice 2 freezes it. Later changes go through the lead.
// This file imports nothing, so every module can import it without a cycle.

export type Risk = 'green' | 'amber' | 'red';
export const RISKS: readonly Risk[] = ['green', 'amber', 'red'];

export type DecisionStatus = 'proposed' | 'assumed' | 'approved' | 'blocked' | 'superseded';
export const DECISION_STATUSES: readonly DecisionStatus[] = ['proposed', 'assumed', 'approved', 'blocked', 'superseded'];

export type FailureClass = 'quota' | 'rate' | 'context' | 'api' | 'auth' | 'process' | 'tool' | 'refusal' | 'unknown';
export const FAILURE_CLASSES: readonly FailureClass[] = ['quota', 'rate', 'context', 'api', 'auth', 'process', 'tool', 'refusal', 'unknown'];

export type DecisionScope = 'run' | `slice:${string}`;

// journal.decisions, at most MAX_DECISIONS. Only the lead writes them (DEC-18).
export interface Decision {
  id: string; key: string; scope: DecisionScope; risk: Risk; status: DecisionStatus;
  question: string; answer?: string; recommended?: string; by: string; // lease id or lead label
  source?: string; provenance?: 'attested'; evidence?: string[]; rollback?: string;
  sliceDigest?: string; watch?: { path: string; fp: string; fpv: number }[];
  supersedes?: string; supersededBy?: string; at: string; updatedAt: string;
  history: { at: string; status: DecisionStatus; by: string }[]; // at most MAX_DECISION_HISTORY
}
export const MAX_DECISIONS = 100;
export const MAX_DECISION_HISTORY = 10;

// attempt.interruptions, at most MAX_INTERRUPTIONS. An interruption is not a failed attempt (DEC-21).
export type InterruptionSource = 't3' | 'cli' | 'lead';
export const INTERRUPTION_SOURCES: readonly InterruptionSource[] = ['t3', 'cli', 'lead'];
export interface Interruption {
  at: string; class: FailureClass; code?: string; source: InterruptionSource;
  retryable?: boolean; resetAt?: string; operation?: string; fingerprint: string;
  resolved?: 'same-thread' | 'handed-off';
}
export const MAX_INTERRUPTIONS = 5;

export interface LeadLease {
  id: string; label: string; claimedAt: string; renewedAt: string; ttlS: number;
  history: { at: string; id: string; event: 'claim' | 'renew' | 'takeover' | 'release'; reason?: string }[];
}

// An engine-run check stored on a checkpoint. It never goes to `evidence` (ACC reads evidence exitCode as a number).
export interface CheckpointCheck {
  command: string; exitCode?: number; timedOut?: boolean; tail: string; at: string; fpBefore: string; fpAfter: string; stable: boolean;
}

export type CheckpointRole = 'lead' | 'worker';
export type CheckpointKind = 'milestone' | 'post-mortem' | 'pre-handoff';
export const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['milestone', 'post-mortem', 'pre-handoff'];
export const MAX_DELTA = 40;
export const MAX_HEALTH = 8;
export const MAX_TASK_ALIASES = 10;

export type BlockerCause = 'refusal' | 'decision' | 'no-progress' | 'other';
export type HandoffMode = 'resume-cross' | 'cli' | 'new';

// ---- additions to the 66c3cd6 types in journal.ts (joined there with `&`) ----
export interface JournalAdditions { lead?: LeadLease; decisions?: Decision[] }
export interface AttemptAdditions {
  launchKey?: string; threadId?: string; taskAliases?: string[]; workspace?: string; baseTree?: string; interruptions?: Interruption[];
}
export interface CheckpointAdditions {
  attempt?: number; role?: CheckpointRole; kind?: CheckpointKind;
  delta?: string[]; deltaCount?: number; diffStat?: { files: number; insertions: number; deletions: number };
  snapshot?: string; health?: string[]; check?: CheckpointCheck; fpv?: number;
}
export interface EvidenceAdditions { fpv?: number }
export interface BlockerAdditions { signature?: string; cause?: BlockerCause; decision?: string }
export interface HandoffAdditions {
  mode?: HandoffMode; launchKey?: string; threadId?: string; disarmed?: { status: string; readAt: string; method: string };
}

// ---- the packet (packet.ts) ----
export type PacketMode = 'dispatch' | 'continuation';
export const PACKET_CAPS: Record<PacketMode, number> = { dispatch: 2500, continuation: 3500 };
// How the JSON labels each item: seen by the engine, said by a worker, not known, or settled by the user or an agent.
export type PacketLabel = 'observed' | 'claimed' | 'unknown' | 'settled-user' | 'settled-agent';
export type PacketItem = { label: PacketLabel; text: string };
// The 9 sections in order. Tier 0 never shrinks. Tier 3 shrinks first, then 2, then 1 (down to its floor).
export const PACKET_SECTIONS = [
  { n: 1, key: 'contract', title: 'Contract', tier: 0 },
  { n: 2, key: 'waiting', title: 'Waiting on the user', tier: 0 },
  { n: 3, key: 'observed', title: 'Observed by the engine', tier: 1 },
  { n: 4, key: 'settled', title: 'Settled, do not re-ask', tier: 1 },
  { n: 5, key: 'unknown', title: 'Unknown', tier: 2 },
  { n: 6, key: 'next', title: 'Next', tier: 2 },
  { n: 7, key: 'claimed', title: 'Claimed by the previous worker, unverified', tier: 3 },
  { n: 8, key: 'goal', title: 'Goal, Accept, and verified dependencies', tier: 3 },
  { n: 9, key: 'rules', title: 'Fixed rules', tier: 0 },
] as const;
export type PacketSectionKey = (typeof PACKET_SECTIONS)[number]['key'];
export type PacketSection = { n: number; key: PacketSectionKey; title: string; tier: number; items: PacketItem[] };
export interface Packet { mode: PacketMode; plan: string; slice: string; attempt?: number; launchKey?: string; sections: PacketSection[] }

// The authority line of every packet (Plan A C10).
export const AUTHORITY_LINE = 'Decide GREEN items, and AMBER items with a rollback, and list them in your report. For anything else, finish the unblocked parts, then write BLOCKED.md. Never commit, push, or deploy.';

// ---- `ae decide` lookup ----
// answered: a settled decision exists; use it. loop: the question is already open; do not ask again, finish other work.
// ask: nothing is recorded; candidates are similar keys, never an answer.
export type LookupResult = 'answered' | 'loop' | 'ask';
