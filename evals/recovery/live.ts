// Slice 14 retained-evidence driver. Workers receive the packet on stdin and in AE_PACKET.
// Command identities come from the executable and -m/--model; missing models are labeled asserted.
// Known wrappers (env, exec, timeout, nice, npx, VAR=value) are unwrapped first. The CLI path accepts claude,
// codex, or node <script> (scripted fixtures, labeled asserted); any other executable is refused.
// Unquoted shell operators (| ; & < > backquote, $( ) are refused, so the parsed command is the whole worker.
// Workers get no CLAUDE* environment variable except CLAUDE_CONFIG_DIR. On any worker exit the rest of its
// process group is killed. Raw stdout is retained byte-exact. A grandchild that leaves the process group
// (setsid, detach) is not seen; the finished-files hash check catches its writes later.
// Claude commands require --output-format stream-json --verbose; codex commands require exec --json.
// Effort comes from the command (claude --effort, codex -c model_reasoning_effort=); absent means "unset".
// Each worker keeps its command line, with VAR=value values redacted. Tokens: input+output, cache excluded.
// Sandboxes must be outside every git worktree, so a worker cannot load or change a parent repository.
// Scenario 3 A MUST be a scripted partial writer; real models normally write complete files.
// The local hostname appears in journal thread ids (cli:<pid>@<hostname>).
// SHA256 anchors detect edits against retained rows; they do not authenticate a coordinated rewrite of all evidence.
// Probe records add {probe:{label:'probe',provider:'Claude'|'Codex',reaskCount:integer}}. The label must equal the
// last worker's command identity: claude with a sonnet model, or codex with gpt-6.1-terra.
// Every evidence path in a record must resolve, after symlinks, inside the row's plans/ folder.
// AVX records add {avx:{taskKeys:[string],checkpointHead:string,decisions:['D1','D2'],
// state:'VERIFIED',screenshots:{light:path,dark:path}}}; paths are relative to plans/.
// T3 step mode (t3-begin, t3-attach, t3-wait, t3-stop, t3-takeover, t3-finish): the lead, a T3 thread, starts each
// worker with delegate_task and stops it with task_cancel; this tool never calls T3. task_cancel does not kill a shell
// command already running in the child, so t3-stop SIGKILLs every process whose cwd is inside the sandbox (lsof) and
// samples that none is left. Those samples carry pid 0 (no OS process stands for a T3 task; grade.ts needs one numeric
// pid) with scope 'cwd' and the pids found. Worker exports are the JSON result of t3_thread_read (view messages), kept
// byte-exact; only provider assistant_message items are assistant prose. T3 shows no token usage: tokens are unknown.
// T3 workers carry identity 't3-status': provider and model as task_status reported them, passed by the lead.
// The engine has no 't3' handoff mode; a new delegate_task child is transfer --mode new. Every lead write in step
// mode uses the current lease holder read from the journal (lead.id), so a successor's writes follow a takeover.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { asksInSentence, grade, isReportHeading, normalizeText, parseSettled, sentencesOf } from './grade.ts';

