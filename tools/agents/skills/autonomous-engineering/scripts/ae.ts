import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, renderReport } from './report.ts';
import { createCharter, runStop } from './run.ts';
import { chooseTarget, intensity, parseModelRef } from './dispatch.ts';
import { assessSlice, DEFAULT_POLICY, parsePolicy, parseSnapshot } from './usage.ts';
import type { Caps } from './dispatch.ts';
import { checkPath, classifyCommand, findControls, loadControls, redact } from './guard.ts';
import { assessCapacity, DEFAULT_HEAVY_RSS_MB, emptyCapacity, MAX_HEAVY_RSS_MB, probeMachine } from './capacity.ts';
import type { CapacityDecision, ProbeReading } from './capacity.ts';
import {
  AUTHORITY, FIX_BUDGET, JOURNAL_CAP_BYTES, JOURNAL_WARN_BYTES, MAX_CHECKPOINTS, MAX_WAIT_LOCK_S, PROFILE_NAMES, awaiting, closeStaleHandoffs, handoffOpen, createJournal, evidenceLine, failureSignature, failures, fingerprint, inspectLock, isProfile, journalBytes, journalPath, loadJournal, LockBusy, move,
  faultPoint, nextBatch, orphanTempFiles, outputTail, profileForMode, promoteReady, recordFailure, refuseSymlinks, saveJournal, settled, syncJournal, within, withLock, writeAtomic,
} from './journal.ts';
import type { Attempt, Checkpoint, Evidence, Handoff, Journal, ProfileChange, SliceRecord } from './journal.ts';
import { parsePlan, setSliceFields, verifyCommand } from './plan.ts';
import type { Plan, Slice, State } from './plan.ts';
import { CHECKPOINT_KINDS } from './contract.ts';
import type { CheckpointCheck, CheckpointKind } from './contract.ts';
import { interruptedHook, moduleCommand, resultFields, runHook, sections } from './hooks.ts';
import type { EventName, HookCtx, ModuleCommand, RunCtx, SectionEnv } from './hooks.ts';
import { floorWarning, packet } from './packet.ts';
import type { PacketEnv } from './packet.ts';
import { decide, listDecisions, lookup, parseKey, parseScope, view } from './decisions.ts';
import { addInterruption, openInterruptions } from './failover.ts';
import { parseFailureClass, parseInterruptionSource, parseIsoTime, parseRetryable, workerLabel } from './options.ts';
import { blobIds, snapshotPrefix } from './progress.ts';

// Engine CLI. node --experimental-strip-types ae.ts <command> PLAN [SLICE] [flags]
// JSON on stdout. Errors on stderr with exit 1. `check` exits 0 for allow and 2 for ask or deny.

// `probe` reads the machine for the adaptive profile (capacity.ts). Tests pass their own; no test runs sysctl.
export type Deps = { cwd: string; now?: () => Date; probe?: () => ProbeReading };
type Args = { command: string; plan: string; slice?: string; flags: Map<string, string>; caps?: string[]; cmd?: string; path?: string };
// Files the engine itself rewrites, as canonical repo paths: real root to real plan folder. They never count toward a slice fingerprint.
const engineOwned = (root: string, planPath: string, jfile: string) => {
  const realRoot = realpathSync(root), dir = realpathSync(dirname(planPath));
  return new Set([planPath, planPath.replace(/\.md$/, '.html'), jfile, jfile + '.bak', jfile + '.lock', ...orphanTempFiles(planPath, jfile, jfile + '.bak')].map(p => relative(realRoot, join(dir, basename(p)))));
};
type Base = { args: Args; plan: Plan; now: Date; root: string; planPath: string; cwd: string; jfile: string; probe: () => ProbeReading };
// `discard`: the handler found that nothing may be recorded (an unstable two-phase run); the save is skipped.
type Ctx = Base & { journal: Journal; slice: (id: string | undefined) => { s: Slice; rec: SliceRecord }; discard?: boolean };
type Result = Record<string, unknown>;

const COMMANDS = ['init', 'status', 'next', 'start', 'finish', 'block', 'fail', 'review', 'verify', 'unblock', 'integrate', 'check', 'dispatch', 'handoff', 'recover', 'usage', 'checkpoint', 'prepare', 'transfer', 'report', 'charter', 'set-profile', 'decide', 'decisions', 'interrupt', 'attach', 'lead'];
const USAGE = `usage: ae.ts <command> PLAN [SLICE] [flags]\n       ae.ts check [PLAN] -- CMD | --path P\ncommands: ${COMMANDS.join(', ')}`;
const FLAGS = ['allow', 'profile', 'provider', 'model', 'effort', 'task-id', 'summary', 'reason', 'by', 'note', 'timeout', 'ref', 'manual', 'caps', 'host', 'apply', 'reject',
  'snapshot', 'policy', 'agent', 'remaining', 'to', 'lead', 'done', 'next', 'json', 'approval', 'deadline', 'cap', 'branch', 'replace', 'heavy-rss-mb',
  'key', 'risk', 'status', 'question', 'answer', 'recommended', 'rollback', 'source', 'scope', 'class', 'code', 'retryable', 'reset-at', 'operation', 'launch-key', 'kind', 'active',
  'decision', 'watch', 'supersedes', 'evidence', 'run-check', 'workspace', 'lead-id', 'label', 'claim', 'takeover', 'observed', 'release', 'disarmed', 'thread-id', 'mode', 'exception', 'wait-lock'];
const BOOLEAN = ['manual', 'apply', 'reject', 'json', 'replace', 'active', 'run-check', 'claim', 'takeover', 'release'];
// Free text that the journal, the plan, or the output can hold. It is redacted when it is read, before anything stores it.
const FREE_TEXT = ['summary', 'reason', 'by', 'note', 'ref', 'task-id', 'provider', 'model', 'effort', 'agent', 'to', 'lead', 'done', 'next',
  'question', 'answer', 'recommended', 'rollback', 'source', 'code', 'operation', 'evidence', 'label', 'observed', 'exception'];
const HOSTS = ['t3', 'claude-code', 'other'];
const READ_ONLY = ['dispatch', 'handoff', 'usage', 'report', 'decisions'];
// `decide` with only --key is a lookup: read-only, no lock. With any of these flags it is a lead write.
const DECIDE_WRITE = ['risk', 'status', 'question', 'answer', 'recommended', 'rollback', 'source'];
const isReadOnly = (a: Args) => READ_ONLY.includes(a.command) || (a.command === 'decide' && !DECIDE_WRITE.some(f => a.flags.has(f)));
const DEFAULT_TIMEOUT_S = 600;
// Slice commands whose output a module may extend (hooks.ts `result`).
const SLICE_COMMANDS = ['start', 'finish', 'fail', 'block', 'unblock', 'checkpoint', 'prepare', 'transfer', 'interrupt', 'review', 'verify'];
// Phase 3 of a two-phase run waits this long for the lock, so a short command of another process (it holds the lock
// for well under a second) does not discard a long check. --wait-lock raises it, up to 60 s.
const RELOCK_WAIT_MS = 5_000;

function parseCheck(rest: string[]): Args {
  const plan = rest[0] && !rest[0].startsWith('--') ? rest.shift()! : '', flags = new Map<string, string>();
  if (rest[0] === '--') {
    const cmd = rest.slice(1).join(' ').trim();
    if (!cmd) throw new Error('check: a command is required after --');
    return { command: 'check', plan, flags, cmd };
  }
  if (rest[0] === '--path' && rest.length === 2 && rest[1]) return { command: 'check', plan, flags, path: rest[1] };
  throw new Error('usage: ae.ts check [PLAN] -- CMD   or   ae.ts check [PLAN] --path P');
}

function parseArgs(argv: string[]): Args {
  const [command, ...tail] = argv;
  if (!command) throw new Error(USAGE);
  if (!COMMANDS.includes(command)) throw new Error(`unknown command "${command}"\n${USAGE}`);
  if (command === 'check') return parseCheck(tail);
  const [plan, ...rest] = tail;
  if (!plan || plan.startsWith('--')) throw new Error(`${command}: PLAN path is required`);
  const flags = new Map<string, string>();
  const caps: string[] = [];
  let slice: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { if (slice !== undefined) throw new Error(`unexpected argument "${a}"`); slice = a; continue; }
    const name = a.slice(2);
    if (!FLAGS.includes(name)) throw new Error(`unknown flag --${name}`);
    if (BOOLEAN.includes(name)) { flags.set(name, 'true'); continue; }
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`flag --${name} needs a value`);
    if (name === 'cap') caps.push(v);
    else if (['approval', 'deadline', 'branch'].includes(name) && flags.has(name)) throw new Error(`duplicate flag --${name}`);
    flags.set(name, FREE_TEXT.includes(name) ? redact(v) : v);
  }
  return { command, plan, slice, flags, caps };
}

const need = (a: Args, name: string) => {
  const v = a.flags.get(name)?.trim();
  if (!v) throw new Error(`${a.command}: --${name} is required`);
  return v;
};
// `class` shows only for a heavy slice, so the output for a plan without Class lines is unchanged.
const brief = (s: Slice, rec: SliceRecord) => ({ id: s.id, name: s.name, state: rec.state, wave: `${s.wave.n} ${s.wave.kind}`, ...(s.class === 'heavy' ? { class: s.class } : {}), dependsOn: s.dependsOn, files: s.files, model: s.model, review: s.review, fallback: s.fallback, verify: s.verify });

// The repo is the Git top level of the working folder. Only outside Git does the plan's folder decide.
const repoRoot = (cwd: string, planPath?: string) => git(cwd, 'rev-parse', '--show-toplevel') ?? (planPath ? git(dirname(planPath), 'rev-parse', '--show-toplevel') : null) ?? cwd;

function git(root: string, ...args: string[]): string | null {
  return gitRaw(root, ...args)?.trim() ?? null;
}
function gitRaw(root: string, ...args: string[]): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// Changed paths from git status (renames give the new path), or null outside Git.
function changedFiles(root: string): string[] | null {
  const status = gitRaw(root, '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all');
  if (status === null) return null;
  const parts = status.split('\0').filter(Boolean), changed: string[] = [];
  for (let i = 0; i < parts.length; i++) { changed.push(parts[i].slice(3)); if (/^[RC]/.test(parts[i])) i++; }
  return changed;
}

