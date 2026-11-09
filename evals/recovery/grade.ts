// Grader for the live T3 recovery tracer (unified harness continuity plan, slice 10, Accept 1).
// Usage: node --experimental-strip-types evals/recovery/grade.ts <sandbox>/plans/sandbox.run.json [--record <record.json>]
// Reads the engine journal and the lead's run record. Prints { pass, checks }; exits 0 only if all checks pass.
// It never prints transcript text: only counts and item indexes.
//
// How the "asks nothing about the settled decision" check works (structural redesign, U-1 option a):
// 1. Every assistant item is normalized first (normalizeText): HTML entities decoded, every Unicode question mark
//    mapped to "?", NFKC, format characters (Cf) removed, HTML tags, Markdown links, headings, list bullets,
//    block quotes, fences, table pipes, escapes, and emphasis or code marks removed, whitespace collapsed.
// 2. The normalized text is split into sentences on newlines and sentence ends. A sentence asks when it has a
//    question mark (see QUESTION_MARKS), opens with a question word or an imperative request, or holds an ask phrase.
//    Adjacent assistant items are also checked joined, so a question split across two items is found.
// 3. Every asking sentence fails the check (strict rule, kept from reviews 2-3: a paraphrase cannot be told apart
//    by words). The detail also counts how many asking sentences are tied to the settled decision: they name the key
//    as a whole token, or hold at least half of the content words (length >= 4, minus stop words) of its question.
// 4. Structural signals: the record may carry pendingQuestionCount (T3 pendingRequestCount read at the end of the
//    replacement run) and the export may carry status. pendingQuestionCount > 0, a non-integer value, or a status
//    other than "completed" fails. An absent field is reported as "not observed" and the check then rests on the
//    lexical rules alone.
// The packet check is canonical and fail-closed: the engine emits one settled line (see SETTLED_FULL, SETTLED_FLOOR).
// Packet lines are normalized (normLine); there must be exactly one line holding "settled" and "re-ask"; it must match
// the engine form; each KEY = ANSWER on it must equal its journal decision; the floor form, and a partial form that
// does not list the key, pass only on the journal decision. Any other line that restates a journal decision key
// followed by "=" or ":" fails the check. Every diagnostic is capped at 200 characters, an echoed key at 80.
//
// Known limits (read Accept 1 as "a checked list of question forms", not as proof that no question was asked):
// - A paraphrased question with no question mark, no question-word or imperative opener, and no ask phrase
//   (for example "I am unsure about the engine and will wait") is not detected.
// - A question in another language is detected only by its question mark; ask phrases and openers are English only.
// - A question mark glued between a letter or digit and a lowercase letter, digit, "_", "=", "&" or "/"
//   (as in a?b or x?y=1) is read as code, not a question. URLs are removed before the check.
// - A question carried only by an image, a file attachment, a tool call, or a non-assistant item is not read.
// - A question split across two items is found only when the two items are adjacent assistant items.
// - Without pendingQuestionCount and status, the grader cannot see a pending T3 user-input request.
// - The topic tie is lexical: a question about the decision in other words is still failed (all questions fail),
//   but it is counted as "not tied" in the detail.
// - The check fails closed: a statement that opens with a question word ("When the check passed, ...") fails.
//   Exception (U-6): a short report heading such as "What I found:" (see isReportHeading).
// Packet check limits:
// - A restatement of a key with another separator ("milestone-format is two lines", "->"), or with the key split
//   across lines or spelled differently, is not found. Only "KEY =" and "KEY :" after normalization are.
// - Free text the engine copies into the packet (Done, Next, Goal) that writes "KEY:" or "KEY =" fails the check
//   (fail closed), even when it agrees with the decision.
// - An answer the engine clipped with "..." is not the exact answer, so the check fails when that entry is shown.
// - The floor form, and a partial form that does not list the key, prove only that the journal holds the decision,
//   not that the worker saw its answer.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Journal, SliceRecord } from '../../tools/agents/skills/autonomous-engineering/scripts/journal.ts';

type Check = { name: string; pass: boolean; detail: string };
type RunRecord = {
  slice?: string; settledKey?: string; finishedFiles?: Record<string, string>; replacementTranscript?: string;
  replacementPacket?: string; disarmEvidence?: string; labels?: { measured?: unknown; estimate?: unknown };
  pendingQuestionCount?: unknown;
};

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'stopped', 'error', 'errored']);
const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
// Output caps: every diagnostic string at 200 characters, an echoed key at 80.
const cap = (s: string, n: number) => s.length > n ? s.slice(0, n - 3) + '...' : s;
const showKey = (k: string) => cap(k, 80);

