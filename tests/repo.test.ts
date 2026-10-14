import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,lstat,symlink,rm,access,realpath,chmod,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir,hostname} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSnapshot,digest,publish,readRelease,render,hash} from '../src/core.ts';
import {managed} from '../src/install.ts';
import {repoInstall,repoVerify,repoUninstall} from '../src/repo.ts';

const code=join(dirname(fileURLToPath(import.meta.url)),'..');
const BEGIN='<!-- BEGIN AGENTIC HARNESS -->',END='<!-- END AGENTIC HARNESS -->',BLOCK=/<!-- BEGIN AGENTIC HARNESS -->[\s\S]*?<!-- END AGENTIC HARNESS -->/;
const DESIGN='<!-- BEGIN UMA DESIGN OS -->\nRead .design-os/INDEX.md for design work.\n<!-- END UMA DESIGN OS -->\n';
const TARGETS=['AGENTS.md','CLAUDE.md'],MANIFEST='.agentic-harness/manifest.json',STUB='@AGENTS.md\n';
// Harness root with releases 1.0.0 and 1.1.0 (1.1.0 active), plus an empty project folder.
async function fixture(files:Record<string,string>={}){
 const root=await mkdtemp(join(tmpdir(),'harness-test-')),repo=await mkdtemp(join(tmpdir(),'harness-repo-'));
 await writeFile(join(root,'core.md'),'# Rules\nBuild a tracer bullet and verify it.');
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 await writeFile(join(root,'core.md'),'# Rules\nSecond policy: reproduce a bug first.');
 await publish(root,'1.1.0',digest(await loadSnapshot(root)),true);
 for(const [name,text] of Object.entries(files))await writeFile(join(repo,name),text);
 return {root,repo};
}
const text=(repo:string,name:string)=>readFile(join(repo,name),'utf8');
const exists=(path:string)=>access(path).then(()=>true,()=>false);
const manifest=async(repo:string)=>JSON.parse(await text(repo,MANIFEST));
async function tree(dir:string){
 const out:Record<string,string>={};
 for(const f of (await readdir(dir,{recursive:true})).sort()){const s=await lstat(join(dir,f));out[f]=s.isSymbolicLink()?'link':s.isFile()?hash(await readFile(join(dir,f),'utf8')):'dir';}
 return out;
}
async function unchanged(repo:string,run:()=>Promise<unknown>,error:RegExp){const before=await tree(repo);await assert.rejects(run(),error);assert.deepEqual(await tree(repo),before);}
const edit=async(repo:string,name:string,change:(s:string)=>string)=>writeFile(join(repo,name),change(await text(repo,name)));

