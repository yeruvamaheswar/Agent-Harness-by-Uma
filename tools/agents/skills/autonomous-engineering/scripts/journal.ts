import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { protectedRel, redact } from './guard.ts';
import { definitionDigest } from './plan.ts';
import type { Plan, Slice, State } from './plan.ts';
import type { RunCharter } from './run.ts';
import type { CapacityDecision, CapacityState } from './capacity.ts';
import type { AttemptAdditions, BlockerAdditions, CheckpointAdditions, EvidenceAdditions, HandoffAdditions, JournalAdditions } from './contract.ts';

// Run journal: plans/<slug>.run.json. The journal is canonical for the engine (DEC-4).

export type FixedProfile = 'economy' | 'balanced' | 'sprint';
// adaptive: width from the capacity probe at each `ae next` (capacity.ts), not from a fixed number.
export type ProfileName = FixedProfile | 'adaptive';
// Profiles change width only. The attempt budget is the planner rule and is the same in every profile.
export const PROFILES: Record<FixedProfile, { maxParallel: number }> = {
  economy: { maxParallel: 1 },
  balanced: { maxParallel: 2 },
  sprint: { maxParallel: 4 },
};
export const PROFILE_NAMES: readonly ProfileName[] = ['economy', 'balanced', 'sprint', 'adaptive'];
export const isProfile = (p: string): p is ProfileName => (PROFILE_NAMES as readonly string[]).includes(p);
const isFixed = (p: string): p is FixedProfile => Object.hasOwn(PROFILES, p);
export const FIX_BUDGET = 4; // failure 4 since the last unblock or definition change sets FAILED
export const NO_PROGRESS = 3; // identical failure signatures in a row set FAILED early
export const AUTHORITY = ['deps', 'branches', 'worktrees', 'migrations', 'ci'] as const;
export const profileForMode = (mode: string | null): FixedProfile => mode === 'quick' ? 'economy' : mode === 'sprint' ? 'sprint' : 'balanced';

export type Attempt = {
  n: number; kind: 'work' | 'verify' | 'review'; at: string; endedAt?: string; outcome?: 'finished' | 'failed' | 'blocked' | 'handed-off';
  provider?: string; model?: string; effort?: string; taskId?: string; handoff?: number; // index into SliceRecord.handoffs
  summary?: string; reason?: string; exitCode?: number | null; signature?: string; outputTail?: string;
} & AttemptAdditions;
export type Evidence = {
  kind: 'command' | 'manual'; command?: string; exitCode?: number; durationMs?: number; outputTail?: string; note?: string;
  by: string; at: string; gitHead: string; fingerprint: string; stale?: boolean;
} & EvidenceAdditions;
export type Move = { at: string; from: State; to: State; reason: string; claim?: { state: string; evidence: string } };
export type SliceRecord = {
  state: State; definitionDigest: string; attempts: Attempt[]; evidence: Evidence[];
  review?: { by: string; note: string; at: string }; blocker?: { reason: string; at: string } & BlockerAdditions;
  budgetFrom?: number; integratedRef?: string; history: Move[];
  checkpoints?: Checkpoint[]; handoffs?: Handoff[];
};
// A checkpoint is the minimum to resume: where the work is, what changed, the last check, and what comes next.
export type Checkpoint = {
  at: string; by: string; gitHead: string; branch: string; fingerprint: string; changed: string[]; unowned: string[];
  lastCheck: string; done?: string; next?: string; note?: string;
} & CheckpointAdditions;
// A usage handoff. The slice stays IN_PROGRESS in the plan; the phase lives here (plans/usage-continuity.md DEC-3).
// It is not a failed attempt: the old attempt ends `handed-off`, and the fix budget carries over.
export const MAX_CHECKPOINTS = 5;
// CLOSED: the slice left IN_PROGRESS before the transfer (the old worker finished, failed, or the definition changed).
export type HandoffPhase = 'PREPARED' | 'CHECKPOINTED' | 'TRANSFERRED' | 'CLOSED';
export const handoffOpen = (h: Handoff | undefined) => h?.phase === 'PREPARED' || h?.phase === 'CHECKPOINTED';