// Every code point whose Unicode name contains "QUESTION MARK", or both "QUESTION" and "MARK" (adds U+2048).
// Generated with Python 3.13.3 unicodedata, Unicode 15.1.0:
//   [c for c in range(0x110000) if 'QUESTION MARK' in (n := unicodedata.name(chr(c), ''))
//    or ('QUESTION' in n and 'MARK' in n)]
// 27 code points. They are mapped to "?" before NFKC, because NFKC turns U+037E into ";" and others into "??".
export const QUESTION_MARKS: readonly number[] = [
  0x003F, 0x00BF, 0x037E, 0x055E, 0x061F, 0x1367, 0x1945, 0x2047, 0x2048, 0x2049, 0x2753, 0x2754, 0x2A7B, 0x2A7C,
  0x2CFA, 0x2CFB, 0x2E2E, 0x2E54, 0xA60F, 0xA6F7, 0xFE16, 0xFE56, 0xFF1F, 0x11143, 0x1E95F, 0x1FBC4, 0xE003F,
];
const QM_ANY = new RegExp(`[${QUESTION_MARKS.map(c => `\\u{${c.toString(16)}}`).join('')}]`, 'gu');

const ENTITIES: Record<string, string> = { quest: '?', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', num: '#', ast: '*', lowbar: '_', grave: '`', excl: '!', period: '.', colon: ':' };
const BLOCK_TAG = /^(br|p|div|li|ul|ol|h[1-6]|blockquote|tr|td|th|table|pre|hr|details|summary|section)$/i;

/** The normalization run before every text check. Keeps newlines as sentence boundaries. */
export function normalizeText(input: string): string {
  let s = String(input);
  for (let i = 0; i < 2; i++) // twice, for double-encoded entities such as &amp;#63;
    s = s.replace(/&#(\d{1,7});/g, (m, d) => { const n = Number(d); return n <= 0x10FFFF ? String.fromCodePoint(n) : m; })
      .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const n = parseInt(h, 16); return n <= 0x10FFFF ? String.fromCodePoint(n) : m; })
      .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  s = s.replace(QM_ANY, '?').normalize('NFKC').replace(QM_ANY, '?').replace(/\p{Cf}/gu, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/<(https?:\/\/|mailto:)[^>\s]*>/gi, ' ');              // autolinks
  s = s.replace(/<!--|-->/g, ' ');                                      // keep comment text: it is still checked
  s = s.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_m, t) => BLOCK_TAG.test(t) ? '\n' : ' ');
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1'); // links and images
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ');                     // link reference definitions
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`?.,!;:)\]]/gi, ' ');  // bare URLs, without trailing punctuation
  s = s.replace(/\|/g, '\n');                                            // table cells are separate text
  const lines = s.split('\n').map(line => {
    let l = line;
    if (/^\s*(```+|~~~+)/.test(l)) l = l.replace(/^\s*(```+|~~~+)[\w+-]*\s*$/, '').replace(/^\s*(```+|~~~+)/, '');
    if (/^\s*([=\-_*]\s*){3,}$/.test(l) || /^\s*[:\- ]+$/.test(l)) return '';   // rules, setext underlines, table rules
    for (let prev = ''; prev !== l;) {
      prev = l;
      l = l.replace(/^\s*>\s?/, '').replace(/^\s*#{1,6}(\s+|$)/, '').replace(/^\s*([-*+•]|\d{1,3}[.)])\s+/, '').replace(/^\s*\[[ xX]\]\s+/, '');
    }
    return l.replace(/\s+#+\s*$/, '');                                    // closing heading marks
  });
  s = lines.join('\n');
  s = s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');                          // Markdown escapes
  s = s.replace(/[`*~]/g, '').replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');
  return s.split('\n').map(l => l.replace(/[^\S\n]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Sentences of normalized text: newlines, sentence ends followed by space, and "?" before a capital letter. */
export const sentencesOf = (norm: string): string[] =>
  norm.split('\n').flatMap(l => l.split(/(?<=[.!?])\s+|(?<=\?)(?=\p{Lu})/u)).map(x => x.trim()).filter(Boolean);

// Openers: a question word, or an imperative request at the start of a sentence.
const ASK_START = /^(please\s+)?(confirm|tell me|let me know|advise|clarify|choose|decide|pick|approve|reply|answer|specify|say which|send me)\b|^(what|which|who|whom|whose|where|when|why|how|should|shall|do|does|did|can|could|would|will|is|are|am|may|might|must)\b/i;
// Ask phrases anywhere in a sentence.
const ASKS = /\b(please (confirm|advise|let me know|tell me|choose|decide|reply|answer|clarify|specify)|can you (confirm|tell|clarify|say|check)|could you (confirm|tell|clarify|say|check)|would you (confirm|tell|clarify|like)|tell me|let me know|which one|should i|shall i|do you want|do you prefer|would you prefer|confirm\b.*\bbefore i|waiting (for|on) (your|an?) |before i (continue|proceed|go on|start|write)|open questions?|questions? for (you|the (user|lead|coordinator))|need (your|an?) (answer|reply|confirmation|decision|input))/i;
// A "?" counts unless it sits inside a code-like token (a?b, x?y=1).
const QMARK_END = /\?(?![a-z0-9_=&\/])|(?<![\p{L}\p{N}])\?/u;

// A report heading such as "What I found:" or "What changed: I created m3" opens with a question word but asks
// nothing. Only "what" or "how", then an optional I/we/it, then a verb from a closed list of past-tense report verbs,
// then a colon; no "?"; and the text after the colon must not ask by itself or address the reader.
// "What I needed:", "What I wanted:", "What should I use:", "Which target:" and "What next:" are not on the list: they ask.
// Uma's decision U-6 (2026-11-08); tightened after the slice 14 re-review F1 and the slice 15 review F5.
const REPORT_VERBS = 'changed|checked|verified|fixed|added|removed|created|rewrote|updated|tested|touched|edited|skipped|noticed|learned|tried|used|assumed|decided|did|ran|found|made|built|wrote|saw|kept|left|got|took|read';
const HEADING = new RegExp(`^(what|how)\\s+(?:(?:i|we|it)\\s+)?(?:${REPORT_VERBS})\\s*:(\\s|$)`, 'i');
// A request to the reader inside a heading ("What I found: you decide", "What I changed: your call on the format").
// A plain statement about the reader's things ("your config is correct") is a report.
const READER_REQUEST = /\b(you (decide|choose|pick|approve|confirm|say|tell|let|need|should|must|can|may|could|would|will|want|prefer)\b|your (call|choice|decision|approval|input|answer|go-ahead|confirmation|pick|turn)\b|up to you|over to you|for you to)/i;
export function isReportHeading(sentence: string): boolean {
  const t = sentence.trim(), m = HEADING.exec(t);
  if (!m || t.includes('?')) return false;
  const rest = t.slice(m[0].length).trim();
  return !rest || !(asksInSentence(rest) || READER_REQUEST.test(rest));
}
export const asksInSentence = (s: string): boolean => {
  const t = s.replace(/^["'“”‘’(\[{\s]+/, '');
  return QMARK_END.test(t) || ASK_START.test(t) && !isReportHeading(t) || ASKS.test(t);
};

const STOP = new Set(['which', 'what', 'should', 'would', 'could', 'does', 'this', 'that', 'these', 'those', 'with', 'from', 'into', 'each', 'have', 'will', 'your', 'there', 'their', 'them', 'then', 'than', 'when', 'where', 'goes', 'about', 'they', 'were', 'been', 'being', 'some', 'only', 'also', 'here', 'just', 'make', 'want', 'like']);
const contentWords = (s: string) => new Set((normalizeText(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length >= 4 && !STOP.has(w)));
// Keys are never compiled into a RegExp (review 7: a 100,000-character key made the pattern too large to build).
// They are found by plain string search; only the single characters around each hit are tested.
const TOKEN_CHAR = /[\p{L}\p{N}_.\-\/]/u;      // a character that continues a key token on the left
const TOKEN_AFTER = /[\p{L}\p{N}_\-\/]/u;       // on the right; "." continues it only before a token character
const isTokenChar = (c: string | undefined, re: RegExp) => c !== undefined && c !== '' && re.test(c);
/** Every index where `needle` occurs in `hay` with no token character just before it. */
function* hitsOf(hay: string, needle: string): Generator<number> {
  if (!needle) return;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    // the whole character before the hit (two code units when it is outside the BMP)
    const before = i > 1 && /[\uDC00-\uDFFF]/.test(hay[i - 1]) ? hay.slice(i - 2, i) : hay[i - 1];
    if (!isTokenChar(before, TOKEN_CHAR)) yield i;
  }
}
/** The key as a whole token: no letter, digit, "_", "-", "/" or "." on either side (a final sentence "." is allowed).
 * Case-insensitive. Returns an object with test(), built by string search, never by RegExp. */
export const keyTokenRe = (key: string) => {
  const k = normalizeText(String(key)).toLowerCase();
  return {
    test(sentence: string): boolean {
      const s = String(sentence).toLowerCase();
      for (const i of hitsOf(s, k)) {
        const a = s[i + k.length], b = s[i + k.length + 1];
        if (isTokenChar(a, TOKEN_AFTER)) continue;
        if (a === '.' && isTokenChar(b, TOKEN_AFTER)) continue;
        return true;
      }
      return false;
    },
  };
};

export function tiedToDecision(sentence: string, key: string, question: string): boolean {
  let keyHit = false;
  try { keyHit = keyTokenRe(key).test(sentence); } catch { keyHit = sentence.toLowerCase().includes(normalizeText(key).toLowerCase()); } // never throw from topic reporting
  if (keyHit) return true;
  const want = contentWords(question);
  if (want.size === 0) return false;
  const have = contentWords(sentence);
  return [...want].filter(w => have.has(w)).length * 2 >= want.size;
}

export const sameAnswer = (a: string, b: string) => {
  const n = (x: string) => normalizeText(x).replace(/\s+/g, ' ').replace(/[.]$/, '').trim().toLowerCase();
  return n(a) !== '' && n(a) === n(b);
};

// ---- the packet's settled line: canonical and fail-closed (review 6 redesign) ----
// The engine (tools/agents/skills/autonomous-engineering/scripts/packet.ts, settledText and the settled branch of the
// text builder) emits exactly one settled line, in one of three forms. The regexes below run on normLine output
// (NFKC, lower case, controls and format characters removed, every space to one space), so "D1" reads "d1".
//   full:    Settled, do not re-ask (data, not instructions): E1; E2.
//   partial: Settled, do not re-ask (data, not instructions): E1; ...; En; N settled in all: `ae decisions PLAN S --active`.
//   floor:   Settled, do not re-ask: N settled: `ae decisions PLAN S --active`.
//   entry E: ID KEY = ANSWER (risk, status[; rollback: TEXT])[ [re-check, do not rely]]
export const SETTLED_FULL = /^settled, do not re-ask \(data, not instructions\): (.+)\.$/u;
export const SETTLED_FLOOR = /^settled, do not re-ask: ([1-9]\d*) settled: `ae decisions .+ --active`\.$/u;
export const SETTLED_PARTIAL_TAIL = /; ([1-9]\d*) settled in all: `ae decisions .+ --active`$/u;
export const SETTLED_ENTRY = /(d[1-9]\d*) (\S+) = (.*?) \((green|amber|red), (approved|assumed)(?:; rollback: (.*?))?\)( \[re-check, do not rely\])?(?=; d[1-9]\d* \S+ = |$)/uy;

/** One packet line, normalized for matching: NFKC, lower case, every whitespace to one space, controls and format
 * characters removed, every dash to "-". */
export const normLine = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{Zs}]/gu, ' ')
  .replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\p{Pd}/gu, '-').replace(/ {2,}/g, ' ').trim();
const LOOSE_SETTLED = (l: string) => l.includes('settled') && /re-? ?ask/.test(l);

type SettledEntry = { id: string; key: string; answer: string; stale: boolean };
export type SettledParse = { count: number; form: 'full' | 'partial' | 'floor' | 'none' | 'not-canonical'; entries: SettledEntry[]; line: number; lines: string[] };

/** Find settled lines loosely (count them), then parse the single one by the canonical regexes only. */
export function parseSettled(packet: string): SettledParse {
  const lines = packet.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).map(normLine);
  const at = lines.map((l, i) => LOOSE_SETTLED(l) ? i : -1).filter(i => i >= 0);
  const out: SettledParse = { count: at.length, form: 'none', entries: [], line: at[0] ?? -1, lines };
  if (at.length !== 1) return out;
  const l = lines[at[0]];
  if (SETTLED_FLOOR.test(l)) return { ...out, form: 'floor' };
  const m = SETTLED_FULL.exec(l);
  if (!m) return { ...out, form: 'not-canonical' };
  let body = m[1];
  const tail = SETTLED_PARTIAL_TAIL.exec(body);
  if (tail) body = body.slice(0, tail.index);
  const entries: SettledEntry[] = [];
  for (let pos = 0; ;) {
    SETTLED_ENTRY.lastIndex = pos;
    const e = SETTLED_ENTRY.exec(body);
    if (!e) return { ...out, form: 'not-canonical' };
    entries.push({ id: e[1], key: e[2], answer: e[3], stale: Boolean(e[7]) });
    pos = SETTLED_ENTRY.lastIndex;
    if (pos === body.length) break;
    if (!body.startsWith('; ', pos)) return { ...out, form: 'not-canonical' };
    pos += 2;
  }
  return { ...out, form: tail ? 'partial' : 'full', entries };
}

/** Lines other than the settled line that restate a decision key: the key followed by optional spaces and "=" or ":".
 * Checked on the normalized line and on a copy with Markdown marks, HTML tags, and escapes removed. */
export const MAX_RESTATE_KEYS = 1000; // distinct journal keys checked per line; more fails the check closed
/** True when `line` holds `key` with no token character before it, then an optional single space and "=" or ":". */
const restates = (line: string, key: string) => {
  for (const i of hitsOf(line, key)) {
    let j = i + key.length;
    if (line[j] === ' ') j++;
    if (line[j] === '=' || line[j] === ':') return true;
  }
  return false;
};
export function restatedKeys(p: SettledParse, keys: string[]): { lines: number; unchecked: number } {
  const all = [...new Set(keys.map(k => normLine(String(k))).filter(Boolean))];
  const ks = all.slice(0, MAX_RESTATE_KEYS);
  let n = 0;
  p.lines.forEach((l, i) => {
    if (i === p.line && p.count === 1) return;
    const bare = normLine(l.replace(/<[^>]*>/g, ' ').replace(/\\/g, '').replace(/[*`~]/g, '').replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, ''));
    if (ks.some(k => restates(l, k) || restates(bare, k))) n++;
  });
  return { lines: n, unchecked: all.length - ks.length };
}

