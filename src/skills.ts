import {cp, mkdir, readdir, readFile, lstat, readlink, realpath, rename, rm, symlink} from 'node:fs/promises';
import {join, relative, resolve, dirname, basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {hash, json, saveJSON, inside} from './core.ts';
import {claudeHome} from './install.ts';
import {CODE_ROOT} from './env.ts';

type Options = {home?:string; source?:string; repo?:string; replace?:boolean};
type FileHash = {path:string; hash:string};
type Receipt = {name:string; scope:string; scopeId:string; agentsPath:string; claudePath:string; sourceDigest:string; files:FileHash[]; origin:'created'|'adopted'|'replaced'|'updated'; backup:string|null; claudeLink:{created:boolean; backup:string|null}; installedAt:string; verification:string};
type Undo = (()=>Promise<unknown>)[];
// Tests swap these to inject cross-device and partial-removal failures.
export const io = {rename,rm,cp};
const missing = (error:unknown) => {if((error as NodeJS.ErrnoException).code==='ENOENT')return null; throw error;};
const exists = (path:string) => lstat(path).catch(missing);
const stamp = () => new Date().toISOString().replace(/[:.]/g,'-');
// Symlinks are hashed by target so a copy that swaps a file for a link never counts as equal.
async function inventory(directory:string):Promise<FileHash[]> {
  const files:FileHash[]=[];
  async function walk(path:string) {
    for(const entry of await readdir(path,{withFileTypes:true})) {
      if(entry.name==='.DS_Store')continue;
      const absolute=join(path,entry.name), rel=relative(directory,absolute);
      if(entry.isDirectory())await walk(absolute);
      else if(entry.isFile())files.push({path:rel,hash:createHash('sha256').update(await readFile(absolute)).digest('hex')});
      else if(entry.isSymbolicLink())files.push({path:rel,hash:hash('symlink:'+await readlink(absolute))});
      else throw new Error(`Unsupported skill entry: ${absolute}`);
    }
  }
  await walk(directory);
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
const digest = (files:FileHash[]) => hash(JSON.stringify(files));
async function installedFiles(path:string) {try {return await inventory(path);} catch(error) {if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return null; throw error;}}
async function context(root:string, options:Options) {
  const home=options.home??homedir(), repo=options.repo?await realpath(options.repo):undefined;
  const source=options.source??join(CODE_ROOT,'tools/agents/skills'), scopeId=repo?'repo-'+hash(repo).slice(0,12):'home';
  const valid=(await readdir(source,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>e.name).sort();
  return {root:resolve(root),scope:repo?'repo':'home',scopeId,repo,source,valid,
    agents:join(repo??home,'.agents/skills'),claude:repo?join(repo,'.claude/skills'):join(claudeHome(home),'skills'),
    receipts:join(resolve(root),'.state/installations/skills',scopeId)};
}
type Context = Awaited<ReturnType<typeof context>>;
// One path part only, so a name can never reach outside the skill folders or receipts.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function checked(names:string[]) {
  const bad=names.filter(name=>!NAME.test(name));
  if(bad.length)throw new Error(`Invalid skill name ${bad.join(', ')}. Use letters, digits, dots, dashes, or underscores, starting with a letter or digit.`);
  return [...new Set(names)];
}
function select(ctx:Context,names:string[],required=false) {
  checked(names);
  const unknown=names.filter(name=>!ctx.valid.includes(name));
  if(unknown.length)throw new Error(`Unknown skill ${unknown.join(', ')}. Valid names: ${ctx.valid.join(', ')}`);
  if(required&&!names.length)throw new Error(`Name at least one skill. Valid names: ${ctx.valid.join(', ')}`);
  return [...new Set(names.length?names:ctx.valid)];
}
// Repo links are relative so the project still works when it is cloned elsewhere.
const linkTarget = (ctx:Context,name:string) => ctx.scope==='repo'?join('../../.agents/skills',name):join(ctx.agents,name);
const receiptPath = (ctx:Context,name:string) => join(ctx.receipts,name+'.json');
async function receipt(ctx:Context,name:string) {return json<Receipt>(receiptPath(ctx,name)).catch(missing);}
// The home receipt folder is shared by every HOME and CLAUDE_CONFIG_DIR, so a receipt must match the paths of this run.
const foreign = (ctx:Context,name:string,saved:Receipt|null) => !!saved&&(saved.name!==name||saved.agentsPath!==join(ctx.agents,name)||saved.claudePath!==join(ctx.claude,name));
const foreignNote = (ctx:Context,name:string,saved:Receipt) => `${name}: receipt ${receiptPath(ctx,name)} belongs to another home, Claude folder, or skill name (${saved.name}: ${saved.agentsPath}, ${saved.claudePath}). Rerun with the HOME and CLAUDE_CONFIG_DIR it was made with.`;
const stored = (ctx:Context,path:string) => inside(join(ctx.root,'.state/backups/skills'),resolve(ctx.root,path));
async function linked(path:string,target:string) {
  if(!(await exists(path))?.isSymbolicLink())return false;
  const [a,b]=await Promise.all([realpath(path).catch(missing),realpath(target).catch(missing)]);
  return a&&b?a===b:resolve(dirname(path),await readlink(path))===resolve(target);
}
async function check(agentsPath:string,claudePath:string,files:FileHash[]) {
  const installed=await installedFiles(agentsPath), filesMatch=!!installed&&digest(installed)===digest(files), linkValid=await linked(claudePath,agentsPath);
  return {filesMatch,linkValid,configurationVerified:filesMatch&&linkValid};
}
async function inspect(ctx:Context,name:string) {
  const files=await inventory(join(ctx.source,name)), sourceDigest=digest(files), saved=await receipt(ctx,name);
  const agentsPath=join(ctx.agents,name), claudePath=join(ctx.claude,name), present=await exists(agentsPath);
  const installed=present?await installedFiles(agentsPath):null;
  const state=foreign(ctx,name,saved)?'foreign':!present?'absent':installed&&digest(installed)===sourceDigest?'current':saved?(installed&&digest(installed)===digest(saved.files)?'stale':'modified'):'unmanaged';
  const claudeState=!(await exists(claudePath))?'absent':await linked(claudePath,agentsPath)?'linked':'other';
  return {name,sourceDigest,agents:{path:agentsPath,state},claude:{path:claudePath,state:claudeState},receipt:!!saved,files,saved};
}
export async function skillsStatus(root:string,names:string[]=[],options:Options={}) {
  const ctx=await context(root,options);
  return Promise.all(select(ctx,names).map(async name=>{const {files,saved,...row}=await inspect(ctx,name);return row;}));
}
async function move(from:string,to:string) {
  if(await exists(to))throw new Error(`Refusing to overwrite ${to}.`);
  await mkdir(dirname(to),{recursive:true});
  try {await io.rename(from,to);return;} catch(error) {if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;}
  // Across devices: copy, then remove. A failure puts the source back whole and leaves no destination.
  try {await io.cp(from,to,{recursive:true,verbatimSymlinks:true});} catch(error) {return rollback(error,[()=>io.rm(to,{recursive:true,force:true})]);}
  try {await io.rm(from,{recursive:true,force:true});} catch(error) {
    return rollback(error,[async()=>{await io.cp(to,from,{recursive:true,force:true,verbatimSymlinks:true});await io.rm(to,{recursive:true,force:true});}]);
  }
}
// Registered before its move, so it also covers a move that failed halfway; it acts only if the move happened.
const back = (from:string,to:string) => async()=>{if(await exists(to)&&!(await exists(from)))await move(to,from);};
// Exclusive mkdir keeps two runs in the same millisecond from sharing a backup folder.
async function reserve(ctx:Context) {
  const base=join(ctx.root,'.state/backups/skills'), id=stamp();
  await mkdir(base,{recursive:true});
  for(let i=0;;i++) {
    const dir=join(base,id+(i?'-'+i:''));
    try {await mkdir(dir);return dir;} catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
}
async function rollback(error:unknown,undo:Undo):Promise<never> {
  const failures:unknown[]=[];
  for(const revert of undo.reverse())try {await revert();} catch(failure) {failures.push(failure);}
  throw failures.length?new AggregateError([error,...failures],'Rollback incomplete; check .state/backups/skills.'):error;
}
function refusals(ctx:Context,row:Awaited<ReturnType<typeof inspect>>,replace:boolean|undefined) {
  const out=[], {name,agents,claude,saved}=row;
  if(agents.state==='foreign')return [foreignNote(ctx,name,saved!)];
  if(replace)return [];
  if(agents.state==='modified')out.push(`${name}: ${agents.path} differs from its receipt. Compare it with ${join(ctx.source,name)}, then rerun with --replace.`);
  if(agents.state==='unmanaged')out.push(`${name}: ${agents.path} differs from the source and has no receipt. Rerun with --replace to back it up and replace it.`);
  if(claude.state==='other')out.push(`${name}: ${claude.path} is not a link to ${agents.path}. Rerun with --replace to back it up and link it.`);
  return out;
}
export async function skillsInstall(root:string,names:string[],options:Options={}) {
  const ctx=await context(root,options), rows=await Promise.all(select(ctx,names,true).map(name=>inspect(ctx,name)));
  const blocked=rows.flatMap(row=>refusals(ctx,row,options.replace));
  if(blocked.length)throw new Error(`Nothing installed. ${blocked.join(' ')}`);
  const undo:Undo=[], results=[];
  let dir:string|undefined;
  try {
    for(const row of rows) {
      const {name,saved}=row, agentsPath=row.agents.path, claudePath=row.claude.path, state=row.agents.state;
      let action='unchanged', origin=saved?.origin??'adopted', backup=saved?.backup??null;
      const made:string[]=[];
      if(state==='current') {if(!saved)action='adopted';}
      else {
        if(state==='absent'){action='installed';origin=saved&&saved.origin!=='adopted'?saved.origin:'created';}
        else {
          const destination=join(dir??=await reserve(ctx),name,'agents');
          undo.push(back(agentsPath,destination));await move(agentsPath,destination);made.push(relative(ctx.root,destination));
          // A copy the harness never wrote (no receipt, or adopted) is the user's; uninstall restores it.
          if(!backup&&(!saved||saved.origin==='adopted'))backup=relative(ctx.root,destination);
          action=origin=state==='stale'?'updated':'replaced';
        }
        await mkdir(ctx.agents,{recursive:true});
        const stage=join(ctx.agents,`.${name}.stage-${stamp()}`);
        undo.push(()=>rm(stage,{recursive:true,force:true}));
        await cp(join(ctx.source,name),stage,{recursive:true,verbatimSymlinks:true,filter:path=>basename(path)!=='.DS_Store'});
        await io.rename(stage,agentsPath);undo.push(()=>rm(agentsPath,{recursive:true,force:true}));
      }
      let created=saved?.claudeLink.created??false, claudeBackup=saved?.claudeLink.backup??null;
      if(row.claude.state!=='linked') {
        if(row.claude.state==='other') {
          const destination=join(dir??=await reserve(ctx),name,'claude');
          undo.push(back(claudePath,destination));await move(claudePath,destination);made.push(relative(ctx.root,destination));
          claudeBackup??=relative(ctx.root,destination);
        }
        await mkdir(ctx.claude,{recursive:true});
        await symlink(linkTarget(ctx,name),claudePath);undo.push(()=>rm(claudePath,{force:true}));
        created=true;
        if(action==='unchanged')action='linked';
      }
      if(action!=='unchanged'||saved?.sourceDigest!==row.sourceDigest) {
        const value:Receipt={name,scope:ctx.scope,scopeId:ctx.scopeId,agentsPath,claudePath,sourceDigest:row.sourceDigest,files:row.files,origin,backup,claudeLink:{created,backup:claudeBackup},installedAt:new Date().toISOString(),verification:'files installed; fresh-session behavior not yet verified'};
        const path=receiptPath(ctx,name);
        undo.push(()=>saved?saveJSON(path,saved):rm(path,{force:true}));
        await saveJSON(path,value);
      }
      results.push({name,action,agentsPath,claudePath,backups:made,configurationVerified:(await check(agentsPath,claudePath,row.files)).configurationVerified,behaviorVerified:false});
    }
    return results;
  } catch(error) {return rollback(error,undo);}
}
async function receiptNames(ctx:Context,names:string[]) {
  if(names.length)return checked(names);
  return checked(((await readdir(ctx.receipts).catch(missing))??[]).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).sort());
}
export async function skillsVerify(root:string,names:string[]=[],options:Options={}) {
  const ctx=await context(root,options);
  return Promise.all((await receiptNames(ctx,names)).map(async name=>{
    const saved=await receipt(ctx,name);if(!saved)throw new Error(`No receipt for skill ${name} in ${ctx.receipts}.`);
    const source=ctx.valid.includes(name)?await installedFiles(join(ctx.source,name)):null;
    const isForeign=foreign(ctx,name,saved), {filesMatch,linkValid,configurationVerified}=await check(join(ctx.agents,name),join(ctx.claude,name),saved.files);
    return {name,scope:ctx.scope,foreign:isForeign,filesMatch,linkValid,sourceCurrent:!!source&&digest(source)===saved.sourceDigest,configurationVerified:!isForeign&&configurationVerified,behaviorVerified:false};
  }));
}
export async function skillsUninstall(root:string,names:string[],options:Options={}) {
  const ctx=await context(root,options);
  if(!names.length)throw new Error('Name at least one skill to uninstall.');
  const rows:{saved:Receipt;ownsLink:boolean}[]=[], problems:string[]=[];
  for(const name of checked(names)) {
    const saved=await receipt(ctx,name), agentsPath=join(ctx.agents,name);
    if(!saved){problems.push(`${name}: no receipt in ${ctx.receipts}.`);continue;}
    if(foreign(ctx,name,saved)){problems.push(foreignNote(ctx,name,saved));continue;}
    // Adopted files are left in place, so their contents do not matter here.
    if(saved.origin!=='adopted') {
      const files=await installedFiles(agentsPath);
      if(!files||digest(files)!==digest(saved.files))problems.push(`${name}: ${agentsPath} ${files?'differs from':'is missing; it does not match'} its receipt. Compare it with the source before uninstall.`);
    }
    for(const backup of [saved.backup,saved.claudeLink.backup])if(backup&&!(await exists(stored(ctx,backup))))problems.push(`${name}: backup ${backup} is missing.`);
    rows.push({saved,ownsLink:saved.claudeLink.created&&await linked(join(ctx.claude,name),agentsPath)});
  }
  if(problems.length)throw new Error(`Nothing uninstalled. ${problems.join(' ')}`);
  const dir=await reserve(ctx), id=basename(dir), removed=join(dir,'removed'), undo:Undo=[], results=[];
  try {
    for(const {saved,ownsLink} of rows) {
      const {name}=saved, agentsPath=join(ctx.agents,name), claudePath=join(ctx.claude,name), adopted=saved.origin==='adopted', backups:string[]=[];
      const stash=async(from:string,to:string)=>{undo.push(back(from,to));await move(from,to);backups.push(relative(ctx.root,to));};
      const restore=async(backup:string,to:string)=>{const from=stored(ctx,backup);undo.push(back(from,to));await move(from,to);};
      if(!adopted) {
        await stash(agentsPath,join(removed,name));
        if(saved.backup)await restore(saved.backup,agentsPath);
      }
      // The Claude entry is handled apart from the files: an adopted copy can still have a harness link or a backed-up folder.
      if(ownsLink)await stash(claudePath,join(removed,name+'.claude-link'));
      const claudeBackup=saved.claudeLink.backup;
      if(claudeBackup){if(await exists(claudePath))backups.push(claudeBackup);else await restore(claudeBackup,claudePath);}
      const from=receiptPath(ctx,name), to=join(ctx.receipts,'retired',`${name}.${id}.json`);
      undo.push(back(from,to));await move(from,to);
      results.push({name,action:adopted?'released':'uninstalled',agentsPath,claudePath,removedTo:adopted?null:relative(ctx.root,join(removed,name)),restoredBackup:!adopted&&!!saved.backup,backups,behaviorVerified:false});
    }
    return results;
  } catch(error) {return rollback(error,undo);}
}
