import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,access,cp,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSnapshot,digest,publish,hash} from '../src/core.ts';
import {install,verifyPacks} from '../src/install.ts';
import {addPack,readPack,removePack,renderPackFile,buildCatalog} from '../src/packs.ts';
import {scanRules,ruleMarkers} from '../src/rules.ts';
import {planRules,previewRules,applyRules,undoRules,verifyRules,ruleReceipts,unifiedDiff,ignoreFinding,unignoreFinding,ruleReceiptDir,retireRule} from '../src/rules-apply.ts';
import type {RulesScan,FindingKind,Proposal} from '../src/rules.ts';

// Puts a file where the receipt folder goes, so saving receipts fails after every target is written. Works when tests run as root.
const blockReceipts=async(root:string)=>{
 const dir=ruleReceiptDir(root);await mkdir(dirname(dir),{recursive:true});await writeFile(dir,'blocks the receipt folder\n');
 return {undo:()=>rm(dir)};
};
const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const CORE='# Rules\n- Build a tracer bullet through every layer first.\n- Verify the behavior with a real check before expanding.\n- Never claim a check passed when it did not run.\n';
const OO='---\ndescription: Presentation\nalwaysApply: true\n---\n\n<!-- Standalone draft rule. -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use short sentences.\n';
const OO_BODY='<!-- Standalone draft rule. -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use short sentences.\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'harness-test-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await writeFile(join(root,'core.md'),CORE);
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 for(const p of ['claude','codex','cursor-files'])await install(root,p,home);
 // install cursor-files no longer writes a rule file, so the rules folder does not exist yet.
 await mkdir(join(home,'.cursor/rules'));
 return {root,home,cursor:join(home,'.cursor/rules'),claude:join(home,'.claude/rules'),agents:join(home,'.codex/AGENTS.md')};
}
async function put(file:string,text:string){await mkdir(dirname(file),{recursive:true});await writeFile(file,text);}
async function append(file:string,text:string){await writeFile(file,(await readFile(file,'utf8'))+text);}
const exists=(p:string)=>access(p).then(()=>true,()=>false);
const kinds=(s:RulesScan,rule:string)=>s.findings.filter(f=>f.rule===rule).map(f=>f.kind);
async function proposal(root:string,home:string,kind:FindingKind,rule:string){
 const s=await scanRules(root,home), f=s.findings.filter(f=>f.kind===kind&&f.rule===rule);
 assert.equal(f.length,1,`${kind} ${rule}`);return s.proposals.find(p=>p.finding===f[0].id)!;
}
async function apply(root:string,home:string,ids:string[]){const preview=await previewRules(root,ids,home);return {preview,result:await applyRules(root,ids,preview.digest,home)};}
async function drift(f:Awaited<ReturnType<typeof fixture>>){
 await put(join(f.cursor,'output-oversight.mdc'),OO);
 await put(join(f.claude,'output-oversight.md'),'<!-- Agentic harness release 0.9.0 -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use long sentences.\n');
 await append(f.agents,'\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use medium sentences.\n\n# Team Notes\n\n- Use pnpm.\n');
}

