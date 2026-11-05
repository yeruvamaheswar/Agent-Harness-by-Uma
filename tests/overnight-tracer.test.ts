import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApproval, checkCheckout, checkExit, fingerprint, parseApproval, MAX_RANGE, RUN_FILES, type ApprovalInput, type Item, type Workspace } from '../tools/agents/skills/thread-continuity/scripts/check.ts';

const CHECK = fileURLToPath(new URL('../tools/agents/skills/thread-continuity/scripts/check.ts', import.meta.url));

// Item shapes copied from T3 0.1.6 thread reads on 2026-11-03 and 2026-11-05. IDs are shortened; the field values are as observed.
const T = 'thread-1';
const proposal: Item = { position: 47, type: 'assistant_message', createdBy: 'agent', creationSource: 'provider', status: 'completed', messageId: 'message:provider:claudeAgent:native-item:p', sourceThreadId: T, text: '| A1 | x |\n| A2 | y |' };
const checkpoint: Item = { position: 48, type: 'checkpoint', createdBy: null, creationSource: null, status: 'completed', messageId: null, sourceThreadId: T, text: '[]' };
const approval: Item = { position: 49, type: 'user_message', createdBy: 'user', creationSource: 'web', status: 'completed', messageId: '5a3d7e4f-edb1-41d6-a576-e13b561659ec', sourceThreadId: T, text: 'Q1 yes\nApprove A1-A2', textTruncated: false };
const rows = ['A1', 'A2', 'A3'];
const input = (items: Item[], over = {}): ApprovalInput => ({ threadId: T, proposalMessageId: proposal.messageId!, approvalMessageId: approval.messageId!, proposalRows: rows, items, ...over });
// Proposal at 47, checkpoint at 48, then `middle` from 49 on, then the approval.
const withBetween = (...middle: Partial<Item>[]) => {
  const between = middle.map((m, n) => ({ ...checkpoint, ...m, position: 49 + n }) as Item);
  return [proposal, checkpoint, ...between, { ...approval, position: 49 + middle.length }];
};

test('EVAL-3: a typed user approval after the proposal grants exactly its rows', () => {
  const r = checkApproval(input([proposal, checkpoint, approval]));
  assert.deepEqual(r, { ok: true, reasons: [], approved: ['A1', 'A2'] });
});