// A handoff cannot outlive the run it was made for. An open one (not transferred) closes when the slice leaves
// IN_PROGRESS: its checkpoint is stale. A transferred one closes when its replacement's attempt ends, other than
// by a block (the same worker continues after unblock).
// Every handoff is checked, not only the latest, so an older transfer never stays TRANSFERRED.
export function closeStaleHandoffs(journal: Journal, at: string) {
  for (const rec of Object.values(journal.slices)) {
    const latestOpen = [...rec.attempts].reverse().find(a => a.kind === 'work' && !a.outcome);
    (rec.handoffs ?? []).forEach((h, i) => {
      if (h.phase === 'CLOSED') return;
      let why: string | null = null;
      if (handoffOpen(h)) { if (rec.state !== 'IN_PROGRESS') why = `slice left IN_PROGRESS (now ${rec.state}) before the transfer`; }
      else {
        const mine = rec.attempts.filter(a => a.kind === 'work' && a.handoff === i).at(-1);
        const owns = !!mine && !mine.outcome && latestOpen === mine && rec.state === 'IN_PROGRESS';
        const blocked = rec.state === 'BLOCKED' && mine?.outcome === 'blocked';
        if (!owns && !blocked) why = `the replacement no longer owns the slice (attempt ${mine?.outcome ?? 'open'}; slice ${rec.state})`;
      }
      if (!why) return;
      h.history.push({ at, phase: 'CLOSED', note: why });
      h.phase = 'CLOSED';
    });
  }
}
export type Handoff = {
  phase: HandoffPhase; at: string; lead: string; reason: string; from: { label: string; attempt?: number; taskId?: string };
  to: string; checkpointAt?: string; taskId?: string; history: { at: string; phase: HandoffPhase; note: string }[];
} & HandoffAdditions;
// One row per `ae set-profile` that changed something. `heavyRssMB` is the new estimate, when it changed.
export type ProfileChange = { at: string; from: ProfileName; to: ProfileName; reason?: string; heavyRssMB?: number };
export type Journal = {
  schemaVersion: 1; plan: string; profile: ProfileName;
  authority: { allow: string[]; grantedBy: 'user'; at: string };
  createdAt: string; updatedAt: string; run?: RunCharter;
  slices: Record<string, SliceRecord>; removed?: Record<string, SliceRecord>;
  capacity?: CapacityState; profileChanges?: ProfileChange[];
} & JournalAdditions;

export const journalPath = (planPath: string) => planPath.replace(/\.md$/, '') + '.run.json';
const hex12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

// ---- transitions ----
const ALLOWED: Record<State, State[]> = {
  PLANNED: ['READY'], READY: ['IN_PROGRESS'],
  IN_PROGRESS: ['AGENT_FINISHED', 'BLOCKED', 'READY', 'FAILED'],
  AGENT_FINISHED: ['REVIEWED', 'VERIFIED', 'ACCEPTED', 'READY', 'FAILED'],
  REVIEWED: ['VERIFIED', 'ACCEPTED', 'READY', 'FAILED'],
  BLOCKED: ['IN_PROGRESS'], FAILED: ['READY'], VERIFIED: ['INTEGRATED', 'AGENT_FINISHED'], INTEGRATED: [],
  // ACCEPTED: a person signed off on a manual Verify step; the engine observed nothing.
  ACCEPTED: ['INTEGRATED', 'AGENT_FINISHED'],
};
export const canTransition = (from: State, to: State) => ALLOWED[from].includes(to);

