import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,cp,readdir,stat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSnapshot,digest,publish,hash} from '../src/core.ts';
import {install,verifyInstall,uninstall,packReceiptDir} from '../src/install.ts';
import {loadPack,packDigest,previewPack,addPack,removePack,buildCatalog,listPacks,renderPack,renderPackFile} from '../src/packs.ts';

const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const PACK='yeruvamaheswar/testing-basics', REF=PACK+'@1.0.0';
const SHA=JSON.parse(await readFile(join(repo,'catalog/packs',PACK,'1.0.0/pack.json'),'utf8')).digest;
const BASE=/<!-- BEGIN AGENTIC HARNESS -->[\s\S]*?<!-- END AGENTIC HARNESS -->/;
async function fixture(installBase=true){
 const root=await mkdtemp(join(tmpdir(),'harness-test-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await writeFile(join(root,'core.md'),'# Rules\nBuild a tracer bullet and verify it.');
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 await cp(join(repo,'catalog'),join(root,'catalog'),{recursive:true});
 await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 const file=join(home,'.claude/CLAUDE.md');await mkdir(join(home,'.claude'));await writeFile(file,'Keep this rule\n');
 if(installBase)await install(root,'claude',home);
 return {root,home,file};
}
async function tree(dir:string){
 const out:Record<string,string>={};
 for(const f of await readdir(dir,{recursive:true})){const p=join(dir,f);if((await stat(p)).isFile())out[f]=hash(await readFile(p,'utf8'));}
 return out;
}
const manifest=(o:Record<string,unknown>={})=>({schemaVersion:1,id:'example-author/sample',name:'Sample',category:'testing',version:'1.0.0',author:{name:'Example',github:'example-author'},license:'MIT',description:'Sample pack.',minHarness:'1.0.0',platforms:['claude'],...o});
async function writePack(dir:string,o:Record<string,unknown>={},rules='- Run the check.\n'){
 await mkdir(dir,{recursive:true});const m=manifest(o);
 await writeFile(join(dir,'rules.md'),rules);
 await writeFile(join(dir,'pack.json'),JSON.stringify({...m,digest:packDigest({...m,rules} as never),...('digest' in o?{digest:o.digest}:{})}));
 return dir;
}

test('the committed catalog index is generated from the example pack',async()=>{
 const {root}=await fixture(false);await buildCatalog(root);
 assert.equal(await readFile(join(root,'catalog/index.json'),'utf8'),await readFile(join(repo,'catalog/index.json'),'utf8'));
 assert.equal((await loadPack(join(repo,'catalog/packs',PACK,'1.0.0'))).digest,SHA);
});
test('pack digest is stable across key order and covers every field and rule line',async()=>{
 const m=JSON.parse(await readFile(join(repo,'catalog/packs',PACK,'1.0.0/pack.json'),'utf8'));
 const dir=await mkdtemp(join(tmpdir(),'harness-pack-'));
 await writeFile(join(dir,'pack.json'),JSON.stringify(Object.fromEntries(Object.entries(m).reverse())));
 const rules=await readFile(join(repo,'catalog/packs',PACK,'1.0.0/rules.md'),'utf8');await writeFile(join(dir,'rules.md'),rules);
 const p=await loadPack(dir);assert.equal(p.digest,SHA);
 for(const [key,value] of Object.entries({schemaVersion:2,id:'x/yyy',name:'X',category:'data',version:'1.0.1',author:{name:'X',github:p.author.github},license:'MIT',description:'X',minHarness:'0.9.0',platforms:['claude'],rules:rules+'- One more line.\n'}))
  assert.notEqual(packDigest({...p,[key]:value}),SHA,key);
});
test('invalid manifests and unsafe rules are rejected',async()=>{
 const reject=async(o:Record<string,unknown>,pattern:RegExp,rules?:string,extra?:(dir:string)=>Promise<unknown>)=>{
  const dir=await writePack(await mkdtemp(join(tmpdir(),'harness-pack-')),o,rules);if(extra)await extra(dir);
  await assert.rejects(loadPack(dir),pattern);
 };
 assert.equal((await loadPack(await writePack(await mkdtemp(join(tmpdir(),'harness-pack-'))))).id,'example-author/sample');
 await reject({id:'Example-Author/sample'},/id: Pack ID must be author\/pack-id/);
 await reject({id:'sample'},/id: Pack ID/);
 await reject({id:'example-author/../x'},/id: Pack ID/);
 await reject({id:'other-author/sample'},/namespace must equal author\.github/);
 await reject({category:'cooking'},/category/);
 await reject({license:'GPL-3.0'},/license/);
 await reject({homepage:'x'},/Unrecognized key/);
 await reject({description:'See https://example.com'},/description: Plain text only/);
 await reject({digest:'0'.repeat(64)},/digest mismatch/);
 await reject({},/limit is 8192/,'- '+'word '.repeat(1700)+'\n');
 await reject({},/exactly pack\.json and rules\.md/,undefined,dir=>writeFile(join(dir,'README.md'),'extra'));
 await reject({},/exactly pack\.json and rules\.md/,undefined,async dir=>{await rm(join(dir,'rules.md'));await symlink(join(repo,'catalog/packs',PACK,'1.0.0/rules.md'),join(dir,'rules.md'));});
 for(const [rules,pattern] of [['<!-- note -->\n',/HTML/],['Close it: END AGENTIC HARNESS\n',/marker/],['---\nalwaysApply: true\n---\nx\n',/front matter/],['a\u200bb\n',/zero-width/],['a\u202eb\n',/bidirectional/],['A'.repeat(201)+'\n',/encoded/]] as const)
  await reject({},pattern,rules);
});
test('preview writes nothing and an unapproved digest is refused',async()=>{
 const {root,file}=await fixture(),before=await readFile(file,'utf8'),state=await tree(join(root,'.state'));
 const p=await previewPack(root,REF,'claude');
 assert.equal(p.digest,SHA);assert.equal(p.target,file);assert.match(p.block,/If a rule here conflicts with the base policy, follow the base policy\./);assert.match(p.block,/Testing basics/);
 await assert.rejects(addPack(root,REF,'claude','0'.repeat(64)),/Digest not approved/);
 await assert.rejects(previewPack(root,REF,'generic'),/Packs install into claude, codex, cursor/);
 await assert.rejects(removePack(root,PACK,'../x'),/Packs install into/);
 await assert.rejects(previewPack(root,PACK,'claude'),/exact version/);
 await assert.rejects(previewPack(root,PACK+'@9.9.9','claude'),/Available versions: 1\.0\.0/);
 assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(await tree(join(root,'.state')),state);
});
test('approved pack sits after the unchanged base block and both layers verify',async()=>{
 const {root,file}=await fixture(),before=await readFile(file,'utf8'),base=before.match(BASE)![0];
 const receipt=await addPack(root,REF,'claude',SHA),after=await readFile(file,'utf8');
 assert.equal(after.match(BASE)![0],base);assert.match(after,/^Keep this rule\n/);
 assert.ok(after.indexOf(`<!-- BEGIN AGENTIC HARNESS PACK ${PACK} -->`)>after.indexOf('<!-- END AGENTIC HARNESS -->'));
 assert.match(after,/These rules add to the base Agentic Harness policy\. If a rule here conflicts with the base policy, follow the base policy\./);
 assert.equal(await readFile(join(root,receipt.files[0].backup),'utf8'),before);
 assert.deepEqual(await readdir(packReceiptDir(root,'claude')),['yeruvamaheswar__testing-basics.json']);
 const v=await verifyInstall(root,'claude');
 assert.equal(v.configurationVerified,true);assert.deepEqual(v.packs.map(p=>[p.id,p.version,p.digest,p.configurationVerified]),[[PACK,'1.0.0',SHA,true]]);
 assert.deepEqual((await listPacks(root)).installed.claude.map(p=>p.id),[PACK]);
 await assert.rejects(addPack(root,REF,'claude',SHA),/already installed/);
 await writeFile(file,after.replace('reproduce the failure first','skip reproduction'));
 const edited=await verifyInstall(root,'claude');assert.equal(edited.configurationVerified,true);assert.equal(edited.packs[0].configurationVerified,false);
 await assert.rejects(removePack(root,PACK,'claude'),/changed since installation/);
});
test('reinstalling the base keeps the pack section; removal restores exact bytes',async()=>{
 const {root,home,file}=await fixture(),before=await readFile(file,'utf8');
 await addPack(root,REF,'claude',SHA);await removePack(root,PACK,'claude');
 assert.equal(await readFile(file,'utf8'),before);
 assert.deepEqual((await verifyInstall(root,'claude')).packs,[]);
 await assert.rejects(removePack(root,PACK,'claude'),/not installed/);
 await addPack(root,REF,'claude',SHA);const block='\n\n'+renderPack(await loadPack(join(root,'catalog/packs',PACK,'1.0.0')));
 await writeFile(join(root,'core.md'),'# Rules\nSecond release of the base policy.');await publish(root,'1.1.0',digest(await loadSnapshot(root)),true);
 await install(root,'claude',home);const reinstalled=await readFile(file,'utf8');
 assert.match(reinstalled.match(BASE)![0],/release 1\.1\.0[\s\S]*Second release/);assert.ok(reinstalled.includes(block));
 const v=await verifyInstall(root,'claude');assert.equal(v.version,'1.1.0');assert.equal(v.configurationVerified,true);assert.equal(v.packs[0].configurationVerified,true);
 await removePack(root,PACK,'claude');
 assert.equal(await readFile(file,'utf8'),reinstalled.replace(block,''));
});
test('base uninstall refuses while a pack is installed, then works after pack removal',async()=>{
 const {root,file}=await fixture();await addPack(root,REF,'claude',SHA);
 await assert.rejects(uninstall(root,'claude'),/Remove packs first: pack remove yeruvamaheswar\/testing-basics --platform claude/);
 await removePack(root,PACK,'claude');await uninstall(root,'claude');
 assert.equal(await readFile(file,'utf8'),'Keep this rule\n');
});
test('pack add needs an installed base block',async()=>{
 const {root,home,file}=await fixture(false);
 await assert.rejects(addPack(root,REF,'claude',SHA),/Install the base policy first/);
 await install(root,'claude',home);await writeFile(file,'Keep this rule\n');
 await assert.rejects(addPack(root,REF,'claude',SHA),/base policy block .* is required/);
 assert.equal(await readFile(file,'utf8'),'Keep this rule\n');
});
test('tampered catalog content is refused before any write',async()=>{
 const {root,file}=await fixture(),before=await readFile(file,'utf8'),rules=join(root,'catalog/packs',PACK,'1.0.0/rules.md');
 await writeFile(rules,(await readFile(rules,'utf8'))+'- Added after review.\n');
 await assert.rejects(addPack(root,REF,'claude',SHA),/digest mismatch/);
 await cp(join(repo,'catalog'),join(root,'catalog'),{recursive:true});
 const index=join(root,'catalog/index.json');await writeFile(index,(await readFile(index,'utf8')).replace(SHA,'0'.repeat(64)));
 await assert.rejects(addPack(root,REF,'claude',SHA),/index\.json does not list this pack digest/);
 assert.equal(await readFile(file,'utf8'),before);
});
test('a failed receipt write restores the target file',async()=>{
 const {root,file}=await fixture(),before=await readFile(file,'utf8'),dir=packReceiptDir(root,'claude');
 await mkdir(dirname(dir),{recursive:true});await writeFile(dir,'blocks the receipt folder\n');
 try{await assert.rejects(addPack(root,REF,'claude',SHA),/EEXIST|ENOTDIR/);}finally{await rm(dir);}
 assert.equal(await readFile(file,'utf8'),before);
});
test('packs on one platform are limited to 24 KB in total',async()=>{
 const {root,file}=await fixture(),rules=('- Keep each rule short and clear. '.repeat(10)+'\n').repeat(20);
 for(const n of [1,2,3,4])await writePack(join(root,'catalog/packs/example-author',`sample-${n}`,'1.0.0'),{id:`example-author/sample-${n}`},rules);
 await buildCatalog(root);
 for(const n of [1,2,3]){const p=await previewPack(root,`example-author/sample-${n}@1.0.0`,'claude');await addPack(root,`example-author/sample-${n}@1.0.0`,'claude',p.digest);}
 const before=await readFile(file,'utf8');
 await assert.rejects(previewPack(root,'example-author/sample-4@1.0.0','claude'),/limit is 24576/);
 assert.deepEqual((await verifyInstall(root,'claude')).packs.map(p=>[p.id,p.configurationVerified]),[1,2,3].map(n=>[`example-author/sample-${n}`,true]));
 await removePack(root,'example-author/sample-2','claude');
 assert.deepEqual((await verifyInstall(root,'claude')).packs.map(p=>p.configurationVerified),[true,true]);
 assert.equal(before.replace(/\n\n<!-- BEGIN AGENTIC HARNESS PACK example-author\/sample-2 -->[\s\S]*?<!-- END AGENTIC HARNESS PACK example-author\/sample-2 -->/,''),await readFile(file,'utf8'));
});
test('codex: the pack section follows the base block in AGENTS.md, verifies, and removes to exact bytes',async()=>{
 const {root,home}=await fixture(false),agents=join(home,'.codex/AGENTS.md');
 await mkdir(join(home,'.codex'));await writeFile(agents,'Keep this rule\n');
 await assert.rejects(addPack(root,REF,'codex',SHA),/Install the base policy first: install codex/);
 await install(root,'codex',home);
 const before=await readFile(agents,'utf8'),config=await readFile(join(home,'.codex/config.toml'),'utf8');
 const p=await previewPack(root,REF,'codex');
 assert.equal(p.target,agents);assert.equal(p.afterLine,before.slice(0,before.indexOf('<!-- END AGENTIC HARNESS -->')).split('\n').length);
 assert.equal(p.approve,`pack add ${REF} --platform codex --approve-sha ${SHA}`);
 await addPack(root,REF,'codex',SHA);const after=await readFile(agents,'utf8');
 assert.equal(after.match(BASE)![0],before.match(BASE)![0]);assert.match(after,/^Keep this rule\n/);
 assert.ok(after.indexOf(`<!-- BEGIN AGENTIC HARNESS PACK ${PACK} -->`)>after.indexOf('<!-- END AGENTIC HARNESS -->'));
 assert.equal(await readFile(join(home,'.codex/config.toml'),'utf8'),config);
 assert.deepEqual(await readdir(packReceiptDir(root,'codex')),['yeruvamaheswar__testing-basics.json']);
 const v=await verifyInstall(root,'codex');
 assert.equal(v.configurationVerified,true);assert.deepEqual(v.packs.map(x=>[x.id,x.path,x.configurationVerified]),[[PACK,agents,true]]);
 assert.deepEqual((await listPacks(root)).installed,{claude:[],codex:v.packs,cursor:[]});
 await assert.rejects(uninstall(root,'codex'),/Remove packs first: pack remove yeruvamaheswar\/testing-basics --platform codex/);
 await writeFile(agents,after.replace('reproduce the failure first','skip reproduction'));
 assert.equal((await verifyInstall(root,'codex')).packs[0].configurationVerified,false);
 await assert.rejects(removePack(root,PACK,'codex'),/changed since installation/);
 await writeFile(agents,after);
 await removePack(root,PACK,'codex');
 assert.equal(await readFile(agents,'utf8'),before);
 await uninstall(root,'codex');assert.equal(await readFile(agents,'utf8'),'Keep this rule\n');
});
test('cursor: one alwaysApply .mdc file per pack, verified as a whole file, removed with its receipt',async()=>{
 const {root,home}=await fixture(false),rules=join(home,'.cursor/rules'),target=join(rules,'agentic-harness-pack-yeruvamaheswar__testing-basics.mdc');
 await assert.rejects(previewPack(root,REF,'cursor'),/Install the base policy first: install cursor-files/);
 await install(root,'cursor-files',home);
 const mcp=join(home,'.cursor/mcp.json'),base=await readFile(mcp,'utf8'),state=await tree(join(root,'.state'));
 const p=await previewPack(root,REF,'cursor');
 assert.equal(p.target,target);assert.equal(p.afterLine,undefined);
 assert.equal(p.block,renderPackFile(await loadPack(join(root,'catalog/packs',PACK,'1.0.0'))));
 await assert.rejects(readdir(rules),/ENOENT/);assert.deepEqual(await tree(join(root,'.state')),state);
 const receipt=await addPack(root,REF,'cursor',SHA),text=await readFile(target,'utf8');
 assert.equal(text,p.block);
 assert.match(text,new RegExp(`^---\\ndescription: Agentic Harness add-on pack ${PACK} 1\\.0\\.0\\nalwaysApply: true\\n---\\n\\n<!-- BEGIN AGENTIC HARNESS PACK ${PACK} -->\\n`));
 assert.match(text,/If a rule here conflicts with the base policy, follow the base policy\./);assert.ok(text.endsWith(`<!-- END AGENTIC HARNESS PACK ${PACK} -->\n`));
 assert.equal(await readFile(mcp,'utf8'),base);
 assert.deepEqual([receipt.platform,receipt.files[0].scope,receipt.files[0].ownedHash],['cursor','file',hash(text)]);
 const v=await verifyInstall(root,'cursor-files');
 assert.equal(v.configurationVerified,true);assert.deepEqual(v.packs.map(x=>[x.id,x.path,x.configurationVerified]),[[PACK,target,true]]);
 assert.deepEqual((await listPacks(root)).installed.cursor,v.packs);
 await assert.rejects(addPack(root,REF,'cursor',SHA),/already installed/);
 await assert.rejects(uninstall(root,'cursor-files'),/Remove packs first: pack remove yeruvamaheswar\/testing-basics --platform cursor/);
 await writeFile(target,text.replace('alwaysApply: true','alwaysApply: false'));
 assert.equal((await verifyInstall(root,'cursor-files')).packs[0].configurationVerified,false);
 await assert.rejects(removePack(root,PACK,'cursor'),/Pack file changed since installation/);
 await writeFile(target,text);
 assert.deepEqual(await removePack(root,PACK,'cursor'),{removed:PACK,platform:'cursor',path:target});
 assert.deepEqual(await readdir(rules),[]);
 assert.deepEqual(await readdir(packReceiptDir(root,'cursor')),[]);
 assert.deepEqual((await verifyInstall(root,'cursor-files')).packs,[]);
 const backups=await readdir(join(root,'.state/backups/packs/cursor'));
 assert.equal(backups.length,2);assert.ok((await Promise.all(backups.map(b=>readFile(join(root,'.state/backups/packs/cursor',b),'utf8')))).includes(text));
 await uninstall(root,'cursor-files');
});
test('cursor: refuses an existing file at the pack path, a missing base file, and deletes the file if the receipt write fails',async()=>{
 const {root,home}=await fixture(false),rules=join(home,'.cursor/rules'),target=join(rules,'agentic-harness-pack-yeruvamaheswar__testing-basics.mdc');
 await install(root,'cursor-files',home);
 await mkdir(rules);await writeFile(target,'mine\n');
 await assert.rejects(addPack(root,REF,'cursor',SHA),/unmanaged file for yeruvamaheswar\/testing-basics already exists/);
 assert.equal(await readFile(target,'utf8'),'mine\n');await rm(target);
 const dir=packReceiptDir(root,'cursor');await mkdir(dirname(dir),{recursive:true});await writeFile(dir,'blocks the receipt folder\n');
 try{await assert.rejects(addPack(root,REF,'cursor',SHA),/EEXIST|ENOTDIR/);}finally{await rm(dir);}
 assert.deepEqual(await readdir(rules),[]);
 await rm(join(home,'.cursor/mcp.json'));
 await assert.rejects(addPack(root,REF,'cursor',SHA),/base install file .*mcp\.json is missing; run install cursor-files/);
 assert.deepEqual(await readdir(rules),[]);
});
test('a pack file deleted by hand reports the receipt to delete',async()=>{
 const {root,home}=await fixture(false);await install(root,'cursor-files',home);
 const r=await addPack(root,REF,'cursor',SHA);await rm(r.files[0].path);
 assert.equal((await verifyInstall(root,'cursor-files')).packs[0].configurationVerified,false);
 await assert.rejects(removePack(root,PACK,'cursor'),/no longer exists\. Delete the receipt .*yeruvamaheswar__testing-basics\.json to finish the removal/);
});
