import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { redact } from './guard.ts';
import { settled, type Journal } from './journal.ts';
import { runStop } from './run.ts';
import { sections, type SectionEnv } from './hooks.ts';
import type { State } from './plan.ts';

// A snapshot of recorded facts. Do not sync definitions, infer verification, or write files here.
export function buildReport({ journal, journalFile, root, planText, now = new Date(), env }: {
  journal: Journal; journalFile: string; root: string; planText: string; now?: Date; env?: SectionEnv;
}) {
  const counts: Partial<Record<State, number>> = {};
  const attempts = new Map<string, { provider: string; model: string; effort: string; count: number }>();
  const slices = Object.entries(journal.slices).map(([id, rec]) => {
    counts[rec.state] = (counts[rec.state] ?? 0) + 1;
    for (const a of rec.attempts.filter(a => a.kind === 'work' || a.kind === 'review')) {
      const label = { provider: a.provider ?? 'unknown', model: a.model ?? 'unknown', effort: a.effort ?? 'unknown' };
      const key = JSON.stringify(label), group = attempts.get(key);
      if (group) group.count++;
      else attempts.set(key, { ...label, count: 1 });
    }
    return {
      id, state: rec.state, evidence: rec.evidence,
      claims: rec.attempts.filter(a => a.kind === 'work' && a.outcome === 'finished'),
      handoffs: rec.handoffs ?? [],
      failures: rec.attempts.filter(a => a.outcome === 'failed'),
      ...(rec.blocker ? { blocker: rec.blocker } : {}),
    };
  });
  // Read only commits reachable from this checkout's HEAD. Match exact trailer values, not substrings.
  let log: string | null = null;
  let gitHistory: 'available' | 'empty' | 'unavailable' = 'unavailable';
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    try {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
    } catch {
      execFileSync('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'], { stdio: 'ignore' });
      gitHistory = 'empty';
    }
    if (gitHistory !== 'empty') log = execFileSync('git', ['--no-optional-locks', '-C', root, 'log', '--format=%H%x00%B%x00', 'HEAD', '--'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (log !== null) gitHistory = 'available';
  } catch { /* Git is absent, unreadable, or has broken history. */ }
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
    counts, settled: slices.filter(s => settled(s.state)).length, done: slices.every(s => settled(s.state)), slices, attempts: [...attempts.values()], commits, gitHistory,
    claims: slices.filter(s => s.state === 'AGENT_FINISHED' || s.state === 'REVIEWED').map(s => ({ slice: s.id, state: s.state, claims: s.claims })),
    handoffs: slices.flatMap(s => s.handoffs.map(h => ({ slice: s.id, ...h }))),
    charter: journal.run ?? null, stop: runStop(journal, now),
    journal: journalFile, readOnly: true,
    ...sections('reportSection', journal, env),
  };
  // Redact every output string, including Git and plan labels. The journal loader already scrubs old records.
  return JSON.parse(JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value)) as typeof report;
}

// Render the same recorded facts as readable sections. No inferred verification or JSON dump.
export function renderReport(report: Record<string, unknown>): string {
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const rows = (value: unknown): Record<string, unknown>[] => {
    const items: unknown[] = Array.isArray(value) ? value : [];
    return items.filter(isObject);
  };
  const describe = (value: unknown): string => {
    if (value === null || value === undefined) return 'none';
    if (Array.isArray(value)) return value.map(describe).join('; ') || 'none';
    if (isObject(value)) return Object.entries(value).map(([k, v]) => `${k}: ${describe(v)}`).join('; ') || 'none';
    return String(value);
  };
  const section = (title: string, entries: string[]) => `## ${title}\n${entries.length ? entries.map(s => `- ${s}`).join('\n') : '- none'}`;
  const slices = rows(report.slices);
  // The section follows the last live evidence entry, as `recover` reads it: a later manual sign-off outranks an older or stale command check.
  // Only a command check counts as engine evidence. A settled slice with a person's note, or with no live evidence, is listed as manual.
  const engineChecked = (s: Record<string, unknown>) => rows(s.evidence).filter(e => !e.stale).at(-1)?.kind === 'command';
  const checked = (s: Record<string, unknown>) => s.state === 'VERIFIED' || s.state === 'INTEGRATED';
  return [
    'Morning report',
    `Goal: ${describe(report.goal)}\nPeriod: ${describe(report.period)}\nStates: ${describe(report.counts)}\nSettled: ${describe(report.settled)}; done: ${describe(report.done)}`,
    section('Verified with engine evidence', slices.filter(s => checked(s) && engineChecked(s)).map(s => `Slice ${s.id} (${s.state}): ${describe(s.evidence)}`)),
    section('Accepted by manual sign-off', slices.filter(s => s.state === 'ACCEPTED' || (checked(s) && !engineChecked(s))).map(s => `Slice ${s.id} (${s.state}): ${describe(s.evidence)}`)),
    section('Claims', rows(report.claims).map(c => `Slice ${c.slice} (${c.state}): ${describe(c.claims)}`)),
    section('Failures', slices.flatMap(s => rows(s.failures).map(f => `Slice ${s.id}: ${describe(f)}`))),
    section('Blocked', slices.filter(s => s.blocker).map(s => `Slice ${s.id}: ${describe(s.blocker)}`)),
    section('Handoffs', rows(report.handoffs).map(describe)),
    section('Commits', [`Git history: ${describe(report.gitHistory)}`, ...rows(report.commits).map(c => `Slice ${c.slice}: ${c.sha}`)]),
    section('Charter and stop', [`Charter: ${describe(report.charter)}`, `Stop: ${describe(report.stop)}`, `Attempts by provider/model/effort: ${describe(report.attempts)}`]),
    section('Journal', [describe(report.journal)]),
  ].join('\n\n');
}
