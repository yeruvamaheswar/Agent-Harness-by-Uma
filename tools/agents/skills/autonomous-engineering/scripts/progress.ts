// Progress capture. Slice 1 holds the tracer part: the base tree of an attempt and the checkpoint delta against it.
// Slice 7 adds the snapshot ref, health findings, the engine-run check, and worker milestones.
//
// A tree here is a Git tree of the slice's owned files as they are on disk (tracked or not), built in a temporary
// index. It writes loose Git objects for those files and nothing else: no ref, no change to the real index or the
// working tree. Protected paths (guard.ts protectedRel) are never read, and the engine's own files never count.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DELTA } from './contract.ts';
import { protectedRel } from './guard.ts';
import { normPath } from './journal.ts';
import { register } from './hooks.ts';

function git(root: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string | null {
  try {
    return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], { encoding: 'utf8', env: env ?? process.env, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  } catch { return null; }
}

// Owned files on disk: folders are walked (not .git, not node_modules); symlinks count as links, never followed.
function onDisk(root: string, owned: string[], skip: ReadonlySet<string>): string[] {
  const out: string[] = [], skipped = new Set([...skip].map(normPath));
  const add = (rel: string) => {
    if (skipped.has(rel) || protectedRel(rel) || /^BLOCKED[^/]*\.md$/.test(rel)) return;
    let st;
    try { st = lstatSync(join(root, rel)); } catch { return; }
    if (st.isDirectory()) { for (const name of readdirSync(join(root, rel)).sort()) if (name !== '.git' && name !== 'node_modules') add(rel ? `${rel}/${name}` : name); }
    else out.push(rel);
  };
  for (const f of owned) add(normPath(f));
  return [...new Set(out)].sort();
}

// The tree of the owned files now, or undefined outside Git. Paths in HEAD that are gone from disk are left out.
export function ownedTree(root: string, owned: string[], skip: ReadonlySet<string>): string | undefined {
  if (git(root, ['rev-parse', '--git-dir']) === null) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'ae-tree-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    if (git(root, ['read-tree', '--empty'], env) === null) return undefined;
    const files = onDisk(root, owned, skip);
    if (files.length && git(root, ['update-index', '--add', '-z', '--stdin'], env, files.join('\0') + '\0') === null) return undefined;
    return git(root, ['write-tree'], env)?.trim() || undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Owned paths that differ between two trees, sorted.
export function treeDelta(root: string, base: string, now: string): string[] | undefined {
  const out = git(root, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, now]);
  return out === null ? undefined : out.split('\0').filter(Boolean).sort();
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

register('progress', {
  // Every work attempt records the tree it starts from. A worker that continues after unblock keeps its base.
  attemptOpened(c, attempt, how, prev) {
    if (how === 'unblock' && prev?.baseTree) { attempt.baseTree = prev.baseTree; return; }
    const tree = ownedTree(c.root, c.s.files, c.skip);
    if (tree) attempt.baseTree = tree;
  },
  // The delta lists owned paths changed since the open attempt's base tree: observed by the engine, not claimed.
  checkpointTaken(c, cp, open) {
    if (!open?.baseTree) return;
    const now = ownedTree(c.root, c.s.files, c.skip);
    const delta = now ? treeDelta(c.root, open.baseTree, now) : undefined;
    if (!delta) return;
    cp.delta = delta.slice(0, MAX_DELTA);
    cp.deltaCount = delta.length;
  },
});
