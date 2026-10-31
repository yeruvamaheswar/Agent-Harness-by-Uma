import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Command and path guard (REQ-9). No input names a profile, so every profile gets the same decision (REQ-13).
// It is a text classifier: a guard, not a sealed room. It reads one command string; it runs, expands, and
// resolves nothing. It cannot catch: obfuscation (base64, string building, globs such as `cat .e*`),
// variables and aliases (`$X`, `alias`, shell functions, `git -c alias.*`), indirect reads (`grep -r KEY .`),
// and scripts or programs that do bad things internally (`bash x.sh`, `node -e`, `npm run x`, Makefiles).
// Unknown forms default to allow. The platform controls (controls/controls.json) stay the enforced layer.

export type Decision = 'allow' | 'ask' | 'deny';
export type Level = 'A' | 'B' | 'C';
export type Verdict = { decision: Decision; level: Level; rule: string; reason: string; segment?: string };
export type ControlRule = { id: string; effect: 'deny' | 'ask'; pattern: string; prefix: string; mode: 'word' | 'raw' | 'exact' };
export type ClassifyOptions = { allow?: string[]; controls?: ControlRule[] };

type Hit = Verdict;
const deny = (rule: string, reason: string): Hit => ({ decision: 'deny', level: 'C', rule, reason });
const askC = (rule: string, reason: string): Hit => ({ decision: 'ask', level: 'C', rule, reason });
const askB = (rule: string, reason: string): Hit => ({ decision: 'ask', level: 'B', rule, reason });
const rank = (v: Verdict) => ({ allow: 0, ask: 1, deny: 2 })[v.decision] * 3 + ({ A: 0, B: 1, C: 2 })[v.level];

// ---- shell text to segments ----
type Seg = { words: string[]; outs: string[]; ins: string[]; text: string; pipeIn: boolean };

function closeParen(s: string, from: number) {
  let depth = 1;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) return -1; j = e; }
    else if (c === '"') { j++; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; if (j >= s.length) return -1; }
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

// Splits on && || ; | & ( ) and new lines, outside quotes. Collects $( ), <( ), >( ), and backtick bodies as subs.
function split(cmd: string) {
  const segs: Seg[] = [], subs: string[] = [];
  let words: string[] = [], outs: string[] = [], ins: string[] = [], word = '', has = false, redir = '', pipeIn = false, start = 0, unbalanced = false;
  const endWord = () => { if (!has) return; (redir === '>' ? outs : redir === '<' ? ins : words).push(word); redir = ''; word = ''; has = false; };
  const endSeg = (end: number, next: number, pipe: boolean) => {
    endWord(); redir = '';
    if (words.length || outs.length || ins.length) segs.push({ words, outs, ins, text: cmd.slice(start, end).trim(), pipeIn });
    words = []; outs = []; ins = []; pipeIn = pipe; start = next;
  };
  const sub = (from: number) => { const e = closeParen(cmd, from); if (e < 0) { unbalanced = true; subs.push(cmd.slice(from)); return cmd.length; } subs.push(cmd.slice(from, e)); return e; };
  const tick = (from: number) => { const e = cmd.indexOf('`', from); if (e < 0) { unbalanced = true; subs.push(cmd.slice(from)); return cmd.length; } subs.push(cmd.slice(from, e)); return e; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (c === '\\') { if (n !== '\n') { word += n ?? ''; has = true; } i++; continue; }
    if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      if (e < 0) { unbalanced = true; word += cmd.slice(i + 1); i = cmd.length; } else { word += cmd.slice(i + 1, e); i = e; }
      has = true; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { word += cmd[++j]; continue; }
        if (cmd[j] === '$' && cmd[j + 1] === '(') { const e = sub(j + 2); word += cmd.slice(j, e + 1); j = e; continue; }
        if (cmd[j] === '`') { const e = tick(j + 1); word += cmd.slice(j, e + 1); j = e; continue; }
        word += cmd[j];
      }
      if (j >= cmd.length) unbalanced = true;
      i = j; has = true; continue;
    }
    if ((c === '$' || c === '<' || c === '>') && n === '(') { const e = sub(i + 2); word += cmd.slice(i, e + 1); i = e; has = true; continue; }
    if (c === '`') { const e = tick(i + 1); word += cmd.slice(i, e + 1); i = e; has = true; continue; }
    if (c === '#' && !has) { const e = cmd.indexOf('\n', i); i = (e < 0 ? cmd.length : e) - 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { endSeg(i, i + 1, false); continue; }
    if (c === '&') {
      if (n === '>') { endWord(); redir = '>'; i += cmd[i + 2] === '>' ? 2 : 1; continue; }
      endSeg(i, i + (n === '&' ? 2 : 1), false); if (n === '&') i++; continue;
    }
    if (c === '|') { const two = n === '|' || n === '&'; endSeg(i, i + (two ? 2 : 1), n !== '|'); if (two) i++; continue; }
    if (c === '<' || c === '>') {
      if (has && /^\d+$/.test(word)) { word = ''; has = false; } else endWord();
      if (c === '<' && n === '<') { i += cmd[i + 2] === '<' || cmd[i + 2] === '-' ? 2 : 1; continue; } // heredoc or here-string
      if (c === '>' && (n === '>' || n === '|')) i++;
      if (cmd[i + 1] === '&') { i++; while (/[\d-]/.test(cmd[i + 1] ?? '')) i++; continue; } // fd copy such as 2>&1
      redir = c; continue;
    }
    word += c; has = true;
  }
  endSeg(cmd.length, cmd.length, false);
  return { segs, subs, unbalanced };
}

