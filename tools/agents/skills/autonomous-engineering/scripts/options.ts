// Failure classes and recovery options. Slice 1 holds only what the tracer needs: parsing an interruption's class
// and source from flags. A class is always given by the lead from an observed field; free text is never classified
// (NOT-3). Slice 9 adds the code table, the option ranking, authorization, and the disarm gate.
import { FAILURE_CLASSES, INTERRUPTION_SOURCES } from './contract.ts';
import type { FailureClass, InterruptionSource } from './contract.ts';

export function parseFailureClass(v: string | undefined): FailureClass {
  if (!v) throw new Error(`interrupt: --class is required; use ${FAILURE_CLASSES.join(', ')}`);
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