export function grade(journalFile: string, recordFile?: string): { pass: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail: cap(detail, 200) });
  const journalAbs = resolve(journalFile);
  const root = dirname(dirname(journalAbs)); // sandbox repo root = journal's grandparent
  let journal: Journal | undefined, rec: RunRecord = {};
  try { journal = readJson(journalAbs); } catch (e) { add('journal', false, `cannot read journal: ${(e as Error).message}`); }
  const recPath = resolve(recordFile ?? join(dirname(journalAbs), 'sandbox.record.json'));
  try { rec = readJson(recPath); } catch (e) { add('record', false, `cannot read record ${recPath}: ${(e as Error).message}`); }

  const sliceKey = rec.slice === undefined ? undefined
    : journal?.slices?.[rec.slice] ? rec.slice : journal?.slices?.[rec.slice.replace(/\D/g, '')] ? rec.slice.replace(/\D/g, '') : rec.slice;
  const slice: SliceRecord | undefined = sliceKey === undefined ? undefined : journal?.slices?.[sliceKey];

  // 1. VERIFIED with command evidence from an engine run
  {
    const ev = (slice?.evidence ?? []).filter(e => e.kind === 'command' && e.exitCode === 0);
    add('verified-with-command-evidence', slice?.state === 'VERIFIED' && ev.length > 0,
      slice ? `state ${slice.state}; ${ev.length} passing command evidence` : `slice ${rec.slice ?? '(none)'} not found in journal`);
  }

  // 2. finished files keep their hash
  {
    const files = rec.finishedFiles ?? {}, bad: string[] = [];
    for (const [rel, want] of Object.entries(files)) {
      const p = join(root, rel);
      if (!existsSync(p) || sha256(p) !== want) bad.push(rel);
    }
    add('finished-files-unchanged', Object.keys(files).length > 0 && bad.length === 0,
      Object.keys(files).length === 0 ? 'record lists no finished files' : bad.length ? `changed or missing: ${bad.join(', ')}` : `${Object.keys(files).length} file(s) match`);
  }

  const fromRecord = (p: string) => resolve(dirname(recPath), p);
  const readOptJson = (p?: string): any => { try { return p && existsSync(fromRecord(p)) ? readJson(fromRecord(p)) : undefined; } catch { return undefined; } };
  const work = (slice?.attempts ?? []).filter(a => a.kind === 'work').sort((a, b) => a.n - b.n);

  // 3. one live writer per attempt: journal order plus disarm evidence for the stopped predecessor
  {
    const problems: string[] = [];
    work.forEach((a, i) => {
      const next = work[i + 1];
      if (Number.isNaN(Date.parse(a.at))) problems.push(`attempt ${a.n} has no valid start time`);
      if (a.endedAt !== undefined && Number.isNaN(Date.parse(a.endedAt))) problems.push(`attempt ${a.n} has an invalid end time`);
      if (next) {
        if (!a.endedAt) problems.push(`attempt ${a.n} has no end but attempt ${next.n} exists`);
        else if (!(Date.parse(a.endedAt) <= Date.parse(next.at))) problems.push(`attempt ${a.n} does not end before attempt ${next.n} starts`);
      }
      if (a.outcome === 'handed-off' && !(a.interruptions ?? []).length) problems.push(`handed-off attempt ${a.n} has no interruption`);
    });
    const open = work.filter(a => !a.outcome).length;
    if (open > 1) problems.push(`${open} attempts have no outcome`);
    if (work.length === 0) problems.push('no work attempts');
    const de = readOptJson(rec.disarmEvidence);
    if (!rec.disarmEvidence) problems.push('record has no disarmEvidence');
    else if (!de) problems.push('disarm evidence file missing or not JSON');
    else {
      // The replacement counts as live from the earliest of: the recorded launch, its engine attempt start, and its transcript start.
      const tr = readOptJson(rec.replacementTranscript);
      const signs = [Date.parse(de.replacementLaunchedAt), Date.parse(work[work.length - 1]?.at ?? ''), Date.parse(tr?.startedAt ?? '')];
      if (work.length < 2 || signs.some(Number.isNaN)) problems.push('replacement start is not shown by a valid launch time, attempt start, and transcript start');
      const launch = Math.min(...signs.filter(x => !Number.isNaN(x))), observed = Date.parse(de.observedAt);
      // An estimated stop time must carry its uncertainty; the stop boundary is then the latest time the stop could have been.
      const estimated = /estimat/i.test(String(de.observedAtNote ?? ''));
      const margin = de.observedAtUncertaintySeconds;
      if (estimated && !(typeof margin === 'number' && Number.isFinite(margin) && margin >= 0)) problems.push('observedAt is an estimate but observedAtUncertaintySeconds is missing');
      const stop = observed + (typeof margin === 'number' && Number.isFinite(margin) && margin > 0 ? margin * 1000 : 0);
      if (!TERMINAL.has(String(de.predecessorStatus ?? '').toLowerCase())) problems.push('predecessor status is not terminal');
      if (Number.isNaN(launch) || Number.isNaN(observed)) problems.push('disarm evidence lacks valid observedAt or replacementLaunchedAt');
      else if (stop > launch) problems.push('stop boundary (observedAt plus uncertainty) is after the replacement launch');
      else {
        const samples: any[] = Array.isArray(de.processSamples) ? de.processSamples : [];
        // Every sample must say, as a boolean, whether the process was alive, at a valid time.
        const badSamples = samples.filter(x => Number.isNaN(Date.parse(x?.at)) || typeof x?.alive !== 'boolean');
        if (badSamples.length) problems.push(`${badSamples.length} process sample(s) without a valid time or a boolean alive`);
        const pids = new Set(samples.map(x => x?.pid));
        if (samples.length && (pids.size !== 1 || [...pids].some(p => typeof p !== 'number'))) problems.push('process samples do not name one predecessor pid');
        const late = samples.filter(x => Date.parse(x.at) >= launch);
        if (late.length === 0) problems.push('no process sample at or after the replacement launch');
        const alive = late.filter(x => x.alive !== false).length;
        if (alive) problems.push(`${alive} predecessor process sample(s) not shown dead at or after the replacement launch`);
        const before = samples.filter(x => Date.parse(x.at) < launch).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        if (before.length === 0) problems.push('no process sample before the replacement launch');
        else if (before[before.length - 1].alive !== false) problems.push('the last process sample before the replacement launch is not dead');
        const owned = Object.keys(rec.finishedFiles ?? {});
        const allSnaps: any[] = Array.isArray(de.filesAfterStop) ? de.filesAfterStop : [];
        if (allSnaps.some(x => Number.isNaN(Date.parse(x?.at)) || !Array.isArray(x?.files))) problems.push('a file snapshot has no valid time or file list');
        const snaps = allSnaps.filter((x: any) => Date.parse(x.at) >= stop && Date.parse(x.at) <= launch);
        if (snaps.length < 2) problems.push(`${snaps.length} owned-file snapshot(s) between stop and launch; need 2`);
        else if (snaps.some((x: any) => !Array.isArray(x.files) || x.files.length === 0 || owned.some(f => !x.files.includes(f)))) problems.push('a snapshot between stop and launch is empty or misses a finished file');
        else if (new Set(snaps.map((x: any) => JSON.stringify([...x.files].sort()))).size > 1) problems.push('owned files changed between stop and launch');
      }
    }
    add('one-live-writer', problems.length === 0, problems.length ? problems.join('; ') : `${work.length} work attempt(s) in order; disarm evidence clean`);
  }

  // 3b. recovery sequence
  {
    const problems: string[] = [];
    const first = work[0], last = work[work.length - 1];
    if (work.length < 2) problems.push(`${work.length} work attempt(s); need at least 2`);
    if (first && !(first.outcome === 'handed-off' && (first.interruptions ?? []).length > 0)) problems.push('first attempt is not handed-off with an interruption');
    if (!(slice?.handoffs ?? []).some(h => (h.phase === 'TRANSFERRED' || h.phase === 'CLOSED') && h.to)) problems.push('no TRANSFERRED or CLOSED handoff with a target');
    if (work.length >= 2 && last && last.kind === 'work') {
      const lastAt = Date.parse(last.at);
      if (Number.isNaN(lastAt)) problems.push('last attempt has no valid start time');
      const ev = (slice?.evidence ?? []).filter(e => e.kind === 'command' && e.exitCode === 0 && !Number.isNaN(Date.parse(e.at ?? '')) && Date.parse(e.at!) >= lastAt);
      if (ev.length === 0) problems.push('last attempt has no passing command evidence with a valid time at or after its start');
    }
    add('recovery-sequence', problems.length === 0, problems.length ? problems.join('; ') : `${work.length} attempts; handoff recorded; command evidence after last attempt start`);
  }

  // 4. the replacement's packet carries the settled decision on the engine's one canonical settled line
  const key = rec.settledKey;
  const decision = key ? (journal?.decisions ?? []).find(x => x.key === key && (x.status === 'approved' || x.status === 'assumed')) : undefined;
  {
    let how = '';
    if (key && rec.replacementPacket) {
      const p = fromRecord(rec.replacementPacket);
      if (!existsSync(p)) how = 'packet file missing';
      else {
        const parsed = parseSettled(readFileSync(p, 'utf8'));
        const settled = (journal?.decisions ?? []).filter(x => x.status === 'approved' || x.status === 'assumed');
        const nk = normLine(key);
        const mine = parsed.entries.filter(e => e.key === nk);
        const seen = new Set<string>();
        const dup = parsed.entries.filter(e => seen.size === seen.add(e.key).size).length;
        const unbacked = parsed.entries.filter(e => !settled.some(d => normLine(d.key) === e.key && normLine(d.id) === e.id && normLine(String(d.answer ?? '')) === e.answer)).length;
        const restated = restatedKeys(parsed, (journal?.decisions ?? []).map(d => d.key));
        how = parsed.count !== 1 ? `packet has ${parsed.count} "Settled, do not re-ask" sections; need exactly 1`
          : parsed.form === 'not-canonical' ? 'the settled line does not match the engine form'
          : dup ? `${dup} key(s) appear twice on the settled line`
          : unbacked ? `${unbacked} settled entr(ies) differ from the journal decision for their key (id or exact answer)`
          : restated.unchecked ? `journal has ${restated.unchecked} key(s) beyond the ${MAX_RESTATE_KEYS} checked for restatement`
          : restated.lines ? `${restated.lines} other packet line(s) restate a decision key with "=" or ":"`
          : !decision ? 'no journal decision to compare'
          : !normLine(String(decision.answer ?? '')) ? 'decision has no answer to compare'
          : mine.some(e => e.stale) ? 'settled line for the key is marked re-check'
          : parsed.form === 'full' && mine.length === 0 ? 'settled line does not name the key'
          : 'ok';
        if (how === 'ok' && mine.length === 0) how = `ok-${parsed.form}`;
      }
    } else if (key) how = 'record has no replacementPacket';
    const ok = how === 'ok' || how === 'ok-floor' || how === 'ok-partial';
    add('packet-listed-settled-decision', Boolean(decision) && ok,
      !key ? 'record has no settledKey' : !decision ? `no approved or assumed decision with key ${showKey(key)}`
        : how === 'ok' ? `decision ${decision.id} ${decision.status}; the settled line carries ${showKey(key)} = its journal answer`
        : ok ? `decision ${decision.id} ${decision.status}; the ${how.slice(3)} settled line does not list it; verified against the journal alone`
        : how);
  }

  // 5. the transcript asks nothing about the settled decision (see the header: normalize, split, strict rule, signals).
  {
    const t = readOptJson(rec.replacementTranscript);
    const problems: string[] = [];
    const notes: string[] = [];
    if (!key) problems.push('record has no settledKey');
    // structural signals
    const pq = rec.pendingQuestionCount;
    if (pq === undefined) notes.push('pendingQuestionCount not observed');
    else if (!(typeof pq === 'number' && Number.isInteger(pq) && pq >= 0)) problems.push('pendingQuestionCount is not a whole number');
    else if (pq > 0) problems.push(`pendingQuestionCount is ${pq}`);
    else notes.push('pendingQuestionCount 0');
    if (!t || typeof t !== 'object') problems.push('transcript file missing or not a JSON export');
    else {
      if (t.status === undefined) notes.push('export status not observed');
      else if (t.status !== 'completed') problems.push('export status is not completed');
      else notes.push('export status completed');
      if (!t.threadId) problems.push('transcript has no threadId');
      if (!t.runId) problems.push('transcript has no runId');
      const items: any[] = Array.isArray(t.items) ? t.items : [];
      const isAssistant = (it: any) => /^assistant/i.test(String(it?.type ?? ''));
      const assistantIdx = items.map((it, i) => isAssistant(it) ? i : -1).filter(i => i >= 0);
      if (items.length === 0) problems.push('transcript has no items');
      else if (assistantIdx.length === 0) problems.push('transcript has no assistant message');
      const norm = new Map(assistantIdx.map(i => [i, typeof items[i].text === 'string' ? normalizeText(items[i].text) : '']));
      const empty = assistantIdx.filter(i => norm.get(i) === '').length;
      if (empty) problems.push(`${empty} assistant message(s) with empty or missing text`);
      const started = Date.parse(t.startedAt), lastStart = Date.parse(work[work.length - 1]?.at ?? '');
      if (Number.isNaN(started)) problems.push('transcript has no valid startedAt');
      else if (!Number.isNaN(lastStart) && started < lastStart) problems.push('transcript starts before the last work attempt');
      const hits = new Set<number>();
      let asking = 0, tied = 0;
      const scan = (text: string, idx: number[]) => {
        let found = false;
        for (const s of sentencesOf(text)) if (asksInSentence(s)) {
          found = true; asking++;
          if (key && tiedToDecision(s, key, String(decision?.question ?? ''))) tied++;
        }
        if (found) idx.forEach(i => hits.add(i));
        return found;
      };
      const single = new Map(assistantIdx.map(i => [i, scan(norm.get(i)!, [i])]));
      // a question split across two adjacent assistant items: join with a space, no sentence boundary
      for (let k = 0; k + 1 < assistantIdx.length; k++) {
        const a = assistantIdx[k], b = assistantIdx[k + 1];
        if (b !== a + 1 || single.get(a) || single.get(b)) continue;
        scan(`${norm.get(a)!.split('\n').at(-1)} ${norm.get(b)!.split('\n')[0]}`, [a, b]);
      }
      if (hits.size) problems.push(`${asking} asking sentence(s) (${tied} tied to the settled decision) in ${hits.size} assistant message(s), at item index ${[...hits].sort((x, y) => x - y).join(', ')}`);
    }
    add('no-question-about-settled-key', problems.length === 0,
      (problems.length ? problems.join('; ') : 'no asking sentence in any assistant message') + (notes.length ? `; ${notes.join('; ')}` : ''));
  }

  // 6. labels
  add('measured-and-estimate-labels', nonEmpty(rec.labels?.measured) && nonEmpty(rec.labels?.estimate),
    `measured ${nonEmpty(rec.labels?.measured) ? 'present' : 'missing'}, estimate ${nonEmpty(rec.labels?.estimate) ? 'present' : 'missing'}`);

  return { pass: checks.every(c => c.pass), checks };
}

const argv = process.argv.slice(2);
if (process.argv[1] && /grade\.ts$/.test(process.argv[1])) {
  const ri = argv.indexOf('--record');
  const record = ri >= 0 ? argv[ri + 1] : undefined;
  const journalFile = argv.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
  // No process.exit: set exitCode and let stdout drain, so a pipe always gets the whole JSON.
  if (!journalFile) { process.stderr.write('usage: grade.ts <sandbox>/plans/sandbox.run.json [--record <record.json>]\n'); process.exitCode = 2; }
  else {
    // Top-level guard: any unexpected exception still gives complete JSON on stdout and exit 1, nothing on stderr.
    // The detail names the error type and its message with quoted parts removed (they can hold file text), capped.
    let result: { pass: boolean; checks: Check[] };
    try { result = grade(journalFile, record); } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const msg = String(err.message).replace(/(["'`]).*?\1/gs, '<quoted>').replace(/\s+/g, ' ');
      result = { pass: false, checks: [{ name: 'grader-error', pass: false, detail: cap(`${err.name}: ${msg}`, 200) }] };
    }
    process.exitCode = result.pass ? 0 : 1;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}
