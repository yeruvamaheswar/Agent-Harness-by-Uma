// Progress capture (plans/unified-agent-harness-master.md, Slice 7; REQ-12, DEC-5, DEC-6).
// Each work attempt records a base tree. Each checkpoint records, as observed by the engine: the delta and diffStat
// against that base, a hidden snapshot ref of the owned files, health findings, and the engine-run check.
// A worker may checkpoint its own open attempt only, as a milestone; its text stays a claim.
//
// A tree here is a Git tree of the slice's owned files as they are on disk (tracked or not), built in a temporary
// index. Git plumbing only: the real index, HEAD, and every branch stay untouched, and nothing is pushed.
// Protected paths (guard.ts protectedRel) are never read, and the engine's own files never count.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { MAX_DELTA, MAX_HEALTH } from './contract.ts';
import { protectedRel, redact } from './guard.ts';
import { normPath } from './journal.ts';
import { register } from './hooks.ts';

function git(root: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string | null {
  try {
    return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8', env: env ?? process.env, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 1 << 30 });
  } catch { return null; }
}

// ---- owned files (review-1 F14: the fingerprint v2 ignore rule of journal.ts, PR #19) ----
// What Git lists for `rels`: tracked, plus untracked and not ignored (git ls-files -co --exclude-standard).
// `dirs` holds every folder above a listed path. null when Git cannot answer: every file then counts.
type Listed = { files: Set<string>; dirs: Set<string> };
function gitListed(root: string, rels: string[]): Listed | null {
  const out = git(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard', ...(rels.includes('') ? [] : ['--', ...rels])]);
  if (out === null) return null;
  const files = new Set(out.split('\0').filter(Boolean).map(normPath)), dirs = new Set<string>();
  for (const f of files) for (let d = posix.dirname(f); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  return { files, dirs };
}
// check-ignore takes no pathspec magic, so it runs without --literal-pathspecs (as journal.ts does). Exit 0: ignored.
const gitIgnores = (root: string, rel: string) => {
  if (rel === '') return false;
  try { execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' }); return true; } catch { return false; }
};

// The owned files on disk, sorted. The same rule as journal.ts fingerprint: a walked folder counts only the files Git
// lists, so git-ignored build output is never written as a blob. A path the plan names exactly always counts, ignored
// or not: an owned file, or an owned folder that Git ignores (walked whole). .git and node_modules are never walked.
// Symlinks count as links, never followed. Missing, protected, skipped, and BLOCKED*.md paths are left out.
export function ownedFiles(root: string, owned: string[], skip: ReadonlySet<string>): string[] {
  const out: string[] = [], skipped = new Set([...skip].map(normPath)), names = owned.map(normPath);
  let listed: Listed | null | undefined; // lazy: a plan that owns only files never lists
  const add = (rel: string, mode: 'owned' | 'filtered' | 'open') => {
    if (skipped.has(rel) || protectedRel(rel) || /^BLOCKED[^/]*\.md$/.test(rel)) return;
    let st;
    try { st = lstatSync(join(root, rel)); } catch { return; }
    if (!st.isDirectory()) { out.push(rel); return; }
    let scope: Listed | null = null;
    if (mode === 'filtered') scope = listed!;
    else if (mode === 'owned') { if (listed === undefined) listed = gitListed(root, names); if (listed && !gitIgnores(root, rel)) scope = listed; }
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const child = rel ? `${rel}/${name}` : name;
      if (!scope || scope.files.has(child)) add(child, 'open');
      else if (scope.dirs.has(child)) add(child, 'filtered');
    }
  };
  for (const f of names) add(f, 'owned');
  return [...new Set(out)].sort();
}

// A tree of these files, written through a temporary index. undefined outside Git or when Git fails.
function treeOf(root: string, files: string[]): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'ae-tree-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    if (git(root, ['read-tree', '--empty'], env) === null) return undefined;
    if (files.length && git(root, ['update-index', '--add', '-z', '--stdin'], env, files.join('\0') + '\0') === null) return undefined;
    return git(root, ['write-tree'], env)?.trim() || undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const inGit = (root: string) => git(root, ['rev-parse', '--git-dir']) !== null;

// The tree of the owned files now, or undefined outside Git. Paths in HEAD that are gone from disk are left out.
export function ownedTree(root: string, owned: string[], skip: ReadonlySet<string>): string | undefined {
  return inGit(root) ? treeOf(root, ownedFiles(root, owned, skip)) : undefined;
}

// Owned paths that differ between two trees, sorted.
export function treeDelta(root: string, base: string, now: string): string[] | undefined {
  const out = git(root, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, now]);
  return out === null ? undefined : out.split('\0').filter(Boolean).sort();
}

// Lines added and removed between two trees. A binary file counts as a file with 0 lines.
export function treeStat(root: string, base: string, now: string): { files: number; insertions: number; deletions: number } | undefined {
  const out = git(root, ['diff-tree', '-r', '--numstat', '--no-renames', base, now]);
  if (out === null) return undefined;
  const stat = { files: 0, insertions: 0, deletions: 0 };
  for (const line of out.split('\n').filter(Boolean)) {
    const [add, del] = line.split('\t');
    stat.files++; stat.insertions += Number(add) || 0; stat.deletions += Number(del) || 0;
  }
  return stat;
}

// Git blob ids of files on disk, computed without writing an object. Protected and missing paths get a label.
export function blobIds(root: string, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    if (protectedRel(p)) { out[p] = 'protected'; continue; }
    try { if (!lstatSync(join(root, p)).isFile()) { out[p] = 'not a file'; continue; } } catch { out[p] = 'missing'; continue; }
    out[p] = git(root, ['hash-object', '--', p])?.trim() || 'unknown';
  }
  return out;
}

// ---- snapshot refs (DEC-5) ----
// refs/ae/snapshots/<slug>/<slice>/<n>: one commit per checkpoint, never pushed (refs/ae/* is in no push refspec).
// n counts up per slice; a ref is created once and never moved, so the ref name in the checkpoint stays exact.
// The snapshot holds owned files only: never the journal (or its backup and lock) and never a plans/ file.
export const SNAPSHOT_ROOT = 'refs/ae/snapshots';
const refPart = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|\.lock$|\.+$/g, '') || 'x';
export const snapshotPrefix = (slug: string, slice: string) => `${SNAPSHOT_ROOT}/${refPart(slug)}/${refPart(slice)}`;
export const inSnapshot = (rel: string) => !/^plans(\/|$)/.test(rel) && !/\.run\.json(\.bak|\.lock|\..*\.tmp)?$/.test(rel);

