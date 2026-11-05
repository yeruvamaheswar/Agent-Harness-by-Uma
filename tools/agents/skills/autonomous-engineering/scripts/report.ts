import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { redact } from './guard.ts';
import type { Journal } from './journal.ts';
import type { State } from './plan.ts';

// A snapshot of recorded facts. Do not sync definitions, infer verification, or write files here.
export function buildReport({ journal, journalFile, root, planText }: {
  journal: Journal; journalFile: string; root: string; planText: string;
}) {
  const counts: Partial<Record<State, number>> = {};
  const attempts = new Map<string, { provider: string; model: string; effort: string; count: number }>();
  const slices = Object.entries(journal.slices).map(([id, rec]) => {
    counts[rec.state] = (counts[rec.state] ?? 0) + 1;
    for (const a of rec.attempts.filter(a => a.kind === 'work')) {
      const label = { provider: a.provider ?? 'unknown', model: a.model ?? 'unknown', effort: a.effort ?? 'unknown' };
      const key = JSON.stringify(label), group = attempts.get(key);
      if (group) group.count++;
      else attempts.set(key, { ...label, count: 1 });
    }
    return {
      id, state: rec.state, evidence: rec.evidence,
      failures: rec.attempts.filter(a => a.outcome === 'failed'),
      ...(rec.blocker ? { blocker: rec.blocker } : {}),
    };
  });
  // Read only commits reachable from this checkout's HEAD. Match exact trailer values, not substrings.
  let log: string | null = null;
  try {
    log = execFileSync('git', ['--no-optional-locks', '-C', root, 'log', '--format=%H%x00%B%x00', 'HEAD', '--'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { /* No Git history: report this as unknown, never as a proven empty history. */ }
  const plan = relative(root, journalFile).replace(/\.run\.json$/, '.md').split('\\').join('/');
  const commits: { sha: string; slice: string }[] = [];
  const fields = log?.split('\0') ?? [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i].trim(), body = fields[i + 1];
    for (const id of Object.keys(journal.slices)) {
      if (body.split('\n').some(line => line.trim() === `AE-Slice: ${plan}#${id}`)) commits.push({ sha, slice: id });
    }
  }
  // Goal is a plan label only. States, attempts and evidence come exclusively from the journal.
  const goal = /^Goal:\s*(.+)$/m.exec(planText)?.[1] ?? /^- Outcome:\s*(.+)$/m.exec(planText)?.[1] ?? 'not recorded';
  const report = {
    plan: journal.plan, goal, period: { start: journal.createdAt, end: journal.updatedAt },
    counts, slices, attempts: [...attempts.values()], commits, gitHistory: log === null ? 'unavailable' : 'available',
    journal: journalFile, readOnly: true,
  };
  // Redact every output string, including Git and plan labels. The journal loader already scrubs old records.
  return JSON.parse(JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value)) as typeof report;
}

export function renderReport(report: Record<string, unknown>): string {
  // Keep text and JSON on the same data path; nested evidence remains complete and searchable.
  return `Morning report\n${JSON.stringify(report, null, 2)}`;
}
