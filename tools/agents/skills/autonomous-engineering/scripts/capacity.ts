import { execFileSync } from 'node:child_process';
import { availableParallelism, loadavg, totalmem } from 'node:os';
import { PROFILES } from './journal.ts';
import type { Attempt, Journal } from './journal.ts';
import type { Plan } from './plan.ts';

// Capacity probe and the adaptive width decision (plans/adaptive-concurrency.md).
// The probe reads machine-wide memory signals at each `ae next`. Free memory comes from kern.memorystatus_level,
// never from the Node free-memory call: on macOS that counts only unused pages (0.46% while memory_pressure read 47%).

export type PressureLevel = 'normal' | 'warn' | 'critical' | 'unknown';
export type ProbeReading = {
  platform: string;
  pressure: PressureLevel;
  swapouts: number | null; // vm_stat "Swapouts": pages swapped out since boot
  freeMB: number | null; // kern.memorystatus_level percent of total memory
  totalMB: number;
  load: number[]; // 1, 5, and 15 minute load averages
  cpus: number;
};
// Runs a fixed program with fixed arguments. Returns stdout, or null on any failure.
export type Exec = (file: string, args: string[]) => string | null;

export const SWAP_WINDOW_S = 60;
export const DEFAULT_HEAVY_RSS_MB = 2048;
export const MAX_HEAVY_RSS_MB = 1_048_576;
export const MAX_SAMPLES = 16;
export const SAMPLE_SPACING_MS = (2 * SWAP_WINDOW_S * 1000) / MAX_SAMPLES; // 7.5 s
export const MAX_EPISODES = 16;
// Without measured signals, adaptive uses the balanced width for all slices, and one heavy slice at a time.
export const FALLBACK_WIDTH = PROFILES.balanced.maxParallel;
const MB = 1024 * 1024;

const runFixed: Exec = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};
// kern.memorystatus_vm_pressure_level gives the dispatch level: 1 normal, 2 warn, 4 critical.
const LEVELS = new Map<string, PressureLevel>([['1', 'normal'], ['2', 'warn'], ['4', 'critical']]);

export function parseSwapouts(vmStat: string | null): number | null {
  const m = /^Swapouts:\s+(\d+)\.?\s*$/m.exec(vmStat ?? '');
  return m ? Number(m[1]) : null;
}

// macOS only. Every other platform, and every failed read, gives `unknown` or null. It never throws.
export function probeMachine(o: { platform?: string; exec?: Exec; load?: () => number[]; cpus?: () => number; total?: () => number } = {}): ProbeReading {
  const platform = o.platform ?? process.platform, exec = o.exec ?? runFixed, totalBytes = (o.total ?? totalmem)();
  const base = { platform, totalMB: Math.floor(totalBytes / MB), load: (o.load ?? loadavg)().map(x => Math.round(x * 100) / 100), cpus: (o.cpus ?? availableParallelism)() };
  if (platform !== 'darwin') return { ...base, pressure: 'unknown', swapouts: null, freeMB: null };
  const sysctl = (name: string) => exec('/usr/sbin/sysctl', ['-n', name])?.trim() ?? '';
  const level = sysctl('kern.memorystatus_level'), pct = /^\d+$/.test(level) ? Number(level) : NaN;
  return {
    ...base,
    pressure: LEVELS.get(sysctl('kern.memorystatus_vm_pressure_level')) ?? 'unknown',
    swapouts: parseSwapouts(exec('/usr/bin/vm_stat', [])),
    freeMB: pct >= 0 && pct <= 100 ? Math.floor((pct / 100) * totalBytes / MB) : null,
  };
}

// ---- state kept in the journal ----
export type CapacitySample = { at: string; swapouts: number | null; pressure: PressureLevel };
export type CapacityState = {
  samples: CapacitySample[]; // at most MAX_SAMPLES readings of `ae next`; see keepSample
  pressureEpisodes: { at: string; level: 'warn' | 'critical' }[]; // a warn or critical reading after one that was not
  heavyRssMB?: number; // set by `ae set-profile --heavy-rss-mb`; else DEFAULT_HEAVY_RSS_MB
};
export const emptyCapacity = (): CapacityState => ({ samples: [], pressureEpisodes: [] });