// The snapshot refs of one slice, in order of n.
export function snapshotRefs(root: string, slug: string, slice: string): string[] {
  const out = git(root, ['for-each-ref', '--format=%(refname)', `${snapshotPrefix(slug, slice)}/`]);
  const n = (r: string) => Number(r.slice(r.lastIndexOf('/') + 1));
  return (out ?? '').split('\n').filter(r => /\/\d+$/.test(r)).sort((a, b) => n(a) - n(b));
}

// Commits the files into a new snapshot ref and returns the ref name, or undefined when Git fails or nothing is owned.
export function takeSnapshot(root: string, slug: string, slice: string, files: string[], at: string, note: string): string | undefined {
  const kept = files.filter(inSnapshot);
  if (!kept.length) return undefined;
  const tree = treeOf(root, kept);
  if (!tree) return undefined;
  const who = { GIT_AUTHOR_NAME: 'ae engine', GIT_AUTHOR_EMAIL: 'ae@localhost', GIT_COMMITTER_NAME: 'ae engine', GIT_COMMITTER_EMAIL: 'ae@localhost', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const commit = git(root, ['-c', 'commit.gpgsign=false', 'commit-tree', '--no-gpg-sign', '-m', `ae snapshot: ${note}`, tree], { ...process.env, ...who })?.trim();
  if (!commit) return undefined;
  const prefix = snapshotPrefix(slug, slice), last = snapshotRefs(root, slug, slice).at(-1);
  let n = last ? Number(last.slice(last.lastIndexOf('/') + 1)) + 1 : 1;
  // `create` refuses an existing ref: a racing writer takes the next number instead of moving this one
  for (let tries = 0; tries < 5; tries++, n++) {
    const ref = `${prefix}/${n}`;
    if (git(root, ['update-ref', '--stdin'], undefined, `create ${ref} ${commit}\n`) !== null) return ref;
  }
  return undefined;
}

// The paths a snapshot holds, sorted.
export function snapshotFiles(root: string, ref: string): string[] | undefined {
  const out = git(root, ['ls-tree', '-r', '--name-only', '-z', ref]);
  return out === null ? undefined : out.split('\0').filter(Boolean).sort();
}

// Writes the snapshot's files into `into` (a folder; the working tree only when the caller passes it).
// A temporary index: the real index, HEAD, and branches stay untouched. Returns the restored paths.
export function restoreSnapshot(root: string, ref: string, into: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'ae-restore-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    if (git(root, ['read-tree', ref], env) === null) throw new Error(`restore: ${ref} is not a snapshot in ${root}`);
    if (git(root, [`--work-tree=${into}`, 'checkout-index', '-a', '-f'], env) === null) throw new Error(`restore: could not write ${ref} into ${into}`);
    return snapshotFiles(root, ref) ?? [];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- health (Plan B S7) ----
// Codes, at most MAX_HEALTH, in this order. `head-moved`: HEAD differs from the slice's previous checkpoint.
export const HEALTH_CODES = ['merge-in-progress', 'rebase-in-progress', 'cherry-pick-in-progress', 'revert-in-progress', 'bisect-in-progress', 'index-lock', 'unmerged-paths', 'head-moved'] as const;
export function healthCodes(root: string, head: string | undefined, prevHead: string | undefined): string[] {
  if (!inGit(root)) return [];
  const has = (name: string) => {
    const p = git(root, ['rev-parse', '--git-path', name])?.trim();
    return !!p && existsSync(isAbsolute(p) ? p : join(root, p));
  };
  const out: string[] = [];
  if (has('MERGE_HEAD')) out.push('merge-in-progress');
  if (has('rebase-merge') || has('rebase-apply')) out.push('rebase-in-progress');
  if (has('CHERRY_PICK_HEAD')) out.push('cherry-pick-in-progress');
  if (has('REVERT_HEAD')) out.push('revert-in-progress');
  if (has('BISECT_LOG')) out.push('bisect-in-progress');
  if (has('index.lock')) out.push('index-lock');
  if (git(root, ['--no-optional-locks', 'ls-files', '-u'])?.trim()) out.push('unmerged-paths');
  if (head && prevHead && head !== 'none' && prevHead !== 'none' && head !== prevHead) out.push('head-moved');
  return out.slice(0, MAX_HEALTH);
}

register('progress', {
  // Every work attempt records the tree it starts from. A worker that continues after unblock keeps its base, and a
  // replacement inherits the old attempt's base (review-1 F13): after A to B to C, A's finished files stay in the delta.
  attemptOpened(c, attempt, how, prev) {
    if ((how === 'unblock' || how === 'transfer') && prev?.baseTree) { attempt.baseTree = prev.baseTree; return; }
    const tree = ownedTree(c.root, c.s.files, c.skip);
    if (tree) attempt.baseTree = tree;
  },
  // DEC-6: a worker (--launch-key) checkpoints its own open attempt only, and only as a milestone. A closed attempt's
  // key, another attempt's key, or a lead kind is refused before anything is written. ae.ts keeps handoff phases for the lead.
  guardEvent(c, event, open) {
    if (event !== 'checkpoint' || !c.flags.has('launch-key')) return;
    const key = c.flags.get('launch-key') ?? '';
    if (!open) throw new Error(`checkpoint refused: slice ${c.s.id} has no open attempt, so launch key ${key} belongs to a closed attempt. Nothing was written`);
    if (open.launchKey !== key) throw new Error(`checkpoint refused: launch key ${key} is not the key of the open attempt ${open.n}; a worker checkpoints its own attempt only. Nothing was written`);
    const kind = c.flags.get('kind');
    if (kind !== undefined && kind !== 'milestone') throw new Error(`checkpoint refused: a worker checkpoint is a milestone; --kind ${kind} belongs to the lead. Nothing was written`);
  },
  // Everything here is observed by the engine, not claimed by the worker.
  checkpointTaken(c, cp, open) {
    // the run-check: redacted again here, so a secret never reaches the journal even if a caller forgets
    if (cp.check) cp.check = { ...cp.check, command: redact(cp.check.command), tail: redact(cp.check.tail) };
    if (cp.role === 'worker' && !cp.kind) cp.kind = 'milestone';
    if (!inGit(c.root)) return;
    const files = ownedFiles(c.root, c.s.files, c.skip), now = treeOf(c.root, files);
    let delta: string[] | undefined;
    if (open?.baseTree && now) delta = treeDelta(c.root, open.baseTree, now);
    if (delta) {
      cp.delta = delta.slice(0, MAX_DELTA);
      cp.deltaCount = delta.length;
      const stat = delta.length ? treeStat(c.root, open!.baseTree!, now!) : undefined;
      if (stat) cp.diffStat = stat;
    }
    // nothing done (an empty delta) needs no snapshot; an unknown delta takes one
    if (!delta || delta.length) {
      const ref = takeSnapshot(c.root, c.slug, c.s.id, files, c.at, `plan ${c.slug}, slice ${c.s.id}${open ? `, attempt ${open.n}` : ''}, ${cp.role ?? 'lead'} checkpoint ${c.at}`);
      if (ref) cp.snapshot = ref;
    }
    const health = healthCodes(c.root, cp.gitHead, c.rec.checkpoints?.at(-1)?.gitHead);
    if (health.length) cp.health = health;
  },
});