test('repo install creates both files and a receipt with the user-scope block',async()=>{
 const {root,repo}=await fixture(),r=await readRelease(root,'1.1.0'),result=await repoInstall(root,repo);
 const block=managed('',render(r)['codex/AGENTS.md']).trim();
 assert.equal(await text(repo,'AGENTS.md'),block+'\n');assert.equal(await text(repo,'CLAUDE.md'),STUB);
 assert.deepEqual(result.writes,[{path:'AGENTS.md',action:'create file'},{path:'CLAUDE.md',action:'create import stub'},{path:MANIFEST,action:'create receipt'}]);
 const m=await manifest(repo);
 assert.deepEqual(Object.keys(m),['schemaVersion','release','installedAt','files','aliases','claudeViaImport']);
 assert.deepEqual(m.release,{version:'1.1.0',digest:r.digest});assert.equal(m.claudeViaImport,true);
 assert.deepEqual(m.files,[{path:'AGENTS.md',blockHash:hash(block),created:true,before:'',after:'\n'}]);
 assert.deepEqual(await repoVerify(repo),{release:m.release,installedAt:m.installedAt,files:[{path:'AGENTS.md',matches:true}],aliases:[],claudeViaImport:true,claudeImport:{path:'CLAUDE.md',matches:true},configurationVerified:true,behaviorVerified:false});
});
test('repo install rejects a path that is not an existing directory',async()=>{
 const {root,repo}=await fixture({'file.txt':'x'});
 await assert.rejects(repoInstall(root,join(repo,'absent')),/Not an existing directory/);
 await assert.rejects(repoInstall(root,join(repo,'file.txt')),/Not an existing directory/);
});
test('repo install then uninstall restores original bytes and removes created files',async()=>{
 for(const original of ['Keep this rule\n','Keep this rule','Keep this rule\n\n','']){
  const {root,repo}=await fixture({'AGENTS.md':original});
  await repoInstall(root,repo);
  assert.ok((await text(repo,'AGENTS.md')).startsWith(original));assert.match(await text(repo,'AGENTS.md'),BLOCK);
  const result=await repoUninstall(root,repo);
  assert.equal(await text(repo,'AGENTS.md'),original);
  assert.deepEqual(result.deletes,[MANIFEST]);
  assert.deepEqual(await readdir(repo),TARGETS);assert.equal(await text(repo,'CLAUDE.md'),STUB);
 }
});
test('repo install keeps the permission bits of an existing file',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});await chmod(join(repo,'AGENTS.md'),0o644);
 await repoInstall(root,repo);assert.equal((await lstat(join(repo,'AGENTS.md'))).mode&0o777,0o644);
 await repoUninstall(root,repo);assert.equal((await lstat(join(repo,'AGENTS.md'))).mode&0o777,0o644);
});
test('repo uninstall keeps a created file that gained user text',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo);
 for(const name of TARGETS)await edit(repo,name,s=>s+'My own rule\n');
 await repoUninstall(root,repo);
 assert.equal(await text(repo,'AGENTS.md'),'My own rule\n');assert.equal(await text(repo,'CLAUDE.md'),STUB+'My own rule\n');assert.deepEqual(await readdir(repo),TARGETS);
});
test('repo dry runs change nothing',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});let before=await tree(repo);const state=await tree(root);
 const plan=await repoInstall(root,repo,{dryRun:true});
 assert.equal(plan.dryRun,true);assert.deepEqual(plan.writes,[{path:'AGENTS.md',action:'append block'},{path:'CLAUDE.md',action:'create import stub'},{path:MANIFEST,action:'create receipt'}]);
 assert.deepEqual(await tree(repo),before);
 await repoInstall(root,repo);before=await tree(repo);const installed=await tree(root);
 const removal=await repoUninstall(root,repo,{dryRun:true});
 assert.deepEqual(removal.writes,[{path:'AGENTS.md',action:'remove owned block'}]);assert.deepEqual(removal.deletes,[MANIFEST]);
 assert.deepEqual(await tree(repo),before);assert.deepEqual(await tree(root),installed);
 assert.notDeepEqual(installed,state);
});
test('repo install saves a safety copy of existing targets in the harness root only',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'}),result=await repoInstall(root,repo);
 assert.ok(!('backup' in await repoInstall(root,repo,{dryRun:true})));
 assert.ok('backup' in result);const {backup}=result;
 assert.match(backup,/^\.state\/backups\/repo\//);
 assert.deepEqual(await readdir(join(root,backup)),['AGENTS.md']);
 assert.equal(await readFile(join(root,backup,'AGENTS.md'),'utf8'),'Keep this rule\n');
 assert.ok(!(await text(repo,MANIFEST)).includes('backups'));
});
test('a DesignOS block present before the repo install is preserved, in either order',async()=>{
 for(const original of [DESIGN,'# Project\n\n'+DESIGN+'\nMore text\n']){
  const {root,repo}=await fixture({'AGENTS.md':original,'CLAUDE.md':original});
  await repoInstall(root,repo);
  for(const name of TARGETS){const s=await text(repo,name);assert.ok(s.startsWith(original));assert.match(s,BLOCK);}
  assert.equal((await repoVerify(repo)).configurationVerified,true);
  await repoUninstall(root,repo);
  for(const name of TARGETS)assert.equal(await text(repo,name),original);
 }
});
test('a DesignOS block added after the repo install survives upgrade and uninstall',async()=>{
 for(const add of [(s:string)=>s+'\n'+DESIGN,(s:string)=>DESIGN+'\n'+s]){
  const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});
  await repoInstall(root,repo,{version:'1.0.0'});
  for(const name of TARGETS)await edit(repo,name,add);
  const outside=async()=>Promise.all(TARGETS.map(async name=>(await text(repo,name)).replace(BLOCK,'')));
  const before=await outside();
  await repoInstall(root,repo);
  assert.deepEqual(await outside(),before);assert.match(await text(repo,'AGENTS.md'),/Second policy/);
  assert.equal((await repoVerify(repo)).configurationVerified,true);
  await repoUninstall(root,repo);
  for(const name of TARGETS){const s=await text(repo,name);assert.ok(s.includes(DESIGN));assert.ok(!s.includes(BEGIN)&&!s.includes(END));}
  assert.ok((await text(repo,'AGENTS.md')).includes('Keep this rule\n'));
  assert.equal(await exists(join(repo,'.agentic-harness')),false);
 }
});
test('a locally edited Harness block refuses install and uninstall with no partial change',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo,{version:'1.0.0'});
 // CLAUDE.md is checked second, so AGENTS.md proves that no write happens before the checks finish.
 await edit(repo,'CLAUDE.md',s=>s.replace('Build a tracer bullet','Ignore all testing'));
 await unchanged(repo,()=>repoInstall(root,repo),/CLAUDE\.md: the Harness block was edited/);
 await unchanged(repo,()=>repoInstall(root,repo,{adopt:true}),/edited/);
 await unchanged(repo,()=>repoUninstall(root,repo),/edited/);
 assert.match(await text(repo,'AGENTS.md'),/release 1\.0\.0/);
 await edit(repo,'CLAUDE.md',s=>s.replace(BLOCK,''));
 await unchanged(repo,()=>repoUninstall(root,repo),/edited or removed/);
});
test('text edited outside the block does not stop upgrade or uninstall',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});await repoInstall(root,repo,{version:'1.0.0'});
 await edit(repo,'AGENTS.md',s=>'# New heading\n'+s.replace('Keep this rule','Changed rule')+'Footer\n');
 await repoInstall(root,repo);
 const s=await text(repo,'AGENTS.md');assert.ok(s.startsWith('# New heading\nChanged rule\n\n'+BEGIN));assert.ok(s.endsWith(END+'\nFooter\n'));assert.match(s,/Second policy/);
 await repoUninstall(root,repo);
 assert.equal(await text(repo,'AGENTS.md'),'# New heading\nChanged rule\nFooter\n');
});
test('an unmanaged Harness block refuses without --adopt and is replaced with it',async()=>{
 const hand=`Intro\n${BEGIN}\nHand copy of the policy\n${END}\nOutro\n`,{root,repo}=await fixture({'AGENTS.md':hand});
 await unchanged(repo,()=>repoInstall(root,repo),/AGENTS\.md holds a Harness block that this command did not install/);
 const result=await repoInstall(root,repo,{adopt:true});
 assert.equal(result.writes[0].action,'adopt and replace block');
 const s=await text(repo,'AGENTS.md');assert.ok(s.startsWith('Intro\n'+BEGIN+'\nHarness release 1.1.0.'));assert.ok(s.endsWith(END+'\nOutro\n'));assert.ok(!s.includes('Hand copy'));
 assert.equal((await repoVerify(repo)).configurationVerified,true);
 await repoInstall(root,repo,{version:'1.0.0'});assert.match(await text(repo,'AGENTS.md'),/release 1\.0\.0/);
 await repoUninstall(root,repo);assert.equal(await text(repo,'AGENTS.md'),'Intro\n\nOutro\n');
});
test('malformed or duplicate Harness markers refuse the whole install',async()=>{
 for(const bad of [`${BEGIN}\nno end\n`,`${END}\n${BEGIN}\n`,`${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`]){
  const {root,repo}=await fixture({'CLAUDE.md':bad});
  await unchanged(repo,()=>repoInstall(root,repo,{adopt:true}),/CLAUDE\.md: malformed or duplicate Harness markers/);
 }
});
test('AGENTS.md symlinked to CLAUDE.md writes one file and verifies',async()=>{
 const {root,repo}=await fixture({'CLAUDE.md':'Keep this rule\n'});await symlink('CLAUDE.md',join(repo,'AGENTS.md'));
 const result=await repoInstall(root,repo);
 assert.deepEqual(result.writes.map(w=>w.path),['CLAUDE.md',MANIFEST]);
 assert.ok((await lstat(join(repo,'AGENTS.md'))).isSymbolicLink());
 assert.equal((await text(repo,'AGENTS.md')).match(new RegExp(BEGIN,'g'))!.length,1);
 const m=await manifest(repo);assert.deepEqual(m.files.map((f:{path:string})=>f.path),['CLAUDE.md']);assert.deepEqual(m.aliases,[{path:'AGENTS.md',target:'CLAUDE.md'}]);
 const v=await repoVerify(repo);assert.deepEqual(v.aliases,[{path:'AGENTS.md',target:'CLAUDE.md',matches:true}]);assert.equal(v.configurationVerified,true);
 await repoUninstall(root,repo);
 assert.equal(await text(repo,'CLAUDE.md'),'Keep this rule\n');assert.ok((await lstat(join(repo,'AGENTS.md'))).isSymbolicLink());
});
test('CLAUDE.md symlinked to a missing AGENTS.md creates the real file once',async()=>{
 const {root,repo}=await fixture();await symlink('AGENTS.md',join(repo,'CLAUDE.md'));
 await repoInstall(root,repo);
 assert.deepEqual((await manifest(repo)).aliases,[{path:'CLAUDE.md',target:'AGENTS.md'}]);
 assert.equal((await repoVerify(repo)).configurationVerified,true);
});
test('a symlink pointing elsewhere, or two symlinks, are refused',async()=>{
 const outside=await mkdtemp(join(tmpdir(),'harness-outside-'));await writeFile(join(outside,'AGENTS.md'),'Outside rule\n');
 const a=await fixture();await symlink(join(outside,'AGENTS.md'),join(a.repo,'AGENTS.md'));
 await unchanged(a.repo,()=>repoInstall(a.root,a.repo),/AGENTS\.md is a symlink that does not point at CLAUDE\.md/);
 assert.equal(await readFile(join(outside,'AGENTS.md'),'utf8'),'Outside rule\n');
 const b=await fixture({'notes.md':'x'});await symlink('notes.md',join(b.repo,'CLAUDE.md'));
 await unchanged(b.repo,()=>repoInstall(b.root,b.repo),/CLAUDE\.md is a symlink that does not point at AGENTS\.md/);
 const c=await fixture();await symlink('CLAUDE.md',join(c.repo,'AGENTS.md'));await symlink('AGENTS.md',join(c.repo,'CLAUDE.md'));
 await unchanged(c.repo,()=>repoInstall(c.root,c.repo),/both symlinks/);
});
test('a target replaced by a symlink after the install stops verify, upgrade, and uninstall',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo,{version:'1.0.0'});
 await rm(join(repo,'AGENTS.md'));await symlink('CLAUDE.md',join(repo,'AGENTS.md'));
 assert.equal((await repoVerify(repo)).configurationVerified,false);
 await unchanged(repo,()=>repoInstall(root,repo),/layout changed/);
 await unchanged(repo,()=>repoUninstall(root,repo),/layout changed/);
});
test('the repo manifest holds no absolute path and no machine name',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});await repoInstall(root,repo);
 const raw=await text(repo,MANIFEST);
 for(const secret of [root,repo,await realpath(root),await realpath(repo),tmpdir(),process.env.HOME!,hostname()])assert.ok(!raw.includes(secret),secret);
 const strings=(v:unknown):string[]=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(strings):[];
 for(const s of strings(JSON.parse(raw)))assert.ok(!s.startsWith('/')&&!s.includes('..'),s);
});
test('a manifest that names another path is rejected',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo);
 const m=await manifest(repo);m.files[0].path='../outside.md';await writeFile(join(repo,MANIFEST),JSON.stringify(m));
 await unchanged(repo,()=>repoUninstall(root,repo),/Unrecognized/);
 await assert.rejects(repoVerify(repo),/Unrecognized/);
});
test('repo upgrade changes the block and the manifest',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'});
 await repoInstall(root,repo,{version:'1.0.0'});const old=await manifest(repo);
 assert.match(await text(repo,'AGENTS.md'),/tracer bullet/);
 const result=await repoInstall(root,repo);const next=await manifest(repo);
 assert.deepEqual(result.writes.map(w=>w.action),['replace owned block','replace owned block','update receipt']);
 for(const name of TARGETS){const s=await text(repo,name);assert.match(s,/Harness release 1\.1\.0\./);assert.ok(!s.includes('tracer bullet'));}
 assert.equal(next.release.version,'1.1.0');assert.notEqual(next.release.digest,old.release.digest);assert.notEqual(next.files[0].blockHash,old.files[0].blockHash);
 assert.deepEqual(next.files.map(({blockHash,...f}:{blockHash:string})=>f),old.files.map(({blockHash,...f}:{blockHash:string})=>f));
 assert.equal((await repoVerify(repo)).configurationVerified,true);
 await repoUninstall(root,repo);assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n');assert.equal(await text(repo,'CLAUDE.md'),'Claude rule\n');assert.deepEqual(await readdir(repo),TARGETS);
});
test('repo verify needs no releases folder and fails after a block edit',async()=>{
 const {root,repo}=await fixture({'CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo);await rm(join(root,'releases'),{recursive:true});
 assert.equal((await repoVerify(repo)).configurationVerified,true);
 await edit(repo,'AGENTS.md',s=>s+'\nUser text outside the block\n');
 assert.equal((await repoVerify(repo)).configurationVerified,true);
 await edit(repo,'AGENTS.md',s=>s.replace('Second policy','Third policy'));
 const v=await repoVerify(repo);assert.deepEqual(v.files,[{path:'AGENTS.md',matches:false},{path:'CLAUDE.md',matches:true}]);assert.equal(v.configurationVerified,false);
 await assert.rejects(repoVerify(await mkdtemp(join(tmpdir(),'harness-repo-'))),/No Harness repo install found/);
});
test('the CLI wires repo install, verify, and uninstall, and verify sets the exit code',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'}),empty=await mkdtemp(join(tmpdir(),'harness-empty-'));
 const cli=(from:string,...args:string[])=>spawnSync(process.execPath,['--experimental-strip-types',join(code,'src/cli.ts'),'--root',from,'repo',...args],{encoding:'utf8'});
 const before=await tree(repo),dry=cli(root,'install',repo,'--version','1.0.0','--dry-run');
 assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).dryRun,true);assert.deepEqual(await tree(repo),before);
 assert.equal(cli(root,'install',repo,'--version','1.0.0').status,0);assert.equal((await manifest(repo)).release.version,'1.0.0');
 // A clone on another machine has no releases/ and no .state/.
 const ok=cli(empty,'verify',repo);assert.equal(ok.status,0);assert.equal(JSON.parse(ok.stdout).configurationVerified,true);
 await edit(repo,'CLAUDE.md',s=>s.replace('tracer bullet','shortcut'));
 const bad=cli(empty,'verify',repo);assert.equal(bad.status,1);assert.equal(JSON.parse(bad.stdout).configurationVerified,false);
 const refused=cli(root,'uninstall',repo);assert.equal(refused.status,1);assert.match(refused.stderr,/edited/);
 await edit(repo,'CLAUDE.md',s=>s.replace('shortcut','tracer bullet'));
 assert.equal(cli(root,'uninstall',repo).status,0);assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n');
 assert.equal(cli(root,'install').status,1);assert.equal(cli(root,'frobnicate',repo).status,1);
});
const POLICY='.agentic-harness/policy.md',SENTENCE='This project uses the Agentic Harness engineering policy. If that policy is not already in your instructions, read `.agentic-harness/policy.md` now and follow it in every task.';
test('repo install --pointer writes the full policy file and a short block that names it',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'}),r=await readRelease(root,'1.1.0'),full=render(r)['codex/AGENTS.md'].trim(),result=await repoInstall(root,repo,{pointer:true});
 assert.equal(await text(repo,POLICY),full+'\n');assert.match(await text(repo,POLICY),/Second policy/);
 const block=`${BEGIN}\nHarness release 1.1.0.\n<!-- Agentic harness release 1.1.0; digest ${r.digest} -->\n${SENTENCE}\n${END}`;
 assert.ok(block.length<400,String(block.length));assert.ok(block.includes('`'+POLICY+'`'));assert.deepEqual(block.split('\n').slice(1,3),full.split('\n').slice(0,2));
 assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n\n'+block+'\n');assert.equal(await text(repo,'CLAUDE.md'),STUB);
 for(const name of TARGETS)assert.ok(!(await text(repo,name)).includes('Second policy'));
 assert.equal(result.mode,'pointer');assert.deepEqual(result.writes,[{path:'AGENTS.md',action:'append block'},{path:'CLAUDE.md',action:'create import stub'},{path:POLICY,action:'create policy file'},{path:MANIFEST,action:'create receipt'}]);
 const m=await manifest(repo);
 assert.deepEqual(Object.keys(m),['schemaVersion','release','installedAt','files','aliases','claudeViaImport','mode','policy']);
 assert.equal(m.mode,'pointer');assert.deepEqual(m.policy,{path:POLICY,hash:hash(full+'\n')});assert.equal(m.files[0].blockHash,hash(block));
 assert.deepEqual(await repoVerify(repo),{release:m.release,installedAt:m.installedAt,files:[{path:'AGENTS.md',matches:true}],aliases:[],claudeViaImport:true,claudeImport:{path:'CLAUDE.md',matches:true},mode:'pointer',policy:{path:POLICY,matches:true},configurationVerified:true,behaviorVerified:false});
});
test('repo verify fails in pointer mode after the policy file is edited, removed, or replaced by a symlink',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo,{pointer:true});const original=await text(repo,POLICY);
 await edit(repo,POLICY,s=>s.replace('Second policy','Third policy'));
 let v=await repoVerify(repo);assert.deepEqual(v.policy,{path:POLICY,matches:false});assert.equal(v.files.every(f=>f.matches),true);assert.equal(v.configurationVerified,false);
 await writeFile(join(repo,POLICY),original);assert.equal((await repoVerify(repo)).configurationVerified,true);
 await rm(join(repo,POLICY));
 v=await repoVerify(repo);assert.deepEqual(v.policy,{path:POLICY,matches:false});assert.equal(v.configurationVerified,false);
 await writeFile(join(repo,'copy.md'),original);await symlink('../copy.md',join(repo,POLICY));
 assert.equal(await text(repo,POLICY),original);assert.equal((await repoVerify(repo)).configurationVerified,false);
});
test('pointer uninstall restores original bytes and removes the policy file and the folder',async()=>{
 for(const original of ['Keep this rule\n','Keep this rule','']){
  const {root,repo}=await fixture({'AGENTS.md':original});await repoInstall(root,repo,{pointer:true});
  const result=await repoUninstall(root,repo);
  assert.equal(await text(repo,'AGENTS.md'),original);assert.deepEqual(result.deletes,[POLICY,MANIFEST]);
  assert.deepEqual(await readdir(repo),TARGETS);assert.equal(await text(repo,'CLAUDE.md'),STUB);
  assert.ok('backup' in result);assert.equal(await readFile(join(root,result.backup,POLICY),'utf8'),render(await readRelease(root,'1.1.0'))['codex/AGENTS.md'].trim()+'\n');
 }
});
test('repo install switches full to pointer and pointer to full and leaves no stray policy file',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo,{version:'1.0.0'});
 const toPointer=await repoInstall(root,repo,{pointer:true});
 assert.deepEqual(toPointer.writes.map(w=>w.action),['replace owned block','replace owned block','create policy file','update receipt']);assert.deepEqual(toPointer.deletes,[]);
 for(const name of TARGETS){const s=await text(repo,name);assert.ok(s.includes(SENTENCE));assert.ok(!s.includes('tracer bullet')&&!s.includes('Second policy'));}
 assert.equal((await repoVerify(repo)).configurationVerified,true);const pointerPolicy=await text(repo,POLICY);
 // A pointer upgrade to another release rewrites the policy file and keeps the mode.
 const down=await repoInstall(root,repo,{version:'1.0.0',pointer:true});
 assert.equal(down.writes[2].action,'replace policy file');assert.match(await text(repo,POLICY),/tracer bullet/);assert.equal((await manifest(repo)).mode,'pointer');assert.equal((await repoVerify(repo)).configurationVerified,true);
 assert.ok('backup' in down);assert.equal(await readFile(join(root,down.backup,POLICY),'utf8'),pointerPolicy);
 const toFull=await repoInstall(root,repo);
 assert.equal(toFull.mode,'full');assert.deepEqual(toFull.deletes,[POLICY]);assert.ok('backup' in toFull);assert.match(await readFile(join(root,toFull.backup,POLICY),'utf8'),/tracer bullet/);
 assert.equal(await exists(join(repo,POLICY)),false);assert.deepEqual(await readdir(join(repo,'.agentic-harness')),['manifest.json']);
 const m=await manifest(repo);assert.ok(!('mode' in m)&&!('policy' in m));
 for(const name of TARGETS){const s=await text(repo,name);assert.match(s,/Second policy/);assert.ok(!s.includes(SENTENCE));}
 const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.ok(!('policy' in v));
 await repoUninstall(root,repo);assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n');assert.equal(await text(repo,'CLAUDE.md'),'Claude rule\n');assert.deepEqual(await readdir(repo),TARGETS);
});
test('an edited or missing policy file refuses upgrade, mode switch, and uninstall with nothing changed',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});await repoInstall(root,repo,{version:'1.0.0',pointer:true});
 for(const damage of [()=>edit(repo,POLICY,s=>s.replace('Build a tracer bullet','Ignore all testing')),()=>rm(join(repo,POLICY))]){
  await damage();
  await unchanged(repo,()=>repoInstall(root,repo,{pointer:true}),/policy\.md was edited or removed/);
  await unchanged(repo,()=>repoInstall(root,repo),/policy\.md was edited or removed/);
  await unchanged(repo,()=>repoInstall(root,repo,{pointer:true,adopt:true}),/edited or removed/);
  await unchanged(repo,()=>repoUninstall(root,repo),/policy\.md was edited or removed/);
  assert.match(await text(repo,'AGENTS.md'),/release 1\.0\.0/);
 }
});
test('a policy.md that the manifest does not own refuses a pointer install',async()=>{
 const a=await fixture({'AGENTS.md':'Keep this rule\n'});await mkdir(join(a.repo,'.agentic-harness'));await writeFile(join(a.repo,POLICY),'My own notes\n');
 await unchanged(a.repo,()=>repoInstall(a.root,a.repo,{pointer:true}),/policy\.md exists and this command did not install it/);
 await unchanged(a.repo,()=>repoInstall(a.root,a.repo,{pointer:true,adopt:true}),/did not install it/);
 // The same holds on a full-mode install that is switched to pointer mode.
 const b=await fixture();await repoInstall(b.root,b.repo);await writeFile(join(b.repo,POLICY),'My own notes\n');
 await unchanged(b.repo,()=>repoInstall(b.root,b.repo,{pointer:true}),/did not install it/);
 assert.equal(await text(b.repo,POLICY),'My own notes\n');
});
test('a manifest without mode is treated as full',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});await repoInstall(root,repo,{version:'1.0.0'});
 const m=await manifest(repo);assert.ok(!('mode' in m)&&!('policy' in m));
 const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.ok(!('mode' in v)&&!('policy' in v));
 const up=await repoInstall(root,repo);assert.equal(up.mode,'full');assert.deepEqual(up.deletes,[]);assert.equal(await exists(join(repo,POLICY)),false);
 // An explicit mode "full" is valid too.
 await writeFile(join(repo,MANIFEST),JSON.stringify({...await manifest(repo),mode:'full'}));
 assert.equal((await repoVerify(repo)).configurationVerified,true);
 await repoUninstall(root,repo);assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n');assert.deepEqual(await readdir(repo),TARGETS);
});
test('a manifest with another policy path, an unknown mode, or a mismatched mode and policy is rejected',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo,{pointer:true});const good=await manifest(repo);await writeFile(join(repo,'outside.md'),'x');
 for(const bad of [{policy:{...good.policy,path:'../outside.md'}},{policy:{...good.policy,path:'outside.md'}},{policy:{...good.policy,path:'AGENTS.md'}},{policy:{path:POLICY}},{policy:undefined},{mode:'other'},{mode:'full'},{mode:undefined}]){
  await writeFile(join(repo,MANIFEST),JSON.stringify({...good,...bad}));
  await unchanged(repo,()=>repoUninstall(root,repo),/Unrecognized/);
  await unchanged(repo,()=>repoInstall(root,repo),/Unrecognized/);
  await assert.rejects(repoVerify(repo),/Unrecognized/);
 }
 assert.equal(await text(repo,'outside.md'),'x');
});
test('a DesignOS block coexists with a pointer block through install, mode switch, and uninstall',async()=>{
 for(const original of [DESIGN,'# Project\n\n'+DESIGN+'\nMore text\n']){
  const {root,repo}=await fixture({'AGENTS.md':original,'CLAUDE.md':original});
  await repoInstall(root,repo,{pointer:true});
  for(const name of TARGETS){const s=await text(repo,name);assert.ok(s.startsWith(original));assert.match(s,BLOCK);assert.ok(s.includes(SENTENCE));}
  assert.equal((await repoVerify(repo)).configurationVerified,true);
  for(const name of TARGETS)await edit(repo,name,s=>s+'\n'+DESIGN.replace('design work','more design work'));
  await repoInstall(root,repo);await repoInstall(root,repo,{pointer:true});
  for(const name of TARGETS){const s=await text(repo,name);assert.ok(s.startsWith(original));assert.ok(s.includes('more design work'));assert.ok(s.includes(SENTENCE));}
  assert.equal((await repoVerify(repo)).configurationVerified,true);
  await repoUninstall(root,repo);
  for(const name of TARGETS)assert.equal(await text(repo,name),original+'\n'+DESIGN.replace('design work','more design work'));
  assert.equal(await exists(join(repo,'.agentic-harness')),false);
 }
});
test('pointer dry runs change nothing and list the policy file',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});let before=await tree(repo);
 const plan=await repoInstall(root,repo,{pointer:true,dryRun:true});
 assert.equal(plan.dryRun,true);assert.deepEqual(plan.writes.map(w=>w.path),['AGENTS.md','CLAUDE.md',POLICY,MANIFEST]);assert.deepEqual(await tree(repo),before);
 await repoInstall(root,repo,{pointer:true});before=await tree(repo);const state=await tree(root);
 const toFull=await repoInstall(root,repo,{dryRun:true});assert.deepEqual(toFull.deletes,[POLICY]);
 const removal=await repoUninstall(root,repo,{dryRun:true});
 assert.deepEqual(removal.writes,[{path:'AGENTS.md',action:'remove owned block'}]);assert.deepEqual(removal.deletes,[POLICY,MANIFEST]);
 assert.deepEqual(await tree(repo),before);assert.deepEqual(await tree(root),state);
});
test('the CLI accepts --pointer for repo install',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n'});
 const cli=(...args:string[])=>spawnSync(process.execPath,['--experimental-strip-types',join(code,'src/cli.ts'),'--root',root,...args],{encoding:'utf8'});
 const before=await tree(repo),dry=cli('repo','install',repo,'--pointer','--dry-run');
 assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).mode,'pointer');assert.deepEqual(await tree(repo),before);
 const run=cli('repo','install',repo,'--pointer');assert.equal(run.status,0);assert.equal(JSON.parse(run.stdout).mode,'pointer');
 assert.equal((await manifest(repo)).mode,'pointer');assert.match(await text(repo,POLICY),/Second policy/);
 const ok=cli('repo','verify',repo);assert.equal(ok.status,0);assert.equal(JSON.parse(ok.stdout).mode,'pointer');
 await edit(repo,POLICY,s=>s+'extra\n');
 assert.equal(cli('repo','verify',repo).status,1);const refused=cli('repo','uninstall',repo);assert.equal(refused.status,1);assert.match(refused.stderr,/edited or removed/);
 await edit(repo,POLICY,s=>s.replace(/extra\n$/,''));
 assert.equal(cli('repo','install',repo).status,0);assert.equal(await exists(join(repo,POLICY)),false);
 assert.equal(cli('repo','uninstall',repo).status,0);assert.equal(await text(repo,'AGENTS.md'),'Keep this rule\n');assert.deepEqual(await readdir(repo),TARGETS);
 assert.match(cli('help').stdout,/repo install PATH \[--version VERSION\] \[--adopt\] \[--pointer\] \[--dry-run\]/);
});
// Single instruction file: CLAUDE.md is missing or imports AGENTS.md, so the block lives in AGENTS.md only.
const strings=(v:unknown):string[]=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(strings):[];
test('uninstall of a fresh single-file install deletes AGENTS.md and the stub and leaves nothing',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo);
 assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.equal((await text(repo,'AGENTS.md')).match(new RegExp(BEGIN,'g'))!.length,1);
 const raw=await text(repo,MANIFEST);assert.equal(JSON.parse(raw).claudeViaImport,true);assert.ok(!raw.includes(STUB.trim()));
 for(const secret of [root,repo,await realpath(repo),tmpdir(),process.env.HOME!])assert.ok(!raw.includes(secret),secret);
 for(const s of strings(JSON.parse(raw)))assert.ok(!s.startsWith('/')&&!s.includes('..'),s);
 const result=await repoUninstall(root,repo);
 assert.deepEqual(result.deletes,['AGENTS.md','CLAUDE.md',MANIFEST]);assert.deepEqual(await readdir(repo),[]);
 assert.ok('backup' in result);assert.deepEqual((await readdir(join(root,result.backup))).sort(),['.agentic-harness',...TARGETS]);assert.equal(await readFile(join(root,result.backup,'CLAUDE.md'),'utf8'),STUB);
});
test('a CLAUDE.md that already imports AGENTS.md is never written and survives uninstall byte for byte',async()=>{
 for(const original of ['# Mine\n@AGENTS.md\nMore text\n','# Mine\r\n@AGENTS.md\r\nMore text\r\n','Mine\n \t@AGENTS.md \t\nMore\n','Mine\n@AGENTS.md','@AGENTS.md\n\n'+DESIGN]){
  const {root,repo}=await fixture({'CLAUDE.md':original}),written=(await lstat(join(repo,'CLAUDE.md'))).mtimeMs;
  for(const options of [{},{pointer:true},{version:'1.0.0'}]){
   const result=await repoInstall(root,repo,options);
   assert.ok(!result.writes.some(w=>w.path==='CLAUDE.md'),original);assert.match(await text(repo,'AGENTS.md'),BLOCK);
   const m=await manifest(repo);assert.equal(m.claudeViaImport,true);assert.deepEqual(m.files.map((f:{path:string})=>f.path),['AGENTS.md']);
   const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.deepEqual(v.claudeImport,{path:'CLAUDE.md',matches:true});
  }
  await repoUninstall(root,repo);
  assert.equal(await text(repo,'CLAUDE.md'),original);assert.equal((await lstat(join(repo,'CLAUDE.md'))).mtimeMs,written);assert.deepEqual(await readdir(repo),['CLAUDE.md']);
 }
});
test('an existing CLAUDE.md without the import keeps the two-file layout',async()=>{
 const {root,repo}=await fixture({'CLAUDE.md':'Claude rule\n'}),result=await repoInstall(root,repo);
 assert.deepEqual(result.writes,[{path:'AGENTS.md',action:'create file'},{path:'CLAUDE.md',action:'append block'},{path:MANIFEST,action:'create receipt'}]);
 for(const name of TARGETS)assert.match(await text(repo,name),BLOCK);
 assert.ok(!(await text(repo,'CLAUDE.md')).includes('@AGENTS.md'));
 const m=await manifest(repo);assert.ok(!('claudeViaImport' in m));assert.deepEqual(m.files.map((f:{path:string})=>f.path),TARGETS);
 const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.ok(!('claudeViaImport' in v)&&!('claudeImport' in v));
 await repoInstall(root,repo,{version:'1.0.0'});for(const name of TARGETS)assert.match(await text(repo,name),/release 1\.0\.0/);
 await repoUninstall(root,repo);assert.equal(await text(repo,'CLAUDE.md'),'Claude rule\n');assert.deepEqual(await readdir(repo),['CLAUDE.md']);
});
test('a sentence that mentions @AGENTS.md, or a line with a byte-order mark, is not an import',async()=>{
 for(const original of ['See @AGENTS.md for the rules.\n','@AGENTS.md is the shared file\n','Use `@AGENTS.md`\n','﻿@AGENTS.md\n','@AGENTS.md.\n','@agents.md\n']){
  const {root,repo}=await fixture({'CLAUDE.md':original});await repoInstall(root,repo);
  assert.ok((await text(repo,'CLAUDE.md')).startsWith(original),original);assert.match(await text(repo,'CLAUDE.md'),BLOCK);
  assert.ok(!('claudeViaImport' in await manifest(repo)));
  await repoUninstall(root,repo);assert.equal(await text(repo,'CLAUDE.md'),original);
 }
});
test('a managed two-file install converts after the user adds the import line',async()=>{
 for(const pointer of [false,true]){
  const {root,repo}=await fixture({'CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo,{version:'1.0.0',pointer});
  await edit(repo,'CLAUDE.md',s=>'@AGENTS.md\n'+s+DESIGN);
  const before=await tree(repo),installed=await text(repo,'CLAUDE.md'),plan=await repoInstall(root,repo,{pointer,dryRun:true});
  assert.deepEqual(plan.writes.slice(0,2),[{path:'AGENTS.md',action:'replace owned block'},{path:'CLAUDE.md',action:'remove owned block'}]);assert.deepEqual(await tree(repo),before);
  const result=await repoInstall(root,repo,{pointer});
  assert.equal(await text(repo,'CLAUDE.md'),'@AGENTS.md\nClaude rule\n'+DESIGN);assert.match(await text(repo,'AGENTS.md'),/release 1\.1\.0/);
  assert.ok('backup' in result);assert.equal(await readFile(join(root,result.backup,'CLAUDE.md'),'utf8'),installed);
  const m=await manifest(repo);assert.equal(m.claudeViaImport,true);assert.deepEqual(m.files.map((f:{path:string})=>f.path),['AGENTS.md']);assert.equal(m.files[0].created,true);
  const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.equal(v.claudeViaImport,true);
  // The next run leaves CLAUDE.md alone, and uninstall keeps it because it is not the stub.
  assert.ok(!(await repoInstall(root,repo,{pointer})).writes.some(w=>w.path==='CLAUDE.md'));
  await repoUninstall(root,repo);assert.equal(await text(repo,'CLAUDE.md'),'@AGENTS.md\nClaude rule\n'+DESIGN);assert.deepEqual(await readdir(repo),['CLAUDE.md']);
 }
});
test('drift in the owned CLAUDE.md block refuses the conversion with nothing changed',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo,{version:'1.0.0'});
 await edit(repo,'CLAUDE.md',s=>'@AGENTS.md\n'+s.replace('Build a tracer bullet','Ignore all testing'));
 await unchanged(repo,()=>repoInstall(root,repo),/CLAUDE\.md: the Harness block was edited/);
 await unchanged(repo,()=>repoInstall(root,repo,{adopt:true}),/edited/);
 await unchanged(repo,()=>repoInstall(root,repo,{pointer:true}),/edited/);
 await edit(repo,'CLAUDE.md',s=>s.replace(BLOCK,''));
 await unchanged(repo,()=>repoInstall(root,repo),/CLAUDE\.md: the Harness block was edited or removed/);
 await rm(join(repo,'CLAUDE.md'));
 await unchanged(repo,()=>repoInstall(root,repo),/CLAUDE\.md: the Harness block was edited or removed/);
 assert.match(await text(repo,'AGENTS.md'),/release 1\.0\.0/);
});
test('a single-file install whose CLAUDE.md loses the import fails verify, and the next install puts the block back',async()=>{
 for(const pointer of [false,true]){
  const {root,repo}=await fixture();await repoInstall(root,repo,{pointer});
  await writeFile(join(repo,'CLAUDE.md'),'My Claude rules\n');
  const v=await repoVerify(repo);
  assert.equal(v.configurationVerified,false);assert.deepEqual(v.files,[{path:'AGENTS.md',matches:true}]);assert.equal(v.claudeImport!.matches,false);assert.match(v.claudeImport!.problem!,/Claude Code no longer receives the Harness block/);
  const result=await repoInstall(root,repo,{pointer});
  assert.deepEqual(result.writes.slice(0,2),[{path:'AGENTS.md',action:'replace owned block'},{path:'CLAUDE.md',action:'append block'}]);
  assert.ok((await text(repo,'CLAUDE.md')).startsWith('My Claude rules\n\n'+BEGIN));
  const m=await manifest(repo);assert.ok(!('claudeViaImport' in m));assert.deepEqual(m.files.map((f:{path:string;created:boolean})=>[f.path,f.created]),[['AGENTS.md',true],['CLAUDE.md',false]]);
  const again=await repoVerify(repo);assert.equal(again.configurationVerified,true);assert.ok(!('claudeViaImport' in again));
  await repoUninstall(root,repo);assert.equal(await text(repo,'CLAUDE.md'),'My Claude rules\n');assert.deepEqual(await readdir(repo),['CLAUDE.md']);
 }
});
test('a missing CLAUDE.md passes verify and the next install recreates the stub',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo,{version:'1.0.0'});await rm(join(repo,'CLAUDE.md'));
 const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.deepEqual(v.claudeImport,{path:'CLAUDE.md',matches:true});
 const result=await repoInstall(root,repo);
 assert.deepEqual(result.writes,[{path:'AGENTS.md',action:'replace owned block'},{path:'CLAUDE.md',action:'create import stub'},{path:MANIFEST,action:'update receipt'}]);
 assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.equal((await manifest(repo)).claudeViaImport,true);
 // Uninstall with no CLAUDE.md at all also works.
 await rm(join(repo,'CLAUDE.md'));assert.deepEqual((await repoUninstall(root,repo)).deletes,['AGENTS.md',MANIFEST]);assert.deepEqual(await readdir(repo),[]);
});
test('uninstall keeps the stub while AGENTS.md still holds a DesignOS block or user text',async()=>{
 for(const add of [DESIGN,'My own rule\n']){
  const {root,repo}=await fixture();await repoInstall(root,repo);await edit(repo,'AGENTS.md',s=>s+add);
  const result=await repoUninstall(root,repo);
  assert.deepEqual(result.deletes,[MANIFEST]);assert.equal(await text(repo,'AGENTS.md'),add);assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.deepEqual(await readdir(repo),TARGETS);
 }
 // A stub that gained text is not the stub any more, so it stays even when AGENTS.md goes.
 const {root,repo}=await fixture();await repoInstall(root,repo);await edit(repo,'CLAUDE.md',s=>s+DESIGN);
 await repoUninstall(root,repo);assert.equal(await text(repo,'CLAUDE.md'),STUB+DESIGN);assert.deepEqual(await readdir(repo),['CLAUDE.md']);
});
test('a two-file manifest edited to list one file is refused as a layout change',async()=>{
 // A two-file manifest edited by hand to drop CLAUDE.md is not a single-file install.
 const {root,repo}=await fixture({'AGENTS.md':'Keep this rule\n','CLAUDE.md':'Claude rule\n'});await repoInstall(root,repo);
 const m=await manifest(repo);await writeFile(join(repo,MANIFEST),JSON.stringify({...m,files:[m.files[0]]}));
 await unchanged(repo,()=>repoUninstall(root,repo),/layout changed/);
});
test('pointer mode works in the single-file layout, including a mode switch',async()=>{
 const {root,repo}=await fixture(),first=await repoInstall(root,repo,{pointer:true});
 assert.deepEqual(first.writes,[{path:'AGENTS.md',action:'create file'},{path:'CLAUDE.md',action:'create import stub'},{path:POLICY,action:'create policy file'},{path:MANIFEST,action:'create receipt'}]);
 assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.ok((await text(repo,'AGENTS.md')).includes(SENTENCE));assert.match(await text(repo,POLICY),/Second policy/);
 let m=await manifest(repo);assert.equal(m.claudeViaImport,true);assert.equal(m.mode,'pointer');assert.equal((await repoVerify(repo)).configurationVerified,true);
 const toFull=await repoInstall(root,repo);
 assert.deepEqual(toFull.writes.map(w=>w.path),['AGENTS.md',MANIFEST]);assert.deepEqual(toFull.deletes,[POLICY]);
 assert.match(await text(repo,'AGENTS.md'),/Second policy/);assert.equal(await text(repo,'CLAUDE.md'),STUB);
 m=await manifest(repo);assert.equal(m.claudeViaImport,true);assert.ok(!('mode' in m));assert.equal((await repoVerify(repo)).configurationVerified,true);
 const back=await repoInstall(root,repo,{pointer:true,version:'1.0.0'});
 assert.deepEqual(back.writes.map(w=>w.path),['AGENTS.md',POLICY,MANIFEST]);assert.match(await text(repo,POLICY),/tracer bullet/);
 const v=await repoVerify(repo);assert.equal(v.configurationVerified,true);assert.equal(v.mode,'pointer');assert.equal(v.claudeViaImport,true);
 assert.deepEqual((await repoUninstall(root,repo)).deletes,['AGENTS.md','CLAUDE.md',POLICY,MANIFEST]);assert.deepEqual(await readdir(repo),[]);
});
test('--adopt takes over an unmanaged block in AGENTS.md with a stub present',async()=>{
 const hand=`Intro\n${BEGIN}\nHand copy of the policy\n${END}\nOutro\n`,{root,repo}=await fixture({'AGENTS.md':hand,'CLAUDE.md':STUB});
 await unchanged(repo,()=>repoInstall(root,repo),/AGENTS\.md holds a Harness block that this command did not install/);
 const result=await repoInstall(root,repo,{adopt:true});
 assert.deepEqual(result.writes,[{path:'AGENTS.md',action:'adopt and replace block'},{path:MANIFEST,action:'create receipt'}]);
 assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.ok(!(await text(repo,'AGENTS.md')).includes('Hand copy'));
 assert.equal((await manifest(repo)).claudeViaImport,true);assert.equal((await repoVerify(repo)).configurationVerified,true);
 await repoUninstall(root,repo);assert.equal(await text(repo,'AGENTS.md'),'Intro\n\nOutro\n');assert.equal(await text(repo,'CLAUDE.md'),STUB);
 // A Harness block that nobody owns inside an importing CLAUDE.md would load twice. It is refused, with or without --adopt.
 const b=await fixture({'CLAUDE.md':`@AGENTS.md\n${BEGIN}\nHand copy\n${END}\n`});
 await unchanged(b.repo,()=>repoInstall(b.root,b.repo),/CLAUDE\.md imports AGENTS\.md and holds a Harness block that this command did not install/);
 await unchanged(b.repo,()=>repoInstall(b.root,b.repo,{adopt:true}),/did not install/);
});
test('symlink layouts get no stub and no claudeViaImport, and a stub replaced by a symlink is refused',async()=>{
 const a=await fixture({'AGENTS.md':'@AGENTS.md\nKeep this rule\n'});await symlink('AGENTS.md',join(a.repo,'CLAUDE.md'));
 const result=await repoInstall(a.root,a.repo);
 assert.deepEqual(result.writes.map(w=>w.path),['AGENTS.md',MANIFEST]);assert.ok((await lstat(join(a.repo,'CLAUDE.md'))).isSymbolicLink());
 const m=await manifest(a.repo);assert.ok(!('claudeViaImport' in m));assert.deepEqual(m.aliases,[{path:'CLAUDE.md',target:'AGENTS.md'}]);
 const v=await repoVerify(a.repo);assert.equal(v.configurationVerified,true);assert.ok(!('claudeViaImport' in v));
 await repoUninstall(a.root,a.repo);assert.equal(await text(a.repo,'AGENTS.md'),'@AGENTS.md\nKeep this rule\n');assert.ok((await lstat(join(a.repo,'CLAUDE.md'))).isSymbolicLink());
 const b=await fixture();await repoInstall(b.root,b.repo,{version:'1.0.0'});
 await rm(join(b.repo,'CLAUDE.md'));await symlink('AGENTS.md',join(b.repo,'CLAUDE.md'));
 const broken=await repoVerify(b.repo);assert.equal(broken.configurationVerified,false);assert.equal(broken.claudeImport!.matches,false);
 await unchanged(b.repo,()=>repoInstall(b.root,b.repo),/layout changed/);
 await unchanged(b.repo,()=>repoUninstall(b.root,b.repo),/layout changed/);
});
test('a manifest with a non-boolean or inconsistent claudeViaImport is rejected',async()=>{
 const {root,repo}=await fixture();await repoInstall(root,repo);const good=await manifest(repo),two=await fixture({'CLAUDE.md':'Claude rule\n'});await repoInstall(two.root,two.repo);
 for(const bad of ['true',1,null,{},[true]]){
  await writeFile(join(repo,MANIFEST),JSON.stringify({...good,claudeViaImport:bad}));
  await unchanged(repo,()=>repoUninstall(root,repo),/Unrecognized/);
  await unchanged(repo,()=>repoInstall(root,repo),/Unrecognized/);
  await assert.rejects(repoVerify(repo),/Unrecognized/);
 }
 // true is valid only with AGENTS.md as the one owned file; false is the same as absent.
 await writeFile(join(two.repo,MANIFEST),JSON.stringify({...await manifest(two.repo),claudeViaImport:true}));
 await unchanged(two.repo,()=>repoUninstall(two.root,two.repo),/Unrecognized/);await assert.rejects(repoVerify(two.repo),/Unrecognized/);
 await writeFile(join(two.repo,MANIFEST),JSON.stringify({...await manifest(two.repo),claudeViaImport:false}));
 assert.equal((await repoVerify(two.repo)).configurationVerified,true);
 await repoUninstall(two.root,two.repo);assert.deepEqual(await readdir(two.repo),['CLAUDE.md']);
});
test('single-file dry runs list the stub and change nothing',async()=>{
 const {root,repo}=await fixture();let before=await tree(repo);const state=await tree(root);
 const plan=await repoInstall(root,repo,{dryRun:true});
 assert.deepEqual(plan.writes,[{path:'AGENTS.md',action:'create file'},{path:'CLAUDE.md',action:'create import stub'},{path:MANIFEST,action:'create receipt'}]);
 assert.deepEqual(await tree(repo),before);assert.deepEqual(await tree(root),state);
 await repoInstall(root,repo);before=await tree(repo);const installed=await tree(root);
 const removal=await repoUninstall(root,repo,{dryRun:true});
 assert.deepEqual(removal.writes,[]);assert.deepEqual(removal.deletes,['AGENTS.md','CLAUDE.md',MANIFEST]);
 assert.deepEqual(await tree(repo),before);assert.deepEqual(await tree(root),installed);
});
// Runs the real DesignOS installer, which follows the same convention. It lives in a sibling checkout next to this repo, so CI and a plain clone skip this test.
const DESIGN_OS=join(code,'..','designOS-by-Uma','scripts','design_os.py');
const designOsMissing=!await exists(DESIGN_OS)?`DesignOS installer not found at ${DESIGN_OS}`:spawnSync('python3',['--version']).status!==0?'python3 not found':false;
test('Harness and the real DesignOS installer share one AGENTS.md and one stub, in either install order',{skip:designOsMissing},async()=>{
 const design=(repo:string,action:string,...args:string[])=>spawnSync('python3',[DESIGN_OS,action,'--project',repo,...args],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 const ok=(r:ReturnType<typeof design>)=>assert.equal(r.status,0,r.stderr);
 const DESIGN_BEGIN='<!-- BEGIN UMA DESIGN OS -->',count=(s:string,mark:string)=>s.split(mark).length-1;
 // harness-lifo removes DesignOS first. The other two remove Harness first.
 for(const order of ['harness','design','harness-lifo']){
  const {root,repo:made}=await fixture(),repo=await realpath(made);
  if(order==='design')ok(design(repo,'install','--platform','all'));
  await repoInstall(root,repo);
  if(order!=='design')ok(design(repo,'install','--platform','all'));
  assert.equal(await text(repo,'CLAUDE.md'),STUB,order);
  const agents=await text(repo,'AGENTS.md');assert.equal(count(agents,BEGIN),1,order);assert.equal(count(agents,DESIGN_BEGIN),1,order);
  assert.equal((await manifest(repo)).claudeViaImport,true);assert.equal(JSON.parse(await text(repo,'.design-os/manifest.json')).claude_via_import,true);
  assert.equal((await repoVerify(repo)).configurationVerified,true,order);ok(design(repo,'status'));
  if(order==='harness-lifo'){
   ok(design(repo,'uninstall'));
   assert.equal(await text(repo,'CLAUDE.md'),STUB);assert.equal((await repoVerify(repo)).configurationVerified,true);
   await repoUninstall(root,repo);
  }else{
   await repoUninstall(root,repo);
   assert.equal(await text(repo,'CLAUDE.md'),STUB,order);assert.equal(count(await text(repo,'AGENTS.md'),BEGIN),0);ok(design(repo,'status'));
   ok(design(repo,'uninstall'));
  }
  // Every order ends with both files gone. When Harness is first in and first out, DesignOS did not create AGENTS.md; it still deletes
  // the file it empties because the layout is installer-made (claude_via_import and an exact stub), and the stub goes with it.
  for(const name of TARGETS)assert.equal(await exists(join(repo,name)),false,`${order}: ${name}`);
  assert.equal(await exists(join(repo,'.agentic-harness')),false);assert.equal(await exists(join(repo,'.design-os/manifest.json')),false);
 }
});
test('converting keeps an import line that the user appended right after the block on its own line',async()=>{
 const {root,repo}=await fixture({'AGENTS.md':DESIGN,'CLAUDE.md':DESIGN});
 await repoInstall(root,repo);
 await writeFile(join(repo,'CLAUDE.md'),await text(repo,'CLAUDE.md')+'@AGENTS.md\n');
 const result=await repoInstall(root,repo);
 assert.ok(result.writes.some(w=>w.path==='CLAUDE.md'&&w.action==='remove owned block'));
 assert.equal(await text(repo,'CLAUDE.md'),DESIGN+'@AGENTS.md\n');
 assert.equal((await repoVerify(repo)).configurationVerified,true);
});
