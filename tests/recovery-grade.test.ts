// Tests for evals/recovery/grade.ts. A tiny repo and journal are built by hand; no live run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { main as ae } from '../tools/agents/skills/autonomous-engineering/scripts/ae.ts';
import { journalPath } from '../tools/agents/skills/autonomous-engineering/scripts/journal.ts';
import { packet as enginePacket } from '../tools/agents/skills/autonomous-engineering/scripts/packet.ts';
import { parsePlan } from '../tools/agents/skills/autonomous-engineering/scripts/plan.ts';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grade, QUESTION_MARKS, normalizeText, parseSettled, keyTokenRe, tiedToDecision } from '../evals/recovery/grade.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY = 'storage.engine';

function build(mut: (j: any, r: any, files: Record<string, string>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grade-'));
  mkdirSync(join(dir, 'plans')); mkdirSync(join(dir, 'src'));
  const files: Record<string, string> = { 'src/m1.txt': 'milestone 1\n' };
  const journal: any = {
    decisions: [{ id: 'D1', key: KEY, scope: 'run', risk: 'amber', status: 'assumed', question: 'Which storage engine should the milestone use for persisted records?', answer: 'sqlite', by: 'x', at: 't', updatedAt: 't', history: [] }],
    slices: { '1': {
      state: 'VERIFIED',
      evidence: [{ kind: 'command', command: 'test', exitCode: 0, by: 'engine', at: '2026-11-08T04:30:00Z', gitHead: 'h', fingerprint: 'f' }],
      attempts: [
        { n: 1, kind: 'work', at: '2026-11-08T04:00:00Z', endedAt: '2026-11-08T04:10:00Z', outcome: 'handed-off', interruptions: [{ at: 't', class: 'quota', source: 'lead', fingerprint: 'f' }] },
        { n: 2, kind: 'work', at: '2026-11-08T04:20:00Z', endedAt: '2026-11-08T04:30:00Z', outcome: 'finished' },
      ],
      handoffs: [{ phase: 'TRANSFERRED', at: 't', lead: 'l', reason: 'quota', from: { label: 'a', attempt: 1 }, to: 'b', history: [] }],
    } },
  };
  const record: any = { slice: '1', settledKey: KEY, finishedFiles: {}, replacementTranscript: 'transcript.json',
    replacementPacket: 'packet.md', disarmEvidence: 'disarm.json',
    labels: { measured: ['runs'], estimate: ['cost'] } };
  const transcript = { threadId: 'th', runId: 'r', provider: 'p', model: 'm', startedAt: '2026-11-08T04:20:00Z', completedAt: 't',
    items: [{ type: 'user', text: 'go' }, { type: 'assistant', text: 'I read the packet.\nI will write src/m2.txt now.' }] };
  const disarm = { observedAt: '2026-11-08T04:11:00Z', predecessorStatus: 'cancelled',
    processSamples: [{ at: '2026-11-08T04:12:00Z', pid: 9, command: 'sh', alive: true }, { at: '2026-11-08T04:20:30Z', pid: 9, command: 'sh', alive: false }, { at: '2026-11-08T04:19:30Z', pid: 9, command: 'sh', alive: false }],
    filesAfterStop: [{ at: '2026-11-08T04:12:00Z', files: ['src/m1.txt'] }, { at: '2026-11-08T04:19:00Z', files: ['src/m1.txt'] }],
    replacementLaunchedAt: '2026-11-08T04:20:00Z' };
  const packet = `# Packet\nSettled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed; rollback: rewrite).\nNext: nothing\n`;
  mut(journal, record, files);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  record.finishedFiles = record.finishedFiles && Object.keys(record.finishedFiles).length ? record.finishedFiles
    : { 'src/m1.txt': sha('milestone 1\n') };
  writeFileSync(join(dir, 'plans/sandbox.run.json'), JSON.stringify(journal));
  writeFileSync(join(dir, 'plans/sandbox.record.json'), JSON.stringify(record));
  writeFileSync(join(dir, 'plans/transcript.json'), JSON.stringify(transcript));
  writeFileSync(join(dir, 'plans/disarm.json'), JSON.stringify(disarm));
  writeFileSync(join(dir, 'plans/packet.md'), packet);
  const json = (n: string, f: (o: any) => void) => { const o = JSON.parse(readFileSync(join(dir, 'plans', n), 'utf8')); f(o); writeFileSync(join(dir, 'plans', n), JSON.stringify(o)); };
  return { dir, run: () => grade(join(dir, 'plans/sandbox.run.json')), write: (n: string, b: string) => writeFileSync(join(dir, 'plans', n), b), json };
}

const failed = (r: ReturnType<typeof grade>) => r.checks.filter(c => !c.pass).map(c => c.name);

test('a good case passes all checks', () => {
  const r = build().run();
  assert.equal(r.pass, true, JSON.stringify(r.checks));
  assert.equal(r.checks.length, 7);
});

test('check 1 fails when the slice is not VERIFIED or has no passing command evidence', () => {
  assert.deepEqual(failed(build(j => { j.slices['1'].state = 'AGENT_FINISHED'; }).run()), ['verified-with-command-evidence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].evidence[0].exitCode = 1; }).run()), ['verified-with-command-evidence', 'recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].evidence[0].kind = 'manual'; }).run()), ['verified-with-command-evidence', 'recovery-sequence']);
});

test('check 2 fails when a finished file changed', () => {
  const r = build((_j, rec) => { rec.finishedFiles = { 'src/m1.txt': sha('something else') }; }).run();
  assert.deepEqual(failed(r), ['finished-files-unchanged']);
});

test('check 3 fails on overlap, two open attempts, or a handed-off attempt without interruption', () => {
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts[0].endedAt = '2026-11-08T04:25:00Z'; }).run()), ['one-live-writer']);
  assert.deepEqual(failed(build(j => { delete j.slices['1'].attempts[0].outcome; delete j.slices['1'].attempts[1].outcome; }).run()), ['one-live-writer', 'recovery-sequence']);
  assert.deepEqual(failed(build(j => { delete j.slices['1'].attempts[0].interruptions; }).run()), ['one-live-writer', 'recovery-sequence']);
});

