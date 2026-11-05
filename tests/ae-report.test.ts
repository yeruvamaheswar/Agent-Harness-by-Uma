import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import type { buildReport } from '../tools/agents/skills/autonomous-engineering/scripts/report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ae = join(root, 'tools/agents/skills/autonomous-engineering/scripts/ae.ts');
const fixture = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ae-report-')));
  mkdirSync(join(dir, 'plans'));
  const plan = 'plans/p.md', jfile = join(dir, 'plans/p.run.json');
  const text = `---\nkind: plan\ntitle: Report fixture\nstatus: active\nupdated: 2026-11-05\nplanner: multi-agent-planning\nmode: standard\n---\nGoal: Ship the morning report\n\n## Slices\n` + [1, 2, 3].map(n => `
### Slice ${n}: work ${n}
- Goal: work ${n}
- Model: Codex (auto)
- Review: Claude (sonnet/high)
- Fallback: Codex (auto)
- Wave: 1 sequential
- Depends on: none
- Files: f${n}.txt
- Out of scope: src/
- Accept: check ${n}
- Verify: \`echo checked\`
- State: PLANNED
- Evidence: none
- [ ] build · Codex (auto) · check passes · revert
`).join('\n');
  writeFileSync(join(dir, plan), text);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = (message: string) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', message);
  commit('baseline');
  const cli = (...args: string[]) => {
    const p = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', ae, ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return p.stdout;
  };
  return { dir, plan, jfile, git, commit, cli };
};

test('morning report reads a real CLI run, redacts output, and leaves every fixture file unchanged', async () => {
  const r = fixture();
  r.cli('init', r.plan);
  r.cli('next', r.plan);
  const start = (id: string) => r.cli('start', r.plan, id, '--provider', 'codex', '--model', 'auto', '--effort', 'medium');
  start('1');
  r.cli('finish', r.plan, '1', '--summary', 'worker claim');
  r.cli('review', r.plan, '1', '--by', 'independent-review', '--note', 'accepted');
  r.cli('verify', r.plan, '1');
  r.commit(`Completed slice\n\nAE-Slice: ${r.plan}#1`);
  const sha = r.git('rev-parse', 'HEAD');
  start('2');
  r.cli('fail', r.plan, '2', '--reason', 'missing assertion');
  r.cli('next', r.plan);
  start('3');
  r.cli('block', r.plan, '3', '--reason', 'needs account access');
  // Simulate an old journal that predates redaction. Report must scrub on read without saving it.
  const raw = readFileSync(r.jfile, 'utf8').replace('missing assertion', 'missing assertion API_TOKEN=synthetic-secret');
  writeFileSync(r.jfile, raw);
  // A live lock must neither block report nor be taken over.
  writeFileSync(r.jfile + '.lock', String(process.pid));
  const files = readdirSync(join(r.dir, 'plans')).sort();
  const before = files.map(f => readFileSync(join(r.dir, 'plans', f)));
  const out = r.cli('report', r.plan), json = r.cli('report', r.plan, '--json');
  const report: ReturnType<typeof buildReport> = JSON.parse(json);
  assert.match(out, /^Morning report\n/);
  assert.equal(out.slice('Morning report\n'.length).trim(), json.trim());
  assert.deepEqual(report.counts, { VERIFIED: 1, READY: 1, BLOCKED: 1 });
  assert.equal(report.goal, 'Ship the morning report');
  const journal = JSON.parse(raw);
  assert.deepEqual(report.period, { start: journal.createdAt, end: journal.updatedAt });
  assert.equal(report.journal, r.jfile);
  assert.equal(report.readOnly, true);
  const evidence = report.slices[0].evidence[0];
  assert.equal(evidence.command, 'echo checked');
  assert.equal(evidence.exitCode, 0);
  assert.match(evidence.gitHead, /^[a-f0-9]{40}$/);
  assert.match(evidence.fingerprint, /^[a-f0-9]+$/);
  assert.match(report.slices[1].failures[0].reason ?? '', /missing assertion/);
  assert.equal(report.slices[2].blocker?.reason, 'needs account access');
  assert.deepEqual(report.commits, [{ sha, slice: '1' }]);
  assert.deepEqual(report.attempts, [{ provider: 'codex', model: 'auto', effort: 'medium', count: 3 }]);
  for (const output of [out, json]) {
    assert.ok(!output.includes('synthetic-secret'));
    assert.match(output, /\[REDACTED\]/);
  }
  assert.deepEqual((await main(['report', r.plan, '--json'], { cwd: r.dir })).counts, report.counts);
  assert.deepEqual(readdirSync(join(r.dir, 'plans')).sort(), files);
  files.forEach((f, i) => assert.deepEqual(readFileSync(join(r.dir, 'plans', f)), before[i], `${f} unchanged`));
});

test('report preserves recorded state when the plan definition changes, and identifies backup recovery', () => {
  const r = fixture();
  r.cli('init', r.plan);
  const journal = readFileSync(r.jfile);
  writeFileSync(r.jfile + '.bak', journal);
  writeFileSync(join(r.dir, r.plan), readFileSync(join(r.dir, r.plan), 'utf8').replace('- Accept: check 1', '- Accept: revised acceptance'));
  const report = JSON.parse(r.cli('report', r.plan, '--json'));
  assert.deepEqual(report.counts, { PLANNED: 3 });
  writeFileSync(r.jfile, 'interrupted write');
  const recovered = JSON.parse(r.cli('report', r.plan, '--json'));
  assert.equal(recovered.recoveredFromBackup, true);
  assert.equal(readFileSync(r.jfile, 'utf8'), 'interrupted write');
  assert.deepEqual(readFileSync(r.jfile + '.bak'), journal);
});

test('overnight reference contains only the morning report section', () => {
  const text = readFileSync(join(root, 'tools/agents/skills/autonomous-engineering/references/overnight.md'), 'utf8');
  assert.deepEqual(text.match(/^#+ .+$/gm), ['## Morning report']);
});