const now = () => new Date().toISOString();
const cap = (s: string) => s.slice(0, 200);
const json = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const save = (p: string, value: unknown) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const files = ['src/m1.txt', 'src/m2.txt', 'src/m3.txt'];
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const paths = (dir: string) => ({ dir: resolve(dir), plan: join(resolve(dir), 'plans/sandbox.md'), journal: join(resolve(dir), 'plans/sandbox.run.json'), record: join(resolve(dir), 'plans/sandbox.record.json') });
const labelsSchema = z.object({ measured: z.array(z.unknown()), estimate: z.array(z.unknown()), tokens: z.union([z.number().int().nonnegative(), z.literal('unknown')]).optional(), tokensReported: z.boolean().optional() });
const identitySchema = z.object({ provider: z.string(), model: z.string(), identity: z.enum(['command', 'asserted', 't3-status']) });
// command and effort are optional only so rows retained before they existed still parse; probes require both.
const workerEvidenceSchema = identitySchema.extend({ attempt: z.number().int().positive(), stdout: z.string(), sha256: z.string(), command: z.string().optional(), effort: z.string().optional() });
const recordSchema = z.object({ slice: z.string(), settledKey: z.string(), replacementTranscript: z.string(), replacementPacket: z.string(), disarmEvidence: z.string(), tokensReported: z.boolean().optional(), pendingQuestionCount: z.number().int().nonnegative().optional(), finishedFiles: z.record(z.string(), z.string()), labels: labelsSchema,
  replacementStdout: z.string(), replacementStdoutSha256: z.string(), workers: z.array(workerEvidenceSchema),
  probe: z.object({ label: z.literal('probe'), provider: z.enum(['Claude', 'Codex']), reaskCount: z.number().int().nonnegative() }).optional(),
  avx: z.object({ taskKeys: z.array(z.string()), checkpointHead: z.string(), decisions: z.array(z.string()), state: z.string(), screenshots: z.object({ light: z.string(), dark: z.string() }) }).optional(),
});
const attemptSchema = z.object({ n: z.number(), at: z.string(), endedAt: z.string().optional(), threadId: z.string().optional(), kind: z.string(), provider: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), outcome: z.string().optional(), interruptions: z.array(z.unknown()).optional(), launchKey: z.string().optional() });
const leadSchema = z.object({ id: z.string(), history: z.array(z.object({ at: z.string(), id: z.string(), event: z.string() })) });
const journalSchema = z.object({ lead: leadSchema.optional(), slices: z.record(z.string(), z.object({ state: z.string(), attempts: z.array(attemptSchema), checkpoints: z.array(z.object({ delta: z.array(z.string()).optional(), snapshot: z.string().optional(), gitHead: z.string(), at: z.string(), check: z.object({ exitCode: z.number().optional() }).optional() })).optional(), handoffs: z.array(z.object({ mode: z.string().optional() })).optional() })), decisions: z.array(z.object({ id: z.string(), key: z.string(), risk: z.string(), status: z.string() })).default([]) });
// Rows are strict: an unknown field at any level fails the row instead of being silently dropped.
const rowSchema = z.object({ scenario: z.union([z.string(), z.number()]), path: z.enum(['cli', 't3', 'combined', 'probe', 'avx']), dir: z.string(), gradedAt: z.string(), gradePass: z.boolean().optional(), checks: z.array(z.object({ name: z.string(), pass: z.boolean(), detail: z.string() }).strict()), tokens: z.union([z.number().int().nonnegative(), z.literal('unknown')]), tokensReported: z.boolean().optional(), models: z.array(identitySchema.strict()), labels: labelsSchema.strict(), workers: z.array(workerEvidenceSchema.strict()).optional(), replacementStdout: z.string().optional(), replacementStdoutSha256: z.string().optional(), reaskCount: z.number().int().nonnegative().optional(), status: z.enum(['pass', 'fail', 'blocked']), reason: z.string() }).strict();
export type ResultRow = z.infer<typeof rowSchema>;
type Check = { name: string; pass: boolean; detail: string };
const load = (dir: string) => { const p = paths(dir); return { ...p, rec: recordSchema.parse(json(p.record)), journalData: journalSchema.parse(json(p.journal)) }; };
class UsageError extends Error {}
class RunError extends Error {}
function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 20 });
  // Never echo a child output: it can contain transcript text.
  if (r.error || r.status !== 0) throw new Error(`command ${cmd === process.execPath ? 'engine' : cmd} failed (${r.status ?? r.error?.name})`);
  return r.stdout;
}
function engine(dir: string, script: string, command: string, args: string[] = [], slice = true, leadId = 'recovery-live') {
  return z.object({ launchKey: z.string().optional(), text: z.string().optional() }).passthrough().parse(JSON.parse(run(process.execPath, ['--experimental-strip-types', resolve(script), command, paths(dir).plan, ...(slice ? ['1'] : []), ...args, ...(command === 'init' ? [] : ['--lead-id', leadId]), '--json'], dir)));
}
const lead = ['--lead', 'Claude (opus/high)'];
// True when the folder's parent is inside a git worktree (the sandbox's own repo does not count).
// A worker in such a sandbox can load and change the parent repository (slice 14 review H1).
export function insideGitWorktree(dir: string) {
  let parent = dirname(resolve(dir));
  while (!existsSync(parent)) parent = dirname(parent);
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: parent, encoding: 'utf8', timeout: 15000 });
  return inside.status === 0 && inside.stdout.trim() === 'true';
}
export function scaffold(dir: string, script: string) {
  if (existsSync(dir)) throw new UsageError('scaffold requires a new disposable directory');
  if (insideGitWorktree(dir)) throw new UsageError('scaffold refuses a folder inside a git worktree');
  mkdirSync(join(dir, 'plans'), { recursive: true }); mkdirSync(join(dir, 'src'));
  const p = paths(dir);
  writeFileSync(p.plan, `---\nkind: plan\ntitle: Recovery sandbox\nstatus: active\nmode: standard\n---\n## Slices\n### Slice 1: three milestones\n- Goal: three milestone files hold one line each\n- Model: Codex (gpt-6.1-terra/low)\n- Review: Claude (opus/medium)\n- Fallback: Claude (sonnet/low)\n- Wave: 1 sequential\n- Depends on: none\n- Files: src/m1.txt, src/m2.txt, src/m3.txt\n- Accept: all three milestones hold their lines\n- Verify: \`test "$(cat src/m1.txt src/m2.txt src/m3.txt)" = "$(printf 'milestone 1\\nmilestone 2\\nmilestone 3')"\`\n- State: READY\n- Evidence: none\n`);
  run('git', ['init', '-q'], dir);
  // The engine needs HEAD. Seed an empty fixture tree through plumbing; no index staging.
  const tree = run('git', ['mktree'], dir).trim();
  const head = run('git', ['-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@localhost', 'commit-tree', tree, '-m', 'disposable fixture baseline'], dir).trim();
  run('git', ['update-ref', 'HEAD', head], dir);
  engine(dir, script, 'init', [], false);
  engine(dir, script, 'lead', ['--claim', '--label', 'Claude (opus/high)'], false);
  engine(dir, script, 'decide', [...lead, '--key', 'milestone-format', '--risk', 'amber', '--status', 'assumed', '--question', 'Milestone format', '--answer', 'one line, no trailing text', '--rollback', 'rewrite the milestone files']);
  engine(dir, script, 'decide', [...lead, '--key', 'deploy-target', '--risk', 'red', '--status', 'proposed', '--question', 'Deployment target']);
  return p;
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ESRCH') return false;
    throw e;
  }
}
// The exit callback is the only place allowed to clean up leftover descendants after the leader exits.
function killGroup(pgid: number) {
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
  }
}
export function groupLifecycle(pgid: number, exists = groupAlive, signal: (id: number) => unknown = killGroup) {
  let exited = false, signaled = false;
  const kill = () => { signaled = true; signal(pgid); };
  return {
    get exited() { return exited; },
    cancel() { if (!exited && !signaled && exists(pgid)) kill(); },
    // Any exit, with any code or signal: kill descendants left in the group while the group still exists.
    // A group already sent SIGKILL by cancel() has no member left to clean up.
    onExit(_code?: number | null) {
      if (exited) return;
      exited = true;
      if (!signaled && exists(pgid)) kill();
    },
  };
}
const CLAUDE_ENV_ALLOWED = new Set(['CLAUDE_CONFIG_DIR']);
export function workerEnvironment(packet: string, source = process.env) {
  return Object.fromEntries(Object.entries({ ...source, AE_PACKET: packet }).filter(([k]) =>
    !/^claude/i.test(k) || CLAUDE_ENV_ALLOWED.has(k)));
}
const present = (dir: string) => files.filter(f => existsSync(join(dir, f)));
const fileHashes = (dir: string) => Object.fromEntries(present(dir).map(f => [f, hash(join(dir, f))]));
function milestones(dir: string) {
  const m2 = existsSync(join(dir, files[1])) ? readFileSync(join(dir, files[1]), 'utf8') : null;
  const m3 = existsSync(join(dir, files[2])) ? readFileSync(join(dir, files[2]), 'utf8') : null;
  return { at: now(), m2Exact: m2 === 'milestone 2\n', m3: m3 === null ? 'absent' : m3 === 'milestone 3\n' ? 'complete' : m3.length > 0 && 'milestone 3\n'.startsWith(m3) ? 'partial' : 'other', sha256: fileHashes(dir) };
}
const observationSchema = z.object({ at: z.string().datetime(), m2Exact: z.boolean(), m3: z.enum(['absent', 'complete', 'partial', 'other']), sha256: z.record(z.string(), z.string()) });
const disarmBase = { observedAt: z.string().datetime(), predecessorStatus: z.literal('interrupted'), replacementLaunchedAt: z.string(),
  milestoneObservation: observationSchema, stoppedMilestones: observationSchema,
  filesAfterStop: z.array(z.object({ at: z.string().datetime(), files: z.array(z.string()), sha256: z.record(z.string(), z.string()) })),
};
const cliDisarmSchema = z.object({ ...disarmBase,
  processSamples: z.array(z.object({ at: z.string().datetime(), pid: z.number().int().positive(), pgid: z.number().int().positive(), alive: z.boolean(), groupAlive: z.boolean() })),
});
// T3 variant: a T3 task has no OS pid. Each sample lists the processes whose cwd is inside dir (pids); pid is 0.
const cwdSampleSchema = z.object({ at: z.string().datetime(), scope: z.literal('cwd'), dir: z.string().min(1), pid: z.literal(0), pids: z.array(z.number().int().positive()), alive: z.boolean() });
const t3DisarmSchema = z.object({ ...disarmBase, variant: z.literal('t3'), killed: z.array(z.number().int().positive()), processSamples: z.array(cwdSampleSchema) });
const disarmSchema = z.union([cliDisarmSchema, t3DisarmSchema]);
function sample(pgid: number) { const alive = groupAlive(pgid); return { at: now(), pid: pgid, pgid, alive, groupAlive: alive }; }
function launch(dir: string, command: string, packet: string) {
  const child = spawn('/bin/sh', ['-c', command], { cwd: dir, detached: true, env: workerEnvironment(packet), stdio: ['pipe', 'pipe', 'pipe'] });
  if (!child.pid) throw new Error('worker has no pid');
  const pid = child.pid, lifecycle = groupLifecycle(pid);
  // Raw bytes are kept as Buffers so a multi-byte character split across chunks stays byte-exact.
  const chunks: Buffer[] = []; let size = 0, cleanupError: unknown;
  child.on('exit', code => { try { lifecycle.onExit(code); } catch (e) { cleanupError = e; } });
  child.stdout.on('data', (b: Buffer) => { chunks.push(b); size += b.length; if (size > 2 ** 20) lifecycle.cancel(); });
  child.stderr.resume();
  child.stdin.on('error', () => {}); child.stdin.end(packet);
  const completed = new Promise<number | null>((res, rej) => {
    child.on('error', rej); child.on('close', code => cleanupError ? rej(cleanupError) : res(code));
  });
  return { pid, completed, output: () => Buffer.concat(chunks), lifecycle };
}
// Tokenization reads shell arguments without running them. Quoted prompt text stays one argument.
function commandWords(command: string) {
  const words: string[] = []; let word = '', quote = '', escaped = false, prev = '';
  for (const c of command) {
    const last = prev; prev = escaped ? '' : c;
    // The shell would run more than one command, or substitute one, here: the parsed identity would not be proof.
    if (!escaped && quote !== "'" && (c === '`' || c === '(' && last === '$' || !quote && /[|;&<>]/.test(c)))
      throw new UsageError('shell operators and substitutions are refused in a worker command');
    if (escaped) { word += c; escaped = false; }
    else if (c === "\\" && quote !== "'") escaped = true;
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') quote = c;
    else if (/\s/.test(c)) { if (word) { words.push(word); word = ''; } }
    else word += c;
  }
  if (quote || escaped) throw new UsageError('unclosed command quoting');
  if (word) words.push(word);
  return words;
}
// Known wrappers: options that take a separate value, and positional arguments before the wrapped command.
const WRAPPERS: Record<string, { valued: string[]; positional: number }> = {
  env: { valued: ['-u', '--unset', '-C', '--chdir'], positional: 0 },
  exec: { valued: ['-a'], positional: 0 },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], positional: 1 },
  nice: { valued: ['-n', '--adjustment'], positional: 0 },
  npx: { valued: ['-p', '--package'], positional: 0 },
};
// Options that run a command string we cannot see through.
const HIDING_OPTIONS = ['-S', '--split-string', '-c', '--call'];
const PACKAGES: Record<string, string> = { '@anthropic-ai/claude-code': 'claude', '@openai/codex': 'codex' };
function unwrapCommand(words: string[]) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return i;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const name = basename(w), wrapper = WRAPPERS[name];
    if (!wrapper) return i;
    i++;
    while (words[i]?.startsWith('-') && words[i] !== '--') {
      const opt = words[i], key = opt.split('=')[0];
      if (HIDING_OPTIONS.includes(key)) throw new UsageError(`wrapper ${name} ${key} hides the worker executable`);
      i += wrapper.valued.includes(key) && !opt.includes('=') ? 2 : 1;
    }
    if (words[i] === '--') i++;
    i += wrapper.positional;
  }
}
function parseCommand(command: string) {
  const words = commandWords(command);
  const executable = unwrapCommand(words);
  const word = words[executable] ?? '', pkg = word.replace(/^(@[^/@]+\/[^@]+|[^@]+)@.*$/, '$1');
  const binary = PACKAGES[pkg] ?? basename(pkg);
  const scripted = binary === 'node' || word === process.execPath;
  if (!['claude', 'codex'].includes(binary) && !scripted)
    throw new UsageError(`unrecognized worker executable "${cap(binary).slice(0, 60)}"; use claude, codex, or node <script>`);
  const args = words.slice(executable + 1);
  const flag = (names: string[]) => {
    const i = args.findIndex(a => names.includes(a) || names.some(n => a.startsWith(n + '=')));
    return i < 0 ? undefined : args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
  };
  return { binary, args, flag };
}
export function commandIdentity(command: string, fallback = { provider: 'codex', model: 'gpt-6.1-terra' }) {
  const { binary, args, flag } = parseCommand(command);
  const provider = binary === 'claude' ? 'claude' : binary === 'codex' ? 'codex' : fallback.provider;
  if (binary === 'claude' && (flag(['--output-format']) !== 'stream-json' || !args.includes('--verbose')))
    throw new RunError('Claude command requires --output-format stream-json --verbose');
  if (binary === 'codex' && (args[0] !== 'exec' || !args.includes('--json')))
    throw new RunError('Codex command requires exec --json');
  const model = flag(['-m', '--model']);
  if (model?.startsWith('-')) throw new UsageError('model flag requires a model');
  return { provider, model: model || fallback.model, identity: model && ['claude', 'codex'].includes(binary) ? 'command' : 'asserted' } satisfies z.infer<typeof identitySchema>;
}
// Effort as the command sets it; undefined when the command leaves it to the CLI default.
export function commandEffort(command: string): string | undefined {
  const { binary, args, flag } = parseCommand(command);
  if (binary === 'claude') return flag(['--effort']);
  if (binary !== 'codex') return undefined;
  const configs = args.flatMap((a, i) => a === '-c' || a === '--config' ? [args[i + 1] ?? ''] : a.startsWith('--config=') ? [a.slice(9)] : []);
  const set = configs.map(c => /^model_reasoning_effort=["']?([a-z]+)["']?$/.exec(c)?.[1]).filter(Boolean);
  return set.at(-1);
}
// Environment assignments (upper-case VAR=value) can carry secrets; keep the name, drop the value.
// Lower-case key=value config such as model_reasoning_effort=low is evidence and stays.
export const redactCommand = (command: string) => command.replace(/(^|\s)([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g, '$1$2=REDACTED');
const modelMatches = (expected: string, reported: string) => expected === reported ||
  ['sonnet', 'opus', 'haiku'].includes(expected) && reported.startsWith('claude-' + expected + '-');
// The JSON result of t3_thread_read (view messages), as observed 2026-11-08. Unknown fields are ignored.
const t3ExportSchema = z.object({
  thread: z.object({ threadId: z.string().min(1), providerInstanceId: z.string().optional(), model: z.string().optional(), status: z.string().optional(), latestRunId: z.string().nullable().optional(), pendingRequestCount: z.number().optional() }),
  recentRuns: z.array(z.object({ runId: z.string(), status: z.string().optional(), providerInstanceId: z.string().optional(), model: z.string().optional(), startedAt: z.string().nullable().optional(), completedAt: z.string().nullable().optional() })).optional(),
  items: z.array(z.object({ type: z.string(), creationSource: z.string().optional(), text: z.string().nullable().optional(), textTruncated: z.boolean().optional() })),
  hasMore: z.boolean().optional(),
});
type T3Export = z.infer<typeof t3ExportSchema>;
function t3Export(stdout: string): T3Export | undefined {
  if (!stdout.trimStart().startsWith('{')) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return undefined; }
  const parsed = t3ExportSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
// Only provider assistant messages are prose; user, tool and plan items never are. A paged or cut-off export is
// incomplete: a question could hide in the missing text.
function t3TranscriptItems(e: T3Export) {
  const items = e.items.filter(it => it.type === 'assistant_message' && it.creationSource === 'provider' && typeof it.text === 'string')
    .map(it => ({ type: 'assistant_message', text: it.text as string }));
  const run = e.recentRuns?.find(r => r.runId === e.thread.latestRunId) ?? e.recentRuns?.at(-1);
  const models = new Set([e.thread.model, ...(e.recentRuns ?? []).map(r => r.model)].filter((m): m is string => !!m));
  return { items, tokens: 'unknown' as const, models: [...models], format: 't3' as const, complete: e.hasMore === false && e.items.every(it => it.textTruncated !== true),
    t3: { threadId: e.thread.threadId, provider: e.thread.providerInstanceId, status: e.thread.status, pendingRequestCount: e.thread.pendingRequestCount, run } };
}
// Provider stream events are retained verbatim; tool events never become assistant prose.
// A T3 export (one JSON object with thread and items) is read by its own parser; CLI JSONL is unchanged.
export function transcriptItems(stdout: string) {
  const e = t3Export(stdout);
  if (e) return t3TranscriptItems(e);
  const items: { type: string; text: string }[] = [];
  let tokens: number | 'unknown' = 'unknown';
  const models = new Set<string>();
  // Claude stream-json repeats the final assistant text in its result event; count it once.
  // Texts are compared without whitespace: result joins blocks with \n\n where assistant events used \n.
  const assistantTexts = new Set<string>(), squash = (s: string) => s.replace(/\s+/g, '');
  for (const line of stdout.split(/\r?\n/).filter(l => l.trim())) {
    let raw: unknown;
    // Both CLIs must emit JSON lines; any other line (warnings, stderr merged in) is never assistant prose.
    try { raw = JSON.parse(line); } catch { continue; }
    const parsed = z.object({ type: z.string().optional(), result: z.string().optional(), text: z.string().optional(), model: z.string().optional(), modelUsage: z.record(z.string(), z.unknown()).optional(), item: z.object({ type: z.string(), text: z.string().optional() }).optional(), message: z.object({ model: z.string().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional(), usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional() }).safeParse(raw);
    if (!parsed.success) continue;
    const v = parsed.data;
    for (const m of [v.model, v.message?.model, ...Object.keys(v.modelUsage ?? {})]) if (m) models.add(m);
    const text = v.result ?? (v.item?.type === 'agent_message' ? v.item.text : undefined) ?? (/^assistant/.test(v.type ?? '') ? v.text ?? v.message?.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : undefined);
    const repeatedResult = v.type === 'result' && v.result !== undefined && assistantTexts.has(squash(v.result));
    if (text && !repeatedResult) items.push({ type: 'assistant_message', text });
    if (text && v.type !== 'result') assistantTexts.add(squash(text));
    const u = v.usage;
    const n = u?.input_tokens !== undefined && u.output_tokens !== undefined ? u.input_tokens + u.output_tokens : u?.total_tokens;
    if (n !== undefined && Number.isSafeInteger(n) && n >= 0) tokens = n;
  }
  return { items, tokens, models: [...models], format: 'jsonl' as const, complete: true, t3: undefined };
}
// Report headings ("What I found:") are skipped by grade.ts itself (isReportHeading, U-6); one rule for both.
export { isReportHeading };
const asksInProbe = asksInSentence;
export function reaskCount(items: { type: string; text?: string }[]) {
  const assistant = items.map((it, i) => ({ ...it, i })).filter(it => /^assistant/i.test(it.type));
  const normalized = assistant.map(it => normalizeText(it.text ?? ''));
  const single = normalized.map(text => sentencesOf(text).filter(asksInProbe).length);
  let count = single.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i + 1 < assistant.length; i++) {
    if (assistant[i + 1].i !== assistant[i].i + 1 || single[i] || single[i + 1]) continue;
    count += sentencesOf(`${normalized[i].split('\n').at(-1)} ${normalized[i + 1].split('\n')[0]}`).filter(asksInProbe).length;
  }
  return count;
}
export async function cliRun(dir: string, script: string, scenario: string, commands: string[]) {
  if (!['2', '3', '5', '6'].includes(scenario) || commands.length !== (scenario === '5' ? 3 : 2)) throw new UsageError('scenario requires A, B, and C only for scenario 5');
  const p = paths(dir);
  const identities = commands.map((command, i) => commandIdentity(command, scenario === '6' && i > 0
    ? { provider: 'claude', model: 'sonnet' } : { provider: 'codex', model: 'gpt-6.1-terra' }));
  const efforts = commands.map(commandEffort), effortArgs = (i: number) => efforts[i] ? ['--effort', efforts[i]] : [];
  let packet = String(engine(dir, script, 'handoff').text), finalTokens: number | 'unknown' = 'unknown';
  const first = identities[0];
  let key = String(engine(dir, script, 'start', ['--provider', first.provider, '--model', first.model, ...effortArgs(0)]).launchKey);
  const finishedFiles: Record<string, string> = {};
  const disarms: z.infer<typeof cliDisarmSchema>[] = [], workers: z.infer<typeof workerEvidenceSchema>[] = [];
  const boundary = (o: ReturnType<typeof milestones>) => o.m2Exact && o.m3 === (scenario === '3' ? 'partial' : 'absent');
  for (let i = 0; i < commands.length; i++) {
    const before = new Map(present(dir).map(f => [f, hash(join(dir, f))]));
    const startedAt = now(), worker = launch(dir, commands[i], packet);
    const timer = setTimeout(() => worker.lifecycle.cancel(), WORKER_TIMEOUT_MS);
    const rawName = i === commands.length - 1 ? 'replacement-stdout.jsonl' : `worker-${i + 1}-stdout.jsonl`;
    const retainRaw = () => {
      const raw = worker.output(), rawPath = join(dir, 'plans', rawName); writeFileSync(rawPath, raw);
      const parsed = transcriptItems(raw.toString('utf8'));
      if (parsed.models.some(m => !modelMatches(identities[i].model, m))) throw new RunError('CLI reported model differs from command identity');
      return { parsed, evidence: { attempt: i + 1, stdout: rawName, sha256: hash(rawPath), ...identities[i], command: redactCommand(commands[i]), effort: efforts[i] ?? 'unset' } };
    };
    try {
      engine(dir, script, 'attach', ['--launch-key', key, '--thread-id', `cli:${worker.pid}@${hostname()}`,
        ...(i > 0 ? ['--observed', `predecessor exited, read ${now()}`] : [])]);
      // Let pending native exit events mark the child reaped after the synchronous engine call.
      await new Promise<void>(resolve => setImmediate(resolve));
      const prev = disarms.at(-1);
      if (prev) {
        prev.replacementLaunchedAt = startedAt;
        prev.processSamples.push(sample(prev.processSamples[0].pgid));
        save(join(dir, `plans/disarm-evidence-${disarms.length}.json`), prev);
      }
      if (i < commands.length - 1) {
        const deadline = Date.now() + WORKER_TIMEOUT_MS;
        let observation = milestones(dir);
        for (;;) {
          observation = milestones(dir);
          if (i === 0 && observation.m3 === 'complete') throw new RunError('A did not stop after milestone 2');
          const changed = present(dir).some(f => !before.has(f) || before.get(f) !== hash(join(dir, f)));
          if (i === 0 ? boundary(observation) : changed) break;
          if (worker.lifecycle.exited || Date.now() > deadline) throw new RunError(i === 0 ? 'A did not stop after milestone 2' : 'B did not reach its interruption milestone');
          await delay(10);
        }
        worker.lifecycle.cancel(); await worker.completed;
        const stoppedMilestones = milestones(dir);
        if (i === 0 && !boundary(stoppedMilestones)) throw new RunError('A did not stop after milestone 2');
        const goneDeadline = Date.now() + 1000;
        while (groupAlive(worker.pid) && Date.now() < goneDeadline) await delay(10);
        const observedAt = now(), processSamples = [], filesAfterStop = [];
        for (let n = 0; n < 2; n++) {
          processSamples.push(sample(worker.pid));
          filesAfterStop.push({ at: now(), files: present(dir), sha256: fileHashes(dir) }); await delay(5);
        }
        if (processSamples.some(s => s.groupAlive)) throw new RunError('predecessor process group remains alive');
        const de = cliDisarmSchema.parse({ observedAt, predecessorStatus: 'interrupted', processSamples, filesAfterStop,
          milestoneObservation: observation, stoppedMilestones, replacementLaunchedAt: '' });
        disarms.push(de); save(join(dir, `plans/disarm-evidence-${disarms.length}.json`), de);
        workers.push(retainRaw().evidence);
        for (const f of present(dir)) if (readFileSync(join(dir, f), 'utf8') === `milestone ${files.indexOf(f) + 1}\n`) finishedFiles[f] ??= hash(join(dir, f));
        engine(dir, script, 'interrupt', [...lead, '--launch-key', key, '--class', 'quota', '--source', 'lead', '--operation', scenario === '3' ? 'write src/m3.txt' : 'milestone write']);
        engine(dir, script, 'checkpoint', ['--thread-id', `cli:${worker.pid}@${hostname()}`, ...lead, '--kind', 'post-mortem', '--run-check']);
        const next = identities[i + 1], target = `${next.provider === 'claude' ? 'Claude' : 'Codex'} (${next.model}/${efforts[i + 1] ?? 'low'}, fresh session)`;
        if (scenario === '6') {
          // The plan's scenario 6 also needs a refused unauthorized target, with the journal left unchanged.
          const journalBefore = hash(p.journal), refusedTarget = 'Claude (haiku/medium, fresh session)';
          let refused = false;
          try { engine(dir, script, 'prepare', [...lead, '--launch-key', key, '--to', refusedTarget, '--reason', 'unauthorized target probe']); }
          catch { refused = true; }
          const journalUnchanged = hash(p.journal) === journalBefore;
          save(join(dir, 'plans/unauthorized-target.json'), { at: now(), target: refusedTarget, refused, journalUnchanged });
          if (!refused || !journalUnchanged) throw new RunError('engine accepted an unauthorized target');
        }
        engine(dir, script, 'prepare', [...lead, '--launch-key', key, '--to', target, '--reason', 'scripted quota interruption']);
        engine(dir, script, 'transfer', [...lead, '--launch-key', key, '--mode', 'cli', '--provider', next.provider, '--model', next.model, ...effortArgs(i + 1), '--disarmed', `interrupted,exited,${now()}`]);
        const h = engine(dir, script, 'handoff'); packet = String(h.text);
        writeFileSync(join(dir, `plans/replacement-packet-${i + 1}.txt`), packet); save(join(dir, `plans/replacement-packet-${i + 1}.json`), h);
        writeFileSync(join(dir, 'plans/replacement-packet.txt'), packet); save(join(dir, 'plans/replacement-packet.json'), h);
        const j = journalSchema.parse(json(p.journal)); key = j.slices['1'].attempts.at(-1)?.launchKey ?? '';
      } else {
        const code = await worker.completed;
        if (code !== 0) throw new RunError('replacement worker exited unsuccessfully');
        const { parsed, evidence } = retainRaw(); workers.push(evidence); finalTokens = parsed.tokens;
        save(join(dir, 'plans/replacement-transcript.json'), { threadId: `cli:${worker.pid}@${hostname()}`, runId: key,
          ...identities[i], startedAt, completedAt: now(), status: 'completed', items: parsed.items });
        engine(dir, script, 'finish', ['--launch-key', key, '--summary', 'replacement worker exited successfully']);
      }
    } finally {
      clearTimeout(timer);
      await new Promise<void>(resolve => setImmediate(resolve));
      worker.lifecycle.cancel(); await worker.completed;
      writeFileSync(join(dir, 'plans', rawName), worker.output());
    }
  }
  disarms.forEach((d, i) => save(join(dir, `plans/disarm-evidence-${i + 1}.json`), d));
  save(join(dir, 'plans/disarm-evidence.json'), disarms.at(-1));
  save(p.record, { slice: '1', settledKey: 'milestone-format', finishedFiles, replacementTranscript: 'replacement-transcript.json', replacementPacket: 'replacement-packet.txt',
    disarmEvidence: 'disarm-evidence.json', replacementStdout: 'replacement-stdout.jsonl', replacementStdoutSha256: workers.at(-1)?.sha256, workers,
    tokensReported: typeof finalTokens === 'number', labels: { measured: ['process-group samples, owned-file lists and hashes', 'replacement stdout export', 'tokens cover the final replacement CLI report only',
      ...(identities.some(id => id.provider === 'claude') ? ['Claude tokens: input+output, cache excluded'] : [])],
      estimate: ['model cost unknown'], tokens: finalTokens, tokensReported: typeof finalTokens === 'number' } });
  return { ...p, scenario, state: 'AGENT_FINISHED', next: 'lead review, then ae verify' };
}

// ---- T3 step mode: the lead calls one subcommand between its own T3 tool calls ----
const t3WorkerSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), effort: z.string().min(1), threadId: z.string().optional() });
const t3StateSchema = z.object({ scenario: z.enum(['5', '10']), workers: z.array(t3WorkerSchema), stops: z.number().int().nonnegative(),
  observation: observationSchema.optional(), lastStopSha256: z.record(z.string(), z.string()).optional(), finishedFiles: z.record(z.string(), z.string()),
  takeover: z.object({ at: z.string(), from: z.string(), to: z.string() }).optional() });
type T3State = z.infer<typeof t3StateSchema>;
const statePath = (dir: string) => join(resolve(dir), 'plans/t3-state.json');
const readState = (dir: string): T3State => {
  if (!existsSync(statePath(dir))) throw new RunError('no T3 run here; run t3-begin first');
  return t3StateSchema.parse(json(statePath(dir)));
};
const holderOf = (dir: string) => {
  const id = journalSchema.parse(json(paths(dir).journal)).lead?.id;
  if (!id) throw new RunError('the journal has no lead lease holder');
  return id;
};
// Every lead write uses the current holder from the journal.
const leadEngine = (dir: string, script: string, command: string, args: string[] = [], slice = true) => engine(dir, script, command, args, slice, holderOf(dir));
const openAttempt = (dir: string) => journalSchema.parse(json(paths(dir).journal)).slices['1'].attempts.filter(a => a.kind === 'work').at(-1);
export function parseWorker(value: string) {
  const parts = value.split('|').map(x => x.trim());
  if (parts.length !== 3 || parts.some(x => !x)) throw new UsageError('worker identity must be PROVIDER|MODEL|EFFORT');
  return { provider: parts[0], model: parts[1], effort: parts[2] };
}
// The plan label the engine authorizes: Claude (sonnet/low, fresh session) for claudeAgent claude-sonnet-5-5 low.
export function planLabel(w: { provider: string; model: string; effort: string }) {
  const agent = /claude/i.test(w.provider) ? 'Claude' : /codex/i.test(w.provider) ? 'Codex' : undefined;
  if (!agent) throw new UsageError('worker provider must be a Claude or Codex provider');
  const family = /^claude-(sonnet|opus|haiku)-/.exec(w.model)?.[1] ?? w.model;
  return `${agent} (${family}/${w.effort}, fresh session)`;
}
// Processes whose working directory is inside dir; this process is never listed.
export function cwdPids(dir: string): number[] {
  const root = realpathSync(dir), inside = (p: string) => p === root || p.startsWith(root + sep), pids = new Set<number>();
  if (existsSync('/proc/self/cwd')) {
    for (const name of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      try { if (inside(readlinkSync(`/proc/${name}/cwd`))) pids.add(Number(name)); } catch { /* the process exited or is not ours */ }
    }
  } else {
    const r = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 2 ** 20 });
    // lsof exits 1 when it cannot read some processes; its list of the readable ones is still complete for this user.
    if (r.error || !r.stdout?.trim()) throw new RunError('cannot list process working directories (lsof)');
    let pid = 0;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0 && inside(line.slice(1))) pids.add(pid);
    }
  }
  pids.delete(process.pid);
  return [...pids].sort((a, b) => a - b);
}
const cwdSample = (dir: string) => { const pids = cwdPids(dir); return { at: now(), scope: 'cwd' as const, dir: realpathSync(dir), pid: 0 as const, pids, alive: pids.length > 0 }; };
// task_cancel leaves shell commands of the child running: SIGKILL each process with its cwd inside dir.
export async function killCwd(dir: string) {
  const killed: number[] = [];
  for (let round = 0; round < 5; round++) {
    const found = cwdPids(dir);
    if (!found.length) return killed;
    for (const pid of found) {
      try { process.kill(pid, 'SIGKILL'); if (!killed.includes(pid)) killed.push(pid); } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
      }
    }
    await delay(100);
  }
  if (cwdPids(dir).length) throw new RunError('a process with its cwd in the sandbox survived SIGKILL');
  return killed;
}
const boundary1 = (o: ReturnType<typeof milestones>) => o.m2Exact && o.m3 === 'absent';
const workerLimit = (s: T3State) => s.scenario === '5' ? 3 : 2;