test('check 3 fails without clean disarm evidence', () => {
  const one = (f: (o: any) => void) => { const b = build(); b.json('disarm.json', f); return failed(b.run()); };
  assert.deepEqual(one(o => { o.processSamples[1].alive = true; }), ['one-live-writer']); // predecessor alive after launch
  assert.deepEqual(one(o => { o.filesAfterStop[1].files = ['src/m1.txt', 'src/extra.txt']; }), ['one-live-writer']); // files changed
  assert.deepEqual(one(o => { o.predecessorStatus = 'running'; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.processSamples = [o.processSamples[0]]; }), ['one-live-writer']); // no sample after launch
  assert.deepEqual(failed(build((_j, rec) => { delete rec.disarmEvidence; }).run()), ['one-live-writer']);
});

test('the recovery sequence needs an interrupted predecessor, a handoff, and two attempts', () => {
  assert.deepEqual(failed(build(j => { delete j.slices['1'].attempts[0].interruptions; }).run()), ['one-live-writer', 'recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts[0].outcome = 'finished'; }).run()), ['recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].handoffs = []; }).run()), ['recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].handoffs[0].to = ''; }).run()), ['recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts.pop(); }).run()), ['one-live-writer', 'recovery-sequence']); // one attempt: no replacement start either
});

test('check 4 needs the packet file and the key in its settled section', () => {
  assert.deepEqual(failed(build(j => { j.decisions = []; }).run()), ['packet-listed-settled-decision']);
  assert.deepEqual(failed(build(j => { j.decisions[0].status = 'superseded'; }).run()), ['packet-listed-settled-decision']);
  assert.deepEqual(failed(build((_j, rec) => { delete rec.replacementPacket; }).run()), ['packet-listed-settled-decision']);
  assert.deepEqual(failed(build((_j, rec) => { rec.replacementPacket = 'nope.md'; }).run()), ['packet-listed-settled-decision']);
  const b = build();
  b.write('packet.md', `# P\n## Settled, do not re-ask\n- other\n## Open\n- ${KEY}\n`);
  assert.deepEqual(failed(b.run()), ['packet-listed-settled-decision']);
  b.write('packet.md', `# P\n- ${KEY}\n`);
  assert.deepEqual(failed(b.run()), ['packet-listed-settled-decision']);
});

test('check 5 needs a real JSON transcript and flags questions, including paraphrases, without printing text', () => {
  const t = (f: (o: any) => void) => { const b = build(); b.json('transcript.json', f); return b.run(); };
  assert.deepEqual(failed(t(o => { o.items = []; })), ['no-question-about-settled-key']);
  assert.deepEqual(failed(t(o => { o.items = [{ type: 'user', text: 'hi' }]; })), ['no-question-about-settled-key']);
  assert.deepEqual(failed(t(o => { delete o.runId; })), ['no-question-about-settled-key']);
  const direct = t(o => { o.items.push({ type: 'assistant', text: 'ok\nWhich storage.engine should I use?' }); });
  assert.deepEqual(failed(direct), ['no-question-about-settled-key']);
  assert.match(direct.checks.find(c => !c.pass)!.detail, /item index 2/);
  assert.ok(!JSON.stringify(direct).includes('Which storage'));
  const para = t(o => { o.items.push({ type: 'assistant', text: 'Should persisted records live in a database for this milestone?' }); });
  assert.deepEqual(failed(para), ['no-question-about-settled-key']);
  // Strict rule: any question fails, even one that is not about the key (paraphrases cannot be told apart by words).
  assert.deepEqual(failed(t(o => { o.items.push({ type: 'assistant', text: 'Anything else?' }); })), ['no-question-about-settled-key']);
  assert.equal(build().run().pass, true);
});

test('check 6 fails when measured or estimate labels are missing', () => {
  assert.deepEqual(failed(build((_j, rec) => { rec.labels = { measured: ['a'], estimate: [] }; }).run()), ['measured-and-estimate-labels']);
  assert.deepEqual(failed(build((_j, rec) => { rec.labels = { estimate: ['a'] }; }).run()), ['measured-and-estimate-labels']);
});

// Review 2 (Codex) mutations: each one returned exit 0 before the fix.
test('review 2: empty assistant text, direct and paraphrased questions, and requests fail', () => {
  const t = (f: (o: any) => void) => { const b = build(); b.json('transcript.json', f); return failed(b.run()); };
  assert.deepEqual(t(o => { o.items = [{ type: 'assistant', text: '' }]; }), ['no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.items.push({ type: 'assistant', text: '   ' }); }), ['no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.items.push({ type: 'assistant', text: 'What text goes in each milestone file? Please confirm before I continue.' }); }), ['no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.items.push({ type: 'assistant', text: 'What wording belongs in these output documents?' }); }), ['no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.items.push({ type: 'assistant', text: 'Please confirm the format before I write m2.' }); }), ['no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.startedAt = 'not-a-time'; }), ['one-live-writer', 'no-question-about-settled-key']);
  assert.deepEqual(t(o => { o.startedAt = '2026-11-08T04:00:00Z'; }), ['one-live-writer', 'no-question-about-settled-key']); // also overlaps the live predecessor
});

test('review 2: disarm samples need a boolean alive, one pid, a dead last sample before launch, and full snapshots', () => {
  const one = (f: (o: any) => void, r?: (rec: any) => void) => { const b = build(r ? (_j, rec) => r(rec) : undefined); b.json('disarm.json', f); return failed(b.run()); };
  assert.deepEqual(one(o => { delete o.processSamples[1].alive; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.processSamples[1].alive = 'no'; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.processSamples[2].alive = true; }), ['one-live-writer']); // alive just before launch
  assert.deepEqual(one(o => { o.processSamples[1].pid = 10; }), ['one-live-writer']);
  assert.deepEqual(one(o => { for (const s of o.filesAfterStop) s.files = []; }), ['one-live-writer']);
  assert.deepEqual(one(o => { for (const s of o.filesAfterStop) s.files = ['src/other.txt']; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.filesAfterStop[0].at = 'bad'; }), ['one-live-writer']);
});

