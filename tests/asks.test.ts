import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, mkdtemp, cp, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { computeAsksMetrics, formatAsksSummary, normalizeQuestion } from '../src/asks.ts';

const execFileAsync = promisify(execFile);
const FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'asks');

test('normalizeQuestion cleans punctuation, casing, and whitespace', () => {
  assert.equal(
    normalizeQuestion('  Can I make local git commits overnight?  '),
    'can i make local git commits overnight'
  );
  assert.equal(
    normalizeQuestion('Should we use PostgreSQL?'),
    'should we use postgresql'
  );
  assert.equal(
    normalizeQuestion('Should   we use\nPostgreSQL'),
    'should we use postgresql'
  );
});

test('Finding 1: rejections match exact host prefix and require is_error: true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-rejection-'));
  // Session with valid rejection, rejection without prefix, and error without is_error true
  const lines = [
    {
      uuid: 'r1',
      sessionId: 's-rej',
      type: 'user',
      timestamp: '2026-11-01T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_1',
            is_error: true,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected by user.",
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool_2',
            is_error: false,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected but is_error is false.",
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool_3',
            is_error: true,
            content: "Random command failed with error code 1.",
          },
        ],
      },
    },
  ];
  await writeFile(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.userRejections, 1, 'Only tool_result with is_error: true and exact prefix counts');
});

test('Finding 2: planCyclesWithNoEdits counts only when previous ExitPlanMode had no edit after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-plan-cycles-'));
  // Test case: plan, plan (counts 1); plan, edit, plan (counts 0)
  // Session A: plan, plan -> 1
  const sessionA = [
    { uuid: 'a1', sessionId: 's-a', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } },
    { uuid: 'a2', sessionId: 's-a', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } },
  ];
  // Session B: plan, edit, plan -> 0
  const sessionB = [
    { uuid: 'b1', sessionId: 's-b', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } },
    { uuid: 'b2', sessionId: 's-b', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
    { uuid: 'b3', sessionId: 's-b', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] } },
  ];
  await writeFile(join(dir, 'session-a.jsonl'), sessionA.map(l => JSON.stringify(l)).join('\n') + '\n');
  await writeFile(join(dir, 'session-b.jsonl'), sessionB.map(l => JSON.stringify(l)).join('\n') + '\n');

  const mA = await computeAsksMetrics(dir);
  assert.equal(mA.planCycles, 4, 'Total ExitPlanMode calls');
  assert.equal(mA.planCyclesWithNoEdits, 1, 'Only plan, plan counts; plan, edit, plan counts 0');
});

test('Finding 3: questions = askCalls + proseQuestions; ExitPlanMode is host-forced and kept out of questions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-questions-'));
  const lines = [
    {
      uuid: 'q1',
      sessionId: 's-q',
      type: 'assistant',
      timestamp: '2026-11-01T10:00:00.000Z',
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'host-forced plan approval' } },
          { type: 'tool_use', name: 'AskUserQuestion', input: { questions: ['Question 1?', 'Question 2?'] } },
        ],
      },
    },
    {
      uuid: 'q2',
      sessionId: 's-q',
      type: 'user',
      timestamp: '2026-11-01T10:00:10.000Z',
      message: { content: [{ type: 'tool_result', content: 'Answers' }] },
    },
    {
      uuid: 'q3',
      sessionId: 's-q',
      type: 'assistant',
      timestamp: '2026-11-01T10:00:20.000Z',
      message: { id: 'm2', content: [{ type: 'text', text: 'Should we proceed now?' }] },
    },
    {
      uuid: 'q4',
      sessionId: 's-q',
      type: 'user',
      timestamp: '2026-11-01T10:00:30.000Z',
      message: { content: [{ type: 'text', text: 'Yes.' }] },
    },
  ];
  await writeFile(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.breakdown.askCalls, 1, '1 AskUserQuestion call');
  assert.equal(m.breakdown.askItems, 2, '2 question items inside AskUserQuestion');
  assert.equal(m.breakdown.proseQuestions, 1, '1 prose question');
  assert.equal(m.questions, 2, 'questions = askCalls (1) + proseQuestions (1)');
  assert.equal(m.planCycles, 1, 'ExitPlanMode recorded under planCycles only');
});

