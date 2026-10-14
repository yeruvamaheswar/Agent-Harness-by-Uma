import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CODE_ROOT} from '../src/env.ts';
import {loadControls,claudeRules,controlsInstall,controlsVerify,controlsUninstall} from '../src/controls.ts';
import type {Control,Effect} from '../src/controls.ts';

const SOURCE={schemaVersion:1,controls:[
 {id:'no-force-push',why:'x',effect:'deny',claude:['Bash(git push --force:*)']},
 {id:'ask-push-main',why:'x',effect:'ask',claude:['Bash(git push origin main:*)']},
 {id:'no-self-edit',why:'x',effect:'deny',claude:['Edit(/{HARNESS_ROOT}/.state/**)','Edit(/{CODE_ROOT}/controls/**)']},
]};
async function fixture(settings?:string,source:unknown=SOURCE){
 const root=await mkdtemp(join(tmpdir(),'controls-root-')),home=await mkdtemp(join(tmpdir(),'controls-home-'));
 const file=join(root,'controls.json');await writeFile(file,JSON.stringify(source));
 const path=join(home,'.claude','settings.json');
 if(settings!==undefined){await mkdir(join(home,'.claude'),{recursive:true});await writeFile(path,settings);}
 return {root,home,file,path};
}
const read=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const exists=(path:string)=>access(path).then(()=>true,()=>false);

test('the shipped controls.json loads and has the 6 approved controls',async()=>{
 const {controls}=await loadControls();
 assert.deepEqual(
  controls.map(c=>`${c.effect} ${c.id}`),
  ['deny no-force-push','ask ask-push-main','ask ask-force-with-lease','deny no-secret-reads','ask ask-deploys','deny no-self-edit'],
 );
});
test('claudeRules fills the harness root and splits deny from ask',()=>{
 assert.deepEqual(claudeRules(SOURCE.controls as any,'/h','/c'),{deny:['Bash(git push --force:*)','Edit(//h/.state/**)','Edit(//c/controls/**)'],ask:['Bash(git push origin main:*)']});
});
test('install adds rules, keeps other settings, and verify passes',async()=>{
 const {root,home,file,path}=await fixture(JSON.stringify({model:'opus',permissions:{allow:['Bash(ls:*)'],deny:['Bash(rm -rf:*)']}}));
 await controlsInstall(root,'claude',home,file);
 const s=await read(path);
 assert.equal(s.model,'opus');
 assert.deepEqual(s.permissions.allow,['Bash(ls:*)']);
 assert.deepEqual(s.permissions.deny.slice(0,3),['Bash(rm -rf:*)','Bash(git push --force:*)',`Edit(/${root}/.state/**)`]);
 assert.match(s.permissions.deny[3],/^Edit\(\/\/.*\/controls\/\*\*\)$/);
 assert.deepEqual(s.permissions.ask,['Bash(git push origin main:*)']);
 const v=await controlsVerify(root,'claude',file);
 assert.equal(v.configurationVerified,true);assert.equal(v.behaviorVerified,false);
});
test('verify reports a removed rule and a changed source',async()=>{
 const {root,home,file,path}=await fixture('{}');
 await controlsInstall(root,'claude',home,file);
 const s=await read(path);s.permissions.deny=s.permissions.deny.slice(1);await writeFile(path,JSON.stringify(s));
 const v=await controlsVerify(root,'claude',file);
 assert.equal(v.configurationVerified,false);assert.deepEqual(v.missing,[{effect:'deny',rule:'Bash(git push --force:*)'}]);
 await writeFile(file,JSON.stringify({...SOURCE,controls:SOURCE.controls.slice(0,1)}));
 assert.equal((await controlsVerify(root,'claude',file)).sourceChanged,true);
});
test('uninstall of an untouched file restores the original bytes',async()=>{
 for(const original of ['{"model":"opus"}','{\n  "permissions": {"deny": ["Bash(git push --force:*)"]}\n}\n']){
  const {root,home,file,path}=await fixture(original);
  await controlsInstall(root,'claude',home,file);
  const r=await controlsUninstall(root,'claude');
  assert.equal(r.restoredOriginalBytes,true);assert.equal(await readFile(path,'utf8'),original);
 }
});
test('a rule the user already had is not owned and survives uninstall after other edits',async()=>{
 const {root,home,file,path}=await fixture(JSON.stringify({permissions:{deny:['Bash(git push --force:*)']}}));
 await controlsInstall(root,'claude',home,file);
 const s=await read(path);s.theme='dark';await writeFile(path,JSON.stringify(s));
 const r=await controlsUninstall(root,'claude');
 assert.equal(r.restoredOriginalBytes,false);
 assert.deepEqual(await read(path),{permissions:{deny:['Bash(git push --force:*)']},theme:'dark'});
});
test('uninstall removes a settings file the install created',async()=>{
 const {root,home,file,path}=await fixture();
 await controlsInstall(root,'claude',home,file);
 assert.equal(await exists(path),true);
 await controlsUninstall(root,'claude');
 assert.equal(await exists(path),false);
});
test('reinstall drops rules removed from the source and keeps the first backup',async()=>{
 const {root,home,file,path}=await fixture('{"model":"opus"}');
 const first=await controlsInstall(root,'claude',home,file);
 await writeFile(file,JSON.stringify({...SOURCE,controls:SOURCE.controls.slice(0,1)}));
 const second=await controlsInstall(root,'claude',home,file);
 assert.equal(second.backup,first.backup);
 assert.deepEqual(await read(path),{model:'opus',permissions:{deny:['Bash(git push --force:*)']}});
 await controlsUninstall(root,'claude');
 assert.equal(await readFile(path,'utf8'),'{"model":"opus"}');
});
test('install refuses invalid JSON, a symlink, and other platforms without writing',async()=>{
 const {root,home,file,path}=await fixture('{not json');
 await assert.rejects(controlsInstall(root,'claude',home,file),/not a JSON object/);
 assert.equal(await readFile(path,'utf8'),'{not json');
 const b=await fixture();await mkdir(join(b.home,'.claude'));await symlink(join(b.root,'controls.json'),b.path);
 await assert.rejects(controlsInstall(b.root,'claude',b.home,b.file),/symlink/);
 await assert.rejects(controlsInstall(root,'codex',home,file),/Supported controls platforms: claude/);
});
test('loadControls rejects a bad effect and duplicate ids',async()=>{
 const a=await fixture(undefined,{schemaVersion:1,controls:[{id:'a',why:'x',effect:'allow',claude:[]}]});
 await assert.rejects(loadControls(a.file),/effect must be deny or ask/);
 const b=await fixture(undefined,{schemaVersion:1,controls:[{id:'a',why:'x',effect:'deny',claude:[]},{id:'a',why:'x',effect:'deny',claude:[]}]});
 await assert.rejects(loadControls(b.file),/duplicate id/);
});

