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
const fixture = ({ gitRepo = true, history = true } = {}) => {
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
  if (gitRepo) git('init', '-q');
  const commit = (message: string) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', message);
  if (gitRepo && history) commit('baseline');
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
  assert.doesNotMatch(out, /\{\s*"plan"/);
  assert.deepEqual(out.match(/^## .+$/gm), ['## Verified with engine evidence', '## Accepted by manual sign-off', '## Claims', '## Failures', '## Blocked', '## Handoffs', '## Commits', '## Charter and stop', '## Journal']);
  for (const fact of ['echo checked', 'exitCode: 0', 'gitHead:', 'fingerprint:', 'missing assertion', 'needs account access', sha, r.jfile]) assert.ok(out.includes(fact), fact);
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
  assert.deepEqual(report.attempts, [{ provider: 'codex', model: 'auto', effort: 'medium', count: 3 }, { provider: 'unknown', model: 'unknown', effort: 'unknown', count: 1 }]);
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

test('report distinguishes unborn HEAD from no Git, and handles a journal with no attempts', () => {
  for (const [gitRepo, gitHistory] of [[true, 'empty'], [false, 'unavailable']] as const) {
    const r = fixture({ gitRepo, history: false });
    r.cli('init', r.plan);
    const before = readFileSync(r.jfile);
    const report: ReturnType<typeof buildReport> = JSON.parse(r.cli('report', r.plan, '--json'));
    assert.equal(report.gitHistory, gitHistory);
    assert.deepEqual(report.attempts, []);
    assert.deepEqual(report.commits, []);
    assert.deepEqual(report.claims, []);
    assert.deepEqual(report.handoffs, []);
    assert.equal(report.charter, null);
    assert.equal(report.stop, null);
    const out = r.cli('report', r.plan);
    assert.match(out, /## Verified with engine evidence\n- none/);
    assert.deepEqual(readFileSync(r.jfile), before);
  }
});

test('JSON and text separate worker claims from verified evidence and include handoff facts', () => {
  const r = fixture();
  r.cli('init', r.plan); r.cli('next', r.plan);
  r.cli('charter', r.plan, '--approval', `${r.plan}:10`, '--deadline', '2099-11-05T19:00:00-06:00', '--cap', 'codex/auto/auto=2');
  r.cli('start', r.plan, '1', '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  r.cli('prepare', r.plan, '1', '--lead', 'Claude (opus/high)', '--to', 'Codex (auto, fresh session)', '--reason', 'provider outage');
  r.cli('checkpoint', r.plan, '1', '--done', 'Partial patch saved.');
  r.cli('transfer', r.plan, '1', '--lead', 'Claude (opus/high)', '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  r.cli('finish', r.plan, '1', '--summary', 'worker says complete');
  const before = readFileSync(r.jfile);
  const report: ReturnType<typeof buildReport> = JSON.parse(r.cli('report', r.plan, '--json'));
  assert.deepEqual(report.counts, { AGENT_FINISHED: 1, READY: 2 });
  assert.equal(report.claims[0].slice, '1');
  assert.equal(report.claims[0].claims[0].summary, 'worker says complete');
  assert.equal(report.handoffs[0].reason, 'provider outage');
  assert.equal(report.handoffs[0].slice, '1');
  assert.equal(report.stop?.stop, 'budget');
  const text = r.cli('report', r.plan);
  assert.match(text, /## Verified with engine evidence\n- none/);
  assert.match(text, /## Claims\n- Slice 1 \(AGENT_FINISHED\): .*worker says complete/);
  assert.match(text, /## Handoffs\n- .*provider outage/);
  assert.match(text, /Stop: stop: budget/);
  assert.deepEqual(readFileSync(r.jfile), before);
});

test('report counts ACCEPTED as settled and separates manual sign-off from engine verification', () => {
  const r = fixture();
  writeFileSync(join(r.dir, r.plan), readFileSync(join(r.dir, r.plan), 'utf8').replaceAll('- Verify: `echo checked`', '- Verify: person inspects the result'));
  r.cli('init', r.plan); r.cli('next', r.plan);
  for (const id of ['1', '2', '3']) {
    r.cli('start', r.plan, id, '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
    r.cli('finish', r.plan, id, '--summary', 'ready for sign-off');
    r.cli('review', r.plan, id, '--by', 'independent-review', '--note', 'diff inspected');
    r.cli('verify', r.plan, id, '--manual', '--by', 'Owner', '--note', 'visual result approved');
  }
  const before = readFileSync(r.jfile);
  const report: ReturnType<typeof buildReport> = JSON.parse(r.cli('report', r.plan, '--json'));
  assert.deepEqual(report.counts, { ACCEPTED: 3 });
  assert.equal(report.settled, 3);
  assert.equal(report.done, true);
  assert.deepEqual(report.claims, []);
  const text = r.cli('report', r.plan);
  assert.match(text, /## Verified with engine evidence\n- none/);
  assert.match(text, /Settled: 3; done: true/);
  assert.match(text, /## Accepted by manual sign-off\n- Slice 1 \(ACCEPTED\): .*by: Owner; note: visual result approved/);
  assert.deepEqual(readFileSync(r.jfile), before);
});

test('report lists an ACCEPTED then INTEGRATED slice as manual sign-off, not engine evidence', () => {
  const r = fixture();
  writeFileSync(join(r.dir, r.plan), readFileSync(join(r.dir, r.plan), 'utf8').replace('- Verify: `echo checked`', '- Verify: person inspects the result'));
  r.cli('init', r.plan); r.cli('next', r.plan);
  // Slice 1: manual sign-off, then integrated. Slice 2 keeps its command Verify and is integrated too.
  r.cli('start', r.plan, '1', '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  r.cli('finish', r.plan, '1', '--summary', 'ready for sign-off');
  r.cli('review', r.plan, '1', '--by', 'independent-review', '--note', 'diff inspected');
  r.cli('verify', r.plan, '1', '--manual', '--by', 'Owner', '--note', 'visual result approved');
  r.cli('integrate', r.plan, '1', '--ref', 'main');
  r.cli('start', r.plan, '2', '--provider', 'codex', '--model', 'auto', '--effort', 'auto');
  r.cli('finish', r.plan, '2', '--summary', 'done');
  r.cli('review', r.plan, '2', '--by', 'independent-review', '--note', 'accepted');
  r.cli('verify', r.plan, '2');
  r.cli('integrate', r.plan, '2', '--ref', 'main');
  const report: ReturnType<typeof buildReport> = JSON.parse(r.cli('report', r.plan, '--json'));
  assert.equal(report.slices[0].state, 'INTEGRATED');
  assert.equal(report.slices[1].state, 'INTEGRATED');
  const text = r.cli('report', r.plan);
  const part = (title: string) => text.split(/^## /m).find(s => s.startsWith(title)) ?? '';
  const engine = part('Verified with engine evidence'), manual = part('Accepted by manual sign-off');
  assert.doesNotMatch(engine, /Slice 1 /);
  assert.match(engine, /Slice 2 \(INTEGRATED\): .*echo checked/);
  assert.match(manual, /Slice 1 \(INTEGRATED\): .*by: Owner; note: visual result approved/);
  assert.doesNotMatch(manual, /Slice 2 /);
});