test('Finding 4: prose questions counted only when last in turn, no tool_use after, followed by plain user turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-prose-'));
  const lines = [
    // Case A: prose precedes AskUserQuestion in same turn -> NOT counted as prose
    {
      uuid: 'p1',
      sessionId: 's-p',
      type: 'assistant',
      message: {
        id: 'msg_a',
        content: [
          { type: 'text', text: 'Before tool call, should I ask?' },
          { type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Real tool ask?' } },
        ],
      },
    },
    { uuid: 'p2', sessionId: 's-p', type: 'user', message: { content: [{ type: 'tool_result', content: 'res' }] } },
    // Case B: prose followed by tool_use in same message -> NOT counted
    {
      uuid: 'p3',
      sessionId: 's-p',
      type: 'assistant',
      message: {
        id: 'msg_b',
        content: [
          { type: 'text', text: 'Is this calculation right?' },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo 1' } },
        ],
      },
    },
    { uuid: 'p4', sessionId: 's-p', type: 'user', message: { content: [{ type: 'tool_result', content: '1' }] } },
    // Case C: split lines with same message.id; last text block ends in '?' followed by plain user turn -> COUNTED
    {
      uuid: 'p5a',
      sessionId: 's-p',
      type: 'assistant',
      message: { id: 'msg_c', content: [{ type: 'text', text: 'I completed all tasks.' }] },
    },
    {
      uuid: 'p5b',
      sessionId: 's-p',
      type: 'assistant',
      message: { id: 'msg_c', content: [{ type: 'text', text: 'Should I commit the changes?' }] },
    },
    {
      uuid: 'p6',
      sessionId: 's-p',
      type: 'user',
      message: { content: [{ type: 'text', text: 'Yes please commit.' }] },
    },
  ];
  await writeFile(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.breakdown.proseQuestions, 1, 'Only Case C counts as prose question');
});

test('Finding 5: skip non-plain objects, guard null blocks and null question entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-malformed-'));
  const rawText = [
    'not a json line',
    '12345',
    'true',
    'null',
    '["an", "array"]',
    JSON.stringify({
      uuid: 'm1',
      sessionId: 's-m',
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          null,
          { type: 'text', text: 'Valid text block.' },
          { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [null, 'Valid question after null entry?'] } },
        ],
      },
    }),
  ].join('\n') + '\n';

  await writeFile(join(dir, 'session.jsonl'), rawText);

  const m = await computeAsksMetrics(dir);
  assert.equal(m.sessions, 1);
  assert.equal(m.breakdown.askCalls, 1);
  assert.equal(m.breakdown.askItems, 1);
});

test('Finding 6: missing or unreadable dir errors with exit 1; symlinks not followed', async () => {
  // Test missing dir
  await assert.rejects(
    () => computeAsksMetrics('/nonexistent/path/for/sure'),
    /missing or unreadable/
  );

  // Test symlink not followed
  const baseDir = await mkdtemp(join(tmpdir(), 'asks-test-symlink-'));
  const realFile = join(baseDir, 'real.jsonl');
  const linkFile = join(baseDir, 'link.jsonl');
  await writeFile(realFile, JSON.stringify({ uuid: '1', type: 'user' }) + '\n');
  await symlink(realFile, linkFile);

  const m = await computeAsksMetrics(baseDir);
  assert.equal(m.skippedFiles, 1, 'Symlink is skipped and counted in skippedFiles');
  assert.equal(m.sessions, 1, 'Only real file is read');
});

