import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {loadSnapshot,digest,publish,hash,current,render} from '../src/core.ts';
import {install} from '../src/install.ts';
import {scanRules,normalize,frontmatter} from '../src/rules.ts';
import type {RulesScan,FindingKind} from '../src/rules.ts';

const CORE='# Rules\n- Build a tracer bullet through every layer first.\n- Verify the behavior with a real check before expanding.\n- Never claim a check passed when it did not run.\n';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'harness-test-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await writeFile(join(root,'core.md'),CORE);
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 await publish(root,'1.0.0',digest(await loadSnapshot(root)),true);
 for(const p of ['claude','codex','cursor-files'])await install(root,p,home);
 return {root,home};
}
async function put(file:string,text:string){await mkdir(dirname(file),{recursive:true});await writeFile(file,text);}
async function append(file:string,text:string){await writeFile(file,(await readFile(file,'utf8'))+text);}
async function tree(dir:string){
 const out:Record<string,string>={};
 for(const f of await readdir(dir,{recursive:true})){const p=join(dir,f),s=await stat(p);if(s.isFile())out[f]=`${hash(await readFile(p,'utf8'))}:${s.mtimeMs}`;}
 return out;
}
const find=(s:RulesScan,kind:FindingKind,rule:string)=>s.findings.filter(f=>f.kind===kind&&f.rule===rule).map(f=>({...f,proposal:s.proposals.find(p=>p.finding===f.id)!}));
const one=(s:RulesScan,kind:FindingKind,rule:string)=>{const f=find(s,kind,rule);assert.equal(f.length,1,`${kind} ${rule}`);return f[0];};
const PLUGIN_RENDER='---\ndescription: Render\nalwaysApply: true\n---\n\nrender-platform:\n\n- Bind to 0.0.0.0:$PORT.\n- The filesystem is ephemeral.\n';