test('NOT-1: an agent-sent user_message is refused (t3_thread_send, launch, delegate)', () => {
  const sent = { ...approval, createdBy: 'agent', creationSource: 'mcp', messageId: 'message:mcp:client%3A9:thread-send:4' };
  const r = checkApproval(input([proposal, checkpoint, sent], { approvalMessageId: sent.messageId }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /createdBy is agent/);
});

test('NOT-1: a scheduled-task prompt is refused although T3 labels it createdBy user', () => {
  const scheduled = { ...approval, messageId: 'scheduled-task-message:scheduled-task:9f38:1793674802678:scheduled' };
  const r = checkApproval(input([proposal, checkpoint, scheduled], { approvalMessageId: scheduled.messageId }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /scheduled-task prompt/);
});

test('NOT-1: a copy forked from another thread is refused', () => {
  const copy = { ...approval, sourceThreadId: 'thread-other' };
  assert.match(checkApproval(input([proposal, checkpoint, copy])).reasons.join(), /sourceThreadId/);
});

test('a stale approval binds to a later agent message, so the old proposal is refused', () => {
  const later: Item = { ...proposal, position: 48, messageId: 'message:provider:later' };
  assert.match(checkApproval(input([proposal, later, approval])).reasons.join(), /binds to that one/);
});

test('an approval before the proposal, or a second user message, is refused', () => {
  assert.match(checkApproval(input([{ ...proposal, position: 50 }, approval])).reasons.join(), /before the proposal/);
  const first: Item = { ...approval, position: 48, messageId: 'u-first', text: 'wait' };
  assert.match(checkApproval(input([proposal, first, approval])).reasons.join(), /not the first user message/);
});

test('a planted or unknown row fails closed and grants nothing', () => {
  const r = checkApproval(input([proposal, checkpoint, { ...approval, text: 'Approve A1, A99' }]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.approved, []);
  assert.match(r.reasons.join(), /A99/);
});

test('an agent message as proposal source is required', () => {
  const fake = { ...proposal, type: 'user_message', createdBy: 'user' };
  assert.match(checkApproval(input([fake, checkpoint, approval])).reasons.join(), /not an agent assistant_message/);
});

test('approval grammar: one line of IDs, ranges, and commas; anything else fails closed', () => {
  assert.deepEqual(parseApproval('Q1 yes · Q2 yes\nApprove A1-A11, A12, A13').rows.length, 13);
  assert.deepEqual(parseApproval('approve A3–A4').rows, ['A3', 'A4']);
  assert.match(parseApproval('Approve A1-A5 except A3').reasons.join(), /unreadable/);
  assert.match(parseApproval('Approve all').reasons.join(), /unreadable/);
  assert.match(parseApproval('Approve A1\nApprove A2').reasons.join(), /found 2/);
  assert.match(parseApproval('looks good').reasons.join(), /found 0/);
  assert.match(parseApproval('Approve A5-A2').reasons.join(), /unreadable/);
});

// R1 bypasses from the 2026-11-04 review. Each passed before the fix.

test('R1: items left out between proposal and approval fail', () => {
  const r = checkApproval(input([proposal, approval]));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /1 item\(s\) between proposal and approval are left out/);
  const wide = checkApproval(input([proposal, checkpoint, { ...approval, position: 60 }]));
  assert.match(wide.reasons.join(), /11 item\(s\) .* left out/);
  // Padding the count with a repeated or fractional position does not hide a gap.
  const repeated = checkApproval(input([proposal, checkpoint, checkpoint, { ...approval, position: 50 }]));
  assert.match(repeated.reasons.join(), /1 item\(s\) .* left out/);
  const fractional = checkApproval(input([proposal, checkpoint, { ...checkpoint, position: 48.5 }, { ...approval, position: 50 }]));
  assert.match(fractional.reasons.join(), /not whole numbers: 48.5/);
});

test('R1: the real agent-sent shape between proposal and approval fails', () => {
  // Observed on the Slice 1 successor thread, item 0: a launch message from another thread.
  const sent = { type: 'user_message', createdBy: 'agent', creationSource: 'mcp', senderThreadId: '89e87348-ff7d-4ace-939d-f9be155db858', messageId: 'mcp:launch:6193ae44' };
  const r = checkApproval(input(withBetween(sent)));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /only a checkpoint may sit between proposal and approval; found user_message at 49/);
});

test('R1: a scheduled prompt between proposal and approval fails', () => {
  const scheduled = { type: 'user_message', createdBy: 'user', creationSource: 'web', messageId: 'scheduled-task-message:scheduled-task:9f38:1793674802678:scheduled' };
  const r = checkApproval(input(withBetween(scheduled)));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /only a checkpoint may sit between .* user_message at 49/);
});