test('Finding 7: compaction marker only compact_boundary or isCompactSummary; date filter per session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-compaction-'));
  const session1 = [
    { uuid: 'c1', sessionId: 's-comp', timestamp: '2026-11-01T10:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Question before compaction?' } }] } },
    { uuid: 'c2', sessionId: 's-comp', timestamp: '2026-11-01T10:00:10.000Z', type: 'system', subtype: 'compact_boundary' },
    { uuid: 'c3', sessionId: 's-comp', timestamp: '2026-11-01T10:00:20.000Z', type: 'user', isCompactSummary: true, message: { content: 'Summary' } },
    { uuid: 'c4', sessionId: 's-comp', timestamp: '2026-11-01T10:00:30.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Question before compaction?' } }] } },
    { uuid: 'c5', sessionId: 's-comp', timestamp: '2026-11-01T10:00:40.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'Answer' }] } },
  ];
  await writeFile(join(dir, 'session.jsonl'), session1.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.postCompactionReasks, 1);

  // Date filter per session: cutoff between session start and end
  // Session starts at 2026-11-01T10:00:00Z.
  // If now is 2026-11-03 and days is 1 (cutoff 2026-11-02), session start is before cutoff -> whole session skipped
  const mFiltered = await computeAsksMetrics(dir, { days: 1, now: new Date('2026-11-03T10:00:00.000Z') });
  assert.equal(mFiltered.sessions, 0, 'Whole session skipped when start is before cutoff');
});

test('Finding 8: reject non-positive, non-finite, or missing --days value with exit 1', async () => {
  const rootDir = join(import.meta.dirname, '..');
  const invalidDays = ['0', '-5', 'abc', 'NaN', 'Infinity'];
  for (const d of invalidDays) {
    await assert.rejects(
      async () => {
        await execFileAsync('node', [
          '--experimental-strip-types',
          join(rootDir, 'src', 'cli.ts'),
          'asks',
          '--dir',
          FIXTURES_DIR,
          '--days',
          d,
        ], { cwd: rootDir });
      },
      (err: any) => err.code === 1 && err.stderr.includes('positive finite number')
    );
  }
});

test('Finding 9: cross-session repeats grouped by project folder; short prose excluded; sessionsWithRepeats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-project-'));
  const projA = join(dir, 'projectA');
  const projB = join(dir, 'projectB');
  await mkdir(projA, { recursive: true });
  await mkdir(projB, { recursive: true });

  const qText = 'Should we run database migrations now?';

  // Session A1 in projectA
  const sA1 = [
    { uuid: 'a1', sessionId: 's-a1', timestamp: '2026-11-01T10:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: qText } }] } },
    { uuid: 'a2', sessionId: 's-a1', timestamp: '2026-11-01T10:00:10.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'Yes' }] } },
  ];
  // Session A2 in projectA (repeats qText)
  const sA2 = [
    { uuid: 'a3', sessionId: 's-a2', timestamp: '2026-11-01T11:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: qText } }] } },
    { uuid: 'a4', sessionId: 's-a2', timestamp: '2026-11-01T11:00:10.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'Yes' }] } },
  ];
  // Session B1 in projectB (asks qText, but in separate project -> NOT an across-session repeat)
  const sB1 = [
    { uuid: 'b1', sessionId: 's-b1', timestamp: '2026-11-01T12:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: qText } }] } },
    { uuid: 'b2', sessionId: 's-b1', timestamp: '2026-11-01T12:00:10.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'Yes' }] } },
  ];
  await writeFile(join(projA, 's1.jsonl'), sA1.map(l => JSON.stringify(l)).join('\n') + '\n');
  await writeFile(join(projA, 's2.jsonl'), sA2.map(l => JSON.stringify(l)).join('\n') + '\n');
  await writeFile(join(projB, 's3.jsonl'), sB1.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.repeatsAcrossSessions, 1, 'Only sA2 repeats qText within projectA; sB1 does not cross project boundary');
  assert.equal(m.sessionsWithRepeats, 1, 'Only sA2 has repeats');
});

test('Finding 10: time blocked capped at 3600s; median reported; unmeasuredBatches tracked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-time-'));
  const lines = [
    // Turn 1: 5000s gap -> capped at 3600s
    { uuid: 't1', sessionId: 's-t', timestamp: '2026-11-01T10:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Q1?' } }] } },
    { uuid: 't2', sessionId: 's-t', timestamp: '2026-11-01T11:23:20.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'A1' }] } },
    // Turn 2: 40s gap
    { uuid: 't3', sessionId: 's-t', timestamp: '2026-11-01T11:23:30.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Q2?' } }] } },
    { uuid: 't4', sessionId: 's-t', timestamp: '2026-11-01T11:24:10.000Z', type: 'user', message: { content: [{ type: 'tool_result', content: 'A2' }] } },
    // Turn 3: unanswered -> unmeasured
    { uuid: 't5', sessionId: 's-t', timestamp: '2026-11-01T11:24:20.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Q3?' } }] } },
  ];
  await writeFile(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.timeBlockedSeconds, 3640, '3600s (capped) + 40s');
  assert.equal(m.timeBlockedMedianSeconds, 1820, 'Median of [40, 3600] is (40 + 3600) / 2 = 1820');
  assert.equal(m.unmeasuredBatches, 1, 'Turn 3 has no user response');
});

