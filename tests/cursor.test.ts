import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,access,symlink,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadSnapshot,digest,publish,current,render,hash,saveJSON} from '../src/core.ts';
import {install,verifyInstall,uninstall} from '../src/install.ts';
import {cursorUserRules,confirmStep} from '../src/manual-steps.ts';

// Cursor keeps the policy in User Rules only. install cursor-files owns the MCP entry and retires the rule file that earlier installs wrote.
const repo=join(dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
const OTHER=JSON.stringify({mcpServers:{other:{command:'x'}}},null,2)+'\n';
async function source(root:string){
 await writeFile(join(root,'core.md'),'# Rules\nBuild a tracer bullet and verify it.');
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'harness-test-')),home=await mkdtemp(join(tmpdir(),'harness-home-')),rules=join(home,'.cursor/rules'),mcp=join(home,'.cursor/mcp.json');
 await source(root);await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 await mkdir(dirname(mcp));await writeFile(mcp,OTHER);
 return {root,home,rules,mcp,rule:join(rules,'pragmatic-engineer.mdc'),receipt:join(root,'.state/installations/cursor-files.json')};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const exists=(path:string)=>access(path).then(()=>true,()=>false);
const servers=async(f:Fixture)=>Object.keys(JSON.parse(await readFile(f.mcp,'utf8')).mcpServers);
// The state an install left before this change: a receipt that lists the rule file first, then the MCP entry. earlier is the file that the old install replaced.
async function oldInstall(f:Fixture,earlier?:string){
 const r=await install(f.root,'cursor-files',f.home),text=render(await current(f.root))['cursor/agentic-harness.mdc'],backup=join('.state/backups/cursor-files',r.installedAt,'rule.txt');
 await mkdir(f.rules);await writeFile(f.rule,text);await writeFile(join(f.root,backup),earlier??'');
 await saveJSON(f.receipt,{...r,files:[{path:f.rule,hash:hash(text),backup,existed:earlier!==undefined,ownedHash:hash(text)},...r.files]});
 return text;
}