// `force` is for sync and init only: a changed definition returns any slice to READY.
export function move(rec: SliceRecord, to: State, reason: string, at: string, force = false, claim?: Move['claim']) {
  if (!force && !canTransition(rec.state, to)) throw new Error(`illegal transition ${rec.state} -> ${to}`);
  rec.history.push({ at, from: rec.state, to, reason, ...(claim ? { claim } : {}) });
  rec.state = to;
}

export const newRecord = (slice: Slice): SliceRecord => ({ state: 'PLANNED', definitionDigest: definitionDigest(slice), attempts: [], evidence: [], history: [] });

// ---- load, save, lock ----
const isJournal = (j: unknown): j is Journal => !!j && typeof j === 'object' && (j as Journal).schemaVersion === 1 && typeof (j as Journal).slices === 'object' && (j as Journal).slices !== null;
function readJson(file: string): Journal | null {
  try { const j: unknown = JSON.parse(readFileSync(file, 'utf8')); return isJournal(j) ? j : null; } catch { return null; }
}

// Every string of a journal, redacted. A journal written before redaction covered every field may still hold secrets.
const scrub = <T>(v: T): T => (typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v) as T;

// The loaded journal is scrubbed before anything prints or saves it. `scrubbed` says the file held a secret; save it.
export function loadJournal(file: string): { journal: Journal; recoveredFromBackup: boolean; scrubbed: boolean } {
  const main = existsSync(file) ? readJson(file) : null;
  const raw = main ?? (existsSync(file + '.bak') ? readJson(file + '.bak') : null);
  if (!raw) throw new Error(existsSync(file) ? `journal ${file} is corrupt and has no usable .bak` : `no journal at ${file}; run init first`);
  const journal = scrub(raw);
  return { journal, recoveredFromBackup: !main, scrubbed: JSON.stringify(journal) !== JSON.stringify(raw) };
}

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
// The engine never reads or writes its own files through a symlink: a planted link could point anywhere.
export function refuseSymlinks(...paths: string[]) {
  for (const p of paths) if (isLink(p)) throw new Error(`refusing to use ${p}: it is a symlink; remove it and run the command again`);
}