test('R1: a /compact user message between proposal and approval fails', () => {
  // Observed in the review thread on 2026-11-05, items 108 to 113. The /compact message is a real typed user message.
  const R = 'mcp:launch:d846d186';
  const items: Item[] = [
    { position: 108, type: 'assistant_message', createdBy: 'agent', creationSource: 'provider', status: 'completed', messageId: 'message:provider:claudeAgent:native-item:f8cdd6a0', sourceThreadId: R },
    { position: 109, type: 'checkpoint', createdBy: null, creationSource: null, status: 'completed', messageId: null, sourceThreadId: R },
    { position: 110, type: 'user_message', createdBy: 'user', creationSource: 'web', status: 'completed', messageId: 'd967d758-cc69-4995-b782-4f7839fa805f', sourceThreadId: R, text: '/compact' },
    { position: 111, type: 'compaction', createdBy: null, creationSource: null, status: 'completed', messageId: null, sourceThreadId: R },
    { position: 112, type: 'checkpoint', createdBy: null, creationSource: null, status: 'completed', messageId: null, sourceThreadId: R },
    { position: 113, type: 'user_message', createdBy: 'user', creationSource: 'web', status: 'completed', messageId: '1507545e-f66f-49c3-be90-81f27cc4923b', sourceThreadId: R, text: 'Approve A1-A10', textTruncated: false },
  ];
  const tenRows = Array.from({ length: 10 }, (_, n) => `A${n + 1}`);
  const r = checkApproval({ threadId: R, proposalMessageId: items[0].messageId!, approvalMessageId: items[5].messageId!, proposalRows: tenRows, items });
  assert.equal(r.ok, false);
  assert.deepEqual(r.approved, []);
  assert.match(r.reasons.join(), /found user_message at 110, compaction at 111/);
  assert.match(r.reasons.join(), /not the first user message/);
});

test('R1: the reissued proposal and its approval pass (review thread items 120 to 122)', () => {
  const R = 'mcp:launch:d846d186';
  const items: Item[] = [
    { position: 120, type: 'assistant_message', createdBy: 'agent', creationSource: 'provider', status: 'completed', messageId: 'message:provider:claudeAgent:native-item:188ed5a2', sourceThreadId: R },
    { position: 121, type: 'checkpoint', createdBy: null, creationSource: null, status: 'completed', messageId: null, sourceThreadId: R },
    { position: 122, type: 'user_message', createdBy: 'user', creationSource: 'web', status: 'completed', messageId: 'd669f82e-7c24-4a1c-a68c-54ea89f7a9bb', sourceThreadId: R, text: 'Approve A1-A10', textTruncated: false },
  ];
  const tenRows = Array.from({ length: 10 }, (_, n) => `A${n + 1}`);
  const r = checkApproval({ threadId: R, proposalMessageId: items[0].messageId!, approvalMessageId: items[2].messageId!, proposalRows: tenRows, items });
  assert.deepEqual(r, { ok: true, reasons: [], approved: tenRows });
});

test('R1: a rolled-back or unfinished approval fails', () => {
  // The exact rollback status was not observed in T3. Any status other than "completed" fails closed.
  for (const status of ['reverted', 'pending', undefined]) {
    const r = checkApproval(input([proposal, checkpoint, { ...approval, status }]));
    assert.equal(r.ok, false, `status ${status}`);
    assert.match(r.reasons.join(), new RegExp(`status is ${status}, not completed`));
  }
});

test('R1: senderThreadId on the approval, or a source other than web, fails', () => {
  const sent = checkApproval(input([proposal, checkpoint, { ...approval, senderThreadId: 'thread-other' }]));
  assert.equal(sent.ok, false);
  assert.match(sent.reasons.join(), /senderThreadId thread-other shows another thread sent it/);
  const mcp = checkApproval(input([proposal, checkpoint, { ...approval, creationSource: 'mcp' }]));
  assert.match(mcp.reasons.join(), /creationSource is mcp, not web/);
});