// The engine is the only writer of State and Evidence lines. Bring the plan in line with the journal.
function reconcile(text: string, plan: Plan, journal: Journal): string {
  let out = text;
  for (const s of plan.slices) {
    const rec = journal.slices[s.id], line = evidenceLine(rec);
    if (s.state !== rec.state || s.evidence !== line) out = setSliceFields(out, s.id, { state: rec.state, evidence: line });
  }
  return out;
}

// ---- guard wiring ----
const NO_CONTROLS = 'no controls/controls.json found: only built-in rules apply. Set HARNESS_ROOT to the harness checkout to add the harness controls.';
// Found through $HARNESS_ROOT, this script's folders, or the plan's repo root. The result always says which.
function controlsFor(root: string) {
  const file = findControls(undefined, root);
  return { rules: file ? loadControls(file) : [], report: file ? { controls: file } : { controls: null, warning: NO_CONTROLS } };
}

// Every Files entry must be a relative path inside the repo and not protected.
function filesProblems(plan: Plan, root: string, allow: string[]): { id: string; text: string }[] {
  return plan.slices.flatMap(s => s.files.map(f => ({ f, r: checkPath(f, root, { allow }) })).filter(x => !x.r.ok).map(x => ({ id: s.id, text: `slice ${s.id}: Files entry "${x.f}": ${x.r.reason}` })));
}
// One error lists all problems.
function assertFiles(plan: Plan, root: string, allow: string[]) {
  const problems = filesProblems(plan, root, allow).map(p => p.text);
  if (problems.length) throw new Error(`${problems.length} Files path${problems.length === 1 ? ' is' : 's are'} not allowed:\n${problems.map(x => `- ${x}`).join('\n')}`);
}

// check: read-only. No lock, no write. Exit code 0 for allow, 2 for ask or deny.
function check(args: Args, deps: Deps): Result {
  let root = repoRoot(deps.cwd), allow: string[] = [];
  if (args.plan) {
    const planPath = resolve(deps.cwd, args.plan);
    if (!existsSync(planPath)) throw new Error(`plan not found: ${planPath}`);
    root = repoRoot(deps.cwd, planPath);
    const jfile = journalPath(planPath);
    if (existsSync(jfile) || existsSync(jfile + '.bak')) allow = loadJournal(jfile).journal.authority.allow;
  }
  if (args.cmd !== undefined) {
    const c = controlsFor(root), v = classifyCommand(args.cmd, { allow, controls: c.rules });
    return { ...v, ...(v.segment ? { segment: redact(v.segment) } : {}), kind: 'command', command: redact(args.cmd), authority: allow, ...c.report, exitCode: v.decision === 'allow' ? 0 : 2 };
  }
  const r = checkPath(args.path!, root, { allow }), decision = r.ok ? 'allow' : r.needs ? 'ask' : 'deny';
  return { kind: 'path', path: args.path, root, decision, ...(r.ok ? { level: 'A' } : r.needs ? { level: 'B', needs: r.needs } : {}), reason: r.ok ? 'inside the repo and not protected' : r.reason, authority: allow, exitCode: r.ok ? 0 : 2 };
}

// ---- verify run ----
type RunResult = { exitCode?: number; timeout?: string; signal?: string; output: string; timedOut: boolean; durationMs: number };
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    // pipefail: `npm test | tail` fails when npm test fails
    const child = spawn('bash', ['-o', 'pipefail', '-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const take = (b: Buffer) => { output += b.toString('utf8'); if (output.length > 200_000) output = output.slice(-100_000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveRun({ ...(code !== null && !timedOut ? { exitCode: code } : {}), ...(timedOut ? { timeout: `${timeoutMs}ms` } : {}), ...(signal ? { signal } : {}), output, timedOut, durationMs: Math.round(performance.now() - started) }); });
  });
}

// ---- commands ----
const fromTo = (rec: SliceRecord, id: string, from: string): Result => ({ slice: id, from, to: rec.state, state: rec.state });
function expect(rec: SliceRecord, id: string, ...states: string[]) {
  if (!states.includes(rec.state)) throw new Error(`slice ${id} is ${rec.state}; this command needs ${states.join(' or ')}`);
}
const openAttempt = (rec: SliceRecord) => [...rec.attempts].reverse().find(a => a.kind === 'work' && !a.outcome);

const readJsonFlag = (c: Ctx, name: string): unknown => {
  const file = resolve(c.cwd, c.args.flags.get(name)!);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    const position = e instanceof SyntaxError ? e.message.match(/\bat position (\d+)(?: \(line \d+ column \d+\))?$/)?.[1] : undefined;
    const reason = e instanceof SyntaxError ? `not valid JSON${position ? ` at position ${position}` : ''}` : e instanceof Error ? e.message : String(e);
    throw new Error(redact(`cannot read --${name} ${file}: ${reason}`));
  }
};
function hostOpts(c: Ctx) {
  const host = c.args.flags.get('host') ?? 'other';
  if (!HOSTS.includes(host)) throw new Error(`unknown --host "${host}"; use ${HOSTS.join(', ')}`);
  let caps: Caps | null = null;
  if (c.args.flags.has('caps')) {
    caps = readJsonFlag(c, 'caps') as Caps;
    if (!Array.isArray(caps?.providers)) throw new Error(`--caps ${c.args.flags.get('caps')} has no "providers" list`);
  }
  return { caps, host };
}

// ---- usage handoff (plans/usage-continuity.md) ----
const lastHandoff = (rec: SliceRecord): Handoff | undefined => rec.handoffs?.at(-1);
// The handoff that owns the open work attempt, when that attempt was opened by transfer.
// A CLOSED handoff owns nothing, even when its attempt was left open (a definition change does not end attempts).
const transferOf = (rec: SliceRecord) => { const i = openAttempt(rec)?.handoff, h = i === undefined ? undefined : rec.handoffs?.[i]; return h?.phase === 'TRANSFERRED' ? h : undefined; };
// Who works the slice now: the replacement while its transfer attempt is open, else the slice's Model.
// DEC-6: Claude is always the lead that decides the replacement.
function requireLead(a: Args): string {
  const lead = need(a, 'lead');
  let agent: string;
  try { agent = parseModelRef(lead).agent; } catch { agent = ''; }
  if (agent !== 'Claude') throw new Error(`${a.command}: only a Claude lead decides the replacement; --lead "${lead}" is not a Claude model text such as "Claude (opus/high)". Hand the decision to the Claude lead`);
  return lead;
}
const clip = (t: string | undefined, n: number) => { const x = (t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 3) + '...' : x; };
// The last check the engine saw for this slice: live evidence, else the last verify or review attempt.
function lastCheck(rec: SliceRecord): string {
  const live = rec.evidence.filter(e => !e.stale);
  if (live.length) return evidenceLine(rec);
  const a = rec.attempts.filter(x => x.kind !== 'work').at(-1);
  if (!a) return 'none';
  return a.kind === 'verify' ? `verify exit ${a.exitCode ?? 'none'} at ${a.at}` : `review rejected at ${a.at}: ${clip(a.reason, 120)}`;
}

// dispatch and handoff: the target for the next attempt, by failures since the budget started.
function pickTarget(c: Ctx) {
  const { s, rec } = c.slice(c.args.slice), f = c.args.flags;
  if (rec.state === 'FAILED') throw new Error(`slice ${s.id} is FAILED (fix budget spent or no progress); only unblock --reason (a user decision) restarts it`);
  expect(rec, s.id, 'READY');
  const n = failures(rec).length;
  if (n >= FIX_BUDGET) throw new Error(`slice ${s.id} has ${n} failures; the fix budget (${FIX_BUDGET}) is spent`);
  const opts = hostOpts(c);
  // failures 0 and 1: the builder; 2: one level up; 3: the Fallback owner
  const pick = n <= 1 ? chooseTarget(s, 0, opts) : n === 2 ? chooseTarget(s, 1, opts) : chooseTarget({ model: s.fallback }, 0, opts);
  const escalateWhen = [
    'next failure (1): the builder fixes once more; failure 2 escalates one level, failure 3 uses the Fallback, failure 4 sets FAILED',
    'next failure (2): escalate one level; failure 3 uses the Fallback, failure 4 sets FAILED',
    'next failure (3): use the Fallback owner; failure 4 sets FAILED',
    'next failure (4): FAILED, the fix budget is spent; three identical failures in a row also set FAILED',
  ][n];
  // at failure 3 the Fallback is passed as the Model, so name it for what it is
  return { s, rec, failures: n, ...pick, ...(n === 3 && pick.used === 'model' ? { used: 'fallback' as const } : {}), escalateWhen, intensity: intensity(parseModelRef(pick.target.label)) };
}

// What a hook sees (hooks.ts). The slug names the plan in launch keys.
const runCtx = (c: Base & { journal: Journal }): RunCtx => ({
  journal: c.journal, plan: c.plan, slug: basename(c.planPath).replace(/\.md$/, ''), root: c.root, at: c.now.toISOString(),
  command: c.args.command, flags: c.args.flags, skip: engineOwned(c.root, c.planPath, c.jfile),
});
const hookCtx = (c: Ctx, s: Slice, rec: SliceRecord): HookCtx => ({ ...runCtx(c), s, rec });
// What a read-only section sees (status, report, recover).
const sectionEnv = (b: Base): SectionEnv => ({ root: b.root, plan: b.plan, skip: engineOwned(b.root, b.planPath, b.jfile) });
// The slice a writing command names, for guardWrite: undefined when there is none or it is not valid (the handler reports that).
const namedSlice = (c: Ctx) => { const id = c.args.slice; return id && /^\d+$/.test(id) && c.plan.slices.some(x => x.id === id) ? c.slice(id) : undefined; };
// attach and lead come from a track module (hooks.ts `commands`). With SLICE, the module gets a HookCtx (a RunCtx with
// `s` and `rec`); for attach the event guard runs first. With no module, today's refusal stays.
function viaModule(c: Ctx, name: ModuleCommand, stub: string): Result {
  const fn = moduleCommand(name);
  if (!fn) throw new Error(stub);
  if (c.args.slice === undefined) return fn(runCtx(c));
  const { s, rec } = c.slice(c.args.slice);
  return fn(name === 'attach' ? guard(c, s, rec, 'attach') : hookCtx(c, s, rec));
}
const guard = (c: Ctx, s: Slice, rec: SliceRecord, event: EventName) => { const h = hookCtx(c, s, rec); runHook('guardEvent', h, event, openAttempt(rec)); return h; };
// The packet (packet.ts) is the handoff note. Files, Out of scope, and Verify are copied byte for byte.
const packetEnv = (c: Base, label: string, extra: Partial<PacketEnv> = {}): PacketEnv => ({ planPath: c.planPath, journalFile: c.jfile, label, root: c.root, ...extra });