test('review 2: an estimated stop time needs its uncertainty, which narrows the snapshot window', () => {
  const one = (f: (o: any) => void) => { const b = build(); b.json('disarm.json', f); return failed(b.run()); };
  assert.deepEqual(one(o => { o.observedAtNote = 'estimate within about 10 s'; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.observedAtNote = 'estimate'; o.observedAtUncertaintySeconds = 10; }), []);
  // a margin that pushes the first snapshot out of the window leaves only one snapshot
  assert.deepEqual(one(o => { o.observedAtNote = 'estimate'; o.observedAtUncertaintySeconds = 120; }), ['one-live-writer']);
  assert.deepEqual(one(o => { o.observedAtUncertaintySeconds = 3600; }), ['one-live-writer']); // boundary after launch
});

test('review 2: command evidence needs a valid time at or after the last attempt start', () => {
  assert.deepEqual(failed(build(j => { j.slices['1'].evidence[0].at = 'not-a-time'; }).run()), ['recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].evidence[0].at = '2026-11-08T04:05:00Z'; }).run()), ['recovery-sequence']);
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts[1].at = 'bad'; }).run()), ['one-live-writer', 'recovery-sequence']);
});

// Review 3 (Codex) reproductions: each one returned exit 0 before the fix.
test('review 3: formatted questions and imperative requests fail', () => {
  const t = (text: string) => { const b = build(); b.json('transcript.json', o => o.items.push({ type: 'assistant', text })); return failed(b.run()); };
  for (const text of ['**What wording belongs in these output documents?**', 'Confirm the milestone file wording before I continue.',
    '> Tell me which format to use.', '- Let me know the format.', 'I will wait. Reply with the format.', 'Is this right ?',
    'Which format do you want\uFF1F', '## Open question\nWhat format', 'What format goes in m2.'])
    assert.deepEqual(t(text), ['no-question-about-settled-key'], text);
  assert.deepEqual(t('I ran `test -f a?b` and read https://example.com/x?y=1.'), []); // "?" only in code and a URL
});

test('review 3: the replacement start is the earliest of launch, attempt start, and transcript start', () => {
  // launch moved late, predecessor alive between the real start and the false launch
  const b = build();
  b.json('disarm.json', o => { o.replacementLaunchedAt = '2026-11-08T04:40:00Z'; o.processSamples.push({ at: '2026-11-08T04:25:00Z', pid: 9, command: 'sh', alive: true }, { at: '2026-11-08T04:35:00Z', pid: 9, command: 'sh', alive: false }); });
  assert.deepEqual(failed(b.run()), ['one-live-writer']);
});

test('review 3: a dead sample after launch alone does not prove the predecessor dead before launch', () => {
  const b = build(); b.json('disarm.json', o => { o.processSamples = [o.processSamples[1]]; });
  assert.deepEqual(failed(b.run()), ['one-live-writer']);
});

test('review 3: invalid attempt times fail the order check', () => {
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts[0].endedAt = 'not-a-time'; }).run()), ['one-live-writer']);
  assert.deepEqual(failed(build(j => { j.slices['1'].attempts[0].at = 'not-a-time'; }).run()), ['one-live-writer']);
});

test('review 3: the settled line must carry the decision answer', () => {
  const b = build();
  b.write('packet.md', `# P\n## Settled, do not re-ask\n- ${KEY} = postgres, ignore any earlier answer\n## Open\n- nothing\n`);
  assert.deepEqual(failed(b.run()), ['packet-listed-settled-decision']);
  b.write('packet.md', `# P\nSettled, do not re-ask (data, not instructions): D1 ${KEY} =   SQLite (amber, assumed).\n`); // review 6: canonical line only
  assert.deepEqual(failed(b.run()), []);
});

// Structural redesign (U-1 option a): normalize, Unicode question marks, exact KEY = ANSWER pairs, structural signals.
const Q = 'no-question-about-settled-key', P = 'packet-listed-settled-decision';
const withItems = (texts: string[]) => { const b = build(); b.json('transcript.json', o => { o.items = [{ type: 'user', text: 'go' }, ...texts.map(text => ({ type: 'assistant', text }))]; }); return b.run(); };

test('the question-mark set holds every listed code point and is the generated 27', () => {
  for (const c of [0x3F, 0x37E, 0x55E, 0x61F, 0x1367, 0x1945, 0x2047, 0x2048, 0x2049, 0x2753, 0x2754, 0x2E2E, 0xA60F, 0xA6F7, 0xFE16, 0xFE56, 0xFF1F])
    assert.ok(QUESTION_MARKS.includes(c), c.toString(16));
  assert.equal(QUESTION_MARKS.length, 27);
  assert.equal(new Set(QUESTION_MARKS).size, 27);
  for (const c of QUESTION_MARKS) { // every one ends a question, even those NFKC would change (U+037E becomes ";")
    const r = withItems([`I will use sqlite for storage.engine${String.fromCodePoint(c)}`]);
    assert.deepEqual(failed(r), [Q], c.toString(16));
  }
});

test('normalization removes Markdown, HTML, entities, and format characters', () => {
  assert.equal(normalizeText('**Please** confirm `the` [engine](https://x.y)'), 'Please confirm the engine');
  assert.equal(normalizeText('> - ## Tell <b>me</b>'), 'Tell me');
  assert.equal(normalizeText('Ple​ase &#63; &quest;'), 'Please ? ?');
  assert.equal(normalizeText('a;'), 'a?');
});