type ProjectSettings={permissions?:Partial<Record<Effect,string[]>>};
function missingProjectRules(controls:Control[],settings:ProjectSettings){
 const missing:{effect:Effect;rule:string}[]=[];
 for(const control of controls){
  const have=settings.permissions?.[control.effect]??[];
  for(const rule of control.claude){
   if(rule.includes('{'))continue;
   if(!have.includes(rule))missing.push({effect:control.effect,rule});
  }
 }
 return missing;
}
test('project parity helper returns nothing for an aligned settings fixture',()=>{
 const settings={permissions:{
  deny:['Bash(git push --force:*)','Bash(extra:*)'],
  ask:['Bash(git push origin main:*)'],
 }};
 assert.deepEqual(missingProjectRules(SOURCE.controls as Control[],settings),[]);
});
test('project parity helper lists a rule missing from a drifted settings fixture',()=>{
 const settings={permissions:{deny:[],ask:['Bash(git push origin main:*)']}};
 assert.deepEqual(
  missingProjectRules(SOURCE.controls as Control[],settings),
  [{effect:'deny',rule:'Bash(git push --force:*)'}],
 );
});
test('the repo .claude/settings.json has every non-placeholder rule from controls.json',async()=>{
 const {controls}=await loadControls();
 const settings=await read(join(CODE_ROOT,'.claude','settings.json'));
 const missing=missingProjectRules(controls,settings);
 assert.deepEqual(
  missing,
  [],
  `Missing ${missing.length} rule(s):\n`
   +missing.map(m=>`  ${m.effect}: ${m.rule}`).join('\n')
   +'\nupdate .claude/settings.json from controls/controls.json',
 );
});
test('status skips the controls receipt and reports controls (regression)',async()=>{
 const {root,home,file}=await fixture('{}');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[]}));
 await controlsInstall(root,'claude',home,file);
 assert.ok(await exists(join(root,'.state','installations','controls-claude.json')));
 const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:join(home,'claude-config'),HARNESS_ROOT:''};
 const out=await promisify(execFile)(process.execPath,['--experimental-strip-types',join(CODE_ROOT,'src/cli.ts'),'--root',root,'status'],{cwd:tmpdir(),env});
 const s=JSON.parse(out.stdout);
 assert.ok(Array.isArray(s.installations));
 assert.equal(s.installations.length,0);
 assert.equal(s.controls.installed,true);
});