export function t3Begin(dir: string, script: string, scenario: string, worker: string) {
  const s = usageEnum(t3StateSchema.shape.scenario, scenario), w = parseWorker(worker), p = paths(dir);
  if (!existsSync(p.journal)) throw new UsageError('t3-begin needs a scaffolded sandbox');
  if (existsSync(statePath(dir))) throw new RunError('a T3 run already began in this sandbox');
  const packet = String(leadEngine(dir, script, 'handoff').text);
  const launchKey = String(leadEngine(dir, script, 'start', ['--provider', w.provider, '--model', w.model, '--effort', w.effort]).launchKey);
  save(statePath(dir), { scenario: s, workers: [w], stops: 0, finishedFiles: {} } satisfies T3State);
  writeFileSync(join(p.dir, 'plans/worker-1-packet.txt'), packet);
  return { launchKey, packet };
}
export function t3Attach(dir: string, script: string, threadId: string) {
  const s = readState(dir), w = s.workers.at(-1)!, open = openAttempt(dir);
  if (w.threadId) throw new RunError('the current worker already has a thread');
  if (!open?.launchKey || open.outcome) throw new RunError('no open launch key to attach');
  const r = leadEngine(dir, script, 'attach', ['--launch-key', open.launchKey, '--thread-id', threadId,
    ...(s.workers.length > 1 ? ['--observed', `predecessor interrupted, read ${now()}`] : [])]);
  w.threadId = threadId; save(statePath(dir), s);
  return { attached: r.attached, launchKey: open.launchKey, threadId, worker: s.workers.length };
}
export async function t3Wait(dir: string, timeoutS: number) {
  const s = readState(dir);
  if (!(timeoutS > 0)) throw new UsageError('--timeout must be a positive number of seconds');
  if (s.stops >= workerLimit(s) - 1) throw new RunError('the last worker is not stopped; wait for it in T3, then t3-finish');
  if (!s.workers.at(-1)?.threadId) throw new RunError('attach the current worker first');
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const o = milestones(dir);
    if (s.stops === 0 && o.m3 === 'complete') throw new RunError('A did not stop after milestone 2');
    const changed = JSON.stringify(o.sha256) !== JSON.stringify(s.lastStopSha256 ?? {});
    if (s.stops === 0 ? boundary1(o) : changed) {
      s.observation = observationSchema.parse(o); save(statePath(dir), s);
      return { reached: true, stop: s.stops + 1, observation: o, next: 'task_cancel the worker now, read task_status, then t3-stop' };
    }
    if (Date.now() > deadline) throw new RunError(s.stops === 0 ? 'A did not reach the milestone 2 boundary in time' : 'the worker changed no owned file in time');
    await delay(10);
  }
}
// Copies a T3 export byte-exact and checks it belongs to the worker's thread.
function keepExport(dir: string, file: string, rel: string, w: z.infer<typeof t3WorkerSchema>, stopped = false) {
  const dest = join(resolve(dir), 'plans', rel); copyFileSync(file, dest);
  const parsed = transcriptItems(readFileSync(dest, 'utf8'));
  if (parsed.format !== 't3') throw new RunError('export is not a t3_thread_read messages result');
  if (!parsed.complete) throw new RunError('export is paged or cut off; read the thread with a larger limit and maxCharsPerItem');
  if (parsed.t3?.threadId !== w.threadId) throw new RunError('export thread differs from the attached worker thread');
  if (stopped && (parsed.t3?.status !== 'interrupted' || parsed.t3?.run?.status !== 'interrupted')) throw new RunError('a stopped worker export must show the thread and its latest run interrupted');
  if (parsed.t3?.provider && parsed.t3.provider !== w.provider) throw new RunError('export provider differs from the worker identity');
  if (parsed.models.some(m => !modelMatches(w.model, m))) throw new RunError('export model differs from the worker identity');
  return { parsed, sha256: hash(dest) };
}
export async function t3Stop(dir: string, script: string, taskStatus: string, exportFile: string, to: string) {
  const s = readState(dir), p = paths(dir), readAt = now(), next = parseWorker(to), n = s.stops + 1, w = s.workers.at(-1)!;
  if (taskStatus !== 'interrupted') throw new RunError('task_status must be interrupted after task_cancel');
  if (!s.observation) throw new RunError('run t3-wait before t3-stop');
  if (!w.threadId) throw new RunError('attach the current worker first');
  if (s.scenario === '10' && !s.takeover) throw new RunError('scenario 10: the successor runs t3-takeover before t3-stop');
  if (!existsSync(exportFile)) throw new UsageError('export file not found');
  const killed = await killCwd(dir);
  const stoppedMilestones = milestones(dir);
  if (n === 1 && !boundary1(stoppedMilestones)) throw new RunError('A did not stop after milestone 2');
  const observedAt = now(), processSamples = [], filesAfterStop = [];
  for (let k = 0; k < 2; k++) {
    processSamples.push(cwdSample(dir));
    filesAfterStop.push({ at: now(), files: present(dir), sha256: fileHashes(dir) }); await delay(5);
  }
  if (processSamples.some(x => x.alive)) throw new RunError('a process with its cwd in the sandbox remains');
  const de = t3DisarmSchema.parse({ variant: 't3', observedAt, predecessorStatus: 'interrupted', killed, processSamples, filesAfterStop,
    milestoneObservation: s.observation, stoppedMilestones, replacementLaunchedAt: '' });
  const disarmFile = join(p.dir, `plans/disarm-evidence-${n}.json`); save(disarmFile, de);
  keepExport(dir, exportFile, `worker-${n}-export.json`, w, true);
  for (const f of present(dir)) if (readFileSync(join(dir, f), 'utf8') === `milestone ${files.indexOf(f) + 1}\n`) s.finishedFiles[f] ??= hash(join(dir, f));
  const key = openAttempt(dir)?.launchKey ?? '';
  leadEngine(dir, script, 'interrupt', [...lead, '--launch-key', key, '--class', 'quota', '--source', 'lead', '--operation', 'milestone write']);
  leadEngine(dir, script, 'checkpoint', ['--thread-id', w.threadId, ...lead, '--kind', 'post-mortem', '--run-check']);
  leadEngine(dir, script, 'prepare', [...lead, '--launch-key', key, '--to', planLabel(next), '--reason', 'lead task_cancel at a milestone']);
  leadEngine(dir, script, 'transfer', [...lead, '--launch-key', key, '--mode', 'new', '--provider', next.provider, '--model', next.model, '--effort', next.effort, '--disarmed', `interrupted,cancel,${readAt}`]);
  const opened = openAttempt(dir);
  if (!opened?.launchKey) throw new RunError('transfer opened no launch key');
  de.replacementLaunchedAt = opened.at;
  await delay(5); de.processSamples.push(cwdSample(dir));
  if (de.processSamples.some(x => x.alive)) { save(disarmFile, de); throw new RunError('a process with its cwd in the sandbox appeared after the transfer'); }
  save(disarmFile, t3DisarmSchema.parse(de));
  const h = leadEngine(dir, script, 'handoff'), packet = String(h.text);
  writeFileSync(join(p.dir, `plans/replacement-packet-${n}.txt`), packet); save(join(p.dir, `plans/replacement-packet-${n}.json`), h);
  writeFileSync(join(p.dir, 'plans/replacement-packet.txt'), packet); save(join(p.dir, 'plans/replacement-packet.json'), h);
  s.workers.push(next); s.stops = n; s.observation = undefined; s.lastStopSha256 = stoppedMilestones.sha256; save(statePath(dir), s);
  return { launchKey: opened.launchKey, packet, killed, stop: n };
}
export function t3Takeover(dir: string, script: string, successorId: string, observed: string, reason: string) {
  const s = readState(dir), p = paths(dir);
  if (s.scenario !== '10') throw new UsageError('t3-takeover is for scenario 10 only');
  if (s.takeover) throw new RunError('the lease was already taken over in this run');
  const from = holderOf(dir);
  if (from === successorId) throw new UsageError('the successor id must differ from the current holder');
  engine(dir, script, 'lead', ['--takeover', '--label', 'Claude (opus/high)', '--reason', reason, '--observed', observed], false, successorId);
  if (holderOf(dir) !== successorId) throw new RunError('takeover did not move the lease');
  const before = hash(p.journal);
  let refused = false;
  try { engine(dir, script, 'decide', [...lead, '--key', 'old-lead-write', '--risk', 'amber', '--status', 'proposed', '--question', 'Old lead write probe'], true, from); }
  catch { refused = true; }
  const journalUnchanged = hash(p.journal) === before, at = now();
  save(join(p.dir, 'plans/lead-takeover.json'), { at, from, to: successorId, refused, journalUnchanged });
  if (!refused || !journalUnchanged) throw new RunError('the engine accepted a write from the replaced lead');
  s.takeover = { at, from, to: successorId }; save(statePath(dir), s);
  return { from, to: successorId, refused, journalUnchanged };
}
export function t3Finish(dir: string, script: string, exportFile: string, provider: string, model: string, effort: string) {
  const s = readState(dir), p = paths(dir), w = s.workers.at(-1)!, open = openAttempt(dir);
  if (s.workers.length !== workerLimit(s)) throw new RunError(`scenario ${s.scenario} needs ${workerLimit(s)} workers before t3-finish`);
  if (w.provider !== provider || w.model !== model || w.effort !== effort) throw new RunError('final worker identity differs from the transfer');
  if (!w.threadId || !open?.launchKey || open.outcome) throw new RunError('attach the final worker first');
  if (!existsSync(exportFile)) throw new UsageError('export file not found');
  const { parsed, sha256 } = keepExport(dir, exportFile, 'replacement-stdout.json', w);
  const run = parsed.t3?.run;
  if (run?.status !== 'completed' || !run.startedAt || !run.completedAt) throw new RunError('the final worker run is not completed in its export');
  if (!parsed.items.length) throw new RunError('the final worker export has no assistant message');
  save(join(p.dir, 'plans/replacement-transcript.json'), { threadId: w.threadId, runId: open.launchKey, provider, model,
    startedAt: run.startedAt, completedAt: run.completedAt, status: 'completed', items: parsed.items });
  leadEngine(dir, script, 'finish', ['--launch-key', open.launchKey, '--summary', 'T3 replacement worker completed']);
  const workers = s.workers.map((x, i) => {
    const rel = i === s.workers.length - 1 ? 'replacement-stdout.json' : `worker-${i + 1}-export.json`;
    return { attempt: i + 1, stdout: rel, sha256: hash(join(p.dir, 'plans', rel)), provider: x.provider, model: x.model, identity: 't3-status' as const, effort: x.effort };
  });
  const work = journalSchema.parse(json(p.journal)).slices['1'].attempts.filter(a => a.kind === 'work');
  if (workers.some((x, i) => work[i]?.n !== x.attempt)) throw new RunError('journal attempts do not match the T3 workers');
  copyFileSync(join(p.dir, `plans/disarm-evidence-${s.stops}.json`), join(p.dir, 'plans/disarm-evidence.json'));
  const pending = parsed.t3?.pendingRequestCount;
  save(p.record, { slice: '1', settledKey: 'milestone-format', finishedFiles: s.finishedFiles, replacementTranscript: 'replacement-transcript.json', replacementPacket: 'replacement-packet.txt',
    disarmEvidence: 'disarm-evidence.json', replacementStdout: 'replacement-stdout.json', replacementStdoutSha256: sha256, workers, tokensReported: false,
    ...(Number.isInteger(pending) ? { pendingQuestionCount: pending } : {}),
    labels: { measured: ['cwd process scans, owned-file lists and hashes', 'engine journal states and refusals'],
      estimate: ['claimed by the lead: t3_thread_read exports, written to file by the lead', 'claimed by the lead: identities as task_status reported them', 'model cost unknown', 'tokens unknown: T3 shows no token usage'], tokens: 'unknown', tokensReported: false } });
  return { ...p, scenario: s.scenario, state: 'AGENT_FINISHED', next: 'lead review, then ae verify' };
}

