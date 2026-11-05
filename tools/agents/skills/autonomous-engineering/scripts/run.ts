import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { checkPath, redact } from './guard.ts';
import type { Journal } from './journal.ts';

export type RunCap = { provider: string; model: string; effort: string; limit: number };
export type RunCharter = {
  at: string; approval: { path: string; line: number; text: string }; deadline: string;
  caps: RunCap[]; branch?: string; reason?: string;
};
export type RunStop = { stop: 'deadline'; deadline: string } | { stop: 'budget'; cap: RunCap; used: number };

export function createCharter({ root, cwd, approval, deadline, caps, branch, reason, now }: {
  root: string; cwd: string; approval: string; deadline: string; caps: string[];
  branch?: string; reason?: string; now: Date;
}): RunCharter {
  const pointer = /^(.+):([1-9]\d*)$/.exec(approval);
  if (!pointer) throw new Error('charter: --approval must be PATH:LINE');
  const file = resolve(cwd, pointer[1]), path = relative(root, file), line = Number(pointer[2]);
  if (redact(path) !== path) throw new Error('charter: approval path contains secret-like text');
  const allowed = checkPath(path, root, { allow: [] });
  if (!allowed.ok) throw new Error(`charter: approval path refused: ${allowed.reason}`);
  const realRoot = realpathSync(root);
  if (!realpathSync(file).startsWith(realRoot + sep) || !statSync(file).isFile()) throw new Error('charter: approval must be an existing repo file');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (!Number.isSafeInteger(line) || line > lines.length) throw new Error('charter: approval line does not exist');
  if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline) || !Number.isFinite(Date.parse(deadline))) {
    throw new Error('charter: --deadline must be ISO time with a UTC offset (Z or ±HH:MM)');
  }
  if (branch !== undefined) {
    if (redact(branch) !== branch) throw new Error('charter: branch contains secret-like text');
    try { execFileSync('git', ['check-ref-format', `refs/heads/${branch}`], { stdio: 'ignore' }); }
    catch { throw new Error('charter: --branch must be a valid Git branch name'); }
  }
  const parsed = caps.map(value => {
    const m = /^([^\s/=]+)\/([^\s/=]+)\/([^\s/=]+)=(\d+)$/.exec(value);
    if (!m || !Number.isSafeInteger(Number(m[4]))) throw new Error('charter: --cap must be provider/model/effort=N with a non-negative integer');
    if (redact(value) !== value) throw new Error('charter: cap contains secret-like text');
    return { provider: m[1], model: m[2], effort: m[3], limit: Number(m[4]) };
  });
  const labels = parsed.map(c => `${c.provider}/${c.model}/${c.effort}`.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error('charter: duplicate cap label');
  return {
    at: now.toISOString(), approval: { path: path.split(sep).join('/'), line, text: redact(lines[line - 1]) },
    deadline: new Date(deadline).toISOString(), caps: parsed, ...(branch !== undefined ? { branch } : {}),
    ...(reason ? { reason: redact(reason) } : {}),
  };
}

// Caps count launched work and reviews, including handed-off attempts. Verify commands are not model tasks.
export function runStop(journal: Journal, now: Date): RunStop | null {
  const run = journal.run;
  if (!run) return null;
  if (now.getTime() >= Date.parse(run.deadline)) return { stop: 'deadline', deadline: run.deadline };
  const attempts = Object.values(journal.slices).concat(Object.values(journal.removed ?? {})).flatMap(s => s.attempts);
  for (const cap of run.caps) {
    const used = attempts.filter(a => (a.kind === 'work' || a.kind === 'review') &&
      a.provider?.toLowerCase() === cap.provider.toLowerCase() && a.model?.toLowerCase() === cap.model.toLowerCase() && a.effort?.toLowerCase() === cap.effort.toLowerCase()).length;
    if (used >= cap.limit) return { stop: 'budget', cap, used };
  }
  return null;
}