// ---- word helpers ----
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const RUNNERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'source', '.', 'eval']);
const DOWNLOAD = /\b(curl|wget|aria2c)\b/;
const short = (a: string[], ch: string) => a.some(x => /^-[A-Za-z]+$/.test(x) && x.includes(ch));
const has = (a: string[], ...xs: string[]) => a.some(x => xs.includes(x) || xs.some(y => y.startsWith('--') && x.startsWith(y + '=')));
const positional = (a: string[]) => a.filter(x => !x.startsWith('-'));

// Strips VAR=x prefixes, shell keywords, and wrappers (sudo, env, exec, nohup, nice, timeout, xargs).
function unwrap(words: string[]) {
  const w = words.slice();
  let sudo = false, xargs = false;
  for (let n = 0; w.length && n < 20; n++) {
    const h = w[0], name = basename(h);
    if (KEYWORDS.has(h) || ASSIGN.test(h)) { w.shift(); continue; }
    if (name === 'sudo' || name === 'doas') { sudo = true; w.shift(); while (w[0]?.startsWith('-')) if (/^-[ugCDhpRrTt]$/.test(w.shift()!)) w.shift(); continue; }
    if (['command', 'builtin', 'exec', 'nohup', 'caffeinate'].includes(name)) { w.shift(); while (w[0]?.startsWith('-')) w.shift(); continue; }
    if (name === 'env') { w.shift(); while (w.length && (w[0].startsWith('-') || ASSIGN.test(w[0]))) if (/^-[uCP]$/.test(w.shift()!)) w.shift(); continue; }
    if (name === 'nice' || name === 'timeout' || name === 'stdbuf') {
      w.shift(); while (w[0]?.startsWith('-')) if (/^-[nsk]$/.test(w.shift()!)) w.shift();
      if (name === 'timeout' && /^\d/.test(w[0] ?? '')) w.shift();
      continue;
    }
    if (name === 'xargs') { xargs = true; w.shift(); while (w[0]?.startsWith('-')) if (/^-[IdEnLPs]$/.test(w.shift()!)) w.shift(); continue; }
    break;
  }
  return { w, sudo, xargs };
}

// ---- token rules ----
function secretRef(t: string): string | null {
  for (const m of t.matchAll(/(?:^|[^\w.$-])(\.env[\w.-]*)/g)) if (m[1].toLowerCase() !== '.env.example') return m[1];
  if (/(?:^|[^\w.-])\.ssh(?:\/|$|[^\w.-])/.test(t)) return '~/.ssh';
  const k = /[\w-]\.(pem|key)(?![\w.-])/i.exec(t); if (k) return `*.${k[1]}`;
  if (/(?:^|[^\w])id_(rsa|dsa|ecdsa|ed25519)(?![\w.]*\.pub)/.test(t)) return 'ssh private key';
  return null;
}
function protectedTarget(t: string): string | null {
  const x = t.replace(/^[\w-]*=/, '').toLowerCase(), root = process.env.HARNESS_ROOT;
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(x) || /(^|\/)\.claude\/?$/.test(x)) return '.claude/settings*.json';
  if (/(^|\/)\.state(\/|$)/.test(x)) return '.state/';
  if (/^(\.{1,2}\/)*controls(\/|$)/.test(x) || /\/controls\/controls\.json$/.test(x)) return 'controls/';
  if (root && isAbsolute(x) && (x + '/').startsWith(join(root, 'controls').toLowerCase() + '/')) return 'controls/';
  return null;
}
// A word that names a path under .github/workflows/: plain, after `/`, after `=` (--out=PATH), or after a short option (-tPATH).
const ciPath = (t: string) => /(?:^|[/=]|^-[A-Za-z])\.github\/workflows(?:\/|$)/i.test(t.replace(/\\/g, '/'));
// Commands that only read. Naming a workflow file in them is Level A. Every other command that names one is Level B `ci`.
// A Git read with an output option (gitOutputs) is a write.
const READ_ONLY = new Set(['cat', 'less', 'head', 'tail', 'grep', 'rg', 'ls', 'wc', 'diff', 'stat', 'file']);
const GIT_READ_ONLY = new Set(['diff', 'log', 'show', 'status']);
const riskyRmTarget = (t: string) => /^[/~$]/.test(t) || /(^|\/)\.\.(\/|$)/.test(t) || /^(\.\/?|\.\/\*|\*|\.\*|\{\})$/.test(t) || /(^|\/)\.git(\/|$)/.test(t);