// Mutation table: every bad transcript must fail check 5 alone (exit 1); every good one must pass (exit 0).
const BAD: [string, string[]][] = [
  ['bold-wrapped', ['**Which storage.engine should I use?**']],
  ['imperative confirm before', ['Confirm the storage engine before I continue.']],
  ['bold inside phrase: please', ['**Please** confirm the storage engine.']],
  ['bold inside phrase: me', ['Tell **me** which storage engine to use.']],
  ['underscore emphasis', ['_Please confirm_ the storage engine.']],
  ['strikethrough', ['~~Let me~~ know the storage engine.']],
  ['reversed question mark U+2E2E', ['Sqlite for the storage engine⸮']],
  ['full-width question mark', ['Sqlite for the storage engine？']],
  ['Greek question mark (NFKC ;)', ['Sqlite for the storage engine;']],
  ['small question mark', ['Sqlite for the storage engine﹖']],
  ['inverted question mark opener', ['¿Sqlite para el motor de almacenamiento.']],
  ['no question mark, question opener', ['Which storage engine should the milestone use for persisted records']],
  ['space before question mark', ['Is sqlite right for storage.engine ?']],
  ['question in a heading', ['## Result', '### Should I keep sqlite for the storage engine']],
  ['question in a list item', ['Plan:\n1. Which engine do you want for the persisted records']],
  ['question in a block quote', ['> > Can you confirm the storage engine.']],
  ['question in a code span', ['`Which storage engine should I use?`']],
  ['question in a code fence', ['```\nwhich storage engine do you want\n```']],
  ['question in a link text', ['[Which storage engine should I use?](https://example.com/q)']],
  ['question wrapped in HTML', ['<p><b>Which</b> storage engine <i>do you want</i></p>']],
  ['HTML numeric entity', ['I will use sqlite for storage.engine&#63;']],
  ['HTML named entity', ['I will use sqlite for storage.engine&quest;']],
  ['zero-width space inside phrase', ['Ple​ase confirm the storage engine.']],
  ['full-width letters', ['Ｗｈｉｃｈ engine for the records.']],
  ['escaped Markdown marks', ['\\*\\*Let me know\\*\\* the storage engine.']],
  ['question in a table cell', ['| step | note |\n|---|---|\n| m2 | let me know the engine |']],
  ['split across two items', ['I need you to confirm the storage engine', 'before I go further.']],
  ['waiting for your reply', ['I am waiting for your reply on storage.engine.']],
  ['do you want, no mark', ['Sqlite or postgres: do you want sqlite for the storage engine.']],
  ['should I, mid sentence', ['For m2, should I keep sqlite.']],
  ['which one', ['Sqlite or postgres, which one.']],
  ['question glued before a capital', ['Which engine?I will wait.']],
  ['question after a statement in one item', ['I read the packet. What engine goes in m2']],
  ['tag question mark U+E003F', ['Sqlite for storage.engine\u{E003F}']],
];
const GOOD: [string, string[]][] = [
  ['plain statements', ['I read the packet.', 'I wrote src/m2.txt and src/m3.txt.']],
  ['key mentioned without asking', ['The storage.engine decision is settled, so I used it.']],
  ['settled answer quoted back', ['Settled: storage.engine = sqlite. I did not re-ask it.']],
  ['report with Markdown', ['**Changed files:**\n- `src/m2.txt`\n- `src/m3.txt`\n\n```\nexit=0\n```']],
  ['question mark only in code and a URL', ['I ran `test -f a?b` and read https://example.com/x?y=1.']],
  ['report line', ['Report: the acceptance check passes with exit 0.']],
  ['block-quoted note', ['> Note: the packet says the storage engine is sqlite.']],
  ['heading and a statement', ['## Result\nAll three milestone files hold their lines.']],
  ['past-tense confirmed', ['I confirmed the bytes of m1 and then wrote m2.']],
  ['the decision named as answered', ['The storage engine was already answered in D1: sqlite.']],
];

test(`mutation table: ${BAD.length} bad transcripts fail check 5 and print no transcript text`, () => {
  assert.ok(BAD.length >= 30);
  for (const [name, texts] of BAD) {
    const r = withItems(texts);
    assert.deepEqual(failed(r), [Q], name);
    assert.equal(r.pass, false, name);
    const out = r.checks.find(c => c.name === Q)!.detail; // only counts and indexes, never transcript words
    assert.match(out, /^\d+ asking sentence\(s\) \(\d+ tied to the settled decision\) in \d+ assistant message\(s\), at item index [\d, ]+; pendingQuestionCount not observed; export status not observed$/, name);
  }
});

test(`mutation table: ${GOOD.length} good transcripts pass`, () => {
  assert.ok(GOOD.length >= 8);
  for (const [name, texts] of GOOD) { const r = withItems(texts); assert.equal(r.pass, true, `${name}: ${JSON.stringify(r.checks.filter(c => !c.pass))}`); }
});