test('normalize strips front matter, comments, and whitespace; front matter lists parse',()=>{
 assert.equal(normalize('---\nalwaysApply: true\n---\n<!-- BEGIN AGENTIC HARNESS -->\n  Hello   world \n\n<!-- note -->\n- Item\n'),'Hello world\n- Item');
 assert.deepEqual(frontmatter('---\npaths:\n  - "**/render.yaml"\n  - src/**\n---\nx').fields,{paths:['"**/render.yaml"','src/**']});
 assert.match(frontmatter('---\npaths x\n---\nbody').error!,/line 2/);
 assert.match(frontmatter('---\npaths: x\nbody').error!,/no closing/);
});
test('a fixture home produces every finding type with one proposal each and stays unchanged',async()=>{
 const {root,home}=await fixture(), cursor=join(home,'.cursor/rules'), claude=join(home,'.claude/rules'), agents=join(home,'.codex/AGENTS.md'), claudeMd=join(home,'.claude/CLAUDE.md');
 await put(join(cursor,'output-oversight.mdc'),'---\ndescription: Presentation\nalwaysApply: true\n---\n\n<!-- Standalone draft rule; not part of the Agentic harness release. -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use short sentences.\n');
 await put(join(cursor,'testing-style.mdc'),'---\nalwaysApply: true\n---\n\n- Name tests after behavior.\n');
 await put(join(cursor,'copy-core.mdc'),'---\nalwaysApply: true\n---\n\n'+CORE);
 await put(join(cursor,'ask-me.mdc'),'---\ndescription: On request\nalwaysApply: false\n---\n\n- Manual rule.\n');
 const plugin=join(home,'.cursor/plugins/cache/pub/render/abc123/rules/render-platform.mdc');await put(plugin,PLUGIN_RENDER);
 await put(join(claude,'output-oversight.md'),'<!-- Standalone draft rule; not part of Agentic harness release 0.9.0. -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use long sentences.\n');
 await put(join(claude,'render-platform.md'),'<!-- Source: Cursor Render plugin rule render-platform.mdc -->\n\nrender-platform:\n\n- Bind to 0.0.0.0:$PORT.\n');
 await put(join(claude,'nested/render-yaml.md'),'---\npaths:\n  - "**/render.yaml"\n---\n\n- Every service needs a name.\n');
 await put(join(claude,'broken.md'),'---\npaths: x\n\n- No closing line.\n');
 await append(agents,'\n<!-- Source: ~/.cursor/rules/output-oversight.mdc -->\n\n# Output Oversight and Explanations\n\n- Start with the result.\n- Use medium sentences.\n\n# Team Notes\n\n- Use pnpm.\n\n<!-- Source: Cursor Render plugin rule render-platform.mdc -->\nrender-platform:\n\n- Bind to 0.0.0.0:$PORT.\n- The filesystem is ephemeral.\n');
 await append(claudeMd,'\n# Personal Preferences\n\n- Prefer tabs.\n');
 const before=await tree(home), s=await scanRules(root,home);
 assert.deepEqual(await tree(home),before);

 const rule=(id:string)=>s.rules.find(r=>r.id===id)!;
 assert.deepEqual(s.rules.filter(r=>r.path===agents).map(r=>[r.name,r.management]),[['agentic-harness','harness'],['output-oversight','unmanaged'],['team-notes','unmanaged'],['render-platform','unmanaged']]);
 assert.deepEqual(s.rules.filter(r=>r.management==='harness').map(r=>[r.agent,r.writable]),[['claude',false],['codex',false]]);
 assert.equal(rule(`cursor:${plugin}`).management,'plugin');assert.equal(rule(`cursor:${plugin}`).plugin,'pub/render');
 assert.equal(rule(`cursor:${join(cursor,'ask-me.mdc')}`).scope,'manual');
 assert.deepEqual([rule(`claude:${join(claude,'nested/render-yaml.md')}`).name,rule(`claude:${join(claude,'nested/render-yaml.md')}`).scope],['render-yaml','path']);
 assert.equal(rule(`codex:${agents}#render-platform`).hash,rule(`cursor:${plugin}`).hash);
 const section=rule(`codex:${agents}#team-notes`);assert.equal((await readFile(agents,'utf8')).slice(...section.range!),section.text);

 const drift=one(s,'content-drift','output-oversight').proposal;
 assert.deepEqual([drift.action,drift.from],['merge',`cursor:${join(cursor,'output-oversight.mdc')}`]);
 assert.deepEqual(drift.targets,[{agent:'claude',path:join(claude,'output-oversight.md'),format:'claude-rule',replaces:`claude:${join(claude,'output-oversight.md')}`},{agent:'codex',path:agents,format:'codex-agents-section',replaces:`codex:${agents}#output-oversight`}]);
 const render=one(s,'content-drift','render-platform').proposal;
 assert.deepEqual([render.action,render.from,render.targets.map(t=>t.replaces)],['merge',`cursor:${plugin}`,[`claude:${join(claude,'render-platform.md')}`]]);
 assert.ok(s.proposals.every(p=>p.targets.every(t=>!t.path.includes('/plugins/cache/')&&!rule(t.replaces??'')?.management.match(/harness|plugin/))));

 const missing=one(s,'missing','testing-style').proposal;
 assert.deepEqual([missing.action,missing.targets],['add',[{agent:'claude',path:join(claude,'testing-style.md'),format:'claude-rule'},{agent:'codex',path:agents,format:'codex-agents-section'}]]);
 assert.deepEqual(one(s,'missing','render-yaml').proposal.targets.map(t=>t.path),[join(cursor,'render-yaml.mdc')]);
 assert.deepEqual(one(s,'missing','team-notes').proposal.targets.map(t=>t.agent),['cursor','claude']);
 assert.equal(find(s,'missing','ask-me').length,0);assert.equal(find(s,'missing','output-oversight').length,0);assert.equal(find(s,'missing','render-platform').length,0);

 const dup=one(s,'duplicate-of-core','copy-core').proposal;
 assert.deepEqual([dup.action,dup.targets.map(t=>t.replaces)],['remove',[`cursor:${join(cursor,'copy-core.mdc')}`]]);
 assert.equal(s.findings.filter(f=>f.kind==='duplicate-of-core').length,1);

 const stale=find(s,'stale-release','output-oversight');
 assert.deepEqual(stale.map(f=>f.records[0]),[`claude:${join(claude,'output-oversight.md')}`]);
 assert.match(stale[0].message,/release 0\.9\.0; the active release is 1\.0\.0\./);assert.match(stale[0].proposal.reason,/Covered by the content-drift merge/);

 const personal=one(s,'unmanaged-text','personal-preferences').proposal;
 assert.deepEqual([personal.action,personal.targets],['add',[{agent:'claude',path:join(claude,'personal-preferences.md'),format:'claude-rule',replaces:`claude:${claudeMd}#personal-preferences`}]]);
 assert.deepEqual(one(s,'unmanaged-text','team-notes').proposal.targets,[{agent:'codex',path:agents,format:'codex-agents-section',replaces:`codex:${agents}#team-notes`}]);
 assert.equal(one(s,'unmanaged-text','output-oversight').proposal.action,'none');
 assert.equal(one(s,'unmanaged-text','render-platform').proposal.action,'add');

 const bad=one(s,'malformed','broken');
 assert.match(bad.message,/no closing --- line\. Claude Code ignores unparseable front matter/);assert.equal(bad.proposal.action,'none');
 assert.equal(s.findings.filter(f=>f.rule==='broken').length,1);

 const copies=find(s,'plugin-copy','render-platform');
 assert.deepEqual(copies.map(f=>[f.records,f.proposal.action,f.proposal.targets.map(t=>t.replaces)]),[[[`claude:${join(claude,'render-platform.md')}`],'remove',[`claude:${join(claude,'render-platform.md')}`]],[[`codex:${agents}#render-platform`],'remove',[`codex:${agents}#render-platform`]]]);
 assert.match(copies[0].proposal.reason,/claude has no plugin, so it stops getting this rule/);

 const adopt=s.proposals.filter(p=>p.action==='adopt');
 assert.deepEqual(adopt.map(p=>[p.rule,p.finding]),[['copy-core',one(s,'missing','copy-core').id],['output-oversight',one(s,'content-drift','output-oversight').id],['personal-preferences',one(s,'missing','personal-preferences').id],['team-notes',one(s,'missing','team-notes').id],['testing-style',one(s,'missing','testing-style').id]]);
 const oo=adopt.find(p=>p.rule==='output-oversight')!;
 assert.deepEqual(oo.targets.map(t=>t.replaces),[`cursor:${join(cursor,'output-oversight.mdc')}`,`claude:${join(claude,'output-oversight.md')}`,`codex:${agents}#output-oversight`]);
 assert.deepEqual(oo.pack,{id:'local/output-oversight',name:'Output Oversight and Explanations',platforms:['cursor','claude','codex']});
 assert.ok(!adopt.some(p=>['render-platform','render-yaml','ask-me'].includes(p.rule)),'no adopt for plugin, path-scoped, or manual rules');

 assert.deepEqual(new Set(s.findings.map(f=>f.kind)),new Set(['malformed','content-drift','missing','duplicate-of-core','stale-release','unmanaged-text','plugin-copy']));
 assert.equal(new Set(s.findings.map(f=>f.id)).size,s.findings.length);
 assert.deepEqual(s.proposals.filter(p=>p.action!=='adopt').map(p=>p.finding),s.findings.map(f=>f.id));
 assert.ok(s.proposals.every(p=>p.action==='none'||p.action==='remove'?!p.from:!!p.from));
 assert.deepEqual(s.ignored,[]);
});
test('stale harness blocks point to install; a stale comment syncs from a current copy; malformed markers skip the file',async()=>{
 const {root,home}=await fixture(), claudeMd=join(home,'.claude/CLAUDE.md');
 await writeFile(join(root,'core.md'),CORE+'- One more rule for the next release of the policy.\n');await publish(root,'1.1.0',digest(await loadSnapshot(root)),true);
 await put(join(home,'.cursor/rules/style.mdc'),'---\nalwaysApply: true\n---\n\n- Keep it short.\n');
 await put(join(home,'.claude/rules/style.md'),'<!-- Copied from Agentic harness release 1.0.0 -->\n- Keep it short.\n');
 const s=await scanRules(root,home);
 assert.equal(s.activeVersion,'1.1.0');
 assert.deepEqual(find(s,'stale-release','agentic-harness').map(f=>f.proposal.reason),['Run install claude to install release 1.1.0.','Run install codex to install release 1.1.0.']);
 assert.equal(find(s,'content-drift','style').length,0);
 const style=one(s,'stale-release','style').proposal;
 assert.deepEqual([style.action,style.from,style.targets.map(t=>t.replaces)],['merge',`cursor:${join(home,'.cursor/rules/style.mdc')}`,[`claude:${join(home,'.claude/rules/style.md')}`]]);

 await append(claudeMd,'\n<!-- BEGIN AGENTIC HARNESS -->\nsecond copy\n<!-- END AGENTIC HARNESS -->\n');
 const before=await readFile(claudeMd,'utf8'), m=await scanRules(root,home);
 assert.equal(await readFile(claudeMd,'utf8'),before);
 assert.equal(m.rules.filter(r=>r.path===claudeMd).length,0);
 assert.match(one(m,'malformed','claude').message,/duplicate managed markers\. The scanner skipped this file/);
});
test('a retired Cursor rule file that is still on disk stays harness-owned; when stale, the proposal says to retire it',async()=>{
 const {root,home}=await fixture(), rule=join(home,'.cursor/rules/pragmatic-engineer.mdc');
 await put(rule,render(await current(root))['cursor/agentic-harness.mdc']);
 const same=await scanRules(root,home);
 assert.deepEqual(same.rules.filter(r=>r.path===rule).map(r=>[r.name,r.management,r.writable]),[['agentic-harness','harness',false]]);
 assert.deepEqual([same.findings,same.proposals],[[],[]],'the policy copy is never proposed for other agents');
 await writeFile(join(root,'core.md'),CORE+'- One more rule for the next release of the policy.\n');await publish(root,'1.1.0',digest(await loadSnapshot(root)),true);
 const stale=find(await scanRules(root,home),'stale-release','agentic-harness').filter(f=>f.records[0]===`cursor:${rule}`);
 assert.deepEqual(stale.map(f=>[f.proposal.action,f.proposal.reason]),[['none','This rule file is retired: Cursor gets the policy from User Rules. Run install cursor-files, which removes the file when it is unchanged since an earlier install; otherwise remove it by hand.']]);
});
test('AGENTS.override.md and the generic instructions file are scanned read-only',async()=>{
 const {root,home}=await fixture(), override=join(home,'.codex/AGENTS.override.md'), generic=join(home,'.config/agentic-harness/instructions.md');
 await put(join(home,'.cursor/rules/team-notes.mdc'),'---\nalwaysApply: true\n---\n\n# Team Notes\n\n- Use pnpm.\n');
 await put(override,'# Team Notes\n\n- Use yarn.\n');
 await put(generic,'<!-- Agentic harness release 0.9.0; digest x -->\nOld policy.\n');
 const before=await tree(home), s=await scanRules(root,home);
 assert.deepEqual(await tree(home),before);
 assert.deepEqual(s.rules.filter(r=>r.path===override).map(r=>[r.agent,r.name,r.management,r.writable]),[['codex','team-notes','unmanaged',false]]);
 assert.deepEqual(s.rules.filter(r=>r.agent==='generic').map(r=>[r.path,r.name,r.management,r.writable]),[[generic,'agentic-harness','harness',false]]);
 assert.deepEqual(find(s,'stale-release','agentic-harness').map(f=>f.proposal.reason),['Run install generic to install release 1.0.0.']);
 assert.equal(one(s,'content-drift','team-notes').proposal.action,'none');
 assert.deepEqual(s.proposals.filter(p=>p.action==='adopt'),[],'a read-only copy blocks adopt, because adopt must remove every loose copy');
 await writeFile(generic,'# Team Notes\n\n- Use pnpm.\n');
 assert.deepEqual((await scanRules(root,home)).rules.filter(r=>r.agent==='generic').map(r=>[r.name,r.management,r.writable]),[['team-notes','unmanaged',false]]);
});
test('an installed generic file stays harness-owned when the plain-text release line comes first',async()=>{
 const {root,home}=await fixture();await install(root,'generic',home);
 const s=await scanRules(root,home);
 assert.deepEqual(s.rules.filter(r=>r.agent==='generic').map(r=>[r.name,r.management,r.writable]),[['agentic-harness','harness',false]]);
 assert.deepEqual(s.findings.filter(f=>f.records.some(id=>id.startsWith('generic:'))),[]);
});
test('a home with no agent folders scans cleanly',async()=>{
 const {root}=await fixture(), s=await scanRules(root,await mkdtemp(join(tmpdir(),'harness-home-')));
 assert.deepEqual([s.rules,s.findings,s.proposals],[[],[],[]]);
});
test('a Codex copy of a path rule is not drift: Codex cannot scope it, so its wording must differ',async()=>{
 const {root,home}=await fixture(), agents=join(home,'.codex/AGENTS.md');
 await put(join(home,'.cursor/plugins/cache/pub/render/abc123/rules/render-yaml.mdc'),'---\nalwaysApply: false\nglobs:\n  - "**/render.yaml"\n---\n\nrender-yaml:\n- Every service needs a name.\n');
 await put(join(home,'.claude/rules/render-yaml.md'),'---\npaths:\n  - "**/render.yaml"\n---\n\nrender-yaml:\n- Every service needs a name.\n');
 await append(agents,'\n<!-- Source: Cursor Render plugin rule render-yaml.mdc -->\nrender-yaml (apply when editing a `render.yaml` file):\n- Every service needs a name.\n');
 const s=await scanRules(root,home);
 assert.equal(find(s,'content-drift','render-yaml').length,0);
 assert.deepEqual(find(s,'plugin-copy','render-yaml').map(f=>f.proposal.action),['remove','remove'],'each hand copy is still reported');
 await put(join(home,'.claude/rules/render-yaml.md'),'---\npaths:\n  - "**/render.yaml"\n---\n\nrender-yaml:\n- Every service needs a type.\n');
 const drift=one(await scanRules(root,home),'content-drift','render-yaml');
 assert.match(drift.message,/2 copies of render-yaml have 2 different texts \(cursor, claude\)/);
 assert.equal(drift.proposal.action,'merge');
});