// ---- decision ----
export type SwapTrend = { state: 'flat' | 'grew' | 'unknown' | 'unavailable'; pages?: number; windowS?: number; note?: string };
export type Trigger = { at: string; kind: 'timeout' | 'pressure' | 'failures'; text: string };
// starts: how many slices of the class may start now. null: no numeric limit. reason: why no more may start.
export type ClassLimit = { starts: number | null; reason: string | null };
export type CapacityDecision = {
  measured: boolean;
  signals: { platform: string; pressure: PressureLevel; swap: SwapTrend; freeMB: number | null; totalMB: number; load: number[]; cpus: number };
  total: ClassLimit; // a limit only when the signals are not measured
  normal: ClassLimit;
  heavy: ClassLimit & {
    running: number; width: number; rssMB: number; rssFrom: 'default' | 'set';
    backoff: { steps: number; since: string | null; triggers: Trigger[] }; serial: string | null;
  };
};

const bad = (p: PressureLevel | undefined) => p === 'warn' || p === 'critical';
const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
const iso = (t: number) => new Date(t).toISOString();
export const timedOut = (a: Attempt) => a.kind === 'verify' && a.outcome === 'failed' && (a.reason ?? '').startsWith('verify failed (timeout)');

// The newest reading is always kept: pressure episodes compare against it. Older kept readings are at least
// SAMPLE_SPACING_MS apart, so MAX_SAMPLES of them span 105 s or more, and frequent calls cannot push out the swap base.
export function keepSample(samples: CapacitySample[], sample: CapacitySample): CapacitySample[] {
  const close = samples.length >= 2 && time(samples.at(-1)!.at) - time(samples.at(-2)!.at) < SAMPLE_SPACING_MS;
  return [...(close ? samples.slice(0, -1) : samples), sample].slice(-MAX_SAMPLES);
}

// The newest stored sample that is at least SWAP_WINDOW_S old is the base. A longer window can only show more growth.
export function swapTrend(samples: CapacitySample[], current: number | null, now: Date): SwapTrend {
  if (current === null) return { state: 'unavailable' };
  const base = [...samples].reverse().find(s => s.swapouts !== null && now.getTime() - time(s.at) >= SWAP_WINDOW_S * 1000);
  if (!base) return { state: 'unknown', note: `no sample ${SWAP_WINDOW_S} s old yet` };
  const windowS = Math.round((now.getTime() - time(base.at)) / 1000), pages = current - base.swapouts!;
  if (pages < 0) return { state: 'unknown', windowS, note: 'the counter went down, as after a restart' };
  return { state: pages > 0 ? 'grew' : 'flat', pages, windowS };
}

// Results in time order: failed work or verify attempts, and passing Verify commands. A review rejection is a judgment, not a measurement.
// `verify` marks a run that the engine observed: a failed verify attempt or a passing Verify command.
function results(journal: Journal) {
  const out: { t: number; id: string; ok: boolean; timeout: boolean; verify: boolean }[] = [];
  for (const [id, rec] of Object.entries(journal.slices)) {
    for (const a of rec.attempts) if (a.outcome === 'failed' && (a.kind === 'work' || a.kind === 'verify')) out.push({ t: time(a.endedAt ?? a.at), id, ok: false, timeout: timedOut(a), verify: a.kind === 'verify' });
    for (const e of rec.evidence) if (e.kind === 'command' && e.exitCode === 0) out.push({ t: time(e.at), id, ok: true, timeout: false, verify: true });
  }
  return out.filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
}