const handlers: Record<string, (c: Ctx) => Promise<Result> | Result> = {
  status(c) {
    const counts: Record<string, number> = {};
    const slices = c.plan.slices.map(s => {
      const rec = c.journal.slices[s.id];
      counts[rec.state] = (counts[rec.state] ?? 0) + 1;
      const last = rec.history[rec.history.length - 1];
      return { ...brief(s, rec), failures: failures(rec).length, budget: FIX_BUDGET, blocker: rec.blocker?.reason, ...(lastHandoff(rec) ? { handoff: { phase: lastHandoff(rec)!.phase, to: lastHandoff(rec)!.to } } : {}), lastMove: last && `${last.from} -> ${last.to}: ${last.reason}`, evidence: evidenceLine(rec) };
    });
    // REQ-23: the journal size as it is saved. ACC drops a journal above 2 MiB.
    const bytes = journalBytes(c.journal);
    const size = { journalBytes: bytes, ...(bytes > JOURNAL_WARN_BYTES ? { journalWarning: `the journal is ${bytes} bytes, above 1 MiB. ACC drops a journal above 2 MiB; above 1.5 MiB the engine refuses writes that grow it, except state moves. Ask the user to archive it` } : {}) };
    return { plan: c.journal.plan, profile: c.journal.profile, authority: c.journal.authority, counts, done: c.plan.slices.every(s => settled(c.journal.slices[s.id].state)), slices, ...size, ...sections('statusSection', c.journal, sectionEnv(c)) };
  },

  charter(c) {
    const f = c.args.flags;
    if (c.journal.run && (!f.has('replace') || !f.get('reason')?.trim())) throw new Error('charter already exists; replacement requires --replace --reason');
    if (f.has('replace')) need(c.args, 'reason');
    c.journal.run = createCharter({ root: c.root, cwd: c.cwd, approval: need(c.args, 'approval'), deadline: need(c.args, 'deadline'), caps: c.args.caps ?? [],
      branch: f.get('branch'), reason: f.get('reason'), now: c.now });
    return { run: c.journal.run };
  },

  next(c) {
    const stop = runStop(c.journal, c.now);
    if (stop) return { ...stop, batch: [], done: c.plan.slices.every(s => settled(c.journal.slices[s.id].state)) };
    const promoted = promoteReady(c.journal, c.plan, c.now);
    // adaptive: read the machine, keep the sample in the journal, and decide the width per class
    let capacity: CapacityDecision | undefined;
    if (c.journal.profile === 'adaptive') { const a = assessCapacity(c.journal, c.plan, c.probe(), c.now); c.journal.capacity = a.state; capacity = a.decision; }
    const { batch, waiting, deferred, slots, running } = nextBatch(c.journal, c.plan, capacity);
    return { profile: c.journal.profile, slots, running, promoted, batch: batch.map(s => brief(s, c.journal.slices[s.id])), waiting, deferred, ...(capacity ? { capacity } : {}), ...awaiting(c.journal, c.plan), done: c.plan.slices.every(s => settled(c.journal.slices[s.id].state)) };
  },

  // The lead's choice of width, for a journal that exists. It runs under the journal lock, and the save keeps the old
  // journal as .bak. Each change is a profileChanges row. The same profile and estimate again is a no-op.
  'set-profile'(c) {
    const f = c.args.flags, to = need(c.args, 'profile'), from = c.journal.profile;
    if (!isProfile(to)) throw new Error(`set-profile: unknown profile "${to}"; use ${PROFILE_NAMES.join(', ')}`);
    const rss = heavyRss(c.args, to), rssChanged = rss !== undefined && rss !== c.journal.capacity?.heavyRssMB;
    const estimate = () => (to === 'adaptive' ? { heavyRssMB: c.journal.capacity?.heavyRssMB ?? DEFAULT_HEAVY_RSS_MB, heavyRssFrom: c.journal.capacity?.heavyRssMB ? 'set' : 'default' } : {});
    if (to === from && !rssChanged) return { profile: to, from, changed: false, ...estimate() };
    c.journal.profile = to;
    if (to === 'adaptive') { c.journal.capacity ??= emptyCapacity(); if (rss !== undefined) c.journal.capacity.heavyRssMB = rss; }
    const reason = f.get('reason')?.trim();
    const change: ProfileChange = { at: c.now.toISOString(), from, to, ...(reason ? { reason } : {}), ...(rssChanged ? { heavyRssMB: rss } : {}) };
    (c.journal.profileChanges ??= []).push(change);
    return { profile: to, from, changed: true, change, ...estimate() };
  },

  start(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state;
    const stop = runStop(c.journal, c.now);
    if (stop) return { ...stop, slice: s.id, state: rec.state };
    expect(rec, s.id, 'READY');
    const unmet = s.dependsOn.filter(d => !settled(c.journal.slices[d].state));
    if (unmet.length) throw new Error(`slice ${s.id} depends on unverified slice ${unmet.join(', ')}`);
    const f = c.args.flags, at = c.now.toISOString();
    const attempt: Attempt = { n: rec.attempts.length + 1, kind: 'work', at, provider: f.get('provider'), model: f.get('model'), effort: f.get('effort'), taskId: f.get('task-id') };
    rec.attempts.push(attempt);
    runHook('attemptOpened', hookCtx(c, s, rec), attempt, 'start', undefined);
    move(rec, 'IN_PROGRESS', 'start', at);
    const warning = floorWarning(c.journal, s, packetEnv(c, s.model));
    return { ...fromTo(rec, s.id, from), attempt: rec.attempts.length, ...(attempt.launchKey ? { launchKey: attempt.launchKey } : {}), ...(attempt.baseTree ? { baseTree: attempt.baseTree } : {}), ...(warning ? { warning } : {}) };
  },

  finish(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state;
    expect(rec, s.id, 'IN_PROGRESS');
    const h = guard(c, s, rec, 'finish'), a = openAttempt(rec), at = c.now.toISOString();
    if (a) { a.outcome = 'finished'; a.endedAt = at; a.summary = c.args.flags.get('summary'); runHook('attemptEnded', h, a); }
    move(rec, 'AGENT_FINISHED', 'worker reported done (a claim, not verified)', at);
    return { ...fromTo(rec, s.id, from), next: 'review, then verify' };
  },

  block(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state, reason = need(c.args, 'reason');
    expect(rec, s.id, 'IN_PROGRESS');
    const h = guard(c, s, rec, 'block'), a = openAttempt(rec), at = c.now.toISOString();
    if (a) { a.outcome = 'blocked'; a.endedAt = at; a.reason = reason; runHook('attemptEnded', h, a); }
    rec.blocker = { reason, at };
    runHook('blocked', h, reason);
    move(rec, 'BLOCKED', reason, at);
    return { ...fromTo(rec, s.id, from), next: 'a user decision, then unblock --reason' };
  },

  fail(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state, reason = need(c.args, 'reason');
    expect(rec, s.id, 'IN_PROGRESS');
    const h = guard(c, s, rec, 'fail'), a = openAttempt(rec) ?? { n: rec.attempts.length + 1, kind: 'work', at: c.now.toISOString() };
    const out = recordFailure(rec, a, c.now.toISOString(), reason);
    runHook('attemptEnded', h, a);
    return { ...fromTo(rec, s.id, from), failures: failures(rec).length, why: out.why };
  },

  // --reject: the reviewer found a defect. The slice goes back to READY as a failed attempt on the attempt ladder.
  review(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state, by = need(c.args, 'by'), note = need(c.args, 'note'), reject = c.args.flags.has('reject');
    expect(rec, s.id, ...(reject ? ['AGENT_FINISHED', 'REVIEWED'] : ['AGENT_FINISHED']));
    if (s.review === 'CI') throw new Error(`slice ${s.id} has Review: CI; run verify instead`);
    // every worker that wrote this slice is a builder, also one that handed it off
    const builders = new Set(rec.attempts.filter(a => a.kind === 'work' && a.taskId).map(a => a.taskId));
    if (builders.has(by)) throw new Error(`reviewer "${by}" is a builder's task for this slice; the reviewer must be independent`);
    const at = c.now.toISOString(), f = c.args.flags;
    const attempt: Attempt = { n: rec.attempts.length + 1, kind: 'review', at, provider: f.get('provider'), model: f.get('model'), effort: f.get('effort') };
    if (reject) {
      attempt.signature = failureSignature(note);
      const out = recordFailure(rec, attempt, at, `review rejected by ${by}: ${note}`);
      return { ...fromTo(rec, s.id, from), failures: failures(rec).length, why: out.why, next: rec.state === 'READY' ? 'dispatch again: the attempt ladder picks the target' : 'FAILED: only unblock --reason (a user decision) restarts it' };
    }
    rec.attempts.push({ ...attempt, outcome: 'finished', endedAt: at, summary: note });
    rec.review = { by, note, at };
    move(rec, 'REVIEWED', `reviewed by ${by}`, rec.review.at);
    return { ...fromTo(rec, s.id, from), next: 'verify' };
  },

  // verify runs in two phases (PHASED below): the lock is held only to check and to record.

  // BLOCKED returns to IN_PROGRESS (the worker continues). FAILED returns to READY. Both restart the fix budget.
  unblock(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state, reason = need(c.args, 'reason'), at = c.now.toISOString();
    expect(rec, s.id, 'BLOCKED', 'FAILED');
    const hc = hookCtx(c, s, rec);
    runHook('unblocked', hc, reason);
    rec.budgetFrom = rec.attempts.length;
    delete rec.blocker;
    if (from === 'BLOCKED') {
      const prev = rec.attempts.filter(a => a.kind === 'work').at(-1);
      // the same worker continues, so a transfer that owned the blocked attempt owns the new one
      // the same worker continues: it keeps the identity the previous attempt recorded, so a later refusal names the right agent
      const next: Attempt = { n: rec.attempts.length + 1, kind: 'work', at, ...(prev?.provider ? { provider: prev.provider } : {}), ...(prev?.model ? { model: prev.model } : {}), ...(prev?.effort ? { effort: prev.effort } : {}),
        ...(prev?.outcome === 'blocked' && prev.handoff !== undefined ? { handoff: prev.handoff, taskId: prev.taskId } : {}) };
      rec.attempts.push(next);
      runHook('attemptOpened', hc, next, 'unblock', prev);
      move(rec, 'IN_PROGRESS', `unblocked: ${reason}`, at);
      return { ...fromTo(rec, s.id, from), next: 'the worker continues; finish or fail when done' };
    }
    move(rec, 'READY', `unblocked: ${reason}`, at);
    return fromTo(rec, s.id, from);
  },

  integrate(c) {
    const { s, rec } = c.slice(c.args.slice), from = rec.state, ref = need(c.args, 'ref');
    expect(rec, s.id, 'VERIFIED', 'ACCEPTED');
    rec.integratedRef = ref;
    move(rec, 'INTEGRATED', `integrated at ${ref}`, c.now.toISOString());
    return fromTo(rec, s.id, from);
  },

  dispatch(c) {
    const { s, rec, ...p } = pickTarget(c);
    return { slice: s.id, state: rec.state, failures: p.failures, target: p.target, used: p.used, chain: p.chain, intensity: p.intensity, escalateWhen: p.escalateWhen };
  },

  handoff(c) {
    const cur = c.slice(c.args.slice), last = lastHandoff(cur.rec);
    // Only the latest handoff counts. Its note exists only after transfer has claimed ownership.
    if (cur.rec.state === 'IN_PROGRESS' && handoffOpen(last)) throw new Error(`slice ${cur.s.id} has a ${last!.phase} handoff; run ${last!.phase === 'PREPARED' ? 'ae checkpoint, then ' : ''}ae transfer first, so ownership moves before the replacement starts`);
    const h = last?.phase === 'TRANSFERRED' && transferOf(cur.rec) === last ? last : undefined;
    if (cur.rec.state === 'IN_PROGRESS' && h) {
      const pick = chooseTarget({ model: h.to }, 0, hostOpts(c)), cp = cur.rec.checkpoints?.at(-1);
      const env = packetEnv(c, h.to, {
        blobs: blobIds(c.root, cp ? (cp.delta ?? cp.changed) : []),
        fingerprintNow: fingerprint(c.root, cur.s.files, engineOwned(c.root, c.planPath, c.jfile)),
      });
      const { json, text } = packet(c.journal, cur.s, 'continuation', env);
      return { slice: cur.s.id, state: cur.rec.state, continuation: true, phase: h.phase, target: pick.target.label, dispatch: pick.target.dispatch, resolved: pick.target, chars: text.length, text, packet: json };
    }
    const { s, rec, ...p } = pickTarget(c), { json, text } = packet(c.journal, s, 'dispatch', packetEnv(c, p.target.label));
    return { slice: s.id, state: rec.state, target: p.target.label, dispatch: p.target.dispatch, used: p.used, chars: text.length, text, packet: json };
  },

  // Read-only. The current worker's usage risk and, from `assess` up, ranked replacements. The Claude lead decides.
  usage(c) {
    const { s, rec } = c.slice(c.args.slice), f = c.args.flags;
    expect(rec, s.id, 'IN_PROGRESS', 'READY');
    if (!f.has('snapshot')) throw new Error('usage: --snapshot FILE is required (the usage you observed; use {"agents":{}} when you have none)');
    const snapshot = parseSnapshot(readJsonFlag(c, 'snapshot')), policy = f.has('policy') ? parsePolicy(readJsonFlag(c, 'policy')) : DEFAULT_POLICY;
    let remaining: number | undefined;
    if (f.has('remaining')) { remaining = Number(f.get('remaining')); if (!(remaining >= 0)) throw new Error('--remaining must be a percent, 0 or more'); }
    const current = f.get('agent') ?? workerLabel(s, rec), h = lastHandoff(rec);
    return { slice: s.id, state: rec.state, ...(h ? { handoff: { phase: h.phase, to: h.to } } : {}), ...assessSlice(s, current, snapshot, policy, hostOpts(c), remaining) };
  },

  // A lightweight checkpoint at a milestone, or before a handoff. A PREPARED handoff becomes CHECKPOINTED.
  // With --launch-key it is the worker's own checkpoint: a claim for its open attempt that never moves a handoff phase.
  // With --run-check it runs in two phases (PHASED below) and stores the engine-run check on the checkpoint.
  checkpoint(c) { return takeCheckpoint(c); },

  // The Claude lead's choice of replacement. Idempotent for the same --to.
  prepare(c) {
    const { s, rec } = c.slice(c.args.slice), lead = requireLead(c.args), reason = need(c.args, 'reason'), at = c.now.toISOString();
    expect(rec, s.id, 'IN_PROGRESS');
    const to = parseModelRef(need(c.args, 'to'));
    if (to.agent === 'user' || to.agent === 'CI') throw new Error(`prepare: --to must be an agent, not ${to.label}`);
    if (to.agent === 'Grok') throw new Error('prepare: Grok reviews only; it never builds a slice');
    const h = lastHandoff(rec);
    const self = (from: string) => { if (from === to.label && to.extras.every(x => x !== 'fresh session')) throw new Error(`prepare: --to "${to.label}" is the current worker; for a context limit use a fresh session ("${to.label.replace(/\)$/, ', fresh session)')}")`); };
    if (h && handoffOpen(h)) {
      if (h.to === to.label) return { slice: s.id, state: rec.state, unchanged: true, handoff: h };
      self(h.from.label);
      h.history.push({ at, phase: h.phase, note: `lead ${lead} changed the replacement from ${h.to} to ${to.label}: ${reason}` });
      h.to = to.label; h.lead = lead; h.reason = reason;
      return { slice: s.id, state: rec.state, handoff: h, next: h.phase === 'CHECKPOINTED' ? 'ae transfer, ae handoff, delegate, ae transfer --task-id' : 'ae checkpoint' };
    }
    const open = openAttempt(rec), from = workerLabel(s, rec);
    self(from);
    const nh: Handoff = { phase: 'PREPARED', at, lead, reason, from: { label: from, ...(open ? { attempt: open.n } : {}), ...(open?.taskId ? { taskId: open.taskId } : {}) }, to: to.label, history: [{ at, phase: 'PREPARED', note: `lead ${lead}: ${reason}` }] };
    // The lead already took a post-mortem (or pre-handoff) checkpoint of this attempt, after its last interruption,
    // and no slice file changed since: the handoff opens at CHECKPOINTED.
    const cp = rec.checkpoints?.at(-1), lastStop = openInterruptions(open).at(-1);
    if (open && cp && cp.role === 'lead' && (cp.kind === 'post-mortem' || cp.kind === 'pre-handoff') && cp.attempt === open.n && (!lastStop || cp.at >= lastStop.at)
      && fingerprint(c.root, s.files, engineOwned(c.root, c.planPath, c.jfile)) === cp.fingerprint) {
      nh.phase = 'CHECKPOINTED'; nh.checkpointAt = cp.at;
      nh.history.push({ at, phase: 'CHECKPOINTED', note: `${cp.kind} checkpoint ${cp.at} of attempt ${open.n}; no file changed since` });
    }
    (rec.handoffs ??= []).push(nh);
    return { slice: s.id, state: rec.state, handoff: nh, next: nh.phase === 'CHECKPOINTED' ? 'ae transfer, ae handoff, delegate, ae transfer --task-id' : 'ae checkpoint (the old worker may finish its current step first)' };
  },

  // Ownership moves to the replacement, before it is launched: the fingerprint then proves that only the old worker wrote.
  // Refused when files changed after the checkpoint (the old worker may still write). `--task-id` attaches the
  // replacement's task once it runs; without it the transfer only claims ownership.
  transfer(c) {
    const { s, rec } = c.slice(c.args.slice), lead = requireLead(c.args), taskId = c.args.flags.get('task-id'), f = c.args.flags, at = c.now.toISOString();
    expect(rec, s.id, 'IN_PROGRESS');
    const hc = guard(c, s, rec, 'transfer'), h = lastHandoff(rec);
    if (!h) throw new Error(`transfer: slice ${s.id} has no prepared handoff; run ae prepare and ae checkpoint first`);
    if (h.phase === 'TRANSFERRED') {
      const a = openAttempt(rec);
      if (transferOf(rec) !== h || !a) throw new Error(`transfer: the transfer to ${h.to} no longer owns the open attempt; run ae prepare for a new handoff`);
      if (!taskId || h.taskId === taskId) return { slice: s.id, state: rec.state, unchanged: true, handoff: h };
      if (h.taskId) throw new Error(`transfer: slice ${s.id} is already transferred to task ${h.taskId}; a second worker would duplicate it. Run ae prepare for a new handoff first`);
      a.taskId = taskId; h.taskId = taskId;
      for (const k of ['provider', 'model', 'effort'] as const) if (f.get(k)) a[k] = f.get(k);
      h.history.push({ at, phase: 'TRANSFERRED', note: `task ${taskId} attached by lead ${lead}` });
      return { slice: s.id, state: rec.state, handoff: h, attached: taskId, next: 'the replacement continues; finish, review, and verify as usual' };
    }
    if (h.phase === 'CLOSED') throw new Error(`transfer: the last handoff is CLOSED (the slice left IN_PROGRESS); run ae prepare and ae checkpoint again`);
    if (h.phase !== 'CHECKPOINTED') throw new Error(`transfer: the handoff is ${h.phase}; run ae checkpoint first`);
    const cp = rec.checkpoints!.at(-1)!, now = fingerprint(c.root, s.files, engineOwned(c.root, c.planPath, c.jfile));
    if (now !== cp.fingerprint) throw new Error(`transfer refused: slice ${s.id} files changed after the checkpoint (${cp.fingerprint} -> ${now}). The old worker may still be writing. Stop it, run ae checkpoint again, then transfer. Nothing was written`);
    const old = openAttempt(rec);
    if (old) { old.outcome = 'handed-off'; old.endedAt = at; old.reason = h.reason; runHook('attemptEnded', hc, old); }
    const idx = rec.handoffs!.length - 1;
    const next: Attempt = { n: rec.attempts.length + 1, kind: 'work', at, provider: f.get('provider'), model: f.get('model'), effort: f.get('effort'), ...(taskId ? { taskId } : {}), handoff: idx };
    rec.attempts.push(next);
    runHook('attemptOpened', hc, next, 'transfer', old);
    runHook('transferred', hc, h, old, next);
    h.phase = 'TRANSFERRED'; h.lead = lead; if (taskId) h.taskId = taskId;
    h.history.push({ at, phase: 'TRANSFERRED', note: `lead ${lead} transferred to ${h.to}${taskId ? `, task ${taskId}` : '; no task yet'}` });
    rec.history.push({ at, from: 'IN_PROGRESS', to: 'IN_PROGRESS', reason: `handoff: ${h.from.label} -> ${h.to} (lead ${lead}): ${h.reason}; not a failed attempt` });
    return { slice: s.id, state: rec.state, handoff: h, failures: failures(rec).length, next: taskId ? 'the replacement continues; finish, review, and verify as usual' : 'ae handoff for the note, delegate it, then ae transfer --task-id ID' };
  },

  // The lead records that the worker stopped. The attempt stays open; the fix budget does not move (DEC-21).
  interrupt(c) {
    const { s, rec } = c.slice(c.args.slice), f = c.args.flags, lead = requireLead(c.args);
    expect(rec, s.id, 'IN_PROGRESS');
    const hc = guard(c, s, rec, 'interrupt'), at = c.now.toISOString();
    const open = openAttempt(rec), before = failures(rec).length;
    const i = addInterruption(s.id, open, {
      at, class: parseFailureClass(f.get('class')), code: f.get('code'), source: parseInterruptionSource(f.get('source')),
      retryable: parseRetryable(f.get('retryable')), resetAt: parseIsoTime('reset-at', f.get('reset-at')), operation: f.get('operation'),
      fingerprint: fingerprint(c.root, s.files, engineOwned(c.root, c.planPath, c.jfile)),
    });
    // A module may block the slice (a refusal, or stops with no progress). The attempt then ends as `blocked`, as with
    // `ae block`, so `unblock` opens the next one. Still not a failed attempt: the fix budget does not move.
    const stop = interruptedHook(hc, open!, i);
    if (stop) {
      const { reason, cause } = stop.block;
      open!.outcome = 'blocked'; open!.endedAt = at; open!.reason = reason;
      runHook('attemptEnded', hc, open!);
      rec.blocker = { reason, at, cause };
      runHook('blocked', hc, reason);
      move(rec, 'BLOCKED', reason, at);
    }
    return { slice: s.id, state: rec.state, attempt: open!.n, ...(open!.launchKey ? { launchKey: open!.launchKey } : {}), interruption: i, lead, failures: before, budget: FIX_BUDGET,
      ...(stop ? { blocked: stop.block, next: 'BLOCKED: a user decision, then unblock --reason' } : { next: 'not a failed attempt. Wait or resume the same thread; or ae checkpoint --kind post-mortem, then ae prepare and ae transfer' }) };
  },

  // A lookup (only --key) is read-only. A write records or moves a decision; only the Claude lead writes (DEC-18).
  decide(c) {
    const f = c.args.flags, key = parseKey(f.get('key')), sliceId = c.args.slice;
    if (sliceId !== undefined) c.slice(sliceId);
    if (!DECIDE_WRITE.some(x => f.has(x))) return { key, ...(sliceId ? { slice: sliceId } : {}), ...lookup(c.journal, key, sliceId, sliceId !== undefined ? c.slice(sliceId).s.dependsOn : undefined, c.root) };
    const lead = requireLead(c.args), scope = parseScope(f.get('scope') ?? (sliceId ? `slice:${sliceId}` : undefined), c.plan.slices.map(x => x.id));
    const { decision, created } = decide(c.journal, {
      key, scope, risk: f.get('risk'), status: f.get('status'), question: f.get('question'), answer: f.get('answer'), recommended: f.get('recommended'),
      rollback: f.get('rollback'), source: f.get('source'), by: lead, at: c.now.toISOString(),
      ...(scope !== 'run' ? { sliceDigest: c.journal.slices[scope.slice(6)].definitionDigest } : {}),
    });
    // A module fills what its own flags say (watch, supersedes, evidence), before the save.
    runHook('decided', runCtx(c), decision, created);
    return { decision, created, next: decision.risk === 'red' && decision.status !== 'approved' ? 'RED: ask the user; block only the work that depends on it' : 'recorded; the next packet lists it under Settled' };
  },

  // Read-only, no lock.
  decisions(c) {
    const f = c.args.flags, sliceId = c.args.slice;
    const dependsOn = sliceId !== undefined ? c.slice(sliceId).s.dependsOn : undefined;
    const list = listDecisions(c.journal, { active: f.has('active'), key: f.get('key'), slice: sliceId, dependsOn });
    return { plan: c.journal.plan, count: list.length, decisions: list.map(d => ({ ...view(d), by: d.by, at: d.at, updatedAt: d.updatedAt })) };
  },

  attach(c) { return viaModule(c, 'attach', 'attach: not built yet (slice 8 binds the thread and task to the open attempt); nothing was written'); },
  lead(c) { return viaModule(c, 'lead', 'lead: not built yet (slice 8 adds the lead lease); nothing was written'); },
};