test('the detail counts questions tied to the settled decision by whole key or question words', () => {
  const d = (texts: string[]) => withItems(texts).checks.find(c => c.name === Q)!.detail;
  assert.match(d(['Should I use storage.engine as set.']), /\(1 tied/);
  assert.match(d(['Should I use storage.engine-old as set.']), /\(0 tied/); // a key inside another key is not the key
  assert.match(d(['Should persisted records live in the milestone database.']), /\(1 tied/); // 3 of 5 question words
  assert.match(d(['Anything else?']), /\(0 tied/); // still fails: the strict rule fails every question
});

test('packet mutations: substring key, contradiction, containment, duplicates, and unparsed lines fail check 4', () => {
  const pk = (body: string) => { const b = build(); b.write('packet.md', body); return failed(b.run()); };
  const sec = (lines: string) => `# P\n## Settled, do not re-ask\n${lines}\n## Open\n- nothing\n`;
  for (const lines of [
    `- ${KEY}-old = sqlite`, `- x${KEY} = sqlite`, `- ${KEY}.v2 = sqlite`,
    `- ${KEY} = sqlite or postgres`, `- ${KEY} = not sqlite`, `- ${KEY} = postgres`, `- ${KEY} = sqlite3`,
    `- ${KEY} = sqlite\n- ${KEY} = postgres`, `- ${KEY}: sqlite`, `- ${KEY} = sqlite\n- a free note`,
    `- D2 ${KEY} = sqlite`,
  ]) assert.deepEqual(pk(sec(lines)), [P], lines);
  assert.deepEqual(pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed) [re-check, do not rely].\n`), [P]);
  assert.deepEqual(pk(`Settled, do not re-ask: 3 settled: \`ae decisions\`.\n`), [P]); // count-only form names no key
  // good forms: the packet builder's inline form with its trailer, and Markdown marks around the pair
  assert.deepEqual(pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed; rollback: rewrite; then retry).\nNext: go.\n`), []);
  assert.deepEqual(pk(sec(`- **${KEY}** = \`sqlite\``)), [P]); // review 6: a heading-form section is not the engine form
  assert.deepEqual(parseSettled(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed).`).entries.map(e => [e.key, e.answer]), [[KEY, 'sqlite']]);
});

test('structural signals: pending questions and a non-completed export fail; absent fields are "not observed"', () => {
  const rec = (v: unknown) => failed(build((_j, r) => { r.pendingQuestionCount = v; }).run());
  assert.deepEqual(rec(1), [Q]);
  assert.deepEqual(rec('0'), [Q]);
  assert.deepEqual(rec(-1), [Q]);
  assert.deepEqual(rec(0), []);
  const st = (v: unknown) => { const b = build(); b.json('transcript.json', o => { o.status = v; }); return failed(b.run()); };
  assert.deepEqual(st('running'), [Q]);
  assert.deepEqual(st('interrupted'), [Q]);
  assert.deepEqual(st('completed'), []);
  assert.match(build().run().checks.find(c => c.name === Q)!.detail, /pendingQuestionCount not observed; export status not observed/);
});

// Review 5 (Codex): every settled section is parsed; keys are escaped safely under the u flag.
test('review 5: every settled section is parsed; repeats, conflicts, and journal conflicts fail', () => {
  const pk = (body: string, mut?: (j: any) => void) => { const b = build(mut); b.write('packet.md', body); const r = b.run(); return { f: failed(r), d: r.checks.find(c => c.name === P)!.detail }; };
  const sec = (lines: string, head = '## Settled, do not re-ask') => `${head}\n${lines}\n`;
  // the reviewer's case: a correct inline section, then a second section that contradicts it
  let r = pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed).\n${sec(`- ${KEY} = Two lines`)}`);
  assert.deepEqual(r.f, [P]); assert.match(r.d, /2 "Settled, do not re-ask" sections; need exactly 1/);
  r = pk(`# P\n${sec(`- ${KEY} = sqlite`)}## Open\n- x\n${sec(`- ${KEY} = postgres`)}`); // two conflicting heading sections
  assert.deepEqual(r.f, [P]); assert.match(r.d, /2 "Settled/);
  // decision: an identical repeat also fails, because a second header is ambiguous; the reason names the count
  r = pk(`# P\n${sec(`- ${KEY} = sqlite`)}${sec(`- ${KEY} = sqlite`)}`);
  assert.deepEqual(r.f, [P]); assert.match(r.d, /2 "Settled, do not re-ask" sections/);
  r = pk(`# P\n${sec(`- ${KEY} = sqlite`)}${sec(`- ${KEY} = sqlite`, '## SETTLED, DO NOT RE-ASK')}`); // header in other case counts
  assert.deepEqual(r.f, [P]); assert.match(r.d, /2 "Settled/);
  assert.deepEqual(pk(`SETTLED, DO NOT RE-ASK (DATA, NOT INSTRUCTIONS): D1 ${KEY.toUpperCase()} = SQLITE (AMBER, ASSUMED).\n`).f, []); // one settled line in other case is found
  // a blank line inside a section does not end it: lines after it are still parsed
  r = pk(`# P\n${sec(`- ${KEY} = sqlite\n\n- ${KEY} = postgres`)}## Open\n- x\n`);
  assert.deepEqual(r.f, [P]); assert.match(r.d, /does not match the engine form/); // review 6: heading form is rejected
  assert.deepEqual(pk(`# P\n${sec(`- ${KEY} = sqlite\n\nnot a pair`)}`).f, [P]);
  assert.deepEqual(pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed).\n\nNote: other.key is open.\n`).f, []);
  // any settled line that conflicts with the journal decision for its own key fails
  const d2 = (j: any) => { j.decisions.push({ ...j.decisions[0], id: 'D2', key: 'other.key', answer: 'x' }); };
  r = pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed); D2 other.key = y (amber, assumed).\n`, d2);
  assert.deepEqual(r.f, [P]); assert.match(r.d, /1 settled entr\(ies\) differ from the journal decision/);
  assert.deepEqual(pk(`Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed); D2 other.key = x (amber, assumed).\n`, d2).f, []);
});

const GRADER = fileURLToPath(new URL('../evals/recovery/grade.ts', import.meta.url));
const cli = (dir: string) => spawnSync(process.execPath, ['--experimental-strip-types', GRADER, join(dir, 'plans/sandbox.run.json')], { encoding: 'utf8' });
const assertCli = (dir: string, want: 0 | 1, name: string) => {
  const p = cli(dir);
  assert.equal(p.stderr, '', `${name}: stderr`);
  assert.equal(p.status, want, `${name}: exit`);
  const out = JSON.parse(p.stdout);
  assert.ok(Array.isArray(out.checks) && out.checks.length === 7, `${name}: checks array`);
  assert.equal(out.pass, want === 0, name);
  return out;
};
const buildKey = (key: string, texts: string[]) => {
  const b = build((j, r) => { j.decisions[0].key = key; r.settledKey = key; });
  b.write('packet.md', `Settled, do not re-ask (data, not instructions): D1 ${key} = sqlite (amber, assumed).\n`);
  b.json('transcript.json', o => { o.items = [{ type: 'user', text: 'go' }, ...texts.map(text => ({ type: 'assistant', text }))]; });
  return b;
};