test('install cursor-files registers the MCP server, keeps other servers, and writes no rule file',async()=>{
 const f=await fixture(),r=await install(f.root,'cursor-files',f.home);
 assert.deepEqual(r.files.map(x=>[x.path,x.scope]),[[f.mcp,'cursor-mcp']]);
 assert.deepEqual(await servers(f),['other','agentic_harness']);
 assert.equal(await exists(f.rules),false);
 assert.deepEqual([r.retired,r.warnings],[undefined,undefined]);
 const v=await verifyInstall(f.root,'cursor-files');
 assert.deepEqual([v.configurationVerified,v.files.map(x=>x.path)],[true,[f.mcp]]);assert.match(v.note,/manual step in Cursor User Rules/);
 assert.deepEqual(await uninstall(f.root,'cursor-files'),{restored:true,platform:'cursor-files'});
 assert.equal(await readFile(f.mcp,'utf8'),OTHER);assert.equal(await exists(f.receipt),false);
});
test('an upgrade removes the unchanged rule file of an earlier install, keeps a copy, and touches no other rule file',async()=>{
 const f=await fixture(),text=await oldInstall(f),others={'team.mdc':'---\nalwaysApply: true\n---\n\n- Use pnpm.\n','agentic-harness-pack-example__sample.mdc':'pack\n'};
 for(const [name,body] of Object.entries(others))await writeFile(join(f.rules,name),body);
 const r=await install(f.root,'cursor-files',f.home);
 assert.equal(await exists(f.rule),false);
 assert.deepEqual([r.retired,r.warnings],[{path:f.rule,backup:join('.state/backups/cursor-files',r.installedAt,'pragmatic-engineer.mdc')},undefined]);
 assert.equal(await readFile(join(f.root,r.retired!.backup),'utf8'),text);
 assert.deepEqual((await readdir(f.rules)).sort(),Object.keys(others).sort());
 for(const [name,body] of Object.entries(others))assert.equal(await readFile(join(f.rules,name),'utf8'),body);
 const stored=JSON.parse(await readFile(f.receipt,'utf8'));
 assert.deepEqual([stored.files.map((x:{path:string})=>x.path),'retired' in stored],[[f.mcp],false]);
 assert.equal((await verifyInstall(f.root,'cursor-files')).configurationVerified,true);
 // Uninstall restores mcp.json to its state before the upgrade. It does not bring the retired rule file back.
 await uninstall(f.root,'cursor-files');
 assert.deepEqual([await exists(f.rule),await exists(f.receipt),await servers(f)],[false,false,['other','agentic_harness']]);
});
test('a rule file that changed after the earlier install is left in place with a warning',async()=>{
 const edited=await fixture();await oldInstall(edited);await writeFile(edited.rule,'my edit\n');
 const linked=await fixture(),text=await oldInstall(linked),elsewhere=join(linked.home,'elsewhere.mdc');
 await writeFile(elsewhere,text);await rm(linked.rule);await symlink(elsewhere,linked.rule);
 for(const [f,now] of [[edited,'my edit\n'],[linked,text]] as const){
  const r=await install(f.root,'cursor-files',f.home);
  assert.equal(await readFile(f.rule,'utf8'),now);
  assert.equal(r.retired,undefined);assert.equal(r.warnings?.length,1);
  assert.ok(r.warnings![0].startsWith(`${f.rule} changed after the harness installed it, so it was left in place.`));
  assert.match(r.warnings![0],/Cursor now loads the policy twice: from this file and from User Rules\. Remove the file by hand\./);
  assert.deepEqual(await readdir(join(f.root,'.state/backups/cursor-files',r.installedAt)),['0.txt']);
  assert.equal((await verifyInstall(f.root,'cursor-files')).configurationVerified,true);
 }
 assert.equal(await readFile(elsewhere,'utf8'),text);
});
test('a pragmatic-engineer.mdc file that no receipt lists is never touched',async()=>{
 const f=await fixture(),text=render(await current(f.root))['cursor/agentic-harness.mdc'];
 await mkdir(f.rules);await writeFile(f.rule,text);
 for(const run of ['no receipt','a receipt that lists only the MCP entry']){
  const r=await install(f.root,'cursor-files',f.home);
  assert.equal(await readFile(f.rule,'utf8'),text,run);assert.deepEqual([r.retired,r.warnings],[undefined,undefined],run);
 }
 assert.deepEqual(await readdir(f.rules),['pragmatic-engineer.mdc']);
});
test('an old two-file receipt still verifies and uninstalls: the earlier rule file and mcp.json come back',async()=>{
 const f=await fixture();await oldInstall(f,'earlier rule\n');
 const v=await verifyInstall(f.root,'cursor-files');
 assert.deepEqual([v.configurationVerified,v.files.map(x=>x.path)],[true,[f.rule,f.mcp]]);
 assert.deepEqual(await uninstall(f.root,'cursor-files'),{restored:true,platform:'cursor-files'});
 assert.deepEqual([await readFile(f.rule,'utf8'),await readFile(f.mcp,'utf8'),await exists(f.receipt)],['earlier rule\n',OTHER,false]);
});
test('a failed receipt write puts the rule file and mcp.json back',async()=>{
 const f=await fixture(),text=await oldInstall(f),before=await readFile(f.mcp,'utf8'),receipt=await readFile(f.receipt,'utf8');
 // Compact JSON differs from the bytes the installer writes, so this checks a real restore.
 const changed=JSON.stringify(JSON.parse(before));await writeFile(f.mcp,changed);
 await chmod(dirname(f.receipt),0o500);
 try{await assert.rejects(install(f.root,'cursor-files',f.home),/EACCES/);}finally{await chmod(dirname(f.receipt),0o700);}
 assert.deepEqual([await readFile(f.rule,'utf8'),await readFile(f.mcp,'utf8'),await readFile(f.receipt,'utf8')],[text,changed,receipt]);
});