// The checks of a checkpoint, before anything is read or written. Phase 1 and phase 3 of --run-check both run them.
function checkpointGate(c: Ctx) {
  const { s, rec } = c.slice(c.args.slice), f = c.args.flags;
  expect(rec, s.id, 'IN_PROGRESS');
  const hc = guard(c, s, rec, 'checkpoint'), open = openAttempt(rec), role = f.has('launch-key') ? 'worker' as const : 'lead' as const;
  const kind = f.get('kind');
  if (kind !== undefined && !(CHECKPOINT_KINDS as readonly string[]).includes(kind)) throw new Error(`checkpoint: unknown --kind "${kind}"; use ${CHECKPOINT_KINDS.join(', ')}`);
  if (role === 'worker' && handoffOpen(lastHandoff(rec))) throw new Error(`checkpoint refused: slice ${s.id} has a ${lastHandoff(rec)!.phase} handoff; the worker stops and the lead takes the checkpoint. Nothing was written`);
  return { s, rec, hc, open, role, kind: kind as CheckpointKind | undefined };
}

function takeCheckpoint(c: Ctx, check?: CheckpointCheck): Result {
  const { s, rec, hc, open, role, kind } = checkpointGate(c), f = c.args.flags, at = c.now.toISOString();
  const changed = changedFiles(c.root) ?? [], engineFiles = engineOwned(c.root, c.planPath, c.jfile);
  const cp: Checkpoint = {
    at, by: f.get('by') ?? role, gitHead: git(c.root, 'rev-parse', 'HEAD') ?? 'none', branch: git(c.root, 'symbolic-ref', '--short', '-q', 'HEAD') ?? 'detached or none',
    fingerprint: fingerprint(c.root, s.files, engineFiles),
    changed: changed.filter(p => s.files.some(x => within(p, x))),
    unowned: changed.filter(p => !engineFiles.has(p) && !/^BLOCKED[^/]*\.md$/.test(p) && !c.plan.slices.some(o => o.files.some(x => within(p, x)))),
    lastCheck: lastCheck(rec), ...(f.get('done') ? { done: f.get('done') } : {}), ...(f.get('next') ? { next: f.get('next') } : {}), ...(f.get('note') ? { note: f.get('note') } : {}),
    ...(open ? { attempt: open.n } : {}), role, ...(kind ? { kind } : {}), ...(check ? { check } : {}),
  };
  runHook('checkpointTaken', hc, cp, open);
  faultPoint('checkpoint:taken');
  rec.checkpoints = [...(rec.checkpoints ?? []), cp].slice(-MAX_CHECKPOINTS);
  const h = lastHandoff(rec);
  if (role === 'lead' && h && handoffOpen(h) && check?.stable !== false) {
    h.history.push({ at, phase: 'CHECKPOINTED', note: h.phase === 'CHECKPOINTED' ? 'checkpoint refreshed' : 'checkpoint after prepare' });
    h.phase = 'CHECKPOINTED'; h.checkpointAt = at;
  }
  return { slice: s.id, state: rec.state, checkpoint: cp, ...(h ? { handoff: { phase: h.phase, to: h.to } } : {}), next: handoffOpen(h) ? 'stop the old worker, then ae transfer (claims ownership), ae handoff, delegate, ae transfer --task-id' : 'continue' };
}

