import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,readlink,realpath,symlink,chmod,stat,cp,access,rename,unlink} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {skillsStatus,skillsInstall,skillsVerify,skillsUninstall,io} from '../src/skills.ts';

const repo=join(dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
// Every path, its kind, mode, and bytes or link target: equal trees mean nothing was written.
async function tree(dir:string){
 const out:Record<string,string>={};
 async function walk(path:string,rel:string){
  const s=await lstat(path);
  if(s.isSymbolicLink())out[rel]='link:'+await readlink(path);
  else if(s.isDirectory()){out[rel]='dir';for(const n of await readdir(path))await walk(join(path,n),rel+'/'+n);}
  else out[rel]=(s.mode&0o777).toString(8)+':'+await readFile(path,'utf8');
 }
 try{await walk(dir,'.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 return out;
}
const fault=(code:string)=>Object.assign(new Error('injected '+code),{code});
// Swap file operations inside the installer for one call, then put them back.
async function patched(swap:Partial<typeof io>,body:()=>Promise<unknown>){const saved={...io};Object.assign(io,swap);try{await body();}finally{Object.assign(io,saved);}}
const absent=(path:string)=>assert.rejects(lstat(path),{code:'ENOENT'});
async function setup(){
 const base=await mkdtemp(join(tmpdir(),'harness-skills-')),root=join(base,'root'),home=join(base,'home'),source=join(base,'source');
 await mkdir(join(source,'alpha/references'),{recursive:true});await mkdir(join(source,'alpha/scripts'));await mkdir(join(source,'beta'));await mkdir(root);
 await writeFile(join(source,'alpha/SKILL.md'),'alpha v1\n');await writeFile(join(source,'alpha/references/guide.md'),'guide\n');
 await writeFile(join(source,'alpha/scripts/run.sh'),'#!/bin/sh\necho ok\n');await chmod(join(source,'alpha/scripts/run.sh'),0o755);
 await writeFile(join(source,'beta/SKILL.md'),'beta\n');
 const agents=(n:string)=>join(home,'.agents/skills',n),claude=(n:string)=>join(home,'.claude/skills',n);
 // Unrelated skills that share both folders, like the user's own installs.
 await mkdir(agents('other'),{recursive:true});await writeFile(join(agents('other'),'SKILL.md'),'mine\n');
 await mkdir(claude('hand'),{recursive:true});await writeFile(join(claude('hand'),'SKILL.md'),'hand\n');await symlink(agents('other'),claude('other'));
 const unrelated=async()=>[await tree(agents('other')),await tree(claude('hand')),await readlink(claude('other'))];
 const before=await unrelated(),untouched=async()=>assert.deepEqual(await unrelated(),before);
 const receipt=async(n:string,scope='home')=>JSON.parse(await readFile(join(root,'.state/installations/skills',scope,n+'.json'),'utf8'));
 const backups=async()=>{const b=join(root,'.state/backups/skills');return (await readdir(b)).map(id=>join(b,id));};
 return {base,root,home,source,opts:{home,source},agents,claude,untouched,receipt,backups};
}

test('install, verify, reinstall, and uninstall round trip in a temp home (EVAL-4)',async()=>{
 const {root,source,opts,agents,claude,untouched,receipt,backups}=await setup();
 const [r]=await skillsInstall(root,['alpha'],opts);
 assert.deepEqual({action:r.action,configurationVerified:r.configurationVerified,behaviorVerified:r.behaviorVerified},{action:'installed',configurationVerified:true,behaviorVerified:false});
 assert.deepEqual(await tree(agents('alpha')),await tree(join(source,'alpha')));
 assert.equal(await readlink(claude('alpha')),agents('alpha'));
 assert.equal(await realpath(claude('alpha')),await realpath(agents('alpha')));
 assert.equal((await run(join(claude('alpha'),'scripts/run.sh'))).stdout,'ok\n');
 assert.ok((await stat(join(agents('alpha'),'scripts/run.sh'))).mode&0o111);
 const saved=await receipt('alpha');
 assert.deepEqual([saved.origin,saved.backup,saved.claudeLink,saved.files.length,saved.scopeId],['created',null,{created:true,backup:null},3,'home']);
 assert.equal(saved.verification,'files installed; fresh-session behavior not yet verified');
 assert.deepEqual(await skillsVerify(root,[],opts),[{name:'alpha',scope:'home',foreign:false,filesMatch:true,linkValid:true,sourceCurrent:true,configurationVerified:true,behaviorVerified:false}]);
 await untouched();
 assert.equal((await skillsInstall(root,['alpha'],opts))[0].action,'unchanged');
 await untouched();
 const [u]=await skillsUninstall(root,['alpha'],opts);
 assert.equal(u.action,'uninstalled');
 await absent(agents('alpha'));await absent(claude('alpha'));
 const [dir]=await backups();
 assert.deepEqual(await tree(join(dir,'removed/alpha')),await tree(join(source,'alpha')));
 assert.equal((await lstat(join(dir,'removed/alpha.claude-link'))).isSymbolicLink(),true);
 assert.equal((await readdir(join(root,'.state/installations/skills/home/retired'))).length,1);
 assert.deepEqual(await skillsVerify(root,[],opts),[]);
 await untouched();
});

test('an unmanaged differing copy is refused with no writes; --replace backs it up and uninstall restores it (EVAL-5)',async()=>{
 const {base,root,opts,agents,claude,untouched,receipt,backups}=await setup();
 await mkdir(agents('alpha'));await writeFile(join(agents('alpha'),'SKILL.md'),'hand edited\n');
 const snapshot=await tree(base);
 await assert.rejects(skillsInstall(root,['alpha'],opts),/Nothing installed.*no receipt.*--replace/);
 assert.deepEqual(await tree(base),snapshot);
 await absent(join(root,'.state'));
 assert.deepEqual((await skillsStatus(root,['alpha'],opts)).map(s=>[s.agents.state,s.claude.state,s.receipt]),[['unmanaged','absent',false]]);
 assert.equal((await skillsInstall(root,['alpha'],{...opts,replace:true}))[0].action,'replaced');
 const saved=await receipt('alpha');
 assert.equal(saved.origin,'replaced');
 assert.equal(await readFile(join(root,saved.backup,'SKILL.md'),'utf8'),'hand edited\n');
 assert.equal(await readFile(join(agents('alpha'),'SKILL.md'),'utf8'),'alpha v1\n');
 await untouched();
 assert.equal((await skillsUninstall(root,['alpha'],opts))[0].restoredBackup,true);
 assert.deepEqual(await tree(agents('alpha')),{'.':'dir','./SKILL.md':'644:hand edited\n'});
 await absent(claude('alpha'));
 assert.ok((await readdir(join((await backups()).at(-1)!,'removed'))).includes('alpha'));
 await untouched();
});

test('a copy modified after install blocks install and uninstall',async()=>{
 const {base,root,opts,agents,untouched}=await setup();
 await skillsInstall(root,['alpha'],opts);
 await writeFile(join(agents('alpha'),'SKILL.md'),'changed\n');
 assert.equal((await skillsStatus(root,['alpha'],opts))[0].agents.state,'modified');
 assert.equal((await skillsVerify(root,['alpha'],opts))[0].configurationVerified,false);
 const snapshot=await tree(base);
 await assert.rejects(skillsInstall(root,['alpha'],opts),/differs from its receipt\. Compare it with .*--replace/);
 await assert.rejects(skillsUninstall(root,['alpha'],opts),/Nothing uninstalled.*differs from its receipt/);
 assert.deepEqual(await tree(base),snapshot);
 await untouched();
});

test('a source change shows stale, and install updates with a backup',async()=>{
 const {root,source,opts,agents,untouched,receipt,backups}=await setup();
 await skillsInstall(root,['alpha'],opts);
 await writeFile(join(source,'alpha/SKILL.md'),'alpha v2\n');
 assert.equal((await skillsStatus(root,['alpha'],opts))[0].agents.state,'stale');
 assert.equal((await skillsVerify(root,['alpha'],opts))[0].sourceCurrent,false);
 assert.equal((await skillsInstall(root,['alpha'],opts))[0].action,'updated');
 assert.equal(await readFile(join(agents('alpha'),'SKILL.md'),'utf8'),'alpha v2\n');
 const [dir]=await backups();
 assert.equal(await readFile(join(dir,'alpha/agents/SKILL.md'),'utf8'),'alpha v1\n');
 const saved=await receipt('alpha');
 // The old copy came from the harness, so uninstall returns to no copy, not to v1.
 assert.deepEqual([saved.origin,saved.backup],['updated',null]);
 assert.equal((await skillsVerify(root,['alpha'],opts))[0].sourceCurrent,true);
 await skillsUninstall(root,['alpha'],opts);
 await absent(agents('alpha'));
 await untouched();
});

test('an identical hand install is adopted in place and left in place on uninstall',async()=>{
 const {root,source,opts,agents,claude,untouched,receipt}=await setup();
 await cp(join(source,'alpha'),agents('alpha'),{recursive:true});await symlink(agents('alpha'),claude('alpha'));
 const inode=(await stat(join(agents('alpha'),'SKILL.md'))).ino;
 assert.equal((await skillsStatus(root,['alpha'],opts))[0].claude.state,'linked');
 assert.equal((await skillsInstall(root,['alpha'],opts))[0].action,'adopted');
 assert.equal((await stat(join(agents('alpha'),'SKILL.md'))).ino,inode);
 await absent(join(root,'.state/backups'));
 const saved=await receipt('alpha');
 assert.deepEqual([saved.origin,saved.backup,saved.claudeLink.created],['adopted',null,false]);
 assert.equal((await skillsUninstall(root,['alpha'],opts))[0].action,'released');
 assert.equal((await stat(join(agents('alpha'),'SKILL.md'))).ino,inode);
 assert.equal(await readlink(claude('alpha')),agents('alpha'));
 await absent(join(root,'.state/installations/skills/home/alpha.json'));
 await untouched();
});

test('a real folder at the Claude path is refused, then backed up with --replace and restored on uninstall',async()=>{
 const {base,root,opts,agents,claude,untouched,receipt}=await setup();
 await mkdir(claude('alpha'));await writeFile(join(claude('alpha'),'SKILL.md'),'claude own\n');
 const snapshot=await tree(base);
 await assert.rejects(skillsInstall(root,['alpha'],opts),/is not a link to .*--replace/);
 assert.deepEqual(await tree(base),snapshot);
 await skillsInstall(root,['alpha'],{...opts,replace:true});
 assert.equal(await readlink(claude('alpha')),agents('alpha'));
 const saved=await receipt('alpha');
 assert.equal(await readFile(join(root,saved.claudeLink.backup,'SKILL.md'),'utf8'),'claude own\n');
 await skillsUninstall(root,['alpha'],opts);
 assert.deepEqual(await tree(claude('alpha')),{'.':'dir','./SKILL.md':'644:claude own\n'});
 await absent(agents('alpha'));
 await untouched();
});

test('repo scope writes .agents/skills and a relative .claude/skills link (EVAL-6)',async()=>{
 const {base,root,home,opts,untouched}=await setup();
 const project=join(base,'project');await mkdir(project);
 const scope='repo-'+createHash('sha256').update(await realpath(project)).digest('hex').slice(0,12),real=await realpath(project);
 const [r]=await skillsInstall(root,['alpha'],{...opts,repo:project});
 assert.equal(r.configurationVerified,true);
 assert.equal(await readlink(join(project,'.claude/skills/alpha')),'../../.agents/skills/alpha');
 assert.equal(await realpath(join(project,'.claude/skills/alpha')),join(real,'.agents/skills/alpha'));
 assert.equal(await readFile(join(project,'.claude/skills/alpha/SKILL.md'),'utf8'),'alpha v1\n');
 await access(join(root,'.state/installations/skills',scope,'alpha.json'));
 await absent(join(home,'.agents/skills/alpha'));
 assert.equal((await skillsStatus(root,['alpha'],{...opts,repo:project}))[0].claude.state,'linked');
 assert.equal((await skillsStatus(root,['alpha'],opts))[0].agents.state,'absent');
 assert.equal((await skillsVerify(root,[],{...opts,repo:project}))[0].configurationVerified,true);
 await skillsUninstall(root,['alpha'],{...opts,repo:project});
 await absent(join(project,'.agents/skills/alpha'));await absent(join(project,'.claude/skills/alpha'));
 await untouched();
});

test('unknown names list valid names, and a blocked second name stops the first',async()=>{
 const {base,root,opts,agents,untouched}=await setup();
 await assert.rejects(skillsInstall(root,['nope'],opts),/Unknown skill nope\. Valid names: alpha, beta/);
 await assert.rejects(skillsInstall(root,[],opts),/Name at least one skill/);
 await assert.rejects(skillsUninstall(root,[],opts),/Name at least one skill/);
 await mkdir(agents('beta'));await writeFile(join(agents('beta'),'SKILL.md'),'not the source\n');
 const snapshot=await tree(base);
 await assert.rejects(skillsInstall(root,['alpha','beta'],opts),/beta: .*no receipt/);
 assert.deepEqual(await tree(base),snapshot);
 await absent(agents('alpha'));
 await untouched();
});

test('a failed install rolls back its own writes',async()=>{
 const {base,root,opts,home,untouched}=await setup();
 const snapshot=await tree(base),skills=join(home,'.claude/skills');
 await chmod(skills,0o555);
 try{await assert.rejects(skillsInstall(root,['alpha'],opts),{code:'EACCES'});}finally{await chmod(skills,0o755);}
 assert.deepEqual(await tree(base),snapshot);
 await absent(join(home,'.agents/skills/alpha'));await absent(join(root,'.state/installations/skills/home/alpha.json'));
 await untouched();
});

test('CLAUDE_CONFIG_DIR sets the Claude skills folder for the default home',async()=>{
 const {base,root,home,source,agents,claude}=await setup();
 const saved={HOME:process.env.HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR},config=join(base,'claude-config');
 process.env.HOME=home;process.env.CLAUDE_CONFIG_DIR=config;
 try{
  assert.equal(homedir(),home);
  await skillsInstall(root,['alpha'],{source});
  assert.equal(await readlink(join(config,'skills/alpha')),agents('alpha'));
  await absent(claude('alpha'));
  assert.equal((await skillsVerify(root,['alpha'],{source}))[0].configurationVerified,true);
  await skillsUninstall(root,['alpha'],{source});
  await absent(join(config,'skills/alpha'));
 }finally{
  for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});

test('the CLI prints skills status as JSON and lists skills commands in help',async()=>{
 const root=await mkdtemp(join(tmpdir(),'harness-skills-root-')),home=await mkdtemp(join(tmpdir(),'harness-skills-home-'));
 const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:join(home,'claude-config'),HARNESS_ROOT:''};
 const cli=(...args:string[])=>run(process.execPath,['--experimental-strip-types',join(repo,'src/cli.ts'),...args],{cwd:tmpdir(),env});
 const rows=JSON.parse((await cli('--root',root,'skills','status')).stdout);
 const grill=rows.find((r:{name:string})=>r.name==='grill-me');
 assert.deepEqual([grill.agents.path,grill.agents.state,grill.claude.path,grill.receipt],[join(home,'.agents/skills/grill-me'),'absent',join(home,'claude-config/skills/grill-me'),false]);
 await assert.rejects(cli('--root',root,'skills','install'),/Name at least one skill/);
 assert.match((await cli('--root',root,'help')).stdout,/skills install NAME\.\.\. \[--repo PATH\] \[--replace\]/);
 assert.deepEqual(await tree(home),{'.':'dir'});await absent(join(root,'.state'));
});

test('adopted files with a replaced Claude folder: uninstall leaves the files and restores the folder (F1, S5-04)',async()=>{
 const {root,source,opts,agents,claude,untouched,receipt}=await setup();
 await cp(join(source,'alpha'),agents('alpha'),{recursive:true});
 await mkdir(claude('alpha'));await writeFile(join(claude('alpha'),'SKILL.md'),'claude own\n');
 const [r]=await skillsInstall(root,['alpha'],{...opts,replace:true});
 const saved=await receipt('alpha');
 assert.deepEqual([r.action,saved.origin,saved.claudeLink.created],['adopted','adopted',true]);
 assert.deepEqual(r.backups,[saved.claudeLink.backup]);
 const [u]=await skillsUninstall(root,['alpha'],opts);
 assert.equal(u.action,'released');
 assert.deepEqual(await tree(claude('alpha')),{'.':'dir','./SKILL.md':'644:claude own\n'});
 assert.deepEqual(await tree(agents('alpha')),await tree(join(source,'alpha')));
 assert.equal(u.backups.length,1);assert.ok(u.backups[0].endsWith('removed/alpha.claude-link'));
 await untouched();
});

test('adopted files with a harness-made link: uninstall moves the link out and leaves the files (F1)',async()=>{
 const {root,source,opts,agents,claude,untouched,receipt}=await setup();
 await cp(join(source,'alpha'),agents('alpha'),{recursive:true});
 assert.equal((await skillsInstall(root,['alpha'],opts))[0].action,'adopted');
 assert.deepEqual((await receipt('alpha')).claudeLink,{created:true,backup:null});
 const [u]=await skillsUninstall(root,['alpha'],opts);
 await absent(claude('alpha'));
 assert.equal((await lstat(join(root,u.backups[0]))).isSymbolicLink(),true);
 assert.deepEqual(await tree(agents('alpha')),await tree(join(source,'alpha')));
 await untouched();
});

test('a receipt from another home, Claude folder, or name is foreign: status reports it, install and uninstall refuse (F2, S5-01)',async()=>{
 const {base,root,opts,untouched}=await setup();
 await skillsInstall(root,['alpha'],opts);
 const other=join(base,'other-home');await mkdir(other);
 const elsewhere={...opts,home:other},snapshot=await tree(base);
 const [s]=await skillsStatus(root,['alpha'],elsewhere);
 assert.deepEqual([s.agents.path,s.agents.state,s.receipt],[join(other,'.agents/skills/alpha'),'foreign',true]);
 await assert.rejects(skillsInstall(root,['alpha'],{...elsewhere,replace:true}),/Nothing installed\. alpha: .*another home/);
 await assert.rejects(skillsUninstall(root,['alpha'],elsewhere),/Nothing uninstalled\. alpha: .*another home/);
 assert.deepEqual((await skillsVerify(root,['alpha'],elsewhere)).map(v=>[v.foreign,v.configurationVerified]),[[true,false]]);
 assert.deepEqual(await tree(base),snapshot);
 assert.deepEqual((await skillsVerify(root,['alpha'],opts)).map(v=>[v.foreign,v.configurationVerified]),[[false,true]]);
 const receipts=join(root,'.state/installations/skills/home');
 await cp(join(receipts,'alpha.json'),join(receipts,'beta.json'));
 assert.equal((await skillsStatus(root,['beta'],opts))[0].agents.state,'foreign');
 await assert.rejects(skillsUninstall(root,['beta'],opts),/beta: .*another home, Claude folder, or skill name/);
 await assert.rejects(skillsInstall(root,['beta'],opts),/beta: .*another home/);
 await untouched();
});

test('uninstall restores a Claude backup when the link is gone, and reports a backup it must keep (F3)',async()=>{
 const {root,opts,claude,untouched,receipt}=await setup();
 for(const n of ['alpha','beta']){await mkdir(claude(n));await writeFile(join(claude(n),'SKILL.md'),n+' own\n');}
 const installed=await skillsInstall(root,['alpha','beta'],{...opts,replace:true});
 const kept=(await receipt('beta')).claudeLink.backup;
 assert.deepEqual(installed.map(r=>r.backups),[[(await receipt('alpha')).claudeLink.backup],[kept]]);
 await unlink(claude('alpha'));
 await unlink(claude('beta'));await writeFile(claude('beta'),'user file\n');
 const [a,b]=await skillsUninstall(root,['alpha','beta'],opts);
 assert.deepEqual(await tree(claude('alpha')),{'.':'dir','./SKILL.md':'644:alpha own\n'});
 assert.deepEqual(a.backups.map(p=>p.split('/').slice(-2).join('/')),['removed/alpha']);
 assert.equal(await readFile(claude('beta'),'utf8'),'user file\n');
 assert.ok(b.backups.includes(kept));
 assert.equal(await readFile(join(root,kept,'SKILL.md'),'utf8'),'beta own\n');
 await untouched();
});

test('every command refuses a name that is not one path part; uninstall and verify work for a name gone from the source (F4, S5-01)',async()=>{
 const {base,root,source,opts,agents,untouched}=await setup();
 const snapshot=await tree(base);
 for(const call of [skillsStatus,skillsInstall,skillsVerify,skillsUninstall])
  for(const bad of ['../x','..','.','a/b','-x'])await assert.rejects(call(root,[bad],opts),/Invalid skill name/);
 assert.deepEqual(await tree(base),snapshot);
 await skillsInstall(root,['beta'],opts);
 await rename(join(source,'beta'),join(base,'beta-retired'));
 assert.deepEqual((await skillsVerify(root,['beta'],opts)).map(v=>[v.configurationVerified,v.sourceCurrent]),[[true,false]]);
 assert.equal((await skillsUninstall(root,['beta'],opts))[0].action,'uninstalled');
 await absent(agents('beta'));
 await untouched();
});

test('an adopted copy edited by the user is released on uninstall without a hash check (F5)',async()=>{
 const {root,source,opts,agents,claude,untouched}=await setup();
 await cp(join(source,'alpha'),agents('alpha'),{recursive:true});await symlink(agents('alpha'),claude('alpha'));
 await skillsInstall(root,['alpha'],opts);
 await writeFile(join(agents('alpha'),'SKILL.md'),'user edit\n');
 assert.equal((await skillsUninstall(root,['alpha'],opts))[0].action,'released');
 assert.equal(await readFile(join(agents('alpha'),'SKILL.md'),'utf8'),'user edit\n');
 assert.equal(await readlink(claude('alpha')),agents('alpha'));
 await absent(join(root,'.state/installations/skills/home/alpha.json'));
 await untouched();
});

test('a cross-device move that fails while removing the source restores the source, and install rolls back (S5-03)',async()=>{
 const {root,opts,agents,untouched,backups}=await setup();
 await mkdir(join(agents('alpha'),'notes'),{recursive:true});
 await writeFile(join(agents('alpha'),'SKILL.md'),'hand edited\n');await writeFile(join(agents('alpha'),'notes/a.md'),'note\n');
 const before=await tree(agents('alpha')),rm=io.rm;
 const exdev=(async()=>{throw fault('EXDEV');}) as typeof io.rename;
 // Removes one file of the source, then fails, like a read-only subfolder would.
 const partial=(async(path:string,o:object)=>{if(path!==agents('alpha'))return rm(path,o);await unlink(join(path,'SKILL.md'));throw fault('EACCES');}) as typeof io.rm;
 await patched({rename:exdev,rm:partial},()=>assert.rejects(skillsInstall(root,['alpha'],{...opts,replace:true}),{code:'EACCES'}));
 assert.deepEqual(await tree(agents('alpha')),before);
 await absent(join(root,'.state/installations/skills/home/alpha.json'));
 for(const dir of await backups())await absent(join(dir,'alpha/agents'));
 await untouched();
});

test('a failure on the second name rolls back the first, including the backup it moved (F6)',async()=>{
 const {base,root,opts,agents,untouched,backups}=await setup();
 await mkdir(agents('alpha'));await writeFile(join(agents('alpha'),'SKILL.md'),'hand edited\n');
 const before=await tree(join(base,'home'));
 const fail=(async(from:string,to:string)=>{if(to===agents('beta'))throw fault('ENOSPC');return rename(from,to);}) as typeof io.rename;
 await patched({rename:fail},()=>assert.rejects(skillsInstall(root,['alpha','beta'],{...opts,replace:true}),{code:'ENOSPC'}));
 assert.deepEqual(await tree(join(base,'home')),before);
 await absent(join(root,'.state/installations/skills/home/alpha.json'));
 for(const dir of await backups())await absent(join(dir,'alpha/agents'));
 await untouched();
});

test('a failed uninstall rolls back every name it touched (F6)',async()=>{
 const {base,root,opts,agents,untouched,receipt}=await setup();
 await mkdir(agents('alpha'));await writeFile(join(agents('alpha'),'SKILL.md'),'hand edited\n');
 await skillsInstall(root,['alpha'],{...opts,replace:true});await skillsInstall(root,['beta'],opts);
 const before=await tree(join(base,'home')),saved=[await receipt('alpha'),await receipt('beta')];
 const fail=(async(from:string,to:string)=>{if(to.includes('/retired/beta.'))throw fault('ENOSPC');return rename(from,to);}) as typeof io.rename;
 await patched({rename:fail},()=>assert.rejects(skillsUninstall(root,['alpha','beta'],opts),{code:'ENOSPC'}));
 assert.deepEqual(await tree(join(base,'home')),before);
 assert.deepEqual([await receipt('alpha'),await receipt('beta')],saved);
 assert.deepEqual(await readdir(join(root,'.state/installations/skills/home/retired')),[]);
 assert.ok((await skillsVerify(root,[],opts)).every(v=>v.configurationVerified));
 await untouched();
});

test('install --replace on a copy modified after install reports the backup it made',async()=>{
 const {root,opts,agents,untouched,receipt}=await setup();
 await skillsInstall(root,['alpha'],opts);
 await writeFile(join(agents('alpha'),'SKILL.md'),'changed\n');
 const [r]=await skillsInstall(root,['alpha'],{...opts,replace:true});
 assert.deepEqual([r.action,r.backups.length],['replaced',1]);
 assert.equal(await readFile(join(root,r.backups[0],'SKILL.md'),'utf8'),'changed\n');
 // The edit was made after the harness installed, so uninstall returns to no copy.
 assert.equal((await receipt('alpha')).backup,null);
 await untouched();
});