test('Finding 11: skip isSidechain: true lines and dedupe by uuid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-sidechain-'));
  const lines = [
    { uuid: 'sc1', sessionId: 's-sc', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Normal?' } }] } },
    { uuid: 'sc1', sessionId: 's-sc', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Normal duplicate?' } }] } },
    { uuid: 'sc2', sessionId: 's-sc', isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Sidechain?' } }] } },
  ];
  await writeFile(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const m = await computeAsksMetrics(dir);
  assert.equal(m.breakdown.askCalls, 1, 'Dedupe by uuid keeps first, sidechain skipped');
});

test('Finding 12: error messages never include line content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asks-test-err-'));
  const SENSITIVE_TOKEN = 'SUPER_SENSITIVE_LINE_CONTENT_98765';
  const raw = [
    `{"uuid":"1","type":"user","content":"${SENSITIVE_TOKEN}"}`,
    'malformed json line with sensitive token ' + SENSITIVE_TOKEN,
  ].join('\n') + '\n';
  await writeFile(join(dir, 'session.jsonl'), raw);

  // computeAsksMetrics should not leak SENSITIVE_TOKEN in any error or summary
  const m = await computeAsksMetrics(dir);
  const summary = formatAsksSummary(m);
  const jsonStr = JSON.stringify(m);
  assert.ok(!summary.includes(SENSITIVE_TOKEN));
  assert.ok(!jsonStr.includes(SENSITIVE_TOKEN));
});

test('all synthetic fixtures give expected count for each metric', async () => {
  const m = await computeAsksMetrics(FIXTURES_DIR);
  assert.equal(m.sessions, 6);
  assert.equal(m.questions, 9);
  assert.equal(m.batches, 9);
  assert.equal(m.repeatsInSession, 2);
  assert.equal(m.repeatsAcrossSessions, 1);
  assert.equal(m.sessionsWithRepeats, 3);
  assert.equal(m.postCompactionReasks, 1);
  assert.equal(m.timeBlockedSeconds, 3780);
  assert.equal(m.timeBlockedMedianSeconds, 30);
  assert.equal(m.unmeasuredBatches, 1);
  assert.equal(m.userRejections, 1);
  assert.equal(m.planCycles, 3);
  assert.equal(m.planCyclesWithNoEdits, 1);
  assert.equal(m.skippedFiles, 0);
  assert.equal(m.oversizeFiles, 0);
  assert.deepEqual(m.breakdown, {
    askCalls: 7,
    askItems: 8,
    proseQuestions: 2,
    planCycles: 3,
    planCyclesWithNoEdits: 1,
    totalTimeBlockedSeconds: 3780,
    medianTimeBlockedSeconds: 30,
    unmeasuredBatches: 1,
    meanBatchesPerSession: 1.5,
  });
});