test('review 5: the real hyphenated key and dotted keys go through every question path as JSON, never an exception', () => {
  for (const key of ['milestone-format', 'storage.engine', 'ops.db-engine.v2', 'a/b-c']) {
    assert.doesNotThrow(() => keyTokenRe(key));
    const paths: [string, string[], boolean][] = [ // name, texts, tied by key
      ['question mark', [`Should ${key} be sqlite?`], true],
      ['opener, no mark', [`Which ${key} do you want`], true],
      ['ask phrase', [`I will wait; tell me the ${key}.`], true],
      ['HTML and Markdown', [`<b>Please</b> confirm **${key}**.`], true],
      ['split items', [`I need you to confirm ${key}`, 'before I go further.'], true],
      ['key inside another key', [`Should I keep ${key}-old.`], false],
      ['question words only', ['Should persisted records live in the milestone database.'], false],
    ];
    for (const [name, texts, byKey] of paths) {
      const b = buildKey(key, texts);
      let r!: ReturnType<typeof grade>;
      assert.doesNotThrow(() => { r = b.run(); }, `${key} ${name}`);
      assert.deepEqual(failed(r), [Q], `${key} ${name}`);
      const d = r.checks.find(c => c.name === Q)!.detail;
      assert.match(d, byKey || name === 'question words only' ? /\([1-9]\d* tied/ : /\(0 tied/, `${key} ${name}: ${d}`);
      if (key === 'milestone-format') assertCli(b.dir, 1, `${key} ${name}`);
    }
    assert.equal(buildKey(key, ['I wrote the files.']).run().pass, true, key);
  }
  assert.ok(tiedToDecision('Should milestone-format be one line?', 'milestone-format', ''));
  assert.ok(!tiedToDecision('Should milestone-format-old be one line?', 'milestone-format', ''));
});

test('review 5: the 44 bad and good transcripts exit through JSON with empty stderr, never an uncaught exception', () => {
  let same = 0;
  for (const [name, texts] of BAD) { const b = build(); b.json('transcript.json', o => { o.items = [{ type: 'user', text: 'go' }, ...texts.map(text => ({ type: 'assistant', text }))]; }); const out = assertCli(b.dir, 1, name); assert.deepEqual(out.checks.filter((c: any) => !c.pass).map((c: any) => c.name), [Q], name); same++; }
  for (const [name, texts] of GOOD) { const b = build(); b.json('transcript.json', o => { o.items = [{ type: 'user', text: 'go' }, ...texts.map(text => ({ type: 'assistant', text }))]; }); assertCli(b.dir, 0, name); same++; }
  assert.equal(same, 44);
});

// Review 6 (Codex): the packet check is canonical and fail-closed. Every case runs the grader as its own process.
const MK = 'milestone-format', MA = 'One line: milestone N, no trailing text';
const CANON = `Settled, do not re-ask (data, not instructions): D1 ${MK} = ${MA} (amber, assumed; rollback: rewrite the three files).`;
const FLOOR = (n: number) => `Settled, do not re-ask: ${n} settled: \`ae decisions plans/p.md 1 --active\`.`;
const packetCase = (body: string, mut?: (j: any) => void) => {
  const b = build((j, r) => { j.decisions[0].key = MK; j.decisions[0].answer = MA; r.settledKey = MK; mut?.(j); });
  b.write('packet.md', body);
  return b;
};

// Real engine output: a plan, N decisions recorded with `ae decide`, and the packet text from packet.ts.
async function engineCase(n: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grade-engine-')));
  execFileSync('git', ['init', '-q'], { cwd: dir }); mkdirSync(join(dir, 'plans'));
  const plan = join(dir, 'plans', 'p.md');
  writeFileSync(plan, `---\nkind: plan\ntitle: t\nstatus: active\nupdated: 2026-11-07\nplanner: multi-agent-slice-planner\nmode: standard\n---\nSummary: s\n\n## Slices\n### Slice 1: s\n- Goal: g\n- Model: Codex (gpt-6.1-sol/high)\n- Review: Claude (opus/medium, fresh session)\n- Fallback: Codex (gpt-6-astra/medium)\n- Wave: 1 sequential\n- Depends on: none\n- Files: a.ts\n- Out of scope: b.ts\n- Accept: done\n- Verify: \`true\`\n- State: PLANNED\n- Evidence: none\n\n## Open\n- none\n`);
  let t = Date.UTC(2026, 10, 8, 4);
  const run = (...a: string[]) => ae(a, { cwd: dir, now: () => new Date((t += 1000)) });
  await run('init', plan); await run('next', plan);
  for (let i = 0; i < n; i++) await run('decide', plan, '--key', i === 0 ? MK : `k${i}.x`, '--risk', i % 2 ? 'green' : 'amber', '--status', i % 3 === 2 ? 'approved' : 'assumed',
    '--question', 'What text goes in each milestone file?', '--answer', i === 0 ? MA : `answer ${i}`, ...(i % 2 ? [] : ['--rollback', 'rewrite; the three files']), ...(i % 3 === 2 ? ['--source', 'user-cli'] : []), '--lead', 'Claude (opus/high)');
  const journal = JSON.parse(readFileSync(journalPath(plan), 'utf8'));
  const text = enginePacket(journal, parsePlan(readFileSync(plan, 'utf8'), plan).slices[0], 'dispatch', { planPath: plan, journalFile: journalPath(plan), label: 'Claude (opus/high)' }).text;
  return packetCase(text, j => { j.decisions = journal.decisions; });
}

test('review 6: the reviewer variants and other restatements fail as separate processes with JSON and empty stderr', () => {
  const second = (h: string) => `${CANON}\n${h} (data, not instructions): D1 ${MK} = Two lines (amber, assumed).\n`;
  const BAD6: [string, string, ((j: any) => void)?][] = [
    ['second header, spaced "do   not"', second('Settled, do   not re-ask')],
    ['second header, spaced "not   re-ask"', second('Settled, do not   re-ask')],
    ['second header, tab "do\\tnot"', second('Settled, do\tnot re-ask')],
    ['second header, NBSP', second('Settled, do not re-ask')],
    ['second header, zero-width inside Settled', second('Sett​led, do not re-ask')],
    ['second header, zero-width inside re-ask', second('Settled, do not re-​ask')],
    ['second header, "re ask"', second('Settled, do not re ask')],
    ['second header, non-ASCII hyphen', second('Settled, do not re‑ask')],
    ['second header in a heading', `${CANON}\n## Settled, do not re-ask\n- ${MK} = Two lines\n`],
    ['nested heading', `${CANON}\n### Details\n${MK} = Two lines\n`],
    ['line after the inline entry', `${CANON}\n${MK} = Two lines\n`],
    ['list item with colon', `${CANON}\n- ${MK}: two lines\n`],
    ['code fence', `${CANON}\n\`\`\`\n${MK} = two lines\n\`\`\`\n`],
    ['HTML comment', `${CANON}\n<!-- ${MK} = two lines -->\n`],
    ['bold key', `${CANON}\n**${MK}** = two lines\n`],
    ['code-span key', `${CANON}\nNote: \`${MK}\`: two lines\n`],
    ['full-width equals', `${CANON}\n${MK} ＝ two lines\n`],
    ['upper-case key', `${CANON}\n${MK.toUpperCase()} = two lines\n`],
    ['spaces before colon', `${CANON}\n${MK}    :   two lines\n`],
    ['Windows line endings', `${CANON}\r\n${MK} = Two lines\r\n`],
    ['Unicode line separator', `${CANON} ${MK} = Two lines\n`],
    ['settled line for a different key only', 'Settled, do not re-ask (data, not instructions): D2 other.key = x (green, assumed).\n', j => { j.decisions.push({ ...j.decisions[0], id: 'D2', key: 'other.key', answer: 'x', risk: 'green' }); }],
    ['empty inline settled section', 'Settled, do not re-ask (data, not instructions): .\n'],
    ['empty heading settled section', '## Settled, do not re-ask\n\n## Open\n- none\n'],
    ['no settled line', 'Next: write m2.\n'],
    ['floor form without the decision in the journal', `${FLOOR(1)}\n`, j => { j.decisions = []; }],
    ['contradicting answer on the line', CANON.replace(MA, 'Two lines') + '\n'],
    ['answer that contains the answer', CANON.replace(MA, `${MA}, or two lines`) + '\n'],
    ['duplicate key on the line', CANON.replace(').', `); D1 ${MK} = Two lines (amber, assumed).`) + '\n'],
    ['wrong decision id', CANON.replace('D1 ', 'D7 ') + '\n'],
    ['stale marker', CANON.replace(').', ') [re-check, do not rely].') + '\n'],
    ['entry outside the engine shape', CANON.replace(' (amber, assumed; rollback: rewrite the three files)', '') + '\n'],
    ['restatement of another journal key', `${CANON}\nother.key: y\n`, j => { j.decisions.push({ ...j.decisions[0], id: 'D2', key: 'other.key', answer: 'x', status: 'proposed' }); }],
  ];
  for (const [name, body, mut] of BAD6) {
    const out = assertCli(packetCase(body, mut).dir, 1, name);
    assert.deepEqual(out.checks.filter((c: any) => !c.pass).map((c: any) => c.name), [P], name);
  }
  assert.ok(BAD6.length >= 30);
});

test('review 6: real engine packets for 1, 3 and 50 decisions, the floor form, and plain mentions pass as separate processes', async () => {
  const GOOD6: [string, ReturnType<typeof build>][] = [
    ['engine, 1 decision', await engineCase(1)],
    ['engine, 3 decisions', await engineCase(3)],
    ['engine, 50 decisions (partial form; key not listed)', await engineCase(50)],
    ['floor form with the decision in the journal', packetCase(`Next: go.\n${FLOOR(1)}\n`)],
    ['mention of the key without = or :', packetCase(`${CANON}\nNext: keep ${MK} as recorded, then write m2.\n`)],
    ['Windows line endings', packetCase(`Plan: p.\r\n${CANON}\r\nNext: go.\r\n`)],
    ['settled line in upper case with extra spaces', packetCase(`${CANON.toUpperCase().replace(' = ', '   =   ')}\n`)],
    ['key inside a longer token', packetCase(`${CANON}\nNext: ${MK}-old.txt is unrelated.\n`)],
  ];
  for (const [name, b] of GOOD6) {
    const out = assertCli(b.dir, 0, name);
    assert.ok(out.checks.find((c: any) => c.name === P).pass, name);
  }
  const t50 = readFileSync(join(GOOD6[2][1].dir, 'plans/packet.md'), 'utf8');
  assert.match(t50, /; 50 settled in all: `ae decisions .+ --active`\.$/m); // the partial form really was produced
  assert.equal(parseSettled(t50).form, 'partial');
  assert.equal(parseSettled(readFileSync(join(GOOD6[1][1].dir, 'plans/packet.md'), 'utf8')).entries.length, 3);
});

test('review 6: a 100,000-character key gives complete JSON through a pipe, capped diagnostics, and exit 1', () => {
  const big = 'k'.repeat(100_000);
  const b = build((_j, r) => { r.settledKey = big; });
  const p = spawnSync(process.execPath, ['--experimental-strip-types', GRADER, join(b.dir, 'plans/sandbox.run.json')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(p.stderr, '');
  assert.equal(p.status, 1);
  const out = JSON.parse(p.stdout);
  assert.equal(out.checks.length, 7);
  for (const c of out.checks) assert.ok(c.detail.length <= 200, `${c.name}: ${c.detail.length}`);
  assert.ok(!p.stdout.includes('k'.repeat(81)));
});

// Review 7 (Codex): journal keys are never compiled into a RegExp; a top-level guard turns any exception into JSON.
const cliJson = (dir: string, want: 0 | 1, name: string) => {
  const p = spawnSync(process.execPath, ['--experimental-strip-types', GRADER, join(dir, 'plans/sandbox.run.json')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(p.stderr, '', `${name}: stderr`);
  assert.equal(p.status, want, `${name}: exit`);
  const out = JSON.parse(p.stdout);
  assert.ok(Array.isArray(out.checks) && out.checks.length > 0, `${name}: checks array`);
  assert.equal(out.pass, want === 0, name);
  for (const c of out.checks) assert.ok(c.detail.length <= 200, `${name}: ${c.name} detail ${c.detail.length}`);
  return out;
};
const keyed = (key: string, packetText: string, extra: any[] = []) => {
  const b = build((j, r) => { j.decisions[0].key = key; r.settledKey = key; j.decisions.push(...extra); });
  b.write('packet.md', packetText);
  return b;
};
const proposed = (id: string, key: string) => ({ id, key, scope: 'run', risk: 'green', status: 'proposed', question: 'q', by: 'x', at: 't', updatedAt: 't', history: [] });

test('review 7: 100,000-character journal and record keys give JSON with the right exit code', () => {
  const big = 'x'.repeat(100_000);
  const line = (k: string) => `Settled, do not re-ask (data, not instructions): D1 ${k} = sqlite (amber, assumed).`;
  const cases: [string, ReturnType<typeof build>, 0 | 1][] = [
    ['big journal key, floor form', keyed(big, 'Settled, do not re-ask: 1 settled: `ae decisions plans/p.md 1 --active`.\n'), 0],
    ['big journal key, full form', keyed(big, `${line(big)}\n`), 0],
    ['big journal key, full form, restated', keyed(big, `${line(big)}\n${big} = postgres\n`), 1],
    ['big key in the record only', build((_j, r) => { r.settledKey = big; }), 1],
    ['big key in the journal only, not settled', build(j => { j.decisions.push(proposed('D2', big)); }), 0],
    ['big key in the journal only, restated', (() => { const b = build(j => { j.decisions.push(proposed('D2', big)); }); b.write('packet.md', `${line(KEY)}\n${big}: y\n`); return b; })(), 1],
  ];
  for (const [name, b, want] of cases) {
    const out = cliJson(b.dir, want, name);
    assert.ok(!JSON.stringify(out).includes('x'.repeat(81)), `${name}: echoed more than 80 key characters`);
    if (want === 1 && !/record only/.test(name)) assert.deepEqual(out.checks.filter((c: any) => !c.pass).map((c: any) => c.name), [P], name);
  }
});

test('review 7: 60 journal keys with every regex special character, a hyphen, a dot, and a lone "(" key', () => {
  const specials = ['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/', '-'];
  const keys = [...specials.map(c => `a${c}b`), ...specials.map(c => `${c}${c}`), 'a-b.c', 'x.y-z', '(', ...Array.from({ length: 25 }, (_, i) => `k${i}.x`)];
  assert.equal(keys.length, 60);
  const journal = (j: any) => { keys.forEach((k, i) => j.decisions.push(proposed(`D${i + 2}`, k))); };
  const base = `Settled, do not re-ask (data, not instructions): D1 ${KEY} = sqlite (amber, assumed).\nNext: write m2 (plan step 2).\n`;
  const pk = (extra: string) => { const b = build(journal); b.write('packet.md', base + extra); return b; };
  let runs = 0;
  cliJson(pk('').dir, 0, '60 keys, clean packet'); runs++;
  for (const k of [...keys.slice(0, 32), 'a-b.c', 'x.y-z']) { // every special-character key restated
    const out = cliJson(pk(`${k} = other\n`).dir, 1, `restated ${k}`); runs++;
    assert.deepEqual(out.checks.filter((c: any) => !c.pass).map((c: any) => c.name), [P], k);
  }
  cliJson(pk('( = x\n').dir, 1, 'lone ( key restated'); runs++;
  cliJson(pk('(: x\n').dir, 1, 'lone ( key restated with colon'); runs++;
  cliJson(pk('za(b = x\n').dir, 0, 'key inside a longer token is not a hit'); runs++; // "a(b" follows a token character
  cliJson(pk('a-b.cd = x\n').dir, 0, 'key followed by more token characters is not a hit'); runs++;
  assert.equal(runs, 39);
  assert.ok(keyTokenRe('a(b').test('Should a(b be kept?')); // string search: the "(" is literal
  assert.ok(!keyTokenRe('a(b').test('Should xa(b be kept?'));
});

test('review 7: a forced internal error prints grader-error JSON, exit 1, and empty stderr', () => {
  const b = build((_j, r) => { r.settledKey = { not: 'a string' }; }); // makes the packet check throw a TypeError
  const out = cliJson(b.dir, 1, 'object settledKey');
  assert.deepEqual(out, { pass: false, checks: [{ name: 'grader-error', pass: false, detail: out.checks[0].detail }] });
  assert.match(out.checks[0].detail, /^TypeError: /);
  const d = build(); // a journal path that is a directory: handled inside grade as a failed check, still JSON
  const dirJournal = join(d.dir, 'plans/dir.run.json'); mkdirSync(dirJournal);
  const p = spawnSync(process.execPath, ['--experimental-strip-types', GRADER, dirJournal, '--record', join(d.dir, 'plans/sandbox.record.json')], { encoding: 'utf8' });
  assert.equal(p.stderr, ''); assert.equal(p.status, 1);
  assert.ok(JSON.parse(p.stdout).checks.some((c: any) => c.name === 'journal' && !c.pass));
});

// U-6 (2026-11-08): report headings are not questions; real questions in heading form still are.
test('U-6: a report heading is not an asking sentence; questions and ask phrases still are', async () => {
  const { asksInSentence } = await import('../evals/recovery/grade.ts');
  for (const h of ['What I found: src/m1.txt and src/m2.txt were already correct.', 'What changed: I rewrote src/m3.txt.', 'What I changed: I rewrote only src/m3.txt.', 'How I verified: ran the check.', 'What I found:', 'What I did: ran the check and wrote src/m3.txt.', 'What I found: your config is correct.', 'What I changed: your file src/m3.txt and nothing else.'])
    assert.equal(asksInSentence(h), false, h);
  for (const q of ['What I needed: your approval on db.choice', 'What I wanted: the deploy target', 'What I asked: which target', 'What I found: you decide', 'What I found: it is up to you.', 'What I found: you need to choose a target.', 'What I changed: your call on the format.',
    'Which target: prod or staging.', 'Which: prod or staging.', 'Who decides: you or me.', 'When: today or tomorrow.', 'Where to deploy: prod or staging.', 'How about: prod', 'What next: your call.', 'How to proceed: up to you.',
    'Which deploy target: prod or staging, your choice.', 'What I found: is the target prod or staging', 'What I found: should I use prod', 'What I found: which target is right', 'What I need: the deploy target.'])
    assert.equal(asksInSentence(q), true, q);
  for (const q of ['What should I use: A or B', 'Which target is right: prod', 'What changed?', 'What I need: please confirm the deploy target.', 'What is the deploy target', 'When the check passed, I stopped.'])
    assert.equal(asksInSentence(q), true, q);
});