const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'ln', 'touch', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'install', 'rsync', 'unlink', 'mkdir', 'dd']);
const DEPS: Record<string, string[]> = {
  npm: ['install', 'i', 'in', 'ins', 'inst', 'add', 'ci', 'update', 'up', 'upgrade', 'uninstall', 'un', 'remove', 'rm', 'r', 'link', 'ln', 'dedupe'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'import'],
  yarn: ['install', 'add', 'upgrade', 'up', 'remove', 'link'], bun: ['install', 'i', 'add', 'a', 'update', 'remove', 'rm', 'link'],
  pip: ['install', 'uninstall', 'download'], pip3: ['install', 'uninstall', 'download'], pipx: ['install', 'inject', 'upgrade'],
  uv: ['add', 'remove', 'sync', 'pip'], poetry: ['add', 'install', 'remove', 'update'], cargo: ['add', 'install', 'update', 'remove'],
  go: ['get', 'install'], gem: ['install', 'update', 'uninstall'], bundle: ['install', 'add', 'update'],
  brew: ['install', 'upgrade', 'uninstall', 'reinstall', 'tap', 'remove', 'rm'], composer: ['require', 'install', 'update', 'remove'],
  deno: ['add', 'install'], apt: ['install', 'remove', 'purge', 'upgrade'], 'apt-get': ['install', 'remove', 'purge', 'upgrade'],
};
const PUBLISH: Record<string, string[]> = {
  npm: ['publish', 'unpublish', 'deprecate', 'dist-tag'], pnpm: ['publish'], yarn: ['publish'], bun: ['publish'],
  cargo: ['publish', 'yank'], twine: ['upload'], gem: ['push', 'yank'], poetry: ['publish'], flit: ['publish'], hatch: ['publish'], uv: ['publish'],
  docker: ['push'], podman: ['push'], vsce: ['publish'], ovsx: ['publish'], mvn: ['deploy'], gradle: ['publish'],
};
const DEPLOY: Record<string, string[]> = {
  netlify: ['deploy'], fly: ['deploy', 'launch'], flyctl: ['deploy', 'launch'], firebase: ['deploy'], wrangler: ['deploy', 'publish'],
  render: ['deploys'], railway: ['up', 'deploy'], supabase: ['deploy', 'push', 'secrets'],
  kubectl: ['apply', 'create', 'delete', 'replace', 'patch', 'rollout', 'scale', 'set', 'edit'], helm: ['install', 'upgrade', 'uninstall', 'rollback', 'delete'],
  terraform: ['apply', 'destroy', 'import'], tofu: ['apply', 'destroy', 'import'], pulumi: ['up', 'update', 'destroy'],
  cdk: ['deploy', 'destroy'], serverless: ['deploy', 'remove'], sls: ['deploy', 'remove'], gcloud: ['deploy'], aws: ['deploy'], az: ['deploy'], eb: ['deploy'],
};
const VERCEL_SAFE = new Set(['dev', 'build', 'logs', 'inspect', 'ls', 'list', 'whoami', 'help']);
const MIGRATE_TOOLS = new Set(['prisma', 'drizzle-kit', 'knex', 'sequelize', 'rails', 'rake', 'alembic', 'dbmate', 'goose', 'migrate', 'supabase', 'typeorm', 'flyway', 'atlas']);
const DB_DESTROY = new Set(['reset', 'drop', 'db:drop', 'db:reset', 'db:schema:load', 'migrate:fresh', 'migrate:reset']);
const SYSTEM = new Set(['dd', 'shred', 'fdisk', 'diskutil', 'shutdown', 'reboot', 'halt']);
const GH: Record<string, string[]> = {
  pr: ['create', 'merge', 'close', 'reopen', 'edit', 'review', 'ready', 'comment', 'lock', 'unlock'],
  release: ['create', 'delete', 'edit', 'upload', 'delete-asset'], repo: ['create', 'delete', 'edit', 'rename', 'archive', 'fork', 'sync'],
  workflow: ['run', 'enable', 'disable'], run: ['rerun', 'cancel', 'delete'], issue: ['create', 'close', 'reopen', 'edit', 'comment', 'delete', 'transfer'],
  secret: ['set', 'delete'], variable: ['set', 'delete'],
};
const SQL = /\b(drop\s+(table|database|schema|view|index|user|role|owned)\b|truncate\s+(table\s+)?["`\w]|delete\s+from\b|alter\s+table\b[^;]*\bdrop\b|dropdb\b|flushall\b|flushdb\b)/i;

// Index of the Git subcommand, after global options such as -C DIR and -c KEY=VALUE.
function gitSubIndex(a: string[], hit?: (h: Hit) => void) {
  let i = 0;
  while (i < a.length && a[i].startsWith('-')) {
    if (hit && /^core\.hookspath=/i.test(a[i + 1] ?? '') && a[i] === '-c') hit(deny('no-verify', 'disables Git hooks'));
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a[i])) i++;
    i++;
  }
  return i;
}