// Writes a fresh temp file, created exclusively under a unique name (it never follows a planted link),
// then renames it over `file`. Rename replaces a link at `file` itself, never the link's target.
// With `lockedBy` (a journal path), it writes only while this process holds that journal's lock.
// Crash safety: the temp file is fsynced before the rename, and its folder after it, so a crash at any step leaves
// either the old whole file or the new whole file, never a part (plus at most one orphan temp file, which recover reports).
export function writeAtomic(file: string, data: string | Buffer, lockedBy?: string) {
  if (lockedBy) assertLockHeld(lockedBy);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o644);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
  fsyncDir(dirname(file));
}
// The rename lives in the folder entry; fsync the folder so the rename survives a power loss.
// Windows cannot open a folder as a file, and NTFS journals the rename itself.
function fsyncDir(dir: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Journal size (REQ-23). ACC drops a journal above 2 MiB. Above 1 MiB `status` warns; above 1.5 MiB the engine
// refuses a write that grows the journal unless it moves a slice state (ae.ts).
export const JOURNAL_WARN_BYTES = 1024 * 1024;
export const JOURNAL_CAP_BYTES = 1.5 * 1024 * 1024;
export const journalText = (j: Journal) => JSON.stringify(j, null, 2) + '\n';
export const journalBytes = (j: Journal) => Buffer.byteLength(journalText(j), 'utf8');

// The save goes ahead only while this process holds the lock. Another process that took the lock over wins.
function assertLockHeld(file: string) {
  const lock = file + '.lock';
  let owner: string | null = null;
  try { if (!isLink(lock)) owner = readFileSync(lock, 'utf8').trim(); } catch { /* no lock */ }
  if (owner !== String(process.pid)) throw new Error(`lost the journal lock ${lock} (${owner ? `now held by ${owner}` : 'missing'}); nothing was written`);
}

// Keep the old good file as .bak (scrubbed), then replace the journal. A corrupt old file never replaces a good .bak.
export function saveJournal(file: string, journal: Journal, now: Date = new Date()) {
  assertLockHeld(file);
  refuseSymlinks(file, file + '.bak');
  journal.updatedAt = now.toISOString();
  const text = journalText;
  const old = existsSync(file) ? readJson(file) : null, bak = old ? null : existsSync(file + '.bak') ? readJson(file + '.bak') : null;
  if (old) writeAtomic(file + '.bak', text(scrub(old)));
  else if (bak && JSON.stringify(scrub(bak)) !== JSON.stringify(bak)) writeAtomic(file + '.bak', text(scrub(bak)));
  writeAtomic(file, text(journal), file);
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Leftovers from a crashed atomic write are reported, never removed or read.
export function orphanTempFiles(...files: string[]): string[] {
  return files.flatMap(file => {
    const prefix = basename(file) + '.';
    return readdirSync(dirname(file)).flatMap(name => {
      if (!name.startsWith(prefix)) return [];
      const match = /^(\d+)\.([a-f0-9]+)\.tmp$/i.exec(name.slice(prefix.length));
      if (!match) return [];
      const pid = Number(match[1]), full = join(dirname(file), name);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) return [];
      try { return lstatSync(full).isFile() ? [full] : []; } catch { return []; }
    });
  }).sort();
}

const YOUNG_MS = 10_000;
export type LockInfo = { pid: number | null; alive: boolean; stale: boolean; empty: boolean; ageMs: number };

// Read-only look at a lock file. An empty file younger than 10 s is live: its owner is between create and write.
export function inspectLock(file: string): LockInfo | null {
  const lock = file + '.lock';
  try {
    const text = readFileSync(lock, 'utf8').trim(), ageMs = Date.now() - statSync(lock).mtimeMs, pid = Number(text);
    const empty = text === '', valid = Number.isInteger(pid) && pid > 0;
    const alive = valid ? pidAlive(pid) : empty && ageMs < YOUNG_MS;
    return { pid: valid ? pid : null, alive, stale: !alive, empty, ageMs: Math.round(ageMs) };
  } catch { return null; }
}

const readLockText = (lock: string) => { try { return readFileSync(lock, 'utf8'); } catch { return null; } };

// Fail-fast by default: a lock held by a live process is an error at once. With `waitMs` (the CLI's --wait-lock,
// 60 s or less) the call polls until the holder releases it, then takes it; it fails when the wait runs out.
export const MAX_WAIT_LOCK_S = 60;
const LOCK_POLL_MS = 50;
// A live process holds the lock. Callers that must say more (a two-phase record step) can tell it from other errors.
export class LockBusy extends Error {}
export async function withLock<T>(file: string, fn: () => Promise<T> | T, waitMs = 0): Promise<T> {
  const lock = file + '.lock', deadline = Date.now() + waitMs;
  refuseSymlinks(lock);
  for (let stale = 0; ;) {
    try { const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      refuseSymlinks(lock);
      const seen = readLockText(lock), info = inspectLock(file);
      if (info?.alive) {
        if (Date.now() < deadline) { await new Promise(r => setTimeout(r, LOCK_POLL_MS)); continue; }
        throw new LockBusy(`journal is locked by ${info.pid ? `live pid ${info.pid}` : 'a process that is creating the lock'} (${lock})${waitMs > 0 ? `; waited ${waitMs / 1000} s` : ''}`);
      }
      if (stale++ >= 3) throw new Error(`cannot take over stale lock ${lock}`);
      // Remove the stale lock only when it still holds what was inspected. A lock that another process
      // replaced in the meantime stays; the next try sees its live owner. The save check catches the rest.
      if (seen !== null && readLockText(lock) === seen) { try { unlinkSync(lock); } catch { /* another process took it over first; retry */ } }
    }
  }
  try { return await fn(); }
  finally { try { if (!isLink(lock) && readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock); } catch { /* already gone */ } }
}

// ---- sync ----
export function createJournal(plan: Plan, profile: ProfileName, allow: string[], now: Date): Journal {
  const at = now.toISOString(), slices: Record<string, SliceRecord> = {};
  for (const s of plan.slices) {
    const rec = newRecord(s);
    rec.state = s.state;
    // Plan states are claims. In-flight work restarts. Finished-or-later work needs a verify run.
    if (s.state === 'IN_PROGRESS') move(rec, 'READY', 'imported in-progress claim; restart', at, true);
    else if (['AGENT_FINISHED', 'REVIEWED', 'VERIFIED', 'ACCEPTED', 'INTEGRATED'].includes(s.state)) move(rec, 'AGENT_FINISHED', 'imported claim; needs verify', at, true, { state: s.state, evidence: redact(s.evidence) });
    slices[s.id] = rec;
  }
  return { schemaVersion: 1, plan: plan.path.split('/').pop()!, profile, authority: { allow, grantedBy: 'user', at }, createdAt: at, updatedAt: at, slices };
}

// New slice: PLANNED. Changed definition: back to READY. Removed slice: moved under `removed`. Returns true when it changed anything.
export function syncJournal(journal: Journal, plan: Plan, now: Date): boolean {
  const at = now.toISOString();
  let changed = false;
  const ids = new Set(plan.slices.map(s => s.id));
  for (const s of plan.slices) {
    const rec = journal.slices[s.id], digest = definitionDigest(s);
    if (!rec) { journal.slices[s.id] = newRecord(s); changed = true; continue; }
    if (rec.definitionDigest === digest) continue;
    rec.definitionDigest = digest;
    for (const e of rec.evidence) e.stale = true;
    if (rec.state !== 'READY') move(rec, 'READY', 'definition changed', at, true);
    else rec.history.push({ at, from: 'READY', to: 'READY', reason: 'definition changed' });
    delete rec.review; delete rec.blocker;
    rec.budgetFrom = rec.attempts.length;
    changed = true;
  }
  for (const id of Object.keys(journal.slices)) {
    if (ids.has(id)) continue;
    (journal.removed ??= {})[id] = journal.slices[id];
    delete journal.slices[id];
    changed = true;
  }
  return changed;
}

// ---- budget and failures ----
export const failures = (rec: SliceRecord) => rec.attempts.slice(rec.budgetFrom ?? 0).filter(a => a.outcome === 'failed');

// Records a failed attempt and moves the slice to READY, or to FAILED at failure 4 or on three identical signatures in a row.
export function recordFailure(rec: SliceRecord, attempt: Attempt, at: string, reason: string): { to: State; why: string } {
  const prior = failures(rec);
  attempt.outcome = 'failed';
  attempt.endedAt = at;
  attempt.reason = reason;
  attempt.signature ??= failureSignature(reason);
  if (!rec.attempts.includes(attempt)) rec.attempts.push(attempt);
  const count = prior.length + 1, run = [...prior.slice(-(NO_PROGRESS - 1)), attempt];
  const repeat = run.length === NO_PROGRESS && run.every(a => a.signature === attempt.signature);
  const to: State = count >= FIX_BUDGET || repeat ? 'FAILED' : 'READY';
  const why = repeat ? `no progress: same failure ${NO_PROGRESS} times (${attempt.signature})` : count >= FIX_BUDGET ? `fix budget spent (${count}/${FIX_BUDGET})` : `failure ${count}/${FIX_BUDGET}`;
  move(rec, to, `${reason}; ${why}`.slice(0, 400), at);
  if (to === 'READY') delete rec.review;
  return { to, why };
}

// ---- evidence helpers ----
export function outputTail(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-40).join('\n').slice(-4000);
}
export const failureSignature = (tail: string) => hex12(tail.replace(/\d+/g, ''));