export function assessCapacity(journal: Journal, plan: Plan, reading: ProbeReading, now: Date): { decision: CapacityDecision; state: CapacityState } {
  const prev = journal.capacity ?? emptyCapacity(), at = now.toISOString();
  const heavyIds = new Set(plan.slices.filter(s => s.class === 'heavy').map(s => s.id));
  const running = plan.slices.filter(s => journal.slices[s.id]?.state === 'IN_PROGRESS');
  const runningHeavy = running.filter(s => heavyIds.has(s.id)).length;
  const all = results(journal), heavyRuns = all.filter(r => r.verify && heavyIds.has(r.id));
  const lastClean = heavyRuns.filter(r => r.ok).at(-1)?.t ?? null;
  const after = (t: number) => lastClean === null || t > lastClean;

  // A pressure episode: warn or critical after a reading that was neither. Episodes before the last clean heavy run are dropped.
  const episodes = [...prev.pressureEpisodes];
  if (bad(reading.pressure) && !bad(prev.samples.at(-1)?.pressure)) episodes.push({ at, level: reading.pressure as 'warn' | 'critical' });
  const pressureEpisodes = episodes.filter(e => after(time(e.at))).slice(-MAX_EPISODES);

  // Back-off triggers after the last clean heavy run: each verify timeout, each pressure episode,
  // and each failure that follows a failure of another slice with no passing Verify between them.
  const triggers: Trigger[] = pressureEpisodes.map(e => ({ at: e.at, kind: 'pressure' as const, text: `memory pressure ${e.level}` }));
  all.forEach((r, i) => {
    if (r.ok || !after(r.t)) return;
    if (r.timeout) triggers.push({ at: iso(r.t), kind: 'timeout', text: `verify timeout of slice ${r.id}` });
    const p = all[i - 1];
    if (p && !p.ok && p.id !== r.id) triggers.push({ at: iso(r.t), kind: 'failures', text: `slices ${p.id} and ${r.id} failed in a row` });
  });
  triggers.sort((a, b) => time(a.at) - time(b.at));

  const swap = swapTrend(prev.samples, reading.swapouts, now);
  const measured = reading.pressure !== 'unknown' && reading.swapouts !== null;
  const p = reading.pressure, load = `load ${reading.load[0] ?? 'unknown'} on ${reading.cpus} CPUs`;

  // Normal slices: no numeric limit while the pressure level is normal. Warn: one slice, only when none runs. Critical: none.
  const normal: ClassLimit = p === 'critical' ? { starts: 0, reason: 'normal: memory pressure critical' }
    : p === 'warn' ? { starts: running.length ? 0 : 1, reason: running.length ? `normal: memory pressure warn; ${running.length} running` : 'normal: memory pressure warn; one slice at a time' }
    : { starts: null, reason: null };
  const total: ClassLimit = measured ? { starts: null, reason: null }
    : { starts: Math.max(0, FALLBACK_WIDTH - running.length), reason: `adaptive: no measured memory signals on ${reading.platform}; balanced width ${FALLBACK_WIDTH} reached` };

  // Heavy slices: every start needs normal pressure and a flat swap window. Memory width is the running heavy slices plus
  // the starts that fit: each start keeps free memory, less the estimate per earlier start, at twice the estimate or more.
  const rssMB = prev.heavyRssMB ?? DEFAULT_HEAVY_RSS_MB, freeMB = reading.freeMB;
  const gate = bad(p) ? `heavy: memory pressure ${p} (${load})`
    : !measured ? null
    : swap.state === 'grew' ? `heavy: swapouts grew by ${swap.pages} pages in ${swap.windowS} s (${load})${swap.windowS! > 2 * SWAP_WINDOW_S ? `; run ae next again in ${SWAP_WINDOW_S} s for a fresh window` : ''}`
    : swap.state === 'unknown' ? `heavy: swap trend unknown (${swap.note}); run ae next again in ${SWAP_WINDOW_S} s or more`
    : null;
  const fit = measured && freeMB !== null ? Math.max(0, Math.floor(freeMB / rssMB) - 1) : null;
  const memoryWidth = fit === null ? 1 : runningHeavy + fit, steps = triggers.length;
  // Any heavy timeout after the last passing heavy Verify keeps heavy slices serial. A later ordinary failure does not clear it.
  const lastTimeout = heavyRuns.filter(r => r.timeout && after(r.t)).at(-1);
  const serial = lastTimeout ? `heavy: a Verify run of heavy slice ${lastTimeout.id} timed out; one heavy slice at a time until a heavy Verify passes` : null;
  let width = Math.max(Math.min(1, memoryWidth), memoryWidth - steps);
  if (serial) width = Math.min(width, 1);
  const shown = triggers.slice(-3).map(t => t.text).join('; ');
  const reason = gate ?? (fit === 0 ? `heavy: ${freeMB} MB free is under twice the ${rssMB} MB heavy RSS estimate`
    : serial ? serial
    : width < memoryWidth ? `heavy: width ${width} reached (back-off ${steps}: ${shown})`
    : fit === null ? `heavy: one heavy slice at a time (${measured ? 'free memory unknown' : 'no measured memory signals'})`
    : `heavy: width ${width} reached (${freeMB} MB free fits ${fit} more at ${rssMB} MB each, plus a ${rssMB} MB margin)`);

  const decision: CapacityDecision = {
    measured, signals: { platform: reading.platform, pressure: p, swap, freeMB, totalMB: reading.totalMB, load: reading.load, cpus: reading.cpus },
    total, normal,
    heavy: {
      starts: gate ? 0 : Math.max(0, width - runningHeavy), reason, running: runningHeavy, width, rssMB, rssFrom: prev.heavyRssMB ? 'set' : 'default',
      backoff: { steps, since: lastClean === null ? null : iso(lastClean), triggers: triggers.slice(-5) }, serial,
    },
  };
  const state: CapacityState = { ...prev, samples: keepSample(prev.samples, { at, swapouts: reading.swapouts, pressure: p }), pressureEpisodes };
  return { decision, state };
}