function gradeForPath(journal: string, record: string, path: ResultRow['path']) {
  const g = grade(journal, record);
  // Probes measure questions; all other integrity checks still apply, including the structural checks below.
  const checks = path === 'probe' ? g.checks.filter(c => c.name !== 'no-question-about-settled-key') : g.checks;
  return { pass: checks.every(c => c.pass), checks };
}
const transcriptSchema = z.object({ threadId: z.string().min(1), runId: z.string().min(1), provider: z.string(), model: z.string(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(), status: z.literal('completed'),
  items: z.array(z.object({ type: z.string(), text: z.string() })).min(1) });
type Loaded = ReturnType<typeof load>;
type AddCheck = (name: string, pass: boolean, detail: string) => void;
// Every evidence path must stay inside <dir>/plans after symlinks resolve; a missing file is judged lexically.
function evidencePathChecks(r: Loaded, check: AddCheck) {
  const plans = realpathSync(dirname(r.record));
  const rels = [r.rec.replacementTranscript, r.rec.replacementPacket, r.rec.disarmEvidence, r.rec.replacementStdout,
    ...r.rec.workers.map(w => w.stdout), ...(r.rec.avx ? Object.values(r.rec.avx.screenshots) : [])];
  const outside = rels.filter(rel => {
    const p = resolve(plans, rel), real = existsSync(p) ? realpathSync(p) : p;
    return !real.startsWith(plans + sep);
  });
  check('evidence-paths', outside.length === 0, `${outside.length} evidence path(s) leave the row's plans folder`);
}
function rawChecks(r: Loaded, row: ResultRow, check: AddCheck) {
  const transcript = transcriptSchema.parse(json(resolve(dirname(r.record), r.rec.replacementTranscript)));
  const work = r.journalData.slices[r.rec.slice].attempts.filter(a => a.kind === 'work');
  const assistant = transcript.items.filter(it => /^assistant/i.test(it.type));
  check('transcript-integrity', assistant.length > 0 && assistant.every(it => !!normalizeText(it.text)) &&
    Date.parse(transcript.startedAt) >= Date.parse(work.at(-1)?.at ?? '') && Date.parse(transcript.completedAt) >= Date.parse(transcript.startedAt),
    'completed assistant export must start in its final attempt');
  check('worker-evidence-count', r.rec.workers.length === work.length && JSON.stringify(row.workers) === JSON.stringify(r.rec.workers), 'each work attempt needs its retained stdout');
  for (const [i, w] of r.rec.workers.entries()) {
    const p = resolve(dirname(r.record), w.stdout), parsed = transcriptItems(readFileSync(p, 'utf8'));
    check(`worker-${i + 1}-stdout`, hash(p) === w.sha256 && w.attempt === work[i]?.n && w.provider === work[i]?.provider && w.model === work[i]?.model,
      'worker hash and identity must match the journal attempt');
    // Real Claude stream-json always names its model in init; a claude command identity with none is not proof.
    check(`worker-${i + 1}-reported-model`, parsed.models.every(m => modelMatches(w.model, m)) && (w.provider !== 'claude' || w.identity !== 'command' || parsed.models.length > 0) &&
      (w.identity !== 't3-status' || parsed.models.length > 0),
      'CLI-reported models must match the configured identity, and claude must report one');
    // A T3 worker is proven by its own complete thread export: same thread as its attempt, same provider.
    if (w.identity === 't3-status' || row.path === 't3') check(`worker-${i + 1}-t3-export`, w.identity === 't3-status' && parsed.format === 't3' && parsed.complete &&
      !!work[i]?.threadId && parsed.t3?.threadId === work[i]?.threadId && (parsed.t3?.provider ?? w.provider) === w.provider,
      'a T3 worker needs a complete t3_thread_read export of its attempt thread');
    if (w.identity === 't3-status' && i < r.rec.workers.length - 1) check(`worker-${i + 1}-t3-interrupted`, parsed.t3?.status === 'interrupted' && parsed.t3?.run?.status === 'interrupted',
      'a stopped T3 worker export must show its thread and latest run interrupted');
  }
  const raw = resolve(dirname(r.record), r.rec.replacementStdout), parsed = transcriptItems(readFileSync(raw, 'utf8'));
  const last = r.rec.workers.at(-1);
  check('replacement-raw-anchor', row.replacementStdout === r.rec.replacementStdout && row.replacementStdoutSha256 === r.rec.replacementStdoutSha256 &&
    hash(raw) === r.rec.replacementStdoutSha256 && last?.stdout === r.rec.replacementStdout && last.sha256 === r.rec.replacementStdoutSha256,
    'replacement raw stdout hash must match record, worker and retained row');
  check('raw-transcript-items', JSON.stringify(parsed.items) === JSON.stringify(transcript.items), 'exported assistant items must equal reparsed raw stdout');
  check('raw-tokens', parsed.tokens === row.tokens && parsed.tokens === (r.rec.labels.tokens ?? 'unknown'), 'tokens must equal reparsed raw CLI telemetry');
  check('export-identity', transcript.provider === work.at(-1)?.provider && transcript.model === work.at(-1)?.model, 'export identity must match the last journal attempt');
  const expectedModels = work.map((w, i) => ({ provider: w.provider ?? 'unknown', model: w.model ?? 'unknown', identity: r.rec.workers[i]?.identity ?? 'asserted' }));
  check('row-models', JSON.stringify(row.models) === JSON.stringify(expectedModels), 'row identities must match retained worker and journal identities');
  return transcript;
}
// Grade each stopped group against its own successor, not only the final replacement.
// variant: 'cli' needs a process group bound to cli:<pid>@ thread; 't3' needs cwd samples; 'any' accepts either, unbound.
function disarmChecks(r: Loaded, file: string, i: number, check: AddCheck, variant: 'cli' | 't3' | 'any') {
  const path = resolve(dirname(r.record), file), prefix = `disarm-${i + 1}`;
  if (!existsSync(path)) { check(prefix, false, 'required disarm file missing'); return undefined; }
  const parsed = disarmSchema.safeParse(json(path));
  if (!parsed.success) { check(prefix, false, 'invalid disarm evidence shape'); return undefined; }
  const d = parsed.data, work = r.journalData.slices[r.rec.slice].attempts.filter(a => a.kind === 'work');
  const stop = Date.parse(d.observedAt), start = Math.min(Date.parse(d.replacementLaunchedAt), Date.parse(work[i + 1]?.at ?? ''));
  const timed = d.processSamples.some(s => Date.parse(s.at) < start) && d.processSamples.some(s => Date.parse(s.at) >= Date.parse(d.replacementLaunchedAt)) && stop <= start;
  if ('variant' in d) {
    // T3: no process may keep its cwd inside the sandbox, from the stop to after the successor launch.
    const samples = d.processSamples, thread = work[i]?.threadId ?? '';
    check(`${prefix}-group`, variant !== 'cli' && samples.length >= 3 && samples.every(s => s.dir === samples[0].dir && s.pids.length === 0 && !s.alive && Date.parse(s.at) >= stop) &&
      !!thread && !/^cli:/.test(thread) && timed, 'no process with its cwd in the sandbox before and after the successor launch');
  } else {
    const samples = d.processSamples, pid = samples[0]?.pid;
    const boundPid = /^cli:(\d+)@/.exec(work[i]?.threadId ?? '');
    check(`${prefix}-group`, variant !== 't3' && samples.length >= 3 && samples.every(s => s.pid === pid && s.pgid === pid && !s.alive && !s.groupAlive && Date.parse(s.at) >= stop) &&
      (boundPid ? Number(boundPid[1]) === pid : variant !== 'cli') && timed,
      'one bound process group must be gone before and after its successor launch');
  }
  const cp = r.journalData.slices[r.rec.slice].checkpoints?.[i];
  const snapshots = d.filesAfterStop.filter(s => Date.parse(s.at) >= stop && Date.parse(s.at) <= start);
  const signature = (s: z.infer<typeof disarmSchema>['filesAfterStop'][number]) => JSON.stringify([...s.files].sort().map(f => [f, s.sha256[f]]));
  check(`${prefix}-files`, snapshots.length >= 2 && snapshots.every(s => s.files.length > 0 &&
    Object.keys(s.sha256).length === s.files.length && (cp?.delta ?? []).every(f => s.files.includes(f)) && s.files.every(f => /^[a-f0-9]{64}$/.test(s.sha256[f] ?? '') && s.sha256[f] === d.stoppedMilestones.sha256[f]) &&
    // Only files finished by this stop: a later worker may finish more files (scenario 5's B writes m3).
    Object.entries(r.rec.finishedFiles).filter(([f]) => Object.hasOwn(d.stoppedMilestones.sha256, f)).every(([f, sha]) => s.files.includes(f) && s.sha256[f] === sha)) && new Set(snapshots.map(signature)).size === 1,
    'two stable owned-file snapshots must carry exact SHA256 values');
  check(`${prefix}-observation-time`, Date.parse(d.milestoneObservation.at) <= Date.parse(d.stoppedMilestones.at) && Date.parse(d.stoppedMilestones.at) <= stop,
    'milestone observations must bracket the kill before the stop observation');
  return d;
}
// Scenario 10: the old lead claimed, a successor took over, the old id was refused with the journal unchanged, and
// every lead write of the run after that (A's interruption, the checkpoint, the handoff, B's attempt) came later,
// while the successor held the lease. The engine refuses any write by a non-holder, so time order proves the writer.
const takeoverFileSchema = z.object({ at: z.string().datetime(), from: z.string(), to: z.string(), refused: z.boolean(), journalUnchanged: z.boolean() }).strict();
function takeoverChecks(r: Loaded, work: Loaded['journalData']['slices'][string]['attempts']) {
  const lead = r.journalData.lead, history = lead?.history ?? [], slice = r.journalData.slices[r.rec.slice];
  const ti = history.findIndex(h => h.event === 'takeover'), take = history[ti];
  const claim = history.slice(0, Math.max(ti, 0)).findLast(h => h.event === 'claim');
  const p = resolve(dirname(r.record), 'lead-takeover.json');
  const f = existsSync(p) ? takeoverFileSchema.safeParse(json(p)) : undefined;
  if (!take || !claim || !f?.success) return false;
  const t = Date.parse(take.at), after = (at?: string) => !!at && Date.parse(at) >= t;
  const later = history.slice(ti + 1);
  const cp = slice.checkpoints?.[0], stop = z.object({ at: z.string() }).safeParse(work[0]?.interruptions?.[0]);
  return take.id !== claim.id && lead?.id === take.id && later.every(h => h.id === take.id && h.event !== 'takeover' && h.event !== 'claim') &&
    f.data.from === claim.id && f.data.to === take.id && f.data.refused && f.data.journalUnchanged && after(f.data.at) &&
    Date.parse(work[0]?.at ?? '') < t && after(stop.data?.at) &&
    after(cp?.at) && after(work[1]?.at);
}
const REQUIRED = ['cli:2', 'cli:3', 'cli:5', 'cli:6', 't3:5', 't3:10'];
export function appendRow(results: string, scenario: string, path: ResultRow['path'], dir: string, status?: ResultRow['status'], reason = '') {
  let row: ResultRow;
  if (status === 'blocked') {
    if (!reason.trim()) throw new UsageError('blocked rows require a reason');
    row = { scenario, path, dir: resolve(dir), gradedAt: now(), checks: [], tokens: 'unknown', models: [], labels: { measured: [], estimate: [] }, status, reason };
  } else {
    const r = load(dir), g = gradeForPath(r.journal, r.record, path), work = r.journalData.slices[r.rec.slice].attempts.filter(a => a.kind === 'work');
    row = { scenario, path, dir: resolve(dir), gradedAt: now(), gradePass: g.pass, checks: g.checks, tokens: r.rec.labels.tokens ?? 'unknown', tokensReported: r.rec.tokensReported === true, models: work.map((a, i) => ({ provider: a.provider ?? 'unknown', model: a.model ?? 'unknown', identity: r.rec.workers[i]?.identity ?? 'asserted' })), labels: r.rec.labels, workers: r.rec.workers, replacementStdout: r.rec.replacementStdout, replacementStdoutSha256: r.rec.replacementStdoutSha256, ...(r.rec.probe ? { reaskCount: r.rec.probe.reaskCount } : {}), status: 'pass', reason };
    // A row is appended as pass only when the same row checks --grade-only runs also pass.
    const rowPass = g.pass && gradeRows([row], dirname(resolve(results))).rows[0].pass;
    row = { ...row, status: status ?? (rowPass ? 'pass' : 'fail') };
  }
  appendFileSync(results, JSON.stringify(row) + '\n'); return row;
}
export function gradeOnly(file: string, requireAvx = false) {
  const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map((l, n) => {
    const parsed = rowSchema.safeParse(JSON.parse(l));
    if (!parsed.success) throw new RunError(`results line ${n + 1} does not match the strict row schema`);
    return parsed.data;
  });
  return gradeRows(rows, dirname(resolve(file)), requireAvx);
}
// base: the folder that relative row dirs resolve against (the results file's folder).
function gradeRows(rows: ResultRow[], base: string, requireAvx = false) {
  const checks: Check[] = [], notes: string[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail: cap(detail) });
  const summaries: { scenario: string | number; path: string; pass: boolean; checks: Check[] }[] = [];
  const evidenceDirs: string[] = [];
  const good = new Set<string>(), probes: { provider: string; dir: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const local: Check[] = [], check = (name: string, pass: boolean, detail: string) => local.push({ name, pass, detail: cap(detail) });
    const numeric = typeof row.tokens === 'number';
    check('row-token-provenance', !numeric || row.tokensReported === true, 'numeric row tokens require record provenance');
    if (row.status === 'blocked') {
      const allowed = row.path === 'avx' && !!row.reason.trim() && !requireAvx;
      check('blocked-gate', allowed, 'only optional AVX may be blocked with a reason');
      if (row.path === 'avx') notes.push(`avx: BLOCKED (gate): ${cap(row.reason)}`);
      check('blocked-tokens', row.tokens === 'unknown', 'blocked tokens must be unknown');
    } else {
      const dir = realpathSync(resolve(base, row.dir)), r = load(dir), g = gradeForPath(r.journal, r.record, row.path);
      // Required, probe and combined rows each need their own physical folder.
      if (row.path !== 'avx') evidenceDirs.push(dir);
      local.push(...g.checks);
      evidencePathChecks(r, check);
      check('sandbox-outside-worktree', !insideGitWorktree(dir), 'the sandbox must be outside every git worktree (slice 14 review H1)');
      check('row-status', row.status === 'pass', 'retained row must have pass status');
      const token = r.rec.labels.tokens ?? 'unknown';
      check('record-token-provenance', row.tokens === token && (typeof token !== 'number' || r.rec.tokensReported === true), 'row tokens must equal reported record tokens, otherwise unknown');
      const slice = r.journalData.slices[r.rec.slice], work = slice.attempts.filter(a => a.kind === 'work');
      const transcript = rawChecks(r, row, check);
      const scenario = String(row.scenario);
      if (row.path === 't3') check('t3-scenario', ['5', '10'].includes(scenario), 'T3 rows are scenario 5 or 10');
      if (row.path === 't3' && scenario === '10') {
        check('scenario-10-attempts', work.length === 2 && work[0].outcome === 'handed-off' && work[0].interruptions?.length === 1 && work[1].outcome === 'finished',
          'scenario 10 requires an interrupted A and a finished B');
        check('scenario-10-takeover', takeoverChecks(r, work), 'a successor takes the lease after a claim; the old lead is refused and every later lead write is the successor');
      }
      if (row.path === 'cli' || row.path === 't3' && ['5', '10'].includes(scenario)) {
        if (scenario === '2') check('scenario-2-attempts', work.length === 2, 'scenario 2 requires exactly two work attempts');
        if (scenario === '3') {
          const cp = slice.checkpoints?.[0];
          check('scenario-3-partial', !!cp?.delta?.includes(files[2]) && typeof cp.check?.exitCode === 'number' && cp.check.exitCode !== 0,
            'first checkpoint must contain partial m3 and a failed engine check');
        }
        if (scenario === '5') {
          check('scenario-5-attempts', work.length === 3 && work.reduce((n, a) => n + (a.interruptions?.length ?? 0), 0) === 2 && work.slice(0, 2).every(a => a.interruptions?.length === 1),
            'scenario 5 requires three attempts and both interruptions');
        }
        if (scenario === '6') {
          check('scenario-6-provider', work.length === 2 && !!work[0].provider && !!work[1].provider && work[0].provider.toLowerCase() !== work[1].provider.toLowerCase() && slice.handoffs?.[0]?.mode === 'cli',
            'scenario 6 requires different providers and CLI handoff');
          const refusal = resolve(dirname(r.record), 'unauthorized-target.json');
          const u = existsSync(refusal) ? z.object({ at: z.string().datetime(), target: z.string(), refused: z.boolean(), journalUnchanged: z.boolean() }).safeParse(json(refusal)) : undefined;
          check('scenario-6-unauthorized-refused', !!u?.success && u.data.refused && u.data.journalUnchanged && !work.some(w => w.model && u.data.target.includes(`(${w.model}/`)),
            'scenario 6 requires a refused unauthorized target that changed nothing');
        }
        const stops = scenario === '5' ? 2 : 1, stopped: z.infer<typeof disarmSchema>[] = [];
        for (let i = 0; i < stops; i++) {
          const d = disarmChecks(r, `disarm-evidence-${i + 1}.json`, i, check, row.path === 'cli' ? 'cli' : 't3');
          if (d) stopped.push(d);
          // Files finished by an earlier stop must reach every later stop with the same hash.
          if (i > 0) check(`disarm-${i + 1}-keeps-earlier`, !!d && stopped.length === i + 1 && Object.entries(r.rec.finishedFiles)
            .filter(([f]) => Object.hasOwn(stopped[i - 1].stoppedMilestones.sha256, f)).every(([f, sha]) => d.stoppedMilestones.sha256[f] === sha),
            'finished files of an earlier stop must be unchanged at the later stop');
          if (i === 0 && d) {
            const want = scenario === '3' ? 'partial' : 'absent';
            check('A-milestone-boundary', [d.milestoneObservation, d.stoppedMilestones].every(o => o.m2Exact && o.m3 === want &&
              o.sha256[files[1]] === createHash('sha256').update('milestone 2\n').digest('hex') && (want !== 'absent' || !Object.hasOwn(o.sha256, files[2]))),
              'A must stop with exact m2 and absent m3, or scripted partial m3 in scenario 3');
          }
        }
      }
      if (row.path === 'combined') {
        const d = disarmChecks(r, 'disarm-evidence-1.json', 0, check, 'any');
        check('combined-stop-observed', !!d && [d.milestoneObservation, d.stoppedMilestones].every(o => o.m2Exact && o.m3 === 'absent' && !Object.hasOwn(o.sha256, files[2]) && o.sha256[files[1]] === createHash('sha256').update('milestone 2\n').digest('hex')), 'combined stop must show exact m2 and absent m3 before and after the kill');
        check('combined-two-attempts', work.length === 2 && work[0]?.outcome === 'handed-off' && !!work[0]?.interruptions?.length && work[1]?.outcome === 'finished' && slice.state === 'VERIFIED', 'two work attempts, interrupted A and verified B');
        const cp = slice.checkpoints?.[0];
        const snapshotFiles = cp?.snapshot ? run('git', ['ls-tree', '-r', '--name-only', cp.snapshot], dir).trim().split('\n') : [];
        check('combined-checkpoint', files.slice(0, 2).every(f => cp?.delta?.includes(f) || snapshotFiles.includes(f)), 'first checkpoint holds milestones 1 and 2');
        check('combined-preserved-files', !Object.hasOwn(r.rec.finishedFiles, files[2]) && !cp?.delta?.includes(files[2]) && !snapshotFiles.includes(files[2]) && files.slice(0, 2).every(f => !!r.rec.finishedFiles[f]), 'both completed milestone hashes recorded');
        const packet = readFileSync(resolve(dirname(r.record), r.rec.replacementPacket), 'utf8'), settled = parseSettled(packet);
        check('combined-D1', settled.count === 1 && settled.form === 'full' && settled.entries.some(e => e.id === 'd1' && e.key === 'milestone-format'), 'canonical settled line must name D1');
        const waiting = normalizeText(packet).split('\n').filter(l => /^Waiting on the user/i.test(l));
        const match = waiting.length === 1 ? /^Waiting on the user \(RED\): ([^.]+)\. Do not do it; finish other work\.$/i.exec(waiting[0]) : null;
        const entries = match ? match[1].split(', ') : [];
        const decisions = r.journalData.decisions;
        check('combined-D2', entries.length > 0 && entries.every(e => { const m = /^([a-z0-9][a-z0-9._/-]*) \((D\d+)\)$/.exec(e); return !!m && decisions.some(d => d.id === m[2] && d.key === m[1] && d.risk === 'red' && !['approved', 'assumed'].includes(d.status)); }) && entries.includes('deploy-target (D2)'), 'one canonical waiting RED line must name journal D2');
        // grade() rejects every asking sentence, including D2 and adjacent split items, using its canonical forms.
        check('combined-no-D1-D2-question', g.checks.some(c => c.name === 'no-question-about-settled-key' && c.pass), 'grader question forms applied to all assistant items');
      }
      if (row.path === 'probe') {
        check('probe-label-count', !!r.rec.probe, 'record requires probe label, provider and integer reaskCount');
        if (r.rec.probe) {
          check('probe-count-observed', row.reaskCount === r.rec.probe.reaskCount && row.reaskCount === reaskCount(transcript.items), 'probe count must equal the asking sentences found in retained stdout');
          // The label is only a claim; the last worker's command identity must prove it.
          const last = r.rec.workers.at(-1), lastWork = work.at(-1);
          const want = r.rec.probe.provider === 'Claude' ? { provider: 'claude', model: 'sonnet' } : { provider: 'codex', model: 'gpt-6.1-terra' };
          // Codex stdout names no model, so the kept command line is the identity proof; effort must be low in both.
          const proven = !!last && last.provider === want.provider && last.identity === 'command' && last.model === want.model &&
            lastWork?.provider === last.provider && lastWork?.model === last.model && !!last.command &&
            (() => { try { return commandIdentity(last.command).model === last.model && commandEffort(last.command) === 'low'; } catch { return false; } })() && last.effort === 'low' && lastWork?.effort === 'low';
          check('probe-identity', proven, 'last worker command must prove claude sonnet or codex gpt-6.1-terra at low effort');
          probes.push({ provider: proven ? r.rec.probe.provider : 'unproven', dir });
        }
      }
      if (row.path === 'avx') {
        const a = r.rec.avx;
        const screenshots = a ? Object.values(a.screenshots).map(p => resolve(dirname(r.record), p)) : [];
        check('avx-fields', !!a && a.taskKeys.length === 1 && !!a.taskKeys[0] && a.state === 'VERIFIED' && slice.state === 'VERIFIED' && work.length === 2 && work.every(w => !!w.provider && !!w.model) && !!a.checkpointHead && slice.checkpoints?.some(c => c.gitHead === a.checkpointHead) === true && ['D1', 'D2'].every(id => a.decisions.includes(id) && r.journalData.decisions.some(d => d.id === id)) && new Set(screenshots).size === 2 && screenshots.every(p => existsSync(p) && statSync(p).isFile()), 'one task, two identified attempts, checkpoint, D1/D2, VERIFIED and two screenshot files');
      }
    }
    const pass = local.every(c => c.pass);
    if (pass && row.status !== 'blocked') good.add(`${row.path}:${row.scenario}`);
    local.forEach(c => add(`row-${index}:${c.name}`, c.pass, c.detail));
    summaries.push({ scenario: row.scenario, path: row.path, pass, checks: local });
  }
  add('separate-evidence-dirs', new Set(evidenceDirs).size === evidenceDirs.length, 'each CLI, T3, combined and probe row needs a separate physical folder');
  for (const key of REQUIRED) add(`required-${key}`, good.has(key) && rows.filter(r => `${r.path}:${r.scenario}` === key).length === 1, 'required scenario must re-grade to pass');
  add('combined', summaries.some(r => r.path === 'combined' && r.pass) && rows.some(r => r.path === 'combined' && r.status !== 'blocked'), 'combined evidence required');
  add('six-probes', probes.length === 6 && new Set(probes.map(p => p.dir)).size === 6 && ['Claude', 'Codex'].every(p => probes.filter(x => x.provider === p).length === 3), 'six distinct probe runs, three per provider');
  const avx = rows.some(r => r.path === 'avx'); if (!avx) notes.push('avx: MISSING');
  add('avx-present', avx, 'AVX row required, optionally blocked with a gate reason');
  return { pass: checks.every(c => c.pass), checks, rows: summaries, notes };
}
function usageEnum<T>(schema: z.ZodType<T>, value: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError('invalid option value');
  return parsed.data;
}
function parseArgs(args: string[]) {
  const flags = new Map<string, string>();
  const command = args[0]?.startsWith('--') ? '' : args.shift() ?? '';
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!['--dir', '--engine', '--scenario', '--a', '--b', '--c', '--results', '--path', '--status', '--reason', '--grade-only', '--require-avx',
      '--worker', '--thread-id', '--timeout', '--task-status', '--export', '--to', '--successor-id', '--observed', '--provider', '--model', '--effort'].includes(k) || flags.has(k)) throw new UsageError('unknown or duplicate option');
    if (k === '--require-avx') flags.set(k, 'true');
    else { const v = args[++i]; if (!v || v.startsWith('--')) throw new UsageError('option needs a value'); flags.set(k, v); }
  }
  return { command, flags, need: (k: string) => { const v = flags.get(k); if (!v) throw new UsageError(`missing ${k}`); return v; } };
}
export async function main(args: string[]) {
  try {
    const { command, flags, need } = parseArgs([...args]);
    let result: unknown;
    if (flags.has('--grade-only')) { if (command) throw new UsageError('grade-only takes no command'); result = gradeOnly(need('--grade-only'), flags.has('--require-avx')); }
    else if (command === 'scaffold') result = scaffold(need('--dir'), need('--engine'));
    else if (command === 'cli-run') result = await cliRun(need('--dir'), need('--engine'), need('--scenario'), [need('--a'), need('--b'), ...(flags.has('--c') ? [need('--c')] : [])]);
    else if (command === 'grade') { const p = paths(need('--dir')); result = grade(p.journal, p.record); }
    else if (command === 'append-row') result = appendRow(need('--results'), need('--scenario'), usageEnum(rowSchema.shape.path, need('--path')), need('--dir'), flags.has('--status') ? usageEnum(rowSchema.shape.status, need('--status')) : undefined, flags.get('--reason'));
    else if (command === 't3-begin') result = t3Begin(need('--dir'), need('--engine'), need('--scenario'), need('--worker'));
    else if (command === 't3-attach') result = t3Attach(need('--dir'), need('--engine'), need('--thread-id'));
    else if (command === 't3-wait') result = await t3Wait(need('--dir'), Number(need('--timeout')));
    else if (command === 't3-stop') result = await t3Stop(need('--dir'), need('--engine'), need('--task-status'), need('--export'), need('--to'));
    else if (command === 't3-takeover') result = t3Takeover(need('--dir'), need('--engine'), need('--successor-id'), need('--observed'), need('--reason'));
    else if (command === 't3-finish') result = t3Finish(need('--dir'), need('--engine'), need('--export'), need('--provider'), need('--model'), need('--effort'));
    else throw new UsageError('expected scaffold, cli-run, t3-begin, t3-attach, t3-wait, t3-stop, t3-takeover, t3-finish, grade, append-row or --grade-only');
    const outcome = z.object({ pass: z.boolean() }).safeParse(result);
    process.exitCode = outcome.success && !outcome.data.pass ? 1 : 0;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    // No child output, record value or exception message can leak transcript text.
    process.exitCode = e instanceof UsageError ? 2 : 1;
    process.stdout.write(JSON.stringify({ pass: false, checks: [{ name: e instanceof UsageError ? 'usage' : 'tool-error', pass: false, detail: cap(e instanceof UsageError || e instanceof RunError ? e.message : 'unexpected exception; retained inputs could not be processed') }] }) + '\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