// ---- two-phase run (Design, "Locks, identity, and the lease"; review-1 F5) ----
// Phase 1, under the lock: check the state and take a snapshot (attempt, definition digest, fingerprint, handoff phase).
// Phase 2, no lock: run the guarded command, so `status`, `decide`, and a worker's checkpoint work meanwhile.
// Phase 3, under the lock again: reload and compare. A change means `unstable: true`: nothing is recorded and the
// fix budget does not move. For --run-check a fingerprint change is recorded instead as `check.stable: false`.
type Snap = { state: State; attempts: number; open: number | null; digest: string; fp: string; handoff: string };
class Prepared {
  readonly command: string; readonly secs: number; readonly snap: Snap; readonly controls: ReturnType<typeof controlsFor>;
  constructor(command: string, secs: number, snap: Snap, controls: ReturnType<typeof controlsFor>) { this.command = command; this.secs = secs; this.snap = snap; this.controls = controls; }
}
type Ran = { prepared: Prepared; run: RunResult; tail: string };
const snapOf = (c: Ctx, s: Slice, rec: SliceRecord): Snap => ({
  state: rec.state, attempts: rec.attempts.length, open: openAttempt(rec)?.n ?? null, digest: rec.definitionDigest,
  fp: fingerprint(c.root, s.files, engineOwned(c.root, c.planPath, c.jfile)), handoff: `${rec.handoffs?.length ?? 0}:${lastHandoff(rec)?.phase ?? 'none'}`,
});
const SNAP_NAMES: Record<keyof Snap, string> = { state: 'slice state', attempts: 'attempts', open: 'open attempt', digest: 'slice definition', fp: 'slice files (fingerprint)', handoff: 'handoff phase' };
const drift = (a: Snap, b: Snap, withFiles: boolean) => (Object.keys(SNAP_NAMES) as (keyof Snap)[]).filter(k => (withFiles || k !== 'fp') && a[k] !== b[k]).map(k => SNAP_NAMES[k]);