// An owned path in one spelling: posix-normalized, no leading ./, no trailing /. '' is the whole repo (. or ./).
export const normPath = (f: string) => { const p = posix.normalize(f.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, ''); return p === '.' ? '' : p; };

// What Git lists for `rels` in `root`: tracked, plus untracked and not ignored (git ls-files -co --exclude-standard).
// `files` holds the listed paths; `dirs` holds every folder above them. Returns null when Git cannot answer (no Git, not a repo):
// the caller then walks every file. Git runs without a shell, in `root`. Ignored files are never listed, so they are never read.
// A nested repo or submodule comes as one entry in `files`.
type Listed = { files: Set<string>; dirs: Set<string> };
function gitListed(root: string, rels: string[]): Listed | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard', ...(rels.includes('') ? [] : ['--', ...rels.map(r => `:(literal)${r}`)])],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 });
    const files = new Set(out.split('\0').filter(Boolean).map(normPath)), dirs = new Set<string>();
    for (const f of files) for (let d = posix.dirname(f); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
    return { files, dirs };
  } catch { return null; }
}
const gitIgnores = (root: string, rel: string) => {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; }
};

// Folders are walked; .git and node_modules are skipped; a missing path counts as `missing`.
// In a Git repo, a walked folder counts only the files Git lists (gitListed): git-ignored build output does not change the
// fingerprint. A path the plan owns by name always counts, ignored or not: an owned file, or an owned folder that Git ignores.
// Outside a Git repo, or when Git fails, every file counts, as before. A tracked file deleted from disk is absent, as before.
// A symlink counts with its link text only. It is never read or followed: its target may be outside the repo
// or protected. checkPath refuses an owned path that is a symlink, so only links inside owned folders get here.
// A protected path (checkPath's rules: .env* but not .env.example, *.pem, *.key, .claude/settings*.json, .state/,
// controls/ at the root) is never read or walked: it counts by its name only, ignored or not.
// `skip` holds the engine's own files (plan, page, journal): the engine rewrites them, so they never count.
// Every path is normalized first (normPath), so `.`, `./src`, and `src//a.ts` give the same entries and the skip check.
export function fingerprint(root: string, files: string[], skip: ReadonlySet<string> = new Set()): string {
  const entries: string[] = [], skipped = new Set([...skip].map(normPath));
  const owned = files.map(normPath);
  let listed: Listed | null | undefined; // lazy: a plan that owns only files never calls Git
  // mode 'owned': a folder named by the plan. 'filtered': below it, only Git-listed paths. 'open': a listed nested repo, walked whole.
  const add = (rel: string, mode: 'owned' | 'filtered' | 'open') => {
    if (skipped.has(rel)) return;
    if (protectedRel(rel)) { entries.push(`${rel}\0protected`); return; }
    const full = join(root, rel);
    let st;
    try { st = lstatSync(full); } catch { entries.push(`${rel}\0missing`); return; }
    if (st.isDirectory()) {
      let scope: Listed | null = null;
      if (mode === 'filtered') scope = listed!;
      else if (mode === 'owned') { if (listed === undefined) listed = gitListed(root, owned); if (listed && !gitIgnores(root, rel)) scope = listed; }
      for (const name of readdirSync(full).sort()) {
        if (name === '.git' || name === 'node_modules') continue;
        const child = rel ? `${rel}/${name}` : name;
        if (!scope) add(child, 'open');
        else if (scope.files.has(child)) add(child, 'open');
        else if (scope.dirs.has(child)) add(child, 'filtered');
      }
    } else if (st.isSymbolicLink()) entries.push(`${rel}\0link:${readlinkSync(full)}`);
    else entries.push(`${rel}\0${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
  };
  for (const f of owned) add(f, 'owned');
  return hex12(entries.sort().join('\n'));
}

// The Evidence: line is one short line: the latest live evidence, else the review, else none.
// A command line quotes the last output line that says pass or fail, else the last non-empty line (80 chars at most).
// The whole line is redacted.
export function evidenceLine(rec: SliceRecord): string {
  const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
  const live = rec.evidence.filter(e => !e.stale), e = live[live.length - 1];
  let line = 'none';
  if (e) {
    const where = `head ${e.gitHead.slice(0, 9)}, files ${e.fingerprint}, ${e.at}`;
    const lines = (e.outputTail ?? '').split('\n').reverse();
    const last = clip(lines.find(l => /\b(pass|fail)/i.test(l)) ?? lines.find(l => l.trim()) ?? '', 80);
    line = e.kind === 'command' ? `verify exit ${e.exitCode}: ${clip(e.command ?? '', 120)}${last ? ` -> "${last}"` : ''} (${where})` : `manual check by ${e.by}: ${clip(e.note ?? '', 120)} (${where})`;
  } else if (rec.review) line = `reviewed by ${rec.review.by}: ${clip(rec.review.note, 120)} (${rec.review.at})`;
  if (rec.integratedRef) line += `; integrated ${clip(rec.integratedRef, 60)}`;
  return redact(line);
}

// ---- next ----
// True when `path` is `owned` or inside it.
export const within = (path: string, owned: string) => { const p = normPath(path), o = normPath(owned); return o === '' || p === o || p.startsWith(o + '/'); };
export const overlap = (a: string[], b: string[]) => a.some(x => b.some(y => within(x, y) || within(y, x)));
// ACCEPTED counts for dependencies and done, so a manual-check slice does not block the plan.
export const settled = (s: State) => s === 'VERIFIED' || s === 'ACCEPTED' || s === 'INTEGRATED';

// Finished work that waits for the coordinator after an interruption: review first, then verify.
export function awaiting(journal: Journal, plan: Plan) {
  const at = (pick: (s: Slice, st: State) => boolean) => plan.slices.filter(s => pick(s, journal.slices[s.id].state)).map(s => s.id);
  return {
    needsReview: at((s, st) => st === 'AGENT_FINISHED' && s.review !== 'CI'),
    needsVerify: at((s, st) => st === 'REVIEWED' || (st === 'AGENT_FINISHED' && s.review === 'CI')),
  };
}

// PLANNED slices with every dependency settled become READY. Returns the ids moved.
export function promoteReady(journal: Journal, plan: Plan, now: Date): string[] {
  const moved: string[] = [];
  for (const s of plan.slices) {
    const rec = journal.slices[s.id];
    if (rec.state === 'PLANNED' && s.dependsOn.every(d => settled(journal.slices[d].state))) { move(rec, 'READY', 'dependencies verified', now.toISOString()); moved.push(s.id); }
  }
  return moved;
}

// The batch to offer: READY slices with settled dependencies, lowest wave first. Parallel slices across waves
// join only when their files do not overlap each other or running work. A fixed profile's width is its number
// minus running slices. The adaptive width comes from `capacity` (assessCapacity in capacity.ts): the
// sequential and overlap rules apply first, then the limit of the slice's class.
export function nextBatch(journal: Journal, plan: Plan, capacity?: CapacityDecision) {
  const profile = journal.profile;
  if (profile !== 'adaptive' && !isFixed(profile)) throw new Error(`unknown profile "${profile}" in the journal; run ae set-profile PLAN --profile ${PROFILE_NAMES.join('|')}`);
  if (profile === 'adaptive' && !capacity) throw new Error('the adaptive profile needs a capacity reading');
  const running = plan.slices.filter(s => journal.slices[s.id].state === 'IN_PROGRESS');
  const waiting: { id: string; waitingOn: string[] }[] = [], deferred: { id: string; reason: string }[] = [];
  const ready: Slice[] = [];
  for (const s of plan.slices) {
    const st = journal.slices[s.id].state;
    if (st !== 'PLANNED' && st !== 'READY') continue;
    const unmet = s.dependsOn.filter(d => !settled(journal.slices[d].state));
    if (unmet.length) waiting.push({ id: s.id, waitingOn: unmet });
    else if (st === 'READY') ready.push(s);
  }
  ready.sort((a, b) => a.wave.n - b.wave.n || Number(a.id) - Number(b.id));
  const batch: Slice[] = [];
  const runningSerial = running.some(r => r.wave.kind !== 'parallel');
  if (profile === 'adaptive') return { ...adaptiveBatch(ready, running, runningSerial, capacity!), waiting };
  const { maxParallel } = PROFILES[profile];
  const slots = Math.max(0, maxParallel - running.length);
  for (const s of ready) {
    if (batch.length >= slots) { deferred.push({ id: s.id, reason: slots === 0 ? 'no free slot' : `profile width ${maxParallel} reached` }); continue; }
    if (runningSerial) { deferred.push({ id: s.id, reason: 'a sequential or integration slice is running' }); continue; }
    const used = [...running, ...batch];
    if (used.length && (s.wave.kind !== 'parallel' || used.some(u => u.wave.kind !== 'parallel'))) {
      deferred.push({ id: s.id, reason: s.wave.kind !== 'parallel' ? `${s.wave.kind} slice runs alone` : 'a sequential or integration slice is in the batch' }); continue;
    }
    const clash = used.find(u => overlap(u.files, s.files));
    if (clash) { deferred.push({ id: s.id, reason: `files overlap slice ${clash.id}` }); continue; }
    batch.push(s);
  }
  return { batch, waiting, deferred, slots, running: running.map(r => r.id) };
}

// The same sequential and overlap rules as a fixed profile (parallel slices cross waves), with no fixed width. Then each
// slice needs room in its class limit (and in the total limit, which exists only without measured signals). A sequential
// or integration slice keeps its place: when it waits for capacity, later slices wait too, and it still runs alone.
function adaptiveBatch(ready: Slice[], running: Slice[], runningSerial: boolean, cap: CapacityDecision) {
  const batch: Slice[] = [], deferred: { id: string; reason: string }[] = [];
  const left: Record<'total' | 'normal' | 'heavy', number | null> = { total: cap.total.starts, normal: cap.normal.starts, heavy: cap.heavy.starts };
  const full = (k: keyof typeof left) => { const v = left[k]; return v !== null && v <= 0; };
  const take = (k: keyof typeof left) => { const v = left[k]; if (v !== null) left[k] = v - 1; };
  let anchor: Slice | undefined;
  for (const s of ready) {
    if (runningSerial) { deferred.push({ id: s.id, reason: 'a sequential or integration slice is running' }); continue; }
    const used = [...running, ...batch];
    if (used.length && (s.wave.kind !== 'parallel' || used.some(u => u.wave.kind !== 'parallel'))) {
      deferred.push({ id: s.id, reason: s.wave.kind !== 'parallel' ? `${s.wave.kind} slice runs alone` : 'a sequential or integration slice is in the batch' }); continue;
    }
    // A waiting slice that must run alone, or a later slice that must, keeps its place; parallel slices of any wave do not wait for each other.
    if (!used.length && anchor && (anchor.wave.kind !== 'parallel' || s.wave.kind !== 'parallel')) {
      deferred.push({ id: s.id, reason: `waits for slice ${anchor.id} (${anchor.wave.n} ${anchor.wave.kind}), which waits for capacity` }); continue;
    }
    const clash = used.find(u => overlap(u.files, s.files));
    if (clash) { deferred.push({ id: s.id, reason: `files overlap slice ${clash.id}` }); continue; }
    const cls = s.class === 'heavy' ? 'heavy' : 'normal', limit = full('total') ? cap.total : full(cls) ? cap[cls] : null;
    if (limit) {
      deferred.push({ id: s.id, reason: limit.reason ?? `${cls}: no capacity` });
      if (!used.length && !anchor) anchor = s;
      continue;
    }
    batch.push(s);
    take('total'); take(cls);
  }
  return { batch, deferred, slots: cap.total.starts, running: running.map(r => r.id) };
}