// Files that a reading Git command writes: --output=F or --output F (diff, log, show, format-patch), and for
// format-patch -o DIR, -oDIR, or --output-directory DIR (Git also takes an unambiguous prefix, such as --output-dir).
// Options stop at --. --output-indicator-* takes a character, not a file.
function gitOutputs(a: string[]): string[] {
  const i = gitSubIndex(a), sub = a[i], r = a.slice(i + 1), out: string[] = [];
  if (!['diff', 'log', 'show', 'format-patch'].includes(sub)) return out;
  for (let j = 0; j < r.length && r[j] !== '--'; j++) {
    const x = r[j], eq = x.indexOf('='), k = eq < 0 ? x : x.slice(0, eq);
    if (k === '--output' || (sub === 'format-patch' && k.length > '--output-'.length && '--output-directory'.startsWith(k))) out.push(eq < 0 ? r[++j] ?? '' : x.slice(eq + 1));
    else if (sub === 'format-patch' && /^-o/.test(x)) out.push(x === '-o' ? r[++j] ?? '' : x.slice(2));
  }
  return out;
}

function gitRules(a: string[], hit: (h: Hit) => void) {
  const i = gitSubIndex(a, hit);
  const sub = a[i], r = a.slice(i + 1), p = positional(r);
  for (const t of gitOutputs(a)) { const x = protectedTarget(t); if (x) hit(deny('protected-write', `git ${sub} writes ${x}`)); }
  switch (sub) {
    case 'push':
      if (short(r, 'f') || has(r, '--force', '--mirror') || p.some(x => x.startsWith('+'))) return hit(deny('force-push', 'force-push rewrites shared history'));
      return hit(askC('git-push', 'push needs your OK'));
    case 'commit':
      if (short(r, 'n')) hit(deny('no-verify', 'commit -n skips Git hooks'));
      return hit(askC('git-commit', 'commit needs your OK'));
    case 'merge': case 'pull': case 'rebase': case 'cherry-pick': case 'revert': case 'am': case 'filter-branch': case 'filter-repo':
      return hit(askC(`git-${sub}`, `git ${sub} changes history and needs your OK`));
    case 'reset': if (has(r, '--hard', '--merge', '--keep')) hit(askC('git-reset-hard', 'reset --hard discards work')); return;
    case 'clean': if (short(r, 'f') || has(r, '--force')) hit(askC('git-clean', 'clean -f deletes untracked files')); return;
    case 'checkout':
      if (has(r, '-b', '-B', '--orphan')) return hit(askB('branches', 'creates a branch'));
      if (p.length || has(r, '-f', '--force')) hit(askC('git-checkout', 'checkout can discard changes or switch the shared checkout'));
      return;
    case 'switch':
      if (has(r, '--discard-changes', '-f', '--force')) return hit(askC('git-switch', 'switch --discard-changes discards work'));
      if (has(r, '-c', '-C', '--create', '--force-create', '--orphan') || p.length) hit(askB('branches', 'creates or switches a branch'));
      return;
    case 'restore': if (!(has(r, '--staged', '-S') && !has(r, '--worktree', '-W'))) hit(askC('git-restore', 'restore discards changes')); return;
    case 'stash': if (!['list', 'show'].includes(p[0])) hit(askC('git-stash', 'stash moves or drops work in the shared checkout')); return;
    case 'branch':
      if (short(r, 'd') || short(r, 'D') || has(r, '--delete')) return hit(askC('git-branch-delete', 'deletes a branch'));
      if (has(r, '-m', '-M', '-c', '-C', '--move', '--copy')) return hit(askB('branches', 'renames or copies a branch'));
      if (has(r, '-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '--contains', '--merged', '--no-merged', '--points-at')) return;
      if (p.length) hit(askB('branches', 'creates a branch'));
      return;
    case 'worktree':
      if (p[0] === 'add') return hit(askB('worktrees', 'adds a worktree'));
      if (['remove', 'prune', 'move'].includes(p[0])) hit(askC('git-worktree', `worktree ${p[0]} can drop work`));
      return;
    case 'tag':
      if (short(r, 'd') || has(r, '--delete') || (p.length && !has(r, '-l', '--list', '-n'))) hit(askC('git-tag', 'tags are release actions'));
      return;
    case 'config': if (p[0]?.toLowerCase() === 'core.hookspath' && p.length > 1) hit(deny('no-verify', 'disables Git hooks')); return;
    case 'rm': case 'mv': for (const t of p) { const x = protectedTarget(t); if (x) hit(deny('protected-write', `writes ${x}`)); } return;
  }
}

type Ctx = { depth: number; hit: (h: Hit) => void; controls: ControlRule[]; xargs?: boolean };

function classifyWords(words: string[], ctx: Ctx, outs: string[] = [], ins: string[] = []) {
  const { hit } = ctx;
  for (const t of [...words, ...outs, ...ins]) {
    const s = secretRef(t);
    if (s) hit(deny('secret-read', `touches a secret file (${s})`));
    if (t === '--no-verify') hit(deny('no-verify', '--no-verify skips hooks'));
  }
  for (const t of outs) {
    const x = protectedTarget(t);
    if (x) hit(deny('protected-write', `writes ${x}`));
    if (ciPath(t)) hit(askB('ci', 'redirects output into .github/workflows/'));
  }
  const u = unwrap(words), w = u.w, xargs = u.xargs || !!ctx.xargs;
  if (u.sudo) hit(askC('sudo', 'sudo runs as another user'));
  if (!w.length) return;
  const h = w[0], name = basename(h), a = w.slice(1), p = positional(a);
  // A reading Git command with an output option writes a file, so it is not read-only.
  const readOnly = READ_ONLY.has(name) || (name === 'git' && GIT_READ_ONLY.has(a[gitSubIndex(a)]) && !gitOutputs(a).length);
  if (!readOnly && w.some(ciPath)) hit(askB('ci', `${name} names a path under .github/workflows/`));
  if (h.startsWith('$') || h.startsWith('`')) {
    return hit(DOWNLOAD.test(h) ? askC('download-to-shell', 'runs downloaded code') : askC('dynamic-command', 'the command name is computed at run time'));
  }
  if (RUNNERS.has(name) && a.some(x => /^(<\(|\$\(|`)/.test(x) && DOWNLOAD.test(x))) hit(askC('download-to-shell', 'runs downloaded code'));
  if (SHELLS.has(name)) {
    const ci = a.findIndex(x => /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
    if (ci >= 0 && a[ci + 1] !== undefined) walk(a[ci + 1], { ...ctx, depth: ctx.depth + 1, xargs: false });
    return;
  }
  if (name === 'eval') return walk(a.join(' '), { ...ctx, depth: ctx.depth + 1, xargs: false });

  // Launchers: npx, bunx, npm|pnpm|yarn|bun exec|dlx|x. Classify the inner command too.
  const launch = name === 'npx' || name === 'bunx' ? 0 : ['npm', 'pnpm', 'yarn', 'bun'].includes(name) && ['exec', 'dlx', 'x'].includes(a[0]) ? 1 : -1;
  if (launch >= 0) {
    const rest = a.slice(launch);
    if (has(rest, '-y', '--yes', '-p', '--package') || a[0] === 'dlx') hit(askB('deps', 'may download and run a package'));
    const inner: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (!inner.length && rest[i].startsWith('-')) { if (rest[i] === '-p' || rest[i] === '--package') i++; continue; }
      inner.push(rest[i]);
    }
    return classifyWords(inner, { ...ctx, xargs });
  }
  if (name === 'git') gitRules(a, hit);
  if (name === 'gh') {
    const subs = GH[p[0]];
    if (subs?.includes(p[1])) hit(askC('pr-or-release', `gh ${p[0]} ${p[1]} acts on GitHub`));
    if (p[0] === 'api' && (a.some(x => /^(-X|--method)$/.test(x)) || has(a, '-f', '-F', '--field', '--raw-field', '--input'))) hit(askC('pr-or-release', 'gh api can change GitHub'));
  }
  if (name === 'rm') {
    const targets = positional(a), recursive = short(a, 'r') || short(a, 'R') || has(a, '--recursive');
    const bad = targets.find(riskyRmTarget);
    if (xargs) hit(askC('rm-outside', 'rm targets come from input and cannot be checked'));
    else if (bad) hit(askC('rm-outside', `rm ${recursive ? '-r ' : ''}of ${bad}`));
  }
  if (name === 'find') {
    if (a.includes('-delete')) hit(askC('rm-outside', 'find -delete removes files it selects at run time'));
    for (let i = 0; i < a.length; i++) if (a[i] === '-exec' || a[i] === '-execdir' || a[i] === '-ok') {
      let e = i + 1; while (e < a.length && a[e] !== ';' && a[e] !== '+') e++;
      classifyWords(a.slice(i + 1, e), { ...ctx, xargs: true });
      i = e;
    }
  }
  if (SYSTEM.has(name) || name.startsWith('mkfs')) hit(askC('system', `${name} can destroy data`));

  // Writes to protected paths.
  const inPlace = (name === 'sed' || name === 'gsed' || name === 'perl') && (short(a, 'i') || a.some(x => x.startsWith('--in-place')));
  if (WRITERS.has(name) || inPlace) {
    const targets = ['cp', 'install', 'rsync', 'ln'].includes(name) ? [p.at(-1) ?? '', a.includes('-t') ? a[a.indexOf('-t') + 1] ?? '' : ''] : name === 'dd' ? a.filter(x => x.startsWith('of=')) : a;
    for (const t of targets) { const x = protectedTarget(t); if (x) hit(deny('protected-write', `writes ${x}`)); }
  }

  // Package tools: deps, publish, deploys, scripts.
  const pm = name === 'python' || name === 'python3' ? (a[0] === '-m' ? a[1] : undefined) : name;
  const pa = name === pm ? p : positional(a.slice(2));
  if (pm && DEPS[pm] && (DEPS[pm].includes(pa[0]) || (pm === 'yarn' && !pa.length))) hit(askB('deps', `${pm} ${pa[0] ?? 'install'} changes dependencies`));
  if (PUBLISH[name] && pa.slice(0, 2).some(x => PUBLISH[name].includes(x))) hit(askC('publish', `${name} publishes a package`));
  if (DEPLOY[name] && p.some(x => DEPLOY[name].includes(x))) hit(askC('deploy', `${name} ${p.join(' ')} reaches a live system`));
  if (name === 'vercel' && (a.includes('--prod') || (p.length ? !VERCEL_SAFE.has(p[0]) : !a.some(x => ['--version', '-v', '--help', '-h'].includes(x)))))
    hit(askC('deploy', 'vercel deploys'));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const script = p[0] === 'run' || p[0] === 'run-script' ? p[1] : name !== 'npm' ? p[0] : undefined;
    if (script && /(^|[:_-])(deploy|publish|release)([:_-]|$)/.test(script)) hit(askC('deploy', `script ${script} looks like a release step`));
    if (script && /migrat/.test(script)) hit(askB('migrations', `script ${script} runs migrations`));
  }

  // Migrations and destructive database tools.
  const dbTool = MIGRATE_TOOLS.has(name) ? name : (name === 'python' || name === 'python3') && /manage\.py$/.test(a[0] ?? '') ? 'django' : null;
  if (dbTool) {
    const dp = dbTool === 'django' ? p.slice(1) : p;
    if (dp.some(x => DB_DESTROY.has(x)) || (dbTool === 'prisma' && dp[0] === 'migrate' && dp[1] === 'deploy')) hit(askC('destructive-db', `${name} ${dp.join(' ')} can destroy data`));
    else if (dp.some(x => /migrat|^(up|upgrade|downgrade|push)$/.test(x))) hit(askB('migrations', `${name} ${dp.join(' ')} runs a migration`));
  }

  // Harness commands.
  const hi = ['harness', 'npm', 'pnpm', 'yarn', 'bun', 'node', 'npx', 'tsx', 'bunx', 'deno'].includes(name) ? w.findIndex(x => basename(x) === 'harness' || /(^|\/)cli\.(ts|js)$/.test(x)) : -1;
  if (hi >= 0) {
    const rest = w.slice(hi + 1).filter(x => x !== '--');
    if (rest[0] === 'controls') hit(deny('harness-controls', 'harness controls changes the enforced controls'));
    else if (rest.slice(0, 3).some(x => ['publish', 'activate', 'install', 'rollback'].includes(x))) hit(askC('harness-release', `harness ${rest.slice(0, 3).join(' ')} changes the installed harness`));
  }
}

function walk(cmd: string, ctx: Ctx) {
  const { depth, hit, controls } = ctx;
  if (depth > 5) return hit(askC('too-deep', 'nesting is too deep to check'));
  const { segs, subs, unbalanced } = split(cmd);
  if (unbalanced) hit(askC('unparsed', 'unbalanced quotes or brackets'));
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i], tag = (h: Hit) => hit({ ...h, segment: h.segment ?? seg.text });
    const name = basename(unwrap(seg.words).w[0] ?? '');
    if (DOWNLOAD.test(name)) for (let j = i + 1; j < segs.length && segs[j].pipeIn; j++)
      if (RUNNERS.has(basename(unwrap(segs[j].words).w[0] ?? ''))) tag(askC('download-to-shell', 'pipes a download into a shell'));
    const lines = [...new Set([seg.words.join(' '), unwrap(seg.words).w.join(' ')])];
    for (const r of controls) if (lines.some(l => controlMatches(r, l))) tag(r.effect === 'deny' ? deny(`controls:${r.id}`, `controls.json ${r.pattern}`) : askC(`controls:${r.id}`, `controls.json ${r.pattern}`));
    classifyWords(seg.words, { depth, hit: tag, controls }, seg.outs, seg.ins);
  }
  for (const s of subs) walk(s, { depth: depth + 1, hit, controls });
}

function controlMatches(r: ControlRule, line: string) {
  if (r.mode === 'exact') return line === r.prefix;
  if (!line.startsWith(r.prefix)) return false;
  const next = line[r.prefix.length];
  return r.mode === 'raw' || next === undefined || next === ' ' || !/\w/.test(r.prefix.at(-1) ?? '');
}

// Most severe verdict over all segments. B rules turn to allow when `allow` names them; C and deny never do.
export function classifyCommand(cmd: string, opts: ClassifyOptions = {}): Verdict {
  const allow = new Set(opts.allow ?? []), hits: Hit[] = [];
  const hit = (h: Hit) => hits.push(h.level === 'B' && h.decision === 'ask' && allow.has(h.rule) ? { ...h, decision: 'allow', reason: `${h.reason} (allowed: ${h.rule})` } : h);
  walk(cmd, { depth: 0, hit, controls: opts.controls ?? [] });
  if (SQL.test(cmd)) hit(askC('destructive-sql', 'destructive SQL'));
  let best: Verdict = { decision: 'allow', level: 'A', rule: 'default', reason: 'no rule matched' };
  for (const h of hits) if (rank(h) > rank(best)) best = h;
  return best;
}

// ---- controls.json ----
export function loadControls(path: string): ControlRule[] {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c?.schemaVersion !== 1 || !Array.isArray(c.controls)) throw new Error(`${path}: unsupported controls schema`);
  const rules: ControlRule[] = [];
  for (const x of c.controls) {
    if (x.effect !== 'deny' && x.effect !== 'ask') throw new Error(`${path}: ${x.id} effect must be deny or ask`);
    for (const pattern of Array.isArray(x.claude) ? x.claude : []) {
      const m = /^Bash\((.*)\)$/s.exec(pattern);
      if (!m || /\{[^}]*\}/.test(m[1])) continue;
      const body = m[1].trim().replace(/\s+/g, ' ');
      const [prefix, mode] = body.endsWith(':*') ? [body.slice(0, -2), 'word' as const] : body.endsWith('*') ? [body.slice(0, -1), 'raw' as const] : [body, 'exact' as const];
      rules.push({ id: x.id, effect: x.effect, pattern, prefix, mode });
    }
  }
  return rules;
}

// Walk up from dir to the first folder with harness.config.json; its controls/controls.json, if any.
function controlsAbove(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'harness.config.json'))) return existsSync(join(d, 'controls', 'controls.json')) ? join(d, 'controls', 'controls.json') : undefined;
    if (dirname(d) === d) return undefined;
  }
}

// Search order: $HARNESS_ROOT/controls/controls.json, then the ancestors of startDir (default: this script),
// then the ancestors of planRoot (the plan's repo root). An installed copy outside the checkout needs the last step.
export function findControls(startDir: string = dirname(fileURLToPath(import.meta.url)), planRoot?: string): string | undefined {
  const env = process.env.HARNESS_ROOT;
  if (env && existsSync(join(env, 'controls', 'controls.json'))) return join(env, 'controls', 'controls.json');
  return controlsAbove(startDir) ?? (planRoot ? controlsAbove(planRoot) : undefined);
}

// ---- paths ----
const lexists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
// The protected rule of a repo-relative path, else null. checkPath and the fingerprint walk both use it.
export function protectedRel(rel: string): string | null {
  const r = rel.split(sep).join('/').toLowerCase(), parts = r.split('/'), base = parts.at(-1) ?? '';
  if (parts.includes('.git')) return '.git/';
  if (base.startsWith('.env') && base !== '.env.example') return '.env*';
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(r)) return '.claude/settings*.json';
  if (parts[0] === 'controls') return 'controls/';
  if (parts.includes('.state')) return '.state/';
  if (/\.(pem|key)$/.test(base)) return '*.pem or *.key';
  return null;
}

// A path an agent may write: relative, inside root after resolve and realpath, not protected.
export function checkPath(path: string, root: string, opts: { allow?: string[] } = {}): { ok: boolean; reason?: string; needs?: string } {
  if (!path) return { ok: false, reason: 'empty path' };
  if (isAbsolute(path)) return { ok: false, reason: 'absolute path' };
  if (path.startsWith('~')) return { ok: false, reason: 'home path' };
  if (path.split(/[\\/]/).includes('..')) return { ok: false, reason: 'parent (..) segment' };
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return { ok: false, reason: 'root does not exist' }; }
  const full = resolve(realRoot, path);
  let probe = full;
  while (!lexists(probe) && probe !== realRoot && dirname(probe) !== probe) probe = dirname(probe);
  let real: string;
  try { real = join(realpathSync(probe), relative(probe, full)); } catch { return { ok: false, reason: 'unresolvable symlink' }; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, reason: 'outside root (symlink)' };
  // An owned path must be its own real path: no symlink at it or in a folder above it inside the repo.
  // Otherwise two spellings could own the same file, and the fingerprint would follow the link.
  if (real !== full) return { ok: false, reason: 'symlink inside the repo (or a different letter case); name the real path' };
  for (const rel of [relative(realRoot, full), relative(realRoot, real)]) {
    const p = protectedRel(rel);
    if (p) return { ok: false, reason: `protected: ${p}` };
    if (/^\.github\/workflows(\/|$)/i.test(rel.split(sep).join('/')) && !(opts.allow ?? []).includes('ci')) return { ok: false, reason: '.github/workflows/ needs ci', needs: 'ci' };
  }
  return { ok: true };
}

// ---- redaction ----
const NAMED = /\b((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/g;
// A field name is secret when one of its words is: API_TOKEN, client_secret, apiKey, X-Api-Key. `keywords` and `tokens` are not.
const SECRET_WORDS = new Set(['secret', 'token', 'password', 'passwd', 'key', 'apikey', 'authorization', 'credential', 'credentials']);
const secretName = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some(w => SECRET_WORDS.has(w));
// "name": value in JSON, for a secret name. The value may be a string, a number, true, false, or null.
const JSON_FIELD = /("([A-Za-z0-9_.-]+)"\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;
// "name": { or 'name': [ : a JSON (or Python literal) field whose value is an object or an array.
const COMPOSITE = /((["'])([A-Za-z0-9_.-]+)\2\s*:\s*)[[{]/g;
// The end of the object or array that opens at `from`: just after its matching bracket. Brackets in strings do not count.
// When the brackets do not balance (one never closes), the end of the input: the rest may all be the secret.
function compositeEnd(s: string, from: number): number {
  const want: string[] = [];
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue; }
    if (c === '{' || c === '[') want.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { if (want.pop() !== c) break; if (!want.length) return i + 1; }
  }
  return s.length;
}
// A secret-named object or array is masked whole: {"token":{"v":"x"}} gives {"token":"[REDACTED]"}.
function maskComposites(text: string): string {
  let out = '', last = 0;
  for (const m of text.matchAll(COMPOSITE)) {
    if (m.index < last || !secretName(m[3])) continue;
    const start = m.index + m[1].length;
    out += text.slice(last, start) + '"[REDACTED]"';
    last = compositeEnd(text, start);
  }
  return out + text.slice(last);
}
// key: value or key = value, for these exact key names (any case, optionally quoted). `tokens used: 5` is not one.
const KEY_HEAD = /(^|[\s{,;(])(["']?)(token|secret|password|passwd|api[_-]key|apikey|access_key|private_key|client_secret)\2(\s*[:=]\s*)/gim;
// key=value with no spaces is a shell assignment: its value is one word, and the command after it stays.
const SHELL_WORD = /"[^"\n]*"|'[^'\n]*'|[^\s,;}"']+/y;
// A JSON or Python field: a quoted key, one whole quoted string, then , } ] or the end of the line. Its structure stays.
const QUOTED_FIELD = /(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')(?=[ \t]*(?:[,}\]]|\r?\n|$))/y;
const lineEnd = (s: string, from: number) => { const nl = /\r?\n/g; nl.lastIndex = from; return nl.exec(s)?.index ?? s.length; };
// Any other value after `:` or a spaced `=` is masked to the end of the line: quoted chunks, brackets, and [REDACTED] parts too.
// A value that opens [ or { is masked to its matching bracket's line, or to the end of the input when it never closes.
function maskKeyLines(text: string): string {
  let out = '', last = 0;
  for (const m of text.matchAll(KEY_HEAD)) {
    const start = m.index + m[0].length, q = m[2];
    if (m.index < last || start >= text.length) continue;
    const at = (re: RegExp) => { re.lastIndex = start; return re.exec(text)?.[0]; };
    // `one`: a value that ends early, a shell word or a whole quoted JSON string. Else the value is the rest.
    const one = m[4] === '=' ? at(SHELL_WORD) : q ? at(QUOTED_FIELD) : undefined;
    if (m[4] === '=' && !one) continue;
    let end = one ? start + one.length : lineEnd(text, start);
    if (!one && (text[start] === '[' || text[start] === '{')) end = Math.max(end, lineEnd(text, compositeEnd(text, start)));
    // keep the value's quote, else the key's quote, so a second pass changes nothing
    const c = /["']/.test(text[start]) ? text[start] : one ? '' : q;
    out += text.slice(last, start) + (c ? `${c}[REDACTED]${c}` : '[REDACTED]');
    last = end;
  }
  return out + text.slice(last);
}
// A header line: Authorization or Proxy-Authorization, or a hyphenated secret name such as X-Api-Key or X-Auth-Token.
const HEADER = /(^|[\s"'])((?:Proxy-)?Authorization|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)(:[ \t]*)([^\s"'][^\r\n"']*)/gim;
export function redact(text: string): string {
  const tokens = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
  // A secret-named field is masked whole, also when a part of it is already [REDACTED]. The result is stable.
  const fields = maskComposites(tokens)
    .replace(JSON_FIELD, (m, head: string, name: string) => secretName(name) ? `${head}"[REDACTED]"` : m)
    .replace(HEADER, (m, pre: string, name: string, colon: string) => secretName(name) ? `${pre}${name}${colon}[REDACTED]` : m);
  return maskKeyLines(fields)
    .replace(NAMED, (m, ex: string, name: string) => /SECRET|TOKEN|PASSWORD|PASSWD|KEY/i.test(name) ? `${ex}${name}=[REDACTED]` : m);
}
