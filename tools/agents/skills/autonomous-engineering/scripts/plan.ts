import { createHash } from 'node:crypto';
import { basename } from 'node:path';

// Plan reader for the multi-agent-planning format (references/slice-format.md).
// It reads slice blocks and rewrites only the State and Evidence lines of one block.

export const STATES = ['PLANNED', 'READY', 'IN_PROGRESS', 'AGENT_FINISHED', 'BLOCKED', 'FAILED', 'REVIEWED', 'VERIFIED', 'INTEGRATED'] as const;
export type State = typeof STATES[number];
export type WaveKind = 'sequential' | 'parallel' | 'integration';
export type Slice = {
  id: string; name: string; goal: string; covers: string; model: string; review: string; fallback: string;
  wave: { n: number; kind: WaveKind }; dependsOn: string[]; files: string[]; outOfScope: string[];
  accept: string; verify: string; state: State; evidence: string;
  // Files and Out of scope exactly as the plan line has them (null when absent), for the handoff note.
  raw: { files: string; outOfScope: string | null };
};
export type Plan = { path: string; slug: string; mode: string | null; slices: Slice[] };

const FIELDS = ['Goal', 'Covers', 'Model', 'Review', 'Fallback', 'Wave', 'Depends on', 'Files', 'Out of scope', 'Accept', 'Verify', 'State', 'Evidence'] as const;
const REQUIRED = FIELDS.filter(f => f !== 'Covers' && f !== 'Out of scope');
const HEADING = /^### Slice (\d+): (.+?)\s*$/, FIELD_LINE = /^- ([A-Za-z][A-Za-z ]*?): ?(.*?)\s*$/;

export class PlanError extends Error {
  problems: string[];
  constructor(path: string, problems: string[]) {
    super(`plan ${path} has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(p => `- ${p}`).join('\n')}`);
    this.name = 'PlanError';
    this.problems = problems;
  }
}

const list = (text: string) => text.split(', ').map(s => s.replace(/`/g, '').trim()).filter(Boolean);

export function parsePlan(text: string, path: string): Plan {
  const lines = text.split('\n'), problems: string[] = [];
  const mode = /^mode:\s*(\S+)/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '')?.[1] ?? null;
  const slices: Slice[] = [], seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('### Slice')) { i++; continue; }
    const m = HEADING.exec(line);
    let end = i + 1;
    while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++;
    if (!m) { problems.push(`line ${i + 1}: bad slice heading "${line}" (want "### Slice N: name")`); i = end; continue; }
    const [, id, name] = m, tag = `Slice ${id}`, f = new Map<string, string>();
    if (seen.has(id)) problems.push(`${tag}: duplicate slice number`);
    seen.add(id);
    for (const l of lines.slice(i + 1, end)) {
      const fm = FIELD_LINE.exec(l.replace(/\r$/, ''));
      if (!fm || !(FIELDS as readonly string[]).includes(fm[1])) continue;
      if (f.has(fm[1])) problems.push(`${tag}: duplicate field ${fm[1]}`);
      else f.set(fm[1], fm[2]);
    }
    for (const r of REQUIRED) if (!f.get(r)) problems.push(`${tag}: missing field ${r}`);
    const get = (k: string) => f.get(k) ?? '';
    const state = get('State');
    if (state && !(STATES as readonly string[]).includes(state)) problems.push(`${tag}: unknown state "${state}"`);
    const wm = /^(\d+) (sequential|parallel|integration)$/.exec(get('Wave'));
    if (get('Wave') && !wm) problems.push(`${tag}: bad Wave "${get('Wave')}" (want "N sequential|parallel|integration")`);
    const dep = get('Depends on');
    const dependsOn = !dep || dep.toLowerCase() === 'none' ? [] : [...new Set(dep.match(/\d+/g) ?? [])];
    if (dep && dep.toLowerCase() !== 'none' && !dependsOn.length) problems.push(`${tag}: Depends on "${dep}" names no slice number`);
    slices.push({
      id, name, goal: get('Goal'), covers: get('Covers'), model: get('Model'), review: get('Review'), fallback: get('Fallback'),
      wave: { n: wm ? Number(wm[1]) : 0, kind: (wm?.[2] ?? 'sequential') as WaveKind }, dependsOn,
      files: list(get('Files')), outOfScope: list(get('Out of scope')), accept: get('Accept'), verify: get('Verify'),
      state: state as State, evidence: get('Evidence'), raw: { files: get('Files'), outOfScope: get('Out of scope') || null },
    });
    i = end;
  }
  if (!slices.length) problems.push('no "### Slice N: name" blocks found');
  const ids = new Set(slices.map(s => s.id));
  for (const s of slices) for (const d of s.dependsOn) {
    if (d === s.id) problems.push(`Slice ${s.id}: depends on itself`);
    else if (!ids.has(d)) problems.push(`Slice ${s.id}: depends on unknown slice ${d}`);
  }
  const cycle = findCycle(slices);
  if (cycle) problems.push(`dependency cycle: ${cycle.map(c => `slice ${c}`).join(' -> ')}`);
  if (problems.length) throw new PlanError(path, problems);
  return { path, slug: basename(path).replace(/\.md$/, ''), mode, slices };
}

function findCycle(slices: Slice[]): string[] | null {
  const deps = new Map(slices.map(s => [s.id, s.dependsOn.filter(d => d !== s.id)])), done = new Set<string>();
  const walk = (id: string, stack: string[]): string[] | null => {
    if (stack.includes(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (done.has(id) || !deps.has(id)) return null;
    for (const d of deps.get(id)!) { const c = walk(d, [...stack, id]); if (c) return c; }
    done.add(id);
    return null;
  };
  for (const s of slices) { const c = walk(s.id, []); if (c) return c; }
  return null;
}

// The first backticked span in Verify, else null (a manual step).
export const verifyCommand = (slice: Slice): string | null => /`([^`]+)`/.exec(slice.verify)?.[1].trim() || null;

// Every field except State and Evidence, so engine writes never look like a definition change.
// `raw` repeats Files and Out of scope; it stays out so that adding it changed no existing digest.
export function definitionDigest(slice: Slice): string {
  const { state: _s, evidence: _e, raw: _r, ...def } = slice;
  const stable = Object.keys(def).sort().map(k => [k, def[k as keyof typeof def]]);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12);
}

// Replaces the State and Evidence lines inside one slice block. Every other byte stays.
export function setSliceFields(text: string, id: string, fields: { state?: string; evidence?: string }): string {
  const lines = text.split('\n');
  const start = lines.findIndex(l => new RegExp(`^### Slice ${id}:`).test(l));
  if (start < 0) throw new Error(`slice ${id} not found in plan`);
  let end = start + 1;
  while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++;
  for (const [key, label] of [['state', 'State'], ['evidence', 'Evidence']] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    const at = lines.findIndex((l, n) => n > start && n < end && l.startsWith(`- ${label}:`));
    if (at < 0) throw new Error(`slice ${id} has no ${label} line`);
    lines[at] = `- ${label}: ${value.replace(/\s+/g, ' ').trim()}` + (lines[at].endsWith('\r') ? '\r' : '');
  }
  return lines.join('\n');
}