test('the Cursor User Rules step is pending until the active release, by version and digest, is confirmed',async()=>{
 const {root}=await fixture(),active=await current(root),file=join(root,'releases/1.0.0/cursor/user-rules.md');
 const pending={id:'cursor-user-rules',needed:true,confirmedVersion:null,activeVersion:'1.0.0',instruction:`Paste the full content of ${file} into Cursor > Customize > Rules > User Rules, in the rule named "Agentic Harness". Then run: npm run harness -- confirm cursor-user-rules`};
 assert.deepEqual(await cursorUserRules(root,active),pending);
 assert.equal(await readFile(file,'utf8'),render(active)['cursor/user-rules.md']);
 await assert.rejects(confirmStep(root,'cursor-user-rules','9.9.9'),/^Error: Release 9\.9\.9 is not in releases\/\. Nothing was recorded\.$/);
 await assert.rejects(confirmStep(root,'cursor-rules'),/Unknown manual step\. Use: confirm cursor-user-rules/);
 assert.equal(await exists(join(root,'.state/manual-steps.json')),false);
 const done=await confirmStep(root,'cursor-user-rules');
 assert.deepEqual([done.confirmed,done.version,done.digest,'manualSteps' in done],['cursor-user-rules','1.0.0',active.digest,false]);
 assert.match(done.note,/No tool can read Cursor User Rules/);
 assert.deepEqual(JSON.parse(await readFile(join(root,'.state/manual-steps.json'),'utf8')),{'cursor-user-rules':{version:'1.0.0',digest:active.digest,confirmedAt:done.confirmedAt}});
 assert.deepEqual(await cursorUserRules(root,active),{...pending,needed:false,confirmedVersion:'1.0.0'});
 assert.equal((await cursorUserRules(root,{version:'1.0.0',digest:'0'.repeat(64)})).needed,true);
});
test('CLI: status lists the step, and publish, activate, rollback, and install cursor-files remind until it is confirmed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'harness-content-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await source(root);
 const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:join(home,'claude-config'),HARNESS_ROOT:''};
 const cli=async(...args:string[])=>JSON.parse((await run(process.execPath,['--experimental-strip-types',join(repo,'src/cli.ts'),'--root',root,...args],{cwd:tmpdir(),env})).stdout);
 const step=(activeVersion:string,confirmedVersion:string|null)=>({id:'cursor-user-rules',needed:true,confirmedVersion,activeVersion,instruction:`Paste the full content of ${join(root,'releases',activeVersion,'cursor/user-rules.md')} into Cursor > Customize > Rules > User Rules, in the rule named "Agentic Harness". Then run: npm run harness -- confirm cursor-user-rules`});
 assert.deepEqual((await cli('status')).manualSteps,[]);
 const first=await cli('preview');
 assert.deepEqual((await cli('publish','1.0.0','--approve-sha',first.digest,'--bootstrap')).manualSteps,[step('1.0.0',null)]);
 assert.deepEqual((await cli('status')).manualSteps,[step('1.0.0',null)]);
 const installed=await cli('install','cursor-files');
 assert.deepEqual([installed.files.length,installed.manualSteps],[1,[step('1.0.0',null)]]);
 assert.equal(await exists(join(home,'.cursor/rules')),false);
 await assert.rejects(cli('confirm','cursor-user-rules','--version','9.9.9'),/Release 9\.9\.9 is not in releases\//);
 assert.equal('manualSteps' in await cli('confirm','cursor-user-rules'),false);
 assert.deepEqual((await cli('status')).manualSteps,[{...step('1.0.0','1.0.0'),needed:false}]);
 assert.equal('manualSteps' in await cli('install','cursor-files'),false);
 await writeFile(join(root,'core.md'),'# Rules\nSecond release of the policy.');
 const second=await cli('preview'),next=[step('1.1.0','1.0.0')];
 assert.deepEqual((await cli('publish','1.1.0','--approve-sha',second.digest,'--bootstrap')).manualSteps,next);
 assert.deepEqual((await cli('status')).manualSteps,next);
 assert.deepEqual((await cli('install','cursor-files')).manualSteps,next);
 // Rolling back to the confirmed release needs no paste; activating the new release does.
 assert.equal('manualSteps' in await cli('rollback','1.0.0'),false);
 assert.deepEqual((await cli('activate','1.1.0')).manualSteps,next);
 assert.deepEqual((await cli('confirm','cursor-user-rules','--version','1.0.0')).manualSteps,next);
 assert.equal('manualSteps' in await cli('confirm','cursor-user-rules'),false);
 assert.deepEqual((await cli('status')).manualSteps,[{...step('1.1.0','1.1.0'),needed:false}]);
});