test('privacy: output holds counts and ids only, never question or answer text', async () => {
  const m = await computeAsksMetrics(FIXTURES_DIR);
  const jsonOutput = JSON.stringify(m);
  const summaryOutput = formatAsksSummary(m);

  // Read all fixture files and extract strings
  const fixtureTexts: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const filename = i === 6 ? 'session-6-edge.jsonl' : `session-1.jsonl`;
    const content = await readFile(join(FIXTURES_DIR, filename), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block?.input?.questions) {
              for (const q of block.input.questions) fixtureTexts.push(typeof q === 'string' ? q : q?.question);
            }
            if (block?.input?.plan) fixtureTexts.push(block.input.plan);
            if (block?.text) fixtureTexts.push(block.text);
            if (block?.content) fixtureTexts.push(typeof block.content === 'string' ? block.content : '');
          }
        }
      } catch {}
    }
  }

  const sensitivePhrases = fixtureTexts
    .map(t => (t ? t.trim() : ''))
    .filter(t => t.length > 8 && !/^\d+$/.test(t));

  assert.ok(sensitivePhrases.length > 5, 'Should have extracted sensitive phrases');

  for (const phrase of sensitivePhrases) {
    assert.ok(!jsonOutput.includes(phrase), `JSON output must not contain fixture text: "${phrase}"`);
    assert.ok(!summaryOutput.includes(phrase), `Summary output must not contain fixture text: "${phrase}"`);
  }
});

test('cli: npm run harness -- asks --dir <dir> --json outputs valid JSON with exact counts', async () => {
  const rootDir = join(import.meta.dirname, '..');
  const { stdout } = await execFileAsync('node', [
    '--experimental-strip-types',
    join(rootDir, 'src', 'cli.ts'),
    'asks',
    '--dir',
    FIXTURES_DIR,
    '--json',
  ], { cwd: rootDir });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.sessions, 6);
  assert.equal(parsed.questions, 9);
  assert.equal(parsed.batches, 9);
  assert.equal(parsed.repeatsInSession, 2);
  assert.equal(parsed.repeatsAcrossSessions, 1);
  assert.equal(parsed.sessionsWithRepeats, 3);
  assert.equal(parsed.postCompactionReasks, 1);
  assert.equal(parsed.timeBlockedSeconds, 3780);
  assert.equal(parsed.timeBlockedMedianSeconds, 30);
  assert.equal(parsed.unmeasuredBatches, 1);
  assert.equal(parsed.userRejections, 1);
  assert.equal(parsed.planCycles, 3);
  assert.equal(parsed.planCyclesWithNoEdits, 1);

  // Verify CLI output also contains no question text
  assert.ok(!stdout.includes('Should we enable caching'));
  assert.ok(!stdout.includes('What is the connection timeout'));
  assert.ok(!stdout.includes('Can I create a local git commit'));
});

test('cli: npm run harness -- asks --dir <dir> outputs human-readable summary without --json', async () => {
  const rootDir = join(import.meta.dirname, '..');
  const { stdout } = await execFileAsync('node', [
    '--experimental-strip-types',
    join(rootDir, 'src', 'cli.ts'),
    'asks',
    '--dir',
    FIXTURES_DIR,
  ], { cwd: rootDir });

  assert.ok(stdout.includes('Asks metrics:'));
  assert.ok(stdout.includes('Sessions: 6'));
  assert.ok(stdout.includes('Questions: 9'));
  assert.ok(stdout.includes('Batches: 9'));
  assert.ok(stdout.includes('Repeats in session: 2'));
  assert.ok(stdout.includes('Repeats across sessions: 1'));
  assert.ok(stdout.includes('Sessions with repeats: 3'));
  assert.ok(stdout.includes('Post-compaction re-asks: 1'));
  assert.ok(stdout.includes('Time blocked: 3780s (median: 30s)'));
  assert.ok(stdout.includes('User rejections: 1'));
  assert.ok(stdout.includes('Plan cycles: 3 (no edits: 1)'));

  // Verify summary output contains no question text
  assert.ok(!stdout.includes('Should we enable caching'));
});