function prepareRun(c: Ctx, s: Slice, rec: SliceRecord, command: string, what: string): Prepared {
  const controls = controlsFor(c.root);
  // The guard runs first. A command that is not `allow` is never run and nothing is recorded.
  const v = classifyCommand(command, { allow: c.journal.authority.allow, controls: controls.rules });
  if (v.decision !== 'allow') throw new Error(`${what} refused for slice ${s.id}: decision ${v.decision}, level ${v.level}, rule ${v.rule}, reason: ${v.reason}. Command: ${redact(command)}. Nothing was run or recorded; ask the user.`);
  const secs = c.args.flags.has('timeout') ? Number(c.args.flags.get('timeout')) : DEFAULT_TIMEOUT_S;
  if (!(secs > 0)) throw new Error(`--timeout must be a positive number of seconds`);
  return new Prepared(command, secs, snapOf(c, s, rec), controls);
}

const unstable = (c: Ctx, s: Slice, rec: SliceRecord, changed: string[], r: Ran, extra: Result): Result => {
  c.discard = true;
  return { slice: s.id, from: r.prepared.snap.state, to: rec.state, state: rec.state, ...extra, unstable: true, changed, exitCode: r.run.exitCode, timedOut: r.run.timedOut, outputTail: r.tail, failures: failures(rec).length,
    next: `${changed.join(', ')} changed while the command ran. Nothing was recorded and the fix budget did not move. Run it again when the slice is quiet` };
};

type Phased = { prepare(c: Ctx): Prepared | Result; record(c: Ctx, r: Ran): Result };
const PHASED: Record<string, Phased> = {
  verify: {
    prepare(c) {
      const { s, rec } = c.slice(c.args.slice), from = rec.state, f = c.args.flags;
      if (rec.state === 'AGENT_FINISHED' && s.review !== 'CI') throw new Error(`slice ${s.id} is AGENT_FINISHED and not CI-reviewed; run review first`);
      expect(rec, s.id, 'REVIEWED', 'AGENT_FINISHED');
      const command = verifyCommand(s), manual = f.has('manual');
      if (command) {
        if (manual) throw new Error(`slice ${s.id} has a Verify command; --manual is refused`);
        return prepareRun(c, s, rec, command, 'verify');
      }
      if (!manual) throw new Error(`slice ${s.id} has a manual Verify step; run verify --manual --by NAME --note TEXT`);
      // A person's sign-off is ACCEPTED, never VERIFIED: the engine observed nothing. One phase; nothing runs.
      const evidence: Evidence = { kind: 'manual', by: need(c.args, 'by'), note: need(c.args, 'note'), at: c.now.toISOString(), gitHead: git(c.root, 'rev-parse', 'HEAD') ?? 'none', fingerprint: fingerprint(c.root, s.files, engineOwned(c.root, c.planPath, c.jfile)) };
      rec.evidence.push(evidence);
      move(rec, 'ACCEPTED', `accepted on a person's note: manual check by ${evidence.by}`, evidence.at);
      return { ...fromTo(rec, s.id, from), verified: false, evidence, next: 'run ae next: dependents may be READY' };
    },
    record(c, r) {
      const { s, rec } = c.slice(c.args.slice), from = rec.state, now = snapOf(c, s, rec), { run, tail, prepared: p } = r;
      const changed = drift(p.snap, now, true);
      if (changed.length) return unstable(c, s, rec, changed, r, { verified: false, ...p.controls.report });
      if (run.exitCode !== 0) {
        const attempt: Attempt = { n: rec.attempts.length + 1, kind: 'verify', at: c.now.toISOString(), ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}), ...(run.timeout ? { timeout: run.timeout } : {}), ...(run.signal ? { signal: run.signal } : {}), outputTail: tail, signature: failureSignature(tail) };
        const out = recordFailure(rec, attempt, c.now.toISOString(), `verify failed (${run.timedOut ? 'timeout' : run.signal ? `signal ${run.signal}` : `exit ${run.exitCode ?? 'unknown'}`}): ${redact(p.command)}`);
        return { ...fromTo(rec, s.id, from), verified: false, exitCode: run.exitCode, timedOut: run.timedOut, failures: failures(rec).length, why: out.why, outputTail: tail, ...p.controls.report };
      }
      const evidence: Evidence = { kind: 'command', command: redact(p.command), exitCode: 0, durationMs: run.durationMs, outputTail: tail, by: 'engine', at: c.now.toISOString(), gitHead: git(c.root, 'rev-parse', 'HEAD') ?? 'none', fingerprint: now.fp };
      rec.evidence.push(evidence);
      // VERIFIED only from a command the engine ran.
      move(rec, 'VERIFIED', 'verify command exit 0', evidence.at);
      return { ...fromTo(rec, s.id, from), verified: true, evidence, next: 'run ae next: dependents may be READY', ...p.controls.report };
    },
  },
  // checkpoint --run-check: the slice's Verify command, run by the engine. The result goes to `checkpoint.check`,
  // never to `evidence` (ACC reads evidence exit codes) and never to the fix budget.
  checkpoint: {
    prepare(c) {
      const { s, rec } = checkpointGate(c), command = verifyCommand(s);
      if (!command) throw new Error(`checkpoint --run-check: slice ${s.id} has a manual Verify step, so there is no command to run. Nothing was written`);
      return prepareRun(c, s, rec, command, 'checkpoint --run-check');
    },
    record(c, r) {
      const { s, rec } = c.slice(c.args.slice), now = snapOf(c, s, rec), { run, tail, prepared: p } = r;
      const changed = drift(p.snap, now, false);
      if (changed.length) return unstable(c, s, rec, changed, r, {});
      const check: CheckpointCheck & { timeout?: string; signal?: string } = { command: redact(p.command), ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}), ...(run.timedOut ? { timedOut: true } : {}), ...(run.timeout ? { timeout: run.timeout } : {}), ...(run.signal ? { signal: run.signal } : {}),
        tail, at: c.now.toISOString(), fpBefore: p.snap.fp, fpAfter: now.fp, stable: p.snap.fp === now.fp };
      return { ...takeCheckpoint(c, check), ...p.controls.report };
    },
  },
};
const phasedFor = (a: Args) => a.command === 'verify' ? PHASED.verify : a.command === 'checkpoint' && a.flags.has('run-check') ? PHASED.checkpoint : undefined;

// --heavy-rss-mb: the RSS estimate of one heavy job, in MB, for the adaptive profile only.
function heavyRss(a: Args, profile: string): number | undefined {
  if (!a.flags.has('heavy-rss-mb')) return undefined;
  if (profile !== 'adaptive') throw new Error(`${a.command}: --heavy-rss-mb applies to the adaptive profile only`);
  const n = Number(a.flags.get('heavy-rss-mb'));
  if (!Number.isInteger(n) || n < 1 || n > MAX_HEAVY_RSS_MB) throw new Error(`${a.command}: --heavy-rss-mb must be a whole number of MB from 1 to ${MAX_HEAVY_RSS_MB}`);
  return n;
}