test('R1: a retraction on another line fails', () => {
  const r = checkApproval(input([proposal, checkpoint, { ...approval, text: 'Approve A1-A2\nnot A2' }]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.approved, []);
  assert.match(r.reasons.join(), /a line other than the Approve line names a row: "not A2"/);
  assert.match(parseApproval('Wait, a2 is wrong\nApprove A1-A2').reasons.join(), /names a row/);
});

test('A4: two items with the proposal or approval message ID fail', () => {
  const twinApproval = checkApproval(input([proposal, checkpoint, approval, { ...approval, position: 50, text: 'Approve A1-A3' }]));
  assert.equal(twinApproval.ok, false);
  assert.match(twinApproval.reasons.join(), /2 items share the approval message ID/);
  const twinProposal = checkApproval(input([{ ...proposal, position: 10 }, proposal, checkpoint, approval]));
  assert.match(twinProposal.reasons.join(), /2 items share the proposal message ID/);
});

test('A4: a range longer than the limit fails without building the list', () => {
  assert.equal(parseApproval(`Approve A1-A${MAX_RANGE}`).rows.length, MAX_RANGE);
  assert.match(parseApproval(`Approve A1-A${MAX_RANGE + 1}`).reasons.join(), /longer than 100 rows/);
  const started = Date.now();
  assert.match(parseApproval('Approve A1-A999999999').reasons.join(), /longer than 100 rows/);
  assert.ok(Date.now() - started < 1000);
});

// F3, F4, and F6 from the A10 review: approval input the checker did not read.

test('F3: a truncated approval text, or one without the textTruncated flag, fails; textTruncated false passes', () => {
  for (const textTruncated of [true, undefined]) {
    const r = checkApproval(input([proposal, checkpoint, { ...approval, textTruncated }]));
    assert.equal(r.ok, false, `textTruncated ${textTruncated}`);
    assert.deepEqual(r.approved, []);
    assert.match(r.reasons.join(), new RegExp(`approval: textTruncated is ${textTruncated}, not false`));
  }
  const { textTruncated: _, ...noFlag } = approval;
  assert.match(checkApproval(input([proposal, checkpoint, noFlag as Item])).reasons.join(), /textTruncated is undefined, not false/);
  assert.deepEqual(checkApproval(input([proposal, checkpoint, { ...approval, textTruncated: false }])), { ok: true, reasons: [], approved: ['A1', 'A2'] });
});

test('F4: a user message at the approval or the proposal position fails and names the position', () => {
  const other: Item = { ...approval, messageId: 'u-other', text: 'Approve A3' };
  const atApproval = checkApproval(input([proposal, checkpoint, approval, { ...other, position: approval.position }]));
  assert.equal(atApproval.ok, false);
  assert.deepEqual(atApproval.approved, []);
  assert.match(atApproval.reasons.join(), /2 items share position 49/);
  const atProposal = checkApproval(input([proposal, { ...other, position: proposal.position }, checkpoint, approval]));
  assert.equal(atProposal.ok, false);
  assert.deepEqual(atProposal.approved, []);
  assert.match(atProposal.reasons.join(), /2 items share position 47/);
});

test('F6: a proposal that is reverted, has no status, or carries senderThreadId fails', () => {
  for (const status of ['reverted', undefined]) {
    const r = checkApproval(input([{ ...proposal, status }, checkpoint, approval]));
    assert.equal(r.ok, false, `status ${status}`);
    assert.deepEqual(r.approved, []);
    assert.match(r.reasons.join(), new RegExp(`proposal: status is ${status}, not completed`));
  }
  const { status: _, ...noStatus } = proposal;
  assert.match(checkApproval(input([noStatus as Item, checkpoint, approval])).reasons.join(), /proposal: status is undefined, not completed/);
  const sent = checkApproval(input([{ ...proposal, senderThreadId: 'thread-other' }, checkpoint, approval]));
  assert.equal(sent.ok, false);
  assert.deepEqual(sent.approved, []);
  assert.match(sent.reasons.join(), /proposal: senderThreadId thread-other shows another thread sent it/);
  assert.equal(checkApproval(input([{ ...proposal, senderThreadId: null }, checkpoint, approval])).ok, true, 'a null senderThreadId is no sender');
});

const ws: Workspace = { projectId: 'p', workspaceRoot: '/r', worktreePath: null, branch: 'b', head: 'h', fingerprint: 'f', runtimeMode: 'auto' };

test('checkout: same workspace passes; another checkout, branch, or a wider mode fails', () => {
  assert.equal(checkCheckout(ws, ws).ok, true);
  assert.equal(checkCheckout(ws, { ...ws, runtimeMode: 'approval-required' }).ok, true, 'a narrower mode is allowed');
  assert.match(checkCheckout(ws, { ...ws, worktreePath: '/w' }).reasons.join(), /worktreePath/);
  assert.match(checkCheckout(ws, { ...ws, branch: 'x' }).reasons.join(), /branch/);
  assert.match(checkCheckout(ws, { ...ws, runtimeMode: 'full-access' }).reasons.join(), /wider/);
  assert.match(checkCheckout(ws, { ...ws, runtimeMode: 'weird' }).reasons.join(), /unknown runtime mode/);
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-')));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(dir, '.gitignore'), '.state/\n'); writeFileSync(join(dir, 'a.txt'), 'one');
  g('add', '.'); g('commit', '-qm', 'base');
  return dir;
}

test('fingerprint: changes with edits to dirty or untracked files, ignores .state', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'dirty');
    const one = fingerprint(dir);
    writeFileSync(join(dir, 'a.txt'), 'dirty again');
    const two = fingerprint(dir);
    assert.notEqual(two, one, 'an edit to an already-dirty file is seen');
    writeFileSync(join(dir, 'new.txt'), 'x');
    assert.notEqual(fingerprint(dir), two, 'an untracked file is seen');
    const three = fingerprint(dir);
    execFileSync('mkdir', ['-p', join(dir, '.state')]);
    writeFileSync(join(dir, '.state/x'), 'y');
    assert.equal(fingerprint(dir), three, '.state is ignored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A complete run folder, as the Slice 1 run wrote it. The handoff records the temporary repo as the checkout.
function runFolder(dir: string) {
  const run = join(dir, '.state/run');
  mkdirSync(run, { recursive: true });
  const workspace = { ...ws, workspaceRoot: dir, fingerprint: fingerprint(dir) };
  const handoff = { fixture: { step1: 's1', step2: 's2' }, owner: 'succ', successor: { threadId: 'succ' }, predecessor: { threadId: 'pred' }, approval: { threadId: T, proposalMessageId: proposal.messageId, approvalMessageId: approval.messageId }, approvedRows: ['A1', 'A2'], workspace };
  const files: Record<string, unknown> = {
    [RUN_FILES.handoff]: handoff,
    [RUN_FILES.backup]: { ...handoff, owner: 'transferring' },
    [RUN_FILES.evidence]: { approval: { ok: true, approved: ['A1'] }, checkout: { ok: true }, predecessorIdleBeforeWrite: true },
    [RUN_FILES.approvalInput]: input([proposal, checkpoint, approval]),
    [RUN_FILES.observed]: workspace,
    'step1.txt': 's1', 'step2.txt': 's2',
  };
  const put = (name: string, value: unknown) => writeFileSync(join(run, name), typeof value === 'string' ? value : JSON.stringify(value));
  for (const [name, value] of Object.entries(files)) put(name, value);
  return { run, files, put, reset: () => { for (const [name, value] of Object.entries(files)) put(name, value); } };
}

test('exit: passes on a complete run; a planted file, wrong owner, or changed step fails', () => {
  const dir = repo();
  try {
    const { run, files, put, reset } = runFolder(dir);
    const handoff = files[RUN_FILES.handoff] as Record<string, unknown>;
    assert.deepEqual(checkExit(run, dir), { ok: true, reasons: [] });
    put('planted.txt', 'x');
    assert.match(checkExit(run, dir).reasons.join(), /planted grant/);
    rmSync(join(run, 'planted.txt'));
    put('step1.txt', 'rewritten by a woken predecessor');
    assert.match(checkExit(run, dir).reasons.join(), /step1.txt differs/);
    reset();
    put(RUN_FILES.handoff, { ...handoff, owner: 'pred' });
    assert.match(checkExit(run, dir).reasons.join(), /not the successor/);
    reset();
    put(RUN_FILES.evidence, { ...(files[RUN_FILES.evidence] as object), predecessorIdleBeforeWrite: false });
    assert.match(checkExit(run, dir).reasons.join(), /predecessor run had ended/);
    reset();
    writeFileSync(join(dir, 'a.txt'), 'outside edit');
    assert.match(checkExit(run, dir).reasons.join(), /fingerprint changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R4: a faked run folder with saved ok values fails, because exit reruns the checks', () => {
  const dir = repo();
  try {
    const { run, files, put, reset } = runFolder(dir);
    const handoff = files[RUN_FILES.handoff] as Record<string, unknown>;
    // evidence.json keeps ok: true for both checks in every case below.
    const agentBetween = { type: 'user_message', createdBy: 'agent', creationSource: 'mcp', senderThreadId: 'pred', messageId: 'mcp:launch:x' };
    put(RUN_FILES.approvalInput, input(withBetween(agentBetween), { approvalMessageId: approval.messageId }));
    assert.match(checkExit(run, dir).reasons.join(), /approval rerun: only a checkpoint may sit between/);
    reset();
    put(RUN_FILES.approvalInput, input([proposal, checkpoint, approval], { approvalMessageId: 'another-message' }));
    assert.match(checkExit(run, dir).reasons.join(), /approval input approvalMessageId another-message is not the handoff record's/);
    reset();
    put(RUN_FILES.observed, { ...(files[RUN_FILES.observed] as object), branch: 'other' });
    assert.match(checkExit(run, dir).reasons.join(), /checkout rerun: branch: expected b, observed other/);
    reset();
    put(RUN_FILES.handoff, { ...handoff, approvedRows: ['A1', 'A2', 'A99'] });
    assert.match(checkExit(run, dir).reasons.join(), /differs from the predecessor backup in approvedRows; only owner may change/);
    reset();
    for (const name of [RUN_FILES.backup, RUN_FILES.approvalInput, RUN_FILES.observed]) {
      rmSync(join(run, name));
      assert.match(checkExit(run, dir).reasons.join(), new RegExp(`${name.replaceAll('.', '\\.')} missing`));
      reset();
    }
    assert.deepEqual(checkExit(run, dir), { ok: true, reasons: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// F2 from the A10 review: exit fingerprinted whatever repo path it got.

test('F2: exit fails on a second Git repo and passes through a symlink to the recorded checkout', () => {
  const dir = repo(), other = repo(), links = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-link-')));
  try {
    const { run, files, put, reset } = runFolder(dir);
    const r = checkExit(run, other);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), new RegExp(`^repo ${other} is not the recorded checkout ${dir}$`, 'm'));
    const link = join(links, 'checkout');
    symlinkSync(dir, link);
    assert.deepEqual(checkExit(run, link), { ok: true, reasons: [] });
    assert.match(checkExit(run, join(links, 'missing')).reasons.join(), /is not the recorded checkout/);
    // worktreePath, when set, is the recorded checkout, not workspaceRoot.
    const handoff = files[RUN_FILES.handoff] as Record<string, unknown>;
    const workspace = { ...(handoff.workspace as Workspace), worktreePath: other };
    for (const [name, value] of [[RUN_FILES.handoff, { ...handoff, workspace }], [RUN_FILES.backup, { ...handoff, owner: 'transferring', workspace }], [RUN_FILES.observed, workspace]] as const) put(name, value);
    assert.match(checkExit(run, dir).reasons.join('\n'), new RegExp(`^repo ${dir} is not the recorded checkout ${other}$`, 'm'));
    reset();
    for (const path of ['', join(links, 'gone')]) {
      const missing = { ...(handoff.workspace as Workspace), workspaceRoot: path };
      for (const [name, value] of [[RUN_FILES.handoff, { ...handoff, workspace: missing }], [RUN_FILES.backup, { ...handoff, owner: 'transferring', workspace: missing }], [RUN_FILES.observed, missing]] as const) put(name, value);
      assert.match(checkExit(run, dir).reasons.join(), path ? /the recorded checkout .*gone does not exist/ : /records no checkout/);
      reset();
    }
    assert.deepEqual(checkExit(run, dir), { ok: true, reasons: [] });
  } finally { for (const d of [dir, other, links]) rmSync(d, { recursive: true, force: true }); }
});

test('F2: the command line binds the default repo "." to the recorded checkout', () => {
  const dir = repo(), other = repo();
  try {
    const { run } = runFolder(dir);
    const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CHECK, 'exit', ...args], { cwd, encoding: 'utf8' });
    const root = cli(dir, run);
    assert.equal(root.status, 0, root.stdout + root.stderr);
    assert.deepEqual(JSON.parse(root.stdout), { ok: true, reasons: [] });
    const elsewhere = cli(other, run);
    assert.equal(elsewhere.status, 1);
    assert.match(JSON.parse(elsewhere.stdout).reasons.join(), new RegExp(`is not the recorded checkout ${dir}`));
  } finally { for (const d of [dir, other]) rmSync(d, { recursive: true, force: true }); }
});

test('R5: through a symlink or a path with a space, the command line prints its result and the right exit code', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracer-cli-')));
  try {
    const good = join(dir, 'good.json'), bad = join(dir, 'bad.json');
    writeFileSync(good, JSON.stringify(input([proposal, checkpoint, approval])));
    writeFileSync(bad, JSON.stringify(input([proposal, approval])));
    const link = join(dir, 'link-check.ts');
    symlinkSync(CHECK, link);
    const spaced = join(dir, 'with space');
    mkdirSync(spaced);
    writeFileSync(join(spaced, 'package.json'), '{"type":"module"}');
    copyFileSync(CHECK, join(spaced, 'check.ts'));
    const linkedDir = join(dir, 'linked dir');
    symlinkSync(spaced, linkedDir);
    for (const script of [link, join(spaced, 'check.ts'), join(linkedDir, 'check.ts')]) {
      const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], { encoding: 'utf8' });
      const ok = run('approval', good);
      assert.equal(ok.status, 0, `${script}: ${ok.stderr}`);
      assert.equal(JSON.parse(ok.stdout).ok, true, script);
      const no = run('approval', bad);
      assert.equal(no.status, 1, script);
      assert.equal(JSON.parse(no.stdout).ok, false, script);
      assert.equal(run().status, 2, `${script}: usage error`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('F1: exit requires the predecessor backup owner to be transferring', () => {
  const dir = repo();
  try {
    const { run, files, put, reset } = runFolder(dir);
    const backup = files[RUN_FILES.backup] as Record<string, unknown>;
    for (const owner of ['succ', 'pred', null, undefined]) {
      put(RUN_FILES.backup, { ...backup, owner });
      const result = checkExit(run, dir);
      assert.equal(result.ok, false, `backup owner ${owner}`);
      assert.match(result.reasons.join(), /backup owner .* is not transferring/);
    }
    reset();
    assert.deepEqual(checkExit(run, dir), { ok: true, reasons: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F7: malformed JSON and a missing workspace give CLI JSON with exit 1', () => {
  const dir = repo();
  try {
    const { run, files, put, reset } = runFolder(dir);
    const handoff = files[RUN_FILES.handoff] as Record<string, unknown>;
    const { workspace: _, ...withoutWorkspace } = handoff;
    for (const malformed of ['{bad json', withoutWorkspace]) {
      put(RUN_FILES.handoff, malformed);
      const direct = checkExit(run, dir);
      assert.equal(direct.ok, false);
      assert.match(direct.reasons.join(), /run folder is malformed:/);
      const cli = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CHECK, 'exit', run, dir], { encoding: 'utf8' });
      assert.equal(cli.status, 1, cli.stdout + cli.stderr);
      assert.equal(cli.stderr, '');
      assert.deepEqual(JSON.parse(cli.stdout), direct);
      reset();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F7: importing with a non-file argv entry does not throw', () => {
  const missing = join(tmpdir(), 'tracer-nonexistent-entry-' + process.pid);
  const cli = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(new URL('../tools/agents/skills/thread-continuity/scripts/check.ts', import.meta.url).href)});`, missing], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr, '');
});
