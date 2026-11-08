// Contract freeze (plans/unified-agent-harness-master.md, Slice 2, Accept 3; DEC-16).
// The frozen contract is contract.ts, hooks.ts, the packet section list, and the command and flag names of ae.ts.
// Each is pinned by its sha256. A failing pin means a frozen part changed. Such a change goes through the lead:
// the lead reviews it, records why in the plan, and updates the digest here in the same patch. A worker never
// updates a digest to make this test pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKET_SECTIONS } from '../tools/agents/skills/autonomous-engineering/scripts/contract.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'agents', 'skills', 'autonomous-engineering', 'scripts');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ae = read('ae.ts');
const line = (re: RegExp, what: string) => { const m = ae.match(re); assert.ok(m, `ae.ts has the ${what}`); return m[0]; };

const FROZEN = {
  'contract.ts': '58bfb5bf7db5cedc3738bce99cb0f426ea5b23a0e3910c9219f41d5f7cb9158c',
  'hooks.ts': 'ca74c483e264a67efd62505a631fc044eeca240ab05e4e87652f21175f5524b1',
  'packet section list': 'fcbab8b12e3a2d302540efda9d5f4a78d2c3361db6d6f45a96e4bf49706b6395',
  'COMMANDS line': 'ed8fd3f95ae19fb0522ab455dac64fc0b666148be0130a979b3b30721e21ea99',
  // Re-pinned by slice 3 (review-1 F2, CH-2): the 17 flag names of slices 3, 4, 7, 8, and 9 were added.
  'FLAGS lines': '1c6b3cf9d64781d0d610d2ae22dad96f74c9bd962e683eb39bd227e277f973c4',
  'BOOLEAN line': 'cdb90ba787f8f97340e767d66bd286fe81d1c9d65427566b619ebe28fa04c2fc',
};

const now = (): Record<keyof typeof FROZEN, string> => ({
  'contract.ts': sha(read('contract.ts')),
  'hooks.ts': sha(read('hooks.ts')),
  'packet section list': sha(JSON.stringify(PACKET_SECTIONS)),
  'COMMANDS line': sha(line(/^const COMMANDS = \[[^\]]*\];$/m, 'COMMANDS line')),
  'FLAGS lines': sha(line(/^const FLAGS = \[[^\]]*\];$/m, 'FLAGS lines')),
  'BOOLEAN line': sha(line(/^const BOOLEAN = \[[^\]]*\];$/m, 'BOOLEAN line')),
});

for (const [part, digest] of Object.entries(now()) as [keyof typeof FROZEN, string][]) {
  test(`frozen: ${part}`, () => {
    assert.equal(digest, FROZEN[part], `${part} changed (sha256 ${digest}). It is frozen at slice 2: send the change to the lead, who reviews it and updates this digest (DEC-16)`);
  });
}

test('frozen: the packet has 9 sections in the design order, with tiers 0, 0, 1, 1, 2, 2, 3, 3, 0', () => {
  assert.deepEqual(PACKET_SECTIONS.map(s => `${s.n}:${s.key}:${s.tier}`),
    ['1:contract:0', '2:waiting:0', '3:observed:1', '4:settled:1', '5:unknown:2', '6:next:2', '7:claimed:3', '8:goal:3', '9:rules:0']);
});

test('frozen: the new command names are single lowercase words in the COMMANDS line', () => {
  const names = [...line(/^const COMMANDS = \[[^\]]*\];$/m, 'COMMANDS line').matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const c of ['decide', 'decisions', 'interrupt', 'attach', 'lead']) assert.ok(names.includes(c), c);
  for (const c of names.slice(names.indexOf('decide'))) assert.match(c, /^[a-z]+$/, c);
});

test('frozen: the FLAGS line has the review-1 F2 names; claim, takeover, release, and run-check take no value', () => {
  const names = (re: RegExp, what: string) => [...line(re, what).matchAll(/'([^']+)'/g)].map(m => m[1]);
  const flags = names(/^const FLAGS = \[[^\]]*\];$/m, 'FLAGS lines'), booleans = names(/^const BOOLEAN = \[[^\]]*\];$/m, 'BOOLEAN line');
  const added = ['decision', 'watch', 'supersedes', 'evidence', 'run-check', 'workspace', 'lead-id', 'label', 'claim', 'takeover', 'observed', 'release', 'disarmed', 'thread-id', 'mode', 'exception', 'wait-lock'];
  for (const f of added) assert.ok(flags.includes(f), f);
  for (const b of ['claim', 'takeover', 'release', 'run-check']) assert.ok(booleans.includes(b), b);
  for (const v of added.filter(f => !['claim', 'takeover', 'release', 'run-check'].includes(f))) assert.ok(!booleans.includes(v), `${v} takes a value`);
  assert.equal(new Set(flags).size, flags.length, 'no flag name twice');
});
