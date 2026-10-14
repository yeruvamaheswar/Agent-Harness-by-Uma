import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSnapshot,digest,publish,current,activate,chunks,localSearch,readRelease,render} from '../src/core.ts';
import {managed,install,verifyInstall,uninstall,nodeCommand} from '../src/install.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'harness-test-'));
 await writeFile(join(root,'core.md'),'# Rules\nBuild a tracer bullet and verify it.');
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave and retrieve a real expense before adding reports.\n## Error handling\nDo not suppress errors.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 return root;
}
test('release requires a matching reviewed digest; source changes cannot slip in',async()=>{const root=await fixture();const sha=digest(await loadSnapshot(root));await writeFile(join(root,'core.md'),'changed');await assert.rejects(publish(root,'1.0.0',sha,true),/Source changed/);});
test('immutable release and rollback select complete previous snapshots',async()=>{const root=await fixture();let s=await loadSnapshot(root);await publish(root,'1.0.0',digest(s),true);await writeFile(join(root,'core.md'),'second policy');s=await loadSnapshot(root);await assert.rejects(publish(root,'1.0.0',digest(s),true),/immutable/);await publish(root,'1.1.0',digest(s),true);await activate(root,'1.0.0');assert.match((await current(root)).core,/tracer bullet/);});
test('bootstrap must be explicit until Notion is reconciled',async()=>{const root=await fixture();await assert.rejects(publish(root,'1.0.0',digest(await loadSnapshot(root))),/Import Notion/);});
test('release tampering is detected',async()=>{const root=await fixture();await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);const path=join(root,'releases/1.0.0/release.json');const r=JSON.parse(await readFile(path,'utf8'));r.core='tampered';await writeFile(path,JSON.stringify(r));await assert.rejects(readRelease(root,'1.0.0'),/integrity/);});
test('platform packages contain exactly the same policy',async()=>{const root=await fixture();const r=await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);const p=render(r);assert.equal(p['codex/AGENTS.md'],p['cursor/user-rules.md']);assert.equal(p['codex/AGENTS.md'],p['grok-bot/bot-description.md']);assert.equal(p['codex/AGENTS.md'],p['claude/CLAUDE.md']);});
test('every platform copy starts with a plain-text release line and keeps the release comment',async()=>{
 // Claude Code hides HTML comments, so only the plain-text line lets an agent report its release.
 const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));const r=await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 const header=['Harness release 1.0.0.',`<!-- Agentic harness release 1.0.0; digest ${r.digest} -->`,'# Rules'],platforms=['claude','codex','cursor-files','generic'];
 for(const p of platforms)await install(root,p,home);
 const lines=(text:string,after='')=>text.slice(text.indexOf(after)+after.length).split('\n').slice(0,3),read=(path:string)=>readFile(join(root,path),'utf8'),installed=(path:string)=>readFile(join(home,path),'utf8');
 assert.deepEqual(lines(await installed('.claude/CLAUDE.md'),'<!-- BEGIN AGENTIC HARNESS -->\n'),header);
 assert.deepEqual(lines(await installed('.codex/AGENTS.md'),'<!-- BEGIN AGENTIC HARNESS -->\n'),header);
 assert.deepEqual(lines(await installed('.config/agentic-harness/instructions.md')),header);
 // Cursor User Rules is a manual paste of the release export, and install cursor-files writes no rule file, so check the published files.
 assert.deepEqual(lines(await read('releases/1.0.0/cursor/user-rules.md')),header);
 assert.deepEqual(lines(await read('releases/1.0.0/cursor/agentic-harness.mdc'),'alwaysApply: true\n---\n\n'),header);
 for(const p of platforms)assert.equal((await verifyInstall(root,p)).configurationVerified,true,p);
});
test('keyword retrieval cites sources, respects domains and excludes nonmatches',async()=>{const root=await fixture();const r=await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);assert.equal(localSearch(r,'expense')[0].sourceUrl,'https://example.com/guide');assert.equal(localSearch(r,'expense',5,'personal').length,0);assert.equal(localSearch(r,'nonsensexyz').length,0);});
test('chunking retains all content even for long lines',()=>{const text='x'.repeat(7000);const c=chunks([{id:'x',title:'X',domain:'engineering',sourceUrl:'url',content:text}]);assert.equal(c.map(x=>x.content).join(''),text);assert.ok(c.every(x=>x.content.length<=2400));});
test('managed instructions preserve unrelated settings and reject malformed markers',()=>{const once=managed('Existing rule\n','policy'),twice=managed(once,'policy');assert.equal(twice,once);assert.match(twice,/Existing rule/);assert.throws(()=>managed('<!-- BEGIN AGENTIC HARNESS -->','x'),/Malformed/);});
test('generic reinstall keeps the path of an existing installation',async()=>{
 const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 const old=join(home,'.config/old-harness/instructions.md');await mkdir(join(root,'.state/installations'),{recursive:true});
 await writeFile(join(root,'.state/installations/generic.json'),JSON.stringify({platform:'generic',version:'0.9.0',files:[{path:old,hash:'x',backup:'',existed:false}],installedAt:'x',verification:'x'}));
 await install(root,'generic',home);assert.match(await readFile(old,'utf8'),/release 1\.0\.0/);
 await assert.rejects(readFile(join(home,'.config/agentic-harness/instructions.md')),/ENOENT/);
});
test('global installation works independently of a project and restores originals',async()=>{const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));await mkdir(join(home,'.codex'));await writeFile(join(home,'.codex/AGENTS.md'),'Keep this rule\n');await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);await install(root,'codex',home);assert.ok((await verifyInstall(root,'codex')).configurationVerified);assert.match(await readFile(join(home,'.codex/AGENTS.md'),'utf8'),/Keep this rule/);await uninstall(root,'codex');assert.equal(await readFile(join(home,'.codex/AGENTS.md'),'utf8'),'Keep this rule\n');});
test('claude installation preserves existing CLAUDE.md and restores it',async()=>{const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));await mkdir(join(home,'.claude'));await writeFile(join(home,'.claude/CLAUDE.md'),'Keep this rule\n');await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);await install(root,'claude',home);assert.ok((await verifyInstall(root,'claude')).configurationVerified);const text=await readFile(join(home,'.claude/CLAUDE.md'),'utf8');assert.match(text,/Keep this rule/);assert.match(text,/Agentic harness release 1\.0\.0/);await uninstall(root,'claude');assert.equal(await readFile(join(home,'.claude/CLAUDE.md'),'utf8'),'Keep this rule\n');});
test('uninstall refuses to overwrite edits made after install',async()=>{const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);await install(root,'generic',home);await writeFile(join(home,'.config/agentic-harness/instructions.md'),'user edit');await assert.rejects(uninstall(root,'generic'),/changed/);});
async function codexInstall(){
 const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 const rules=join(home,'.codex/AGENTS.md'),settings=join(home,'.codex/config.toml');
 await mkdir(join(home,'.codex'));await writeFile(rules,'Keep this rule\n');await writeFile(settings,'model = "x"\n');
 const receipt=await install(root,'codex',home),file=join(root,'.state/installations/codex.json');
 const rewrite=(backup:(b:string,i:number)=>string)=>writeFile(file,JSON.stringify({...receipt,files:receipt.files.map((f,i)=>({...f,backup:backup(f.backup,i)}))}));
 const restored=async()=>{await uninstall(root,'codex');assert.equal(await readFile(rules,'utf8'),'Keep this rule\n');assert.equal(await readFile(settings,'utf8'),'model = "x"\n');};
 return {root,rules,settings,file,receipt,rewrite,restored};
}
test('install receipts store backups relative to the harness root',async()=>{
 const {root,file,receipt,restored}=await codexInstall(),relative=[0,1].map(i=>join('.state/backups/codex',receipt.installedAt,`${i}.txt`));
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')).files.map((f:{backup:string})=>f.backup),relative);
 assert.equal(await readFile(join(root,relative[0]),'utf8'),'Keep this rule\n');
 await restored();
});
test('legacy absolute backup paths restore in place and after the harness folder moved',async()=>{
 const same=await codexInstall();await same.rewrite(b=>join(same.root,b));await same.restored();
 const moved=await codexInstall();await moved.rewrite(b=>join('/old/location/Agentic Harness',b));await moved.restored();
});
test('a missing backup fails clearly and leaves every target untouched',async()=>{
 const {root,rules,settings,file,rewrite}=await codexInstall(),before=[await readFile(rules,'utf8'),await readFile(settings,'utf8')];
 await rewrite((b,i)=>i===1?'/old/location/.state/backups/codex/gone/1.txt':b);
 await assert.rejects(uninstall(root,'codex'),/^Error: Backup not found: \/old\/location\/\.state\/backups\/codex\/gone\/1\.txt \(also checked \/.+\/\.state\/backups\/codex\/gone\/1\.txt\)\. Nothing was restored\.$/);
 await rewrite((b,i)=>i===1?'/elsewhere/1.txt':b);
 await assert.rejects(uninstall(root,'codex'),/^Error: Backup not found: \/elsewhere\/1\.txt\. Nothing was restored\.$/);
 assert.deepEqual([await readFile(rules,'utf8'),await readFile(settings,'utf8')],before);assert.ok(JSON.parse(await readFile(file,'utf8')).files);
});
test('verification tolerates unrelated settings but detects changed owned instructions',async()=>{
 const root=await fixture(),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);await install(root,'codex',home);
 const settings=join(home,'.codex/config.toml');await writeFile(settings,'# Other plugin configured\n'+await readFile(settings,'utf8'));
 assert.equal((await verifyInstall(root,'codex')).configurationVerified,true);
 await assert.rejects(uninstall(root,'codex'),/changed/);
 const rules=join(home,'.codex/AGENTS.md');await writeFile(rules,(await readFile(rules,'utf8')).replace('Build a tracer bullet','Ignore all testing'));
 assert.equal((await verifyInstall(root,'codex')).configurationVerified,false);
});

test('nodeCommand returns a PATH node that resolves to the exec path',async()=>{const dir=await mkdtemp(join(tmpdir(),'harness-node-')),link=join(dir,'node');await symlink(process.execPath,link);assert.equal(await nodeCommand(dir,process.execPath),link);});
test('nodeCommand falls back to the exec path when PATH has no match',async()=>{const dir=await mkdtemp(join(tmpdir(),'harness-node-'));assert.equal(await nodeCommand(dir,process.execPath),process.execPath);});
test('nodeCommand skips a PATH node that points at a different binary',async()=>{const other=await mkdtemp(join(tmpdir(),'harness-node-')),good=await mkdtemp(join(tmpdir(),'harness-node-'));await writeFile(join(other,'other'),'');await symlink(join(other,'other'),join(other,'node'));await symlink(process.execPath,join(good,'node'));assert.equal(await nodeCommand(`${other}:${good}`,process.execPath),join(good,'node'));});