test('unified diff merges hunks up to six unchanged lines apart and marks a missing final newline',()=>{
 assert.equal(unifiedDiff('/f','a\nb\nc\nd\ne\nf\ng\nh\n','A\nb\nc\nd\ne\nf\ng\nH').split('\n').filter(l=>l.startsWith('@@')).length,1);
 assert.equal(unifiedDiff('/f','a\nb\nc\nd\ne\nf\ng\nh\ni\n','A\nb\nc\nd\ne\nf\ng\nh\nI\n').split('\n').filter(l=>l.startsWith('@@')).length,2);
 assert.equal(unifiedDiff('/f',null,'x'),'--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n');
});
test('missing rules become a Cursor .mdc, a Claude rule file, and an appended Codex section; a rescan is clean',async()=>{
 const {root,home,cursor,claude,agents}=await fixture();
 await put(join(claude,'render-yaml.md'),'---\npaths:\n  - "**/render.yaml"\n---\n\n- Every service needs a name.\n');
 await put(join(cursor,'testing-style.mdc'),'---\ndescription: Tests\nalwaysApply: true\n---\n\n- Name tests after behavior.\n');
 const agentsBefore=await readFile(agents,'utf8');
 const ids=[(await proposal(root,home,'missing','render-yaml')).id,(await proposal(root,home,'missing','testing-style')).id];
 const {preview,result}=await apply(root,home,ids);
 assert.deepEqual(preview.changes.map(c=>[c.change,c.path]),[['create',join(claude,'testing-style.md')],['modify',agents],['create',join(cursor,'render-yaml.mdc')]]);
 assert.match(preview.diff,/^--- \/dev\/null\n\+\+\+ b.*render-yaml\.mdc$/m);
 assert.equal(await readFile(join(cursor,'render-yaml.mdc'),'utf8'),'---\nglobs: **/render.yaml\nalwaysApply: false\n---\n\n- Every service needs a name.\n');
 assert.equal(await readFile(join(claude,'testing-style.md'),'utf8'),'- Name tests after behavior.\n');
 const [b,e]=ruleMarkers('testing-style');
 assert.equal(await readFile(agents,'utf8'),agentsBefore+`\n${b}\n- Name tests after behavior.\n${e}\n`);
 assert.equal(result.receipts.length,3);assert.ok(result.verification.every(v=>v.configurationVerified));
 const s=await scanRules(root,home);
 assert.deepEqual([kinds(s,'render-yaml'),kinds(s,'testing-style')],[[],[]]);
 assert.equal(s.rules.find(r=>r.id===`codex:${agents}#testing-style`)?.writable,true);
 assert.deepEqual(await undoRules(root,result.receipts[2].id),{undone:result.receipts[2].id,path:join(cursor,'render-yaml.mdc'),restored:'file removed'});
 assert.equal(await exists(join(cursor,'render-yaml.mdc')),false);
});
test('Codex wrap-in-place keeps every other byte; merge syncs Claude and Codex, then re-merges into the marked section',async()=>{
 const f=await fixture(), {root,home,cursor,claude,agents}=f;
 await drift(f);
 const before=await readFile(agents,'utf8'), s0=await scanRules(root,home);
 const team=s0.rules.find(r=>r.id===`codex:${agents}#team-notes`)!, oo=s0.rules.find(r=>r.id===`codex:${agents}#output-oversight`)!;
 const wrap=await proposal(root,home,'unmanaged-text','team-notes'), merge=await proposal(root,home,'content-drift','output-oversight');
 assert.deepEqual([wrap.action,merge.action],['add','merge']);
 const {preview}=await apply(root,home,[wrap.id,merge.id]);
 assert.deepEqual(preview.changes.map(c=>c.path),[join(claude,'output-oversight.md'),agents]);
 assert.equal(await readFile(join(claude,'output-oversight.md'),'utf8'),OO_BODY);
 const [tb,te]=ruleMarkers('team-notes'),[ob,oe]=ruleMarkers('output-oversight');
 const merged=before.slice(0,oo.range![0])+`${ob}\n${OO_BODY}${oe}`+before.slice(oo.range![1],team.range![0])+`${tb}\n${team.text}\n${te}`+before.slice(team.range![1]);
 assert.equal(await readFile(agents,'utf8'),merged);
 const s1=await scanRules(root,home);
 assert.deepEqual(kinds(s1,'output-oversight'),[]);assert.deepEqual(kinds(s1,'team-notes'),['missing']);

 await writeFile(join(cursor,'output-oversight.mdc'),OO.replace('short','tiny'));
 await apply(root,home,[(await proposal(root,home,'content-drift','output-oversight')).id]);
 assert.equal(await readFile(agents,'utf8'),merged.replace(`${ob}\n${OO_BODY}${oe}`,`${ob}\n${OO_BODY.replace('short','tiny')}${oe}`));
 assert.deepEqual(kinds(await scanRules(root,home),'output-oversight'),[]);
});
test('a CLAUDE.md section moves to its own rule file and CLAUDE.md returns to its exact earlier bytes',async()=>{
 const {root,home,claude}=await fixture(), claudeMd=join(home,'.claude/CLAUDE.md'), original=await readFile(claudeMd,'utf8');
 await append(claudeMd,'\n# Personal Preferences\n\n- Prefer tabs.\n');
 await apply(root,home,[(await proposal(root,home,'unmanaged-text','personal-preferences')).id]);
 assert.equal(await readFile(claudeMd,'utf8'),original);
 assert.equal(await readFile(join(claude,'personal-preferences.md'),'utf8'),'# Personal Preferences\n\n- Prefer tabs.\n');
 assert.deepEqual((await verifyRules(root)).map(v=>v.configurationVerified),[true,true]);
});
test('apply refuses a wrong digest and a file changed since the preview, and writes nothing',async()=>{
 const {root,home,agents}=await fixture();
 await append(agents,'\n# Team Notes\n\n- Use pnpm.\n');
 const p=await proposal(root,home,'unmanaged-text','team-notes'), before=await readFile(agents,'utf8'), preview=await previewRules(root,[p.id],home);
 assert.equal(await readFile(agents,'utf8'),before);
 await assert.rejects(applyRules(root,[p.id],'0'.repeat(64),home),/approved digest does not match/);
 await append(agents,'- Use corepack.\n');
 const edited=await readFile(agents,'utf8');
 await assert.rejects(applyRules(root,[p.id],preview.digest,home),/approved digest does not match the current plan: a target file or the scan changed since the preview/);
 assert.equal(await readFile(agents,'utf8'),edited);
 assert.deepEqual(await ruleReceipts(root),[]);
 assert.equal(await exists(join(root,'.state/backups/rules')),false);
});
test('guards refuse harness blocks, plugin rules, read-only records, action none, and edits that reach into the harness block',async()=>{
 const {root,home,cursor,claude,agents}=await fixture();
 const plugin=join(home,'.cursor/plugins/cache/pub/render/abc123/rules/render-platform.mdc');
 await put(plugin,'---\nalwaysApply: true\n---\n\n- Bind to 0.0.0.0:$PORT.\n');
 await put(join(home,'elsewhere/linked.mdc'),'---\nalwaysApply: true\n---\n\n- Linked.\n');await symlink(join(home,'elsewhere/linked.mdc'),join(cursor,'linked.mdc'));
 await put(join(claude,'broken.md'),'---\npaths: x\n\n- No closing line.\n');
 await append(agents,'\n# Team Notes\n\n- Use pnpm.\n');
 const s=await scanRules(root,home), get=(id:string)=>s.rules.find(r=>r.id===id)!;
 const harness=get(`codex:${agents}#agentic-harness`), plug=get(`cursor:${plugin}`), linked=get(`cursor:${join(cursor,'linked.mdc')}`), team=get(`codex:${agents}#team-notes`);
 assert.equal(linked.writable,false);
 const tamper=(rule:string,p:Omit<Proposal,'id'|'finding'|'rule'|'reason'>,scan:RulesScan=s)=>planRules(root,{...scan,proposals:[{id:'proposal:test',finding:'test',rule,reason:'test',...p}]},['proposal:test']);
 await assert.rejects(tamper('agentic-harness',{action:'remove',targets:[{agent:'codex',path:agents,format:'codex-agents-section',replaces:harness.id}]}),/harness block or pack section/);
 await assert.rejects(tamper('render-platform',{action:'merge',from:team.id,targets:[{agent:'cursor',path:plugin,format:'cursor-mdc',replaces:plug.id}]}),/plugin rule/);
 await assert.rejects(tamper('new',{action:'add',from:team.id,targets:[{agent:'cursor',path:join(dirname(plugin),'new.mdc'),format:'cursor-mdc'}]}),/plugin rule/);
 await assert.rejects(tamper('linked',{action:'merge',from:team.id,targets:[{agent:'cursor',path:linked.path,format:'cursor-mdc',replaces:linked.id}]}),/read-only \(writable=false/);
 await assert.rejects(tamper('agentic-harness',{action:'merge',from:team.id,targets:[{agent:'cursor',path:join(cursor,'pragmatic-engineer.mdc'),format:'cursor-mdc'}]}),/harness Cursor rule/);
 const raw=await readFile(agents,'utf8'), range:[number,number]=[harness.range![1]-40,team.range![1]];
 const sneaky={...s,rules:s.rules.map(r=>r.id===team.id?{...r,range,text:raw.slice(...range)}:r)};
 await assert.rejects(tamper('team-notes',{action:'add',from:team.id,targets:[{agent:'codex',path:agents,format:'codex-agents-section',replaces:team.id}]},sneaky),/would alter a harness block or pack section/);
 const none=(await proposal(root,home,'malformed','broken')).id;
 await assert.rejects(previewRules(root,[none],home),/has action none/);
 await assert.rejects(previewRules(root,['proposal:unknown'],home),/not in the current scan/);
 assert.equal(await readFile(agents,'utf8'),raw);
});
test('installed packs on every agent are pack-managed: no findings, no proposals, and apply refuses them',async()=>{
 const {root,home,cursor,claude,agents}=await fixture(), claudeMd=join(home,'.claude/CLAUDE.md'), id='yeruvamaheswar/testing-basics';
 await cp(join(repo,'catalog'),join(root,'catalog'),{recursive:true});
 const sha=JSON.parse(await readFile(join(repo,'catalog/packs',id,'1.0.0/pack.json'),'utf8')).digest;
 for(const platform of ['claude','codex','cursor'])await addPack(root,id+'@1.0.0',platform,sha);
 await put(join(claude,'team.md'),'- Use pnpm.\n');
 const s=await scanRules(root,home), packFile=join(cursor,'agentic-harness-pack-yeruvamaheswar__testing-basics.mdc');
 const packs=s.rules.filter(r=>r.management==='pack');
 assert.deepEqual(packs.map(r=>[r.id,r.name,r.writable]),[[`cursor:${packFile}`,`pack:${id}`,false],[`claude:${claudeMd}#pack:${id}`,`pack:${id}`,false],[`codex:${agents}#pack:${id}`,`pack:${id}`,false]]);
 assert.deepEqual(s.findings.map(f=>[f.kind,f.rule]),[['missing','team']]);
 assert.ok(s.findings.every(f=>f.records.every(r=>!packs.some(p=>p.id===r))));
 assert.ok(s.proposals.every(p=>p.targets.every(t=>t.path!==packFile&&!packs.some(r=>r.id===t.replaces))));
 const team=s.rules.find(r=>r.name==='team')!;
 const tamper=(p:Omit<Proposal,'id'|'finding'|'rule'|'reason'>)=>planRules(root,{...s,proposals:[{id:'proposal:test',finding:'test',rule:'team',reason:'test',...p}]},['proposal:test']);
 for(const r of packs)await assert.rejects(tamper({action:'remove',targets:[{agent:r.agent,path:r.path,format:r.format,replaces:r.id}]}),/is an add-on pack; use pack commands/);
 await assert.rejects(tamper({action:'add',from:team.id,targets:[{agent:'cursor',path:join(cursor,'agentic-harness-pack-someone__other.mdc'),format:'cursor-mdc'}]}),/is an add-on pack; use pack commands/);
 await writeFile(packFile,(await readFile(packFile,'utf8')).replace(`<!-- END AGENTIC HARNESS PACK ${id} -->`,''));
 const broken=await scanRules(root,home);
 assert.deepEqual(broken.findings.map(f=>[f.kind,f.rule,f.records]),[['malformed',`pack:${id}`,[`cursor:${packFile}`]],['missing','team',[team.id]]]);
 assert.match(broken.findings[0].message,/no longer matches what pack add wrote/);
});
test('a failed write rolls back every file already written and saves no receipt',async()=>{
 const {root,home,cursor,claude,agents}=await fixture();
 await put(join(claude,'team.md'),'- Use pnpm.\n');
 const p=await proposal(root,home,'missing','team'), preview=await previewRules(root,[p.id],home), before=await readFile(agents,'utf8');
 assert.deepEqual(preview.changes.map(c=>c.path),[agents,join(cursor,'team.mdc')]);
 const block=await blockReceipts(root);
 try{await assert.rejects(applyRules(root,[p.id],preview.digest,home),/All written files were restored/);}
 finally{await block.undo();}
 assert.equal(await readFile(agents,'utf8'),before);
 assert.equal(await exists(join(cursor,'team.mdc')),false);
 assert.deepEqual(await ruleReceipts(root),[]);
});
test('verify tracks each receipt; undo refuses after a manual edit and restores exact bytes once the edit is reverted',async()=>{
 const f=await fixture(), {root,home,claude,agents}=f, claudeFile=join(claude,'output-oversight.md');
 await drift(f);
 const claudeBefore=await readFile(claudeFile,'utf8'), agentsBefore=await readFile(agents,'utf8');
 const {result}=await apply(root,home,[(await proposal(root,home,'content-drift','output-oversight')).id]);
 const [rc,ra]=result.receipts, claudeApplied=await readFile(claudeFile,'utf8'), agentsApplied=await readFile(agents,'utf8');
 assert.deepEqual([rc.path,ra.path],[claudeFile,agents]);
 const receipt=(await ruleReceipts(root))[1];
 assert.deepEqual([receipt.owned,receipt.sections.map(s=>s.name),receipt.backup.startsWith('.state/backups/rules/'),receipt.existed],['sections',['output-oversight'],true,true]);
 assert.deepEqual((await verifyRules(root)).map(v=>v.configurationVerified),[true,true]);

 await writeFile(agents,agentsApplied+'\n# Later\n');
 assert.deepEqual((await verifyRules(root)).map(v=>[v.configurationVerified,v.wholeFileUnchanged]),[[true,true],[true,false]]);
 await assert.rejects(undoRules(root,ra.id),/changed since receipt .* Refusing to overwrite newer changes/);
 assert.equal(await readFile(agents,'utf8'),agentsApplied+'\n# Later\n');
 await writeFile(claudeFile,'edited\n');
 assert.equal((await verifyRules(root))[0].configurationVerified,false);
 await assert.rejects(undoRules(root,rc.id),/Refusing to overwrite/);

 await writeFile(agents,agentsApplied);await writeFile(claudeFile,claudeApplied);
 await undoRules(root,ra.id);await undoRules(root,rc.id);
 assert.equal(await readFile(agents,'utf8'),agentsBefore);
 assert.equal(await readFile(claudeFile,'utf8'),claudeBefore);
 assert.equal((await verifyRules(root)).some(v=>v.id===receipt.id),false);
 await assert.rejects(undoRules(root,rc.id),/not found/);
 await assert.rejects(undoRules(root,'../x'),/Name a receipt ID/);
});

async function tree(dir:string){
 const out:Record<string,string>={};
 for(const f of await readdir(dir,{recursive:true}).catch(()=>[] as string[])){const p=join(dir,f);if((await stat(p)).isFile())out[f]=hash(await readFile(p,'utf8'));}
 return out;
}
const OO_PACK='# Output Oversight and Explanations\n\n- Start with the result.\n- Use short sentences.\n';
async function adoptProposal(root:string,home:string){
 const p=(await scanRules(root,home)).proposals.filter(p=>p.action==='adopt'&&p.rule==='output-oversight');
 assert.equal(p.length,1);return p[0];
}
test('adopt as managed pack: preview writes nothing, apply installs the pack on three agents and removes the loose copies, undo of the apply restores exact bytes',async()=>{
 const f=await fixture(), {root,home,cursor,claude,agents}=f, claudeMd=join(home,'.claude/CLAUDE.md'), id='local/output-oversight';
 await drift(f);
 const files=[join(cursor,'output-oversight.mdc'),join(claude,'output-oversight.md'),agents,claudeMd], original=await Promise.all(files.map(p=>readFile(p,'utf8')));
 const homeBefore=await tree(home), stateBefore=await tree(join(root,'.state'));
 const p=await adoptProposal(root,home);
 assert.deepEqual(p.pack,{id,name:'Output Oversight and Explanations',platforms:['cursor','claude','codex']});
 const preview=await previewRules(root,[p.id],home), packFile=join(cursor,'agentic-harness-pack-local__output-oversight.mdc');
 assert.deepEqual([await tree(home),await tree(join(root,'.state'))],[homeBefore,stateBefore]);
 assert.deepEqual(preview.packs.map(a=>[a.pack.id,a.pack.version,a.exists,a.dir,a.pack.rules]),[[id,'1.0.0',false,'.state/packs/local/output-oversight/1.0.0',OO_PACK]]);
 assert.deepEqual(preview.changes.map(c=>[c.change,c.path]),[['modify',claudeMd],['delete',join(claude,'output-oversight.md')],['modify',agents],['create',packFile],['delete',join(cursor,'output-oversight.mdc')]]);

 const result=await applyRules(root,[p.id],preview.digest,home), pack=await readPack(root,id+'@1.0.0');
 assert.equal(pack.digest,preview.packs[0].pack.digest);
 assert.equal(await readFile(packFile,'utf8'),renderPackFile(pack));
 assert.deepEqual([await exists(files[0]),await exists(files[1])],[false,false]);
 const agentsText=await readFile(agents,'utf8');
 assert.doesNotMatch(agentsText,/Use medium sentences/);assert.match(agentsText,/# Team Notes\n\n- Use pnpm\./);
 for(const text of [agentsText,await readFile(claudeMd,'utf8')])assert.match(text,/<!-- BEGIN AGENTIC HARNESS PACK local\/output-oversight -->\n[\s\S]*- Use short sentences\.\n<!-- END AGENTIC HARNESS PACK local\/output-oversight -->/);
 for(const platform of ['cursor','claude','codex'])assert.deepEqual((await verifyPacks(root,platform)).map(v=>[v.id,v.version,v.configurationVerified]),[[id,'1.0.0',true]]);
 assert.equal(result.verification.length,5);assert.ok(result.verification.every(v=>v.configurationVerified));
 assert.deepEqual(result.verification.flatMap(v=>v.packs.map(x=>x.platform)).sort(),['claude','codex','cursor']);
 const after=await scanRules(root,home);
 assert.deepEqual(after.findings.filter(x=>x.rule==='output-oversight'),[]);
 assert.deepEqual(after.rules.filter(r=>r.name===`pack:${id}`).map(r=>[r.agent,r.management]),[['cursor','pack'],['claude','pack'],['codex','pack']]);
 await assert.rejects(previewRules(root,[p.id],home),/not in the current scan/);

 const undone=await undoRules(root,result.applyId);
 assert.equal('receipts' in undone&&undone.receipts.length,5);
 assert.deepEqual(await Promise.all(files.map(p=>readFile(p,'utf8'))),original);
 assert.equal(await exists(packFile),false);
 for(const platform of ['cursor','claude','codex'])assert.deepEqual(await verifyPacks(root,platform),[]);
 assert.deepEqual(await ruleReceipts(root),[]);
 assert.equal((await adoptProposal(root,home)).id,p.id);
 assert.deepEqual((await previewRules(root,[p.id],home)).packs.map(a=>[a.pack.version,a.exists]),[['1.0.0',true]]);
});
test('an adopted pack composes with pack remove; the adopt receipts then report the change and undo refuses',async()=>{
 const f=await fixture(), {root,home,cursor,agents}=f, id='local/output-oversight';
 await drift(f);
 const p=await adoptProposal(root,home), {result}=await apply(root,home,[p.id]);
 for(const platform of ['cursor','claude','codex'])await removePack(root,id,platform);
 const agentsText=await readFile(agents,'utf8');
 assert.doesNotMatch(agentsText,/AGENTIC HARNESS PACK|Use medium sentences/);assert.match(agentsText,/# Team Notes/);
 assert.equal(await exists(join(cursor,'agentic-harness-pack-local__output-oversight.mdc')),false);
 const verify=await verifyRules(root);
 assert.ok(verify.filter(v=>v.packs.length).every(v=>!v.configurationVerified));
 const codex=verify.find(v=>v.path===agents)!;
 await assert.rejects(undoRules(root,codex.id),/changed since receipt .*pack remove/);
 await assert.rejects(undoRules(root,result.applyId),/changed since receipt/);
 assert.equal(await exists(join(cursor,'output-oversight.mdc')),false);
 assert.equal((await ruleReceipts(root)).length,5);
});
test('plugin rules are never adopted: no adopt proposal, tampered adopts are refused, and a hand copy can be removed',async()=>{
 const {root,home,claude}=await fixture();
 const plugin=join(home,'.cursor/plugins/cache/pub/render/abc123/rules/render-platform.mdc'), copy=join(claude,'render-platform.md');
 await put(plugin,'---\nalwaysApply: true\n---\n\n- Bind to 0.0.0.0:$PORT.\n');await put(copy,'- Bind to 0.0.0.0:$PORT.\n');
 const pluginText=await readFile(plugin,'utf8'), s=await scanRules(root,home), copyRecord=s.rules.find(r=>r.path===copy)!, pluginRecord=s.rules.find(r=>r.path===plugin)!;
 assert.deepEqual(s.proposals.filter(p=>p.action==='adopt'),[]);
 const tamper=(from:string)=>planRules(root,{...s,proposals:[{id:'proposal:test',finding:'test',rule:'render-platform',reason:'test',action:'adopt',from,targets:[{agent:'claude',path:copy,format:'claude-rule',replaces:copyRecord.id}],pack:{id:'local/render-platform',name:'Render',platforms:['cursor','claude','codex']}}]},['proposal:test']);
 for(const from of [copyRecord.id,pluginRecord.id])await assert.rejects(tamper(from),/plugin rule .*never adopted as packs; keep or remove the hand copies/);
 const remove=await proposal(root,home,'plugin-copy','render-platform');
 assert.deepEqual([remove.action,remove.targets.map(t=>t.replaces)],['remove',[copyRecord.id]]);
 await apply(root,home,[remove.id]);
 assert.equal(await exists(copy),false);assert.equal(await readFile(plugin,'utf8'),pluginText);
 assert.deepEqual((await scanRules(root,home)).findings,[]);
 assert.equal(await exists(join(root,'.state/packs')),false);
});
test('adopt refuses partial copies, two adopts at once, and path-scoped rules; catalog build reserves the local author',async()=>{
 const f=await fixture(), {root,home,cursor,claude}=f;
 await drift(f);
 await put(join(cursor,'testing-style.mdc'),'---\nalwaysApply: true\n---\n\n- Name tests after behavior.\n');
 await put(join(claude,'render-yaml.md'),'---\npaths:\n  - "**/render.yaml"\n---\n\n- Every service needs a name.\n');
 const s=await scanRules(root,home), adopt=(rule:string)=>s.proposals.find(p=>p.action==='adopt'&&p.rule===rule);
 const oo=adopt('output-oversight')!, ts=adopt('testing-style')!, yaml=s.rules.find(r=>r.name==='render-yaml')!;
 assert.equal(adopt('render-yaml'),undefined);
 await assert.rejects(previewRules(root,[oo.id,ts.id],home),/one adopt proposal at a time/);
 await assert.rejects(planRules(root,{...s,proposals:[{...oo,targets:oo.targets.slice(1)}]},[oo.id]),/must remove every loose copy of output-oversight; .* would remain/);
 await assert.rejects(planRules(root,{...s,proposals:[{...ts,id:'proposal:test',rule:'render-yaml',from:yaml.id,targets:[{agent:'claude',path:yaml.path,format:'claude-rule',replaces:yaml.id}],pack:{id:'local/render-yaml',name:'x',platforms:['cursor','claude','codex']}}]},['proposal:test']),/is a path rule/);
 await mkdir(join(root,'catalog/packs/local'),{recursive:true});
 await assert.rejects(buildCatalog(root),/catalog\/packs\/local is reserved/);
 assert.equal(await exists(join(root,'.state/packs')),false);
});
test('a failed adopt restores every file and leaves no pack receipt or local pack version',async()=>{
 const f=await fixture(), {root,home}=f;
 await drift(f);
 const p=await adoptProposal(root,home), preview=await previewRules(root,[p.id],home), before=await tree(home);
 const block=await blockReceipts(root);
 try{await assert.rejects(applyRules(root,[p.id],preview.digest,home),/All written files were restored/);}
 finally{await block.undo();}
 assert.deepEqual(await tree(home),before);
 assert.equal(await exists(join(root,'.state/packs/local/output-oversight/1.0.0')),false);
 for(const platform of ['cursor','claude','codex'])assert.deepEqual(await verifyPacks(root,platform),[]);
 assert.deepEqual(await ruleReceipts(root),[]);
});
test('ignore hides a finding with a recorded reason until its text changes; unignore restores it',async()=>{
 const {root,home,claude}=await fixture(), team=join(claude,'team.md');
 await put(team,'- Use pnpm.\n');
 const s0=await scanRules(root,home), f=s0.findings.find(x=>x.kind==='missing'&&x.rule==='team')!;
 assert.deepEqual(s0.proposals.filter(p=>p.finding===f.id).map(p=>p.action),['add','adopt']);
 await assert.rejects(ignoreFinding(root,f.id,'  ',home),/Give a reason/);
 await assert.rejects(ignoreFinding(root,'missing:nope:0','x',home),/not in the current scan/);
 const entry=await ignoreFinding(root,f.id,' Claude only, on purpose. ',home);
 assert.deepEqual([entry.finding,entry.hash,entry.reason],[f.id,f.hash,'Claude only, on purpose.']);
 assert.deepEqual(JSON.parse(await readFile(join(root,'.state/rules-ignored.json'),'utf8')).ignored.map((i:{finding:string})=>i.finding),[f.id]);
 const s1=await scanRules(root,home);
 assert.deepEqual([s1.findings,s1.proposals,s1.ignored.map(i=>[i.id,i.reason])],[[],[],[[f.id,'Claude only, on purpose.']]]);
 await assert.rejects(previewRules(root,[s0.proposals.find(p=>p.finding===f.id)!.id],home),/not in the current scan/);
 await assert.rejects(ignoreFinding(root,f.id,'again',home),/already ignored/);
 await writeFile(team,'- Use pnpm 10.\n');
 const s2=await scanRules(root,home);
 assert.deepEqual([s2.findings.map(x=>x.id),s2.ignored],[[f.id],[]]);
 await writeFile(team,'- Use pnpm.\n');
 assert.equal((await scanRules(root,home)).ignored.length,1);
 assert.deepEqual(await unignoreFinding(root,f.id),{unignored:f.id});
 const s3=await scanRules(root,home);
 assert.deepEqual([s3.findings.map(x=>x.id),s3.ignored],[[f.id],[]]);
 await assert.rejects(unignoreFinding(root,f.id),/is not ignored/);
});
async function appliedReceipt(){
 const {root,home,claude}=await fixture();
 await put(join(claude,'team.md'),'- Use pnpm.\n');
 const {result}=await apply(root,home,[(await proposal(root,home,'missing','team')).id]);
 return {root,home,receipt:(await ruleReceipts(root)).find(r=>r.id===result.receipts[0].id)!};
}
const activeFiles=async(root:string)=>(await readdir(ruleReceiptDir(root))).sort();
test('retire moves a receipt that no longer verifies to retired/ with the reason; the backup stays',async()=>{
 const {root,receipt}=await appliedReceipt(), original=JSON.parse(await readFile(join(ruleReceiptDir(root),receipt.id+'.json'),'utf8'));
 await writeFile(receipt.path,'Rewritten by hand.\n');
 assert.equal((await verifyRules(root))[0].configurationVerified,false);
 const out=await retireRule(root,receipt.id,'  Removed on purpose.  ');
 const file=join(ruleReceiptDir(root),'retired',receipt.id+'.json');
 assert.deepEqual([out.retired,out.path,out.reason],[receipt.id,file,'Removed on purpose.']);
 assert.match(out.note,/backup .* is kept.*move/);
 const {retired,...rest}=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(rest,original);
 assert.equal(retired.reason,'Removed on purpose.');assert.ok(!Number.isNaN(Date.parse(retired.at)));
 assert.equal(await exists(join(ruleReceiptDir(root),receipt.id+'.json')),false);
 assert.equal((await verifyRules(root)).some(v=>v.id===receipt.id),false);
 assert.equal(await exists(join(root,receipt.backup)),true);
});
test('retire refuses a receipt that still verifies, an unknown id, a blank reason, and an already retired id',async()=>{
 const {root,receipt}=await appliedReceipt(), before=await activeFiles(root);
 await assert.rejects(retireRule(root,receipt.id,'why'),/still verifies.*rules undo/);
 await assert.rejects(retireRule(root,'nope-0','why'),/not found among active receipts/);
 await assert.rejects(retireRule(root,receipt.id,'   '),/Give a reason/);
 assert.deepEqual(await activeFiles(root),before);
 assert.equal(await exists(join(ruleReceiptDir(root),'retired')),false);
 await writeFile(receipt.path,'Rewritten by hand.\n');
 await put(join(ruleReceiptDir(root),'retired',receipt.id+'.json'),'{}');
 await assert.rejects(retireRule(root,receipt.id,'why'),/already retired/);
 assert.deepEqual(await activeFiles(root),[...before,'retired'].sort());
 assert.equal(await readFile(join(ruleReceiptDir(root),'retired',receipt.id+'.json'),'utf8'),'{}');
});
