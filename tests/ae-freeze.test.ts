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
  'contract.ts': '7d37ec5db5811910b76ce174c5ed81e66ba832da38fb0c51f20f685022903e67',
  'hooks.ts': 'ca74c483e264a67efd62505a631fc044eeca240ab05e4e87652f21175f5524b1',
  'packet section list': 'fcbab8b12e3a2d302540efda9d5f4a78d2c3361db6d6f45a96e4bf49706b6395',
  'COMMANDS line': 'ed8fd3f95ae19fb0522ab455dac64fc0b666148be0130a979b3b30721e21ea99',
  'FLAGS lines': '14953410d80b2c8b36aee7de1ea25db40ccee2b95e677dc154be956285d6a20c',
  'BOOLEAN line': '2c87023201d0adf90e63381b85020a9eed630d9a33e54e446604b7ecde11de94',
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
