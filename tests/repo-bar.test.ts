import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {repoBar} from '../src/repo-bar.ts';

async function repo(files:Record<string,string>){
 const dir=await mkdtemp(join(tmpdir(),'harness-bar-'));
 for(const [p,t] of Object.entries(files)){await mkdir(dirname(join(dir,p)),{recursive:true});await writeFile(join(dir,p),t);}
 return dir;
}
const CI='name: c\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  t:\n    steps:\n      - run: docker run ghcr.io/gitleaks/gitleaks:v8.24.3 git /repo\n';
const FULL={'.github/workflows/ci.yml':CI,'.github/dependabot.yml':'version: 2\n','SECURITY.md':'x','CONTRIBUTING.md':'x','.claude/settings.json':'{"permissions":{"deny":["Read(./.env)"]}}','.github/CODEOWNERS':'* @me\n','.github/pull_request_template.md':'## What\n'};

test('a bare repo fails every check',async()=>{
 const b=await repoBar(await repo({'README.md':'x'}));
 assert.equal(b.ok,false);assert.equal(b.passed,0);assert.equal(b.total,7);
});
test('a repo with every file passes',async()=>{
 const b=await repoBar(await repo(FULL));
 assert.deepEqual(b.checks.filter(c=>!c.ok).map(c=>c.id),[]);assert.equal(b.ok,true);
});
test('one workflow without permissions fails the token check, and push-only CI fails the CI check',async()=>{
 const b=await repoBar(await repo({...FULL,'.github/workflows/ci.yml':'on:\n  push:\n    branches: [main]\njobs: {}\n','.github/workflows/scan.yml':CI}));
 const by=Object.fromEntries(b.checks.map(c=>[c.id,c]));
 assert.equal(by.token.ok,false);assert.match(by.token.detail,/missing in ci\.yml/);
 assert.equal(by.ci.ok,true);
 const only=await repoBar(await repo({...FULL,'.github/workflows/ci.yml':'on:\n  push:\npermissions: {}\n'}));
 assert.equal(only.checks.find(c=>c.id==='ci')!.ok,false);
});
test('malformed settings count as no deny rules',async()=>{
 const b=await repoBar(await repo({...FULL,'.claude/settings.json':'{oops'}));
 assert.equal(b.checks.find(c=>c.id==='agent-controls')!.ok,false);
});