function initJournal(c: Base, jfile: string): Journal {
  if (existsSync(jfile)) throw new Error(`journal already exists: ${jfile}; init refuses to overwrite it`);
  const f = c.args.flags, profile = f.get('profile') ?? profileForMode(c.plan.mode);
  if (!isProfile(profile)) throw new Error(`unknown profile "${profile}"; use ${PROFILE_NAMES.join(', ')}`);
  const rss = heavyRss(c.args, profile);
  const allow = (f.get('allow') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const bad = allow.filter(x => !(AUTHORITY as readonly string[]).includes(x));
  if (bad.length) throw new Error(`unknown --allow value ${bad.join(', ')}; use ${AUTHORITY.join(', ')}`);
  assertFiles(c.plan, c.root, allow);
  const journal = createJournal(c.plan, profile, allow, c.now);
  if (profile === 'adaptive') journal.capacity = { ...emptyCapacity(), ...(rss !== undefined ? { heavyRssMB: rss } : {}) };
  return journal;
}

// ---- recover ----
const NEEDS_CHECK = 'check task_status, then ae fail or ae finish';

// Report drift between journal, plan, Git, and files. Without --apply it writes nothing and takes no lock.
// With --apply it demotes stale VERIFIED and ACCEPTED slices to AGENT_FINISHED, then reconciles the plan lines.
async function recover(b: Base, text: string, waitMs: number): Promise<Result> {
  const { args, now, root, planPath, jfile } = b, apply = args.flags.has('apply'), at = now.toISOString();
  const lockBefore = inspectLock(jfile);
  const body = (): Result => {
    if (apply) { refuseSymlinks(planPath, jfile, jfile + '.bak'); text = readFileSync(planPath, 'utf8'); b = { ...b, plan: parsePlan(text, args.plan) }; }
    const { plan } = b;
    const l = loadJournal(jfile), journal = l.journal, before = JSON.stringify(journal);
    if (apply) runHook('guardWrite', runCtx({ ...b, journal }), undefined);
    const known = new Map(Object.entries(journal.slices).map(([id, r]) => [id, r.definitionDigest]));
    syncJournal(journal, plan, now);
    closeStaleHandoffs(journal, at);
    const synced: string[] = [];
    for (const s of plan.slices) {
      const old = known.get(s.id);
      if (old === undefined) synced.push(`slice ${s.id} is new; added as PLANNED`);
      else if (old !== journal.slices[s.id].definitionDigest) synced.push(`slice ${s.id} definition changed; now READY, its evidence is stale`);
    }
    for (const id of known.keys()) if (!plan.slices.some(s => s.id === id)) synced.push(`slice ${id} left the plan; moved under removed`);

    // plan lines that differ from the journal: hand edits, or a crash between the journal write and the plan write
    const planDrift: Result[] = [];
    for (const s of plan.slices) {
      const rec = journal.slices[s.id], line = evidenceLine(rec);
      if (s.state !== rec.state) planDrift.push({ slice: s.id, field: 'State', plan: s.state, journal: rec.state, ...(['VERIFIED', 'ACCEPTED', 'INTEGRATED'].includes(s.state) && !settled(rec.state) ? { note: `plan claims ${s.state} but the journal has no verify evidence` } : {}) });
      if (s.evidence !== line) planDrift.push({ slice: s.id, field: 'Evidence', plan: redact(s.evidence), journal: line });
    }

    // Files paths are checked before any fingerprint. A slice whose Files fail is listed in filesProblems and never read:
    // a path that now runs through a link may point outside the repo or at a protected file.
    const problems = filesProblems(plan, root, journal.authority.allow), unchecked = new Set(problems.map(p => p.id));

    // VERIFIED and ACCEPTED slices whose files changed after the evidence was recorded
    const staleEvidence: Result[] = [];
    for (const s of plan.slices) {
      const rec = journal.slices[s.id];
      if (rec.state !== 'VERIFIED' && rec.state !== 'ACCEPTED') continue;
      // Files that fail validation are never read, and their evidence cannot be trusted: report it as stale.
      if (unchecked.has(s.id)) { staleEvidence.push({ slice: s.id, recorded: 'unchecked', current: null, note: 'Files fail validation; not fingerprinted' }); continue; }
      const e = rec.evidence.filter(x => !x.stale).at(-1), cur = fingerprint(root, s.files, engineOwned(root, planPath, jfile));
      if (!e) staleEvidence.push({ slice: s.id, recorded: null, current: cur, note: `${rec.state} without live evidence` });
      else if (e.fingerprint !== cur) staleEvidence.push({ slice: s.id, recorded: e.fingerprint, current: cur, verifiedAt: e.at, gitHead: e.gitHead });
      else if (rec.state === 'VERIFIED' && e.kind === 'manual') staleEvidence.push({ slice: s.id, recorded: e.fingerprint, current: cur, verifiedAt: e.at, gitHead: e.gitHead, legacyManual: true, note: "VERIFIED on a person's note (journal from an older engine); sign off again to reach ACCEPTED" });
    }

    // IN_PROGRESS slices: the worker may be gone or done; the engine cannot tell
    const inProgress = plan.slices.filter(s => journal.slices[s.id].state === 'IN_PROGRESS').map(s => {
      const a = journal.slices[s.id].attempts.at(-1);
      return { slice: s.id, provider: a?.provider ?? null, model: a?.model ?? null, effort: a?.effort ?? null, taskId: a?.taskId ?? null, since: a?.at ?? null, needsCheck: NEEDS_CHECK };
    });

    // Handoffs that stopped before TRANSFERRED: the orchestrator may have crashed in between.
    const handoffs = plan.slices.flatMap(s => {
      const rec = journal.slices[s.id], h = rec.handoffs?.at(-1);
      if (!h || h.phase === 'CLOSED' || rec.state !== 'IN_PROGRESS') return [];
      const next = h.phase === 'PREPARED' ? 'ae checkpoint'
        : h.phase === 'CHECKPOINTED' ? 'confirm the old worker stopped (task_status), then ae transfer'
        : h.taskId ? 'the replacement owns the slice; check its task_status'
        : `check task_status for a task already started for ${h.to}: attach it with ae transfer --task-id, else ae handoff and delegate`;
      return [{ slice: s.id, phase: h.phase, from: h.from.label, to: h.to, ...(h.taskId ? { taskId: h.taskId } : {}), next }];
    });

    // A BLOCKED file is read only when it is a regular file. A link may point outside the repo or at a protected file.
    const blockedFiles = readdirSync(root).filter(n => /^BLOCKED.*\.md$/.test(n)).sort().map((n): Result => {
      const full = resolve(root, n);
      let regular = false;
      try { regular = lstatSync(full).isFile(); } catch { /* gone */ }
      if (!regular) return { file: n, issue: null, note: 'not read: symlink or not a regular file' };
      let issue = '';
      try { issue = redact(/^- Issue:\s*(.*)$/m.exec(readFileSync(full, 'utf8'))?.[1] ?? '').slice(0, 200); } catch { /* unreadable */ }
      return { file: n, issue };
    });

    // Git: branch, head, and changed files that no slice owns (engine files and BLOCKED files are not counted)
    const found = changedFiles(root), changed = found ?? [];
    const engineFiles = engineOwned(root, planPath, jfile);
    const ownedBy = (p: string) => plan.slices.some(s => s.files.some(f => within(p, f)));
    const tempFiles = orphanTempFiles(planPath, jfile, jfile + '.bak').map(p => relative(root, p));
    // Removed slices still name snapshots. Older unreferenced refs may come from the five-checkpoint window.
    // Only refs above the highest named number for their slice are crash orphans. Keep all refs intact.
    const namedSnapshots = new Set([...Object.values(journal.slices), ...Object.values(journal.removed ?? {})]
      .flatMap(rec => (rec.checkpoints ?? []).flatMap(cp => cp.snapshot ? [cp.snapshot] : [])));
    const prefix = snapshotPrefix(basename(planPath, '.md'), 'x').replace(/\/x$/, '/');
    const highestNamed = new Map<string, number>();
    for (const ref of namedSnapshots) {
      const end = ref.lastIndexOf('/'), slicePrefix = ref.slice(0, end);
      highestNamed.set(slicePrefix, Math.max(highestNamed.get(slicePrefix) ?? 0, Number(ref.slice(end + 1))));
    }
    const unreferenced = (git(root, 'for-each-ref', '--format=%(refname)', prefix) ?? '').split('\n')
      .filter(ref => ref.startsWith(prefix) && /\/\d+\/\d+$/.test(ref) && !namedSnapshots.has(ref)).sort();
    const isCrashOrphan = (ref: string) => {
      const end = ref.lastIndexOf('/');
      return Number(ref.slice(end + 1)) > (highestNamed.get(ref.slice(0, end)) ?? 0);
    };
    const orphanSnapshotRefs = unreferenced.filter(isCrashOrphan), prunedSnapshotRefs = unreferenced.filter(ref => !isCrashOrphan(ref));
    const unowned = changed.filter(p => !engineFiles.has(p) && !/^BLOCKED[^/]*\.md$/.test(p) && !ownedBy(p));

    let applied: Result[] = [];
    if (apply) {
      // every stale VERIFIED or ACCEPTED slice, also one with no live evidence at all (recorded: null)
      applied = staleEvidence.map(x => {
        const rec = journal.slices[x.slice as string], was = rec.state;
        for (const e of rec.evidence) e.stale = true;
        delete rec.review;
        const reason = x.legacyManual ? "VERIFIED on a person's note: demoted; sign off again to reach ACCEPTED" : x.recorded === null ? 'evidence stale: no live evidence' : x.current === null ? 'evidence stale: Files fail validation' : 'evidence stale: files changed';
        move(rec, 'AGENT_FINISHED', reason, at);
        return { slice: x.slice, from: was, to: 'AGENT_FINISHED', reason };
      });
    }
    const sim = structuredClone(journal);
    promoteReady(sim, plan, now);
    // adaptive: a fresh reading for the report only. The sample is not kept: recover changes no capacity state.
    const capacity = sim.profile === 'adaptive' ? assessCapacity(sim, plan, b.probe(), now).decision : undefined;
    const nb = nextBatch(sim, plan, capacity);

    let planChanged = false;
    if (apply) {
      const planText = reconcile(text, plan, journal);
      if (l.recoveredFromBackup || l.scrubbed || JSON.stringify(journal) !== before) saveJournal(jfile, journal, now);
      if (planText !== text) { faultPoint('save:before-plan'); writeAtomic(planPath, planText, jfile); faultPoint('save:after-plan'); planChanged = true; }
    }
    return {
      plan: journal.plan, readOnly: !apply, ...(l.recoveredFromBackup ? { recoveredFromBackup: true } : {}),
      lock: lockBefore && { pid: lockBefore.pid, alive: lockBefore.alive, stale: lockBefore.stale, note: lockBefore.stale ? (apply ? 'stale lock (dead pid) taken over' : 'stale lock (dead pid); a writing command takes it over') : 'held by a live process; this report may be out of date' },
      ...(apply && lockBefore?.stale ? { staleLockTakenOver: true } : {}),
      synced, planDrift, staleEvidence, inProgress, handoffs, tempFiles, orphanSnapshotRefs, orphanSnapshotCount: orphanSnapshotRefs.length, prunedSnapshotRefs, prunedSnapshotCount: prunedSnapshotRefs.length, ...awaiting(journal, plan), blockedFiles,
      git: { branch: git(root, 'symbolic-ref', '--short', '-q', 'HEAD') ?? 'detached or none', head: git(root, 'rev-parse', 'HEAD') ?? 'none', changedFiles: found, unowned },
      filesProblems: problems.map(p => p.text),
      next: { batch: nb.batch.map(s => s.id), running: nb.running, waiting: nb.waiting, deferred: nb.deferred, ...(capacity ? { capacity } : {}) },
      done: plan.slices.every(s => settled(journal.slices[s.id].state)),
      ...sections('recoverSection', journal, sectionEnv(b)),
      ...(apply ? { applied } : { hint: 'read-only: nothing was written. recover --apply demotes stale VERIFIED and ACCEPTED slices and reconciles the plan lines' }),
      ...(planChanged ? { rebuild: `~/.agents/bin/md-view.sh ${args.plan}` } : {}),
    };
  };
  return apply ? withLock(jfile, body, waitMs) : body();
}

// ---- main ----
// The plan's folder must be its own real path: the lexical path under the repo root's real path. A linked folder between
// them (plans -> docs) gives the engine's files a second name, and the fingerprint exclusions could miss one of them.
function assertPlanFolderReal(planPath: string, realRoot: string) {
  const dir = dirname(planPath), realDir = realpathSync(dir);
  // the repo root in the plan path's spelling: the highest folder above the plan that resolves to the real root
  let top: string | null = null;
  for (let p = dir; ; p = dirname(p)) { if (realpathSync(p) === realRoot) top = p; if (dirname(p) === p) break; }
  const lexical = top === null ? null : join(realRoot, relative(top, dir));
  if (realDir !== lexical) throw new Error(`the plan folder ${dir} resolves to ${realDir}, not ${lexical ?? `a folder under ${realRoot}`}: a folder between the repo root and the plan is a symlink. Refusing to read or write the engine files; name the plan by its real path. Nothing was written`);
}

// --wait-lock S: wait up to S seconds (60 or less) for a lock that a live process holds. Fail-fast is the default.
function lockWait(a: Args): number {
  if (!a.flags.has('wait-lock')) return 0;
  const n = Number(a.flags.get('wait-lock'));
  if (!(n >= 0 && n <= MAX_WAIT_LOCK_S)) throw new Error(`${a.command}: --wait-lock must be a number of seconds from 0 to ${MAX_WAIT_LOCK_S}`);
  return Math.round(n * 1000);
}

const makeCtx = (b: Base, journal: Journal): Ctx => ({
  ...b, journal,
  slice: (id: string | undefined) => {
    if (!id || !/^\d+$/.test(id)) throw new Error(`${b.args.command}: SLICE number is required`);
    const s = b.plan.slices.find(x => x.id === id);
    if (!s) throw new Error(`unknown slice ${id}`);
    return { s, rec: journal.slices[id] };
  },
});

const stateKey = (j: Journal) => JSON.stringify(Object.entries(j.slices).map(([id, r]) => [id, r.state]));
// REQ-23: above 1.5 MiB a write that grows the journal is refused, unless it moves a slice state. State moves keep
// working, so a run can still finish, verify, or block while the user archives the journal.
function assertSize(c: Ctx, beforeBytes: number, beforeStates: string) {
  const bytes = journalBytes(c.journal);
  if (bytes <= JOURNAL_CAP_BYTES || bytes <= beforeBytes || stateKey(c.journal) !== beforeStates) return;
  throw new Error(`${c.args.command} refused: the journal would grow to ${bytes} bytes, above the 1.5 MiB cap (${JOURNAL_CAP_BYTES}), and this write moves no slice state. ACC drops a journal above 2 MiB. Nothing was written. State moves still pass; ask the user to archive the journal`);
}

// One locked command: load, sync, guardWrite, the handler, the module result fields, the size guard, then save.
// `fn` returning undefined is phase 1 of a two-phase run: housekeeping is saved, and the output comes from phase 3.
function locked(b: Base, text: string, waitMs: number, fn: (c: Ctx) => Promise<Result | undefined> | Result | undefined): Promise<Result> {
  const { args, now, planPath, jfile } = b;
  return withLock(jfile, async () => {
    refuseSymlinks(planPath, jfile, jfile + '.bak');
    text = readFileSync(planPath, 'utf8');
    const plan = parsePlan(text, args.plan);
    b = { ...b, plan };
    let journal: Journal, recovered = false, scrubbed = false, before = '', beforeBytes = 0, beforeStates = '';
    if (args.command === 'init') journal = initJournal(b, jfile);
    else {
      const l = loadJournal(jfile); journal = l.journal; recovered = l.recoveredFromBackup; scrubbed = l.scrubbed; before = JSON.stringify(journal);
      beforeBytes = journalBytes(journal); beforeStates = stateKey(journal);
      syncJournal(journal, plan, now); closeStaleHandoffs(journal, now.toISOString());
      assertFiles(plan, b.root, journal.authority.allow);
    }
    const c = makeCtx(b, journal);
    // Before the handler of every journal-writing command except init (lead lease, authorization, reviewer family).
    if (args.command !== 'init') runHook('guardWrite', runCtx(c), namedSlice(c));
    const warnings = args.command === 'init' ? plan.slices.map(s => floorWarning(journal, s, packetEnv(b, s.model))).filter((w): w is string => !!w) : [];
    const out = args.command === 'init'
      ? { profile: journal.profile, allow: journal.authority.allow, slices: plan.slices.map(s => ({ id: s.id, from: s.state, state: journal.slices[s.id].state })), journal: jfile, ...(warnings.length ? { warnings } : {}) }
      : await fn(c);
    const result: Result = out === undefined ? {} : SLICE_COMMANDS.includes(args.command) ? (() => { const { s, rec } = c.slice(args.slice); return { ...out, ...resultFields(hookCtx(c, s, rec), out) }; })() : out;
    if (c.discard) return { ...result, ...(recovered ? { recoveredFromBackup: true } : {}) };
    closeStaleHandoffs(journal, now.toISOString());
    // Save the journal first. A crash before the plan write is repaired by the next command's reconcile.
    const planText = reconcile(text, plan, journal);
    const write = args.command === 'init' || recovered || scrubbed || JSON.stringify(journal) !== before;
    if (write && args.command !== 'init') assertSize(c, beforeBytes, beforeStates);
    if (write) saveJournal(jfile, journal, now);
    if (planText !== text) { faultPoint('save:before-plan'); writeAtomic(planPath, planText, jfile); faultPoint('save:after-plan'); }
    return { ...result, ...(recovered ? { recoveredFromBackup: true } : {}), ...(planText !== text ? { rebuild: `~/.agents/bin/md-view.sh ${args.plan}` } : {}) };
  }, waitMs);
}

export async function main(argv: string[], deps: Deps): Promise<Result> {
  const args = parseArgs(argv), now = (deps.now ?? (() => new Date()))();
  if (args.command === 'check') return check(args, deps);
  const planPath = resolve(deps.cwd, args.plan);
  if (!existsSync(planPath)) throw new Error(`plan not found: ${planPath}`);
  const jfile = journalPath(planPath);
  // The engine writes next to the plan. Refuse planted links and a plans folder that leaves the repo.
  refuseSymlinks(planPath, jfile, jfile + '.bak', jfile + '.lock');
  const text = readFileSync(planPath, 'utf8'), plan = parsePlan(text, args.plan);
  const root = repoRoot(deps.cwd, planPath);
  // The plan and every engine file (all next to the plan) must really be inside the repo, after symlinks resolve.
  const realPlan = realpathSync(planPath), realRoot = realpathSync(root);
  if (!realPlan.startsWith(realRoot + sep)) throw new Error(`the plan ${planPath} resolves to ${realPlan}, outside the repo ${realRoot}; refusing to write there. Run the engine from the plan's repo`);
  assertPlanFolderReal(planPath, realRoot);
  const base: Base = { args, plan, now, root, planPath, cwd: deps.cwd, jfile, probe: deps.probe ?? (() => probeMachine()) };
  const waitMs = lockWait(args);
  if (args.command === 'recover') return recover(base, text, waitMs);
  if (isReadOnly(args)) {
    const l = loadJournal(jfile);
    // report.ts merges the report sections without the env; the env-aware ones replace them here.
    if (args.command === 'report') return { ...buildReport({ journal: l.journal, journalFile: jfile, root, planText: text, now, env: sectionEnv(base) }), ...(l.recoveredFromBackup ? { recoveredFromBackup: true } : {}) };
    syncJournal(l.journal, plan, now); // in memory only
    closeStaleHandoffs(l.journal, now.toISOString());
    assertFiles(plan, root, l.journal.authority.allow);
    return { ...(await handlers[args.command](makeCtx(base, l.journal))), ...(l.recoveredFromBackup ? { recoveredFromBackup: true } : {}) };
  }
  const phased = phasedFor(args);
  if (!phased) return locked(base, text, waitMs, c => handlers[args.command](c));
  // Two-phase run: the lock is held to check (phase 1) and to record (phase 3), never while the command runs.
  let prepared: Prepared | undefined;
  const first = await locked(base, text, waitMs, c => { const p = phased.prepare(c); if (p instanceof Prepared) { prepared = p; return undefined; } return p; });
  if (!prepared) return first;
  const run = await runCommand(prepared.command, root, Math.round(prepared.secs * 1000));
  const raw = run.timedOut ? `${run.output}\n[timed out after ${prepared.secs}s]` : run.output;
  const ran: Ran = { prepared, run, tail: outputTail(redact(raw)) }; // redact first, so a cut-off key block cannot escape
  // The plan may have changed during the run (another command, or a hand edit): read it again, so phase 3 compares
  // against the current definition and never writes back old plan text.
  const relock = Math.max(waitMs, RELOCK_WAIT_MS);
  const final = await locked(base, text, relock, c => phased.record(c, ran)).catch((e: unknown) => {
    if (!(e instanceof LockBusy)) throw e;
    throw new Error(`${args.command}: lost the journal lock while the command ran (exit ${run.exitCode ?? 'none'}): ${e.message}, still held after ${relock / 1000} s. Nothing was recorded and the fix budget did not move; run it again`);
  });
  return { ...first, ...final };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { cwd: process.cwd() }).then(
    r => { console.log(process.argv[2] === 'report' && !process.argv.includes('--json') ? renderReport(r) : JSON.stringify(r, null, 2)); if (process.argv[2] === 'check' && typeof r.exitCode === 'number') process.exitCode = r.exitCode; },
    e => { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; },
  );
}
