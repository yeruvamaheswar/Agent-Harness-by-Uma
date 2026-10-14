import { join, resolve } from 'node:path';
import { readFile, lstat, stat, readlink, realpath, unlink, rmdir, chmod } from 'node:fs/promises';
import { atomic, current, readRelease, render, hash } from './core.ts';
import { markers, section } from './install.ts';

// Repo scope: cloud agents see only a clone, so the policy block lives in the project's own AGENTS.md and CLAUDE.md.
// Those files are shared with the user and other installers. Every operation here is scoped to the Harness block.
// One instruction file: when CLAUDE.md is missing or imports AGENTS.md, the block goes to AGENTS.md only. DesignOS (scripts/design_os.py) follows the same convention.
const TARGETS=['AGENTS.md','CLAUDE.md'] as const, DIR='.agentic-harness', MANIFEST=`${DIR}/manifest.json`, POLICY=`${DIR}/policy.md`, MARK=markers('instructions');
type Target=typeof TARGETS[number];
// The stub is a shared convention file, not an owned one: it is never listed in manifest.files.
const IMPORT='@AGENTS.md', STUB=IMPORT+'\n';
// Same line breaks and whitespace as Python splitlines() and strip(), so both installers decide alike. A byte-order mark is not whitespace here.
const SPACE='\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000', EDGES=new RegExp(`^[${SPACE}]+|[${SPACE}]+$`,'g');
export const importsAgents=(text:string)=>text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).some(line=>line.replace(EDGES,'')===IMPORT);
// Pointer mode: the block is a short pointer and the full policy lives in POLICY, owned through manifest.policy. A manifest without mode is full.
// before/after are the exact separator bytes the install added around the block, so uninstall can restore the original bytes.
export type RepoManifest={schemaVersion:1;release:{version:string;digest:string};installedAt:string;files:{path:Target;blockHash:string;created:boolean;before:string;after:string}[];aliases:{path:Target;target:Target}[];claudeViaImport?:boolean;mode?:'full'|'pointer';policy?:{path:string;hash:string}};
type Change={path:string;before:string|null;after:string|null};
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const isTarget=(p:unknown):p is Target=>TARGETS.includes(p as Target);

async function repoRoot(repo:string) {
  const dir=await realpath(resolve(repo)).catch(e=>{if(missing(e))throw new Error(`Not an existing directory: ${repo}`);throw e;});
  if(!(await stat(dir)).isDirectory())throw new Error(`Not an existing directory: ${repo}`);
  return dir;
}
async function read(dir:string,path:string):Promise<string|null> {
  let raw:Buffer;
  try{raw=await readFile(join(dir,path));}catch(e){if(missing(e))return null;throw e;}
  const text=raw.toString('utf8');
  if(!Buffer.from(text).equals(raw))throw new Error(`${path} is not valid UTF-8. Refusing to rewrite it. Nothing was changed.`);
  return text;
}
function block(text:string,path:string):[number,number]|null {
  if(!text.includes(MARK[0])&&!text.includes(MARK[1]))return null;
  try{return section(text,MARK);}catch{throw new Error(`${path}: malformed or duplicate Harness markers. Resolve them by hand. Nothing was changed.`);}
}
async function layout(repo:string) {
  const dir=await repoRoot(repo);
  const kind=await Promise.all([...TARGETS,DIR].map(t=>lstat(join(dir,t)).then(s=>s.isSymbolicLink()?'link':s.isFile()?'file':s.isDirectory()?'dir':'other',e=>{if(missing(e))return 'none';throw e;})));
  if(!['none','dir'].includes(kind[2]))throw new Error(`${DIR} is not a regular folder. Nothing was changed.`);
  const odd=TARGETS.find((_,i)=>!['none','file','link'].includes(kind[i]));
  if(odd)throw new Error(`${odd} is not a regular file. Nothing was changed.`);
  const links=TARGETS.filter((_,i)=>kind[i]==='link');
  if(links.length===2)throw new Error('AGENTS.md and CLAUDE.md are both symlinks. Refusing to write through them. Nothing was changed.');
  const aliases:RepoManifest['aliases']=[];
  for(const path of links){
    const target=TARGETS.find(t=>t!==path)!,link=join(dir,path);
    const to=await realpath(link).catch(async e=>{if(missing(e))return resolve(dir,await readlink(link));throw e;});
    if(to!==join(dir,target))throw new Error(`${path} is a symlink that does not point at ${target} in this folder. Refusing to write through it. Nothing was changed.`);
    aliases.push({path,target});
  }
  return {dir,files:TARGETS.filter(t=>!links.includes(t)),aliases};
}
// The manifest comes from a clone, so treat it as untrusted: only the two target names are valid paths.
function parseManifest(text:string|null):RepoManifest|null {
  if(text===null)return null;
  const m=JSON.parse(text) as RepoManifest, str=(v:unknown)=>typeof v==='string';
  if(m?.schemaVersion!==1||!str(m.release?.version)||!str(m.release?.digest)||!Array.isArray(m.files)||!Array.isArray(m.aliases)
    ||m.files.some(f=>!isTarget(f?.path)||!str(f.blockHash)||typeof f.created!=='boolean'||!str(f.before)||!str(f.after))
    ||m.aliases.some(a=>!isTarget(a?.path)||!isTarget(a.target))
    ||![undefined,true,false].includes(m.claudeViaImport)||(m.claudeViaImport&&(m.files.map(f=>f.path).join()!=='AGENTS.md'||m.aliases.length>0))
    ||![undefined,'full','pointer'].includes(m.mode)||(m.mode==='pointer'?m.policy?.path!==POLICY||!str(m.policy.hash):m.policy!==undefined))throw new Error(`Unrecognized ${MANIFEST}. Nothing was changed.`);
  return m;
}
function owned(text:string|null,f:RepoManifest['files'][number]):[number,number] {
  const s=text===null?null:block(text,f.path);
  if(!s||hash(text!.slice(...s))!==f.blockHash)throw new Error(`${f.path}: the Harness block was edited or removed after the install. Restore the block, or delete ${MANIFEST} and run repo install with --adopt. Nothing was changed.`);
  return s;
}
// Returns the text of the owned policy file, or null when the manifest owns none. claim: the caller will write the file, so an unowned one is a collision.
async function ownedPolicy(dir:string,m:RepoManifest|null,claim:boolean):Promise<string|null> {
  const regular=await lstat(join(dir,POLICY)).then(s=>s.isFile(),e=>{if(missing(e))return null;throw e;});
  if(!m?.policy){
    if(claim&&regular!==null)throw new Error(`${POLICY} exists and this command did not install it. Move it away, then run repo install again. Nothing was changed.`);
    return null;
  }
  const text=regular?await read(dir,POLICY):null;
  if(text===null||hash(text)!==m.policy.hash)throw new Error(`${POLICY} was edited or removed after the install. Restore it, or delete it and ${MANIFEST} and run repo install with --adopt. Nothing was changed.`);
  return text;
}
// Removes an owned block and the separator bytes the install recorded around it.
function without(text:string,f:RepoManifest['files'][number]) {
  let [a,b]=owned(text,f);
  if(text.endsWith(f.before,a))a-=f.before.length;
  if(text.startsWith(f.after,b))b+=f.after.length;
  // Text the user added after the block must not be glued to the line before it.
  const head=text.slice(0,a),tail=text.slice(b);
  return head+(head&&tail&&!head.endsWith('\n')&&!tail.startsWith('\n')?'\n':'')+tail;
}
// With claudeViaImport the manifest lists AGENTS.md only, and CLAUDE.md must still be a regular file or missing.
function sameLayout(m:RepoManifest,files:readonly string[]) {
  if((m.claudeViaImport?TARGETS:m.files.map(f=>f.path)).join()!==files.join())throw new Error(`The AGENTS.md and CLAUDE.md layout changed after the install. Restore it, or delete ${MANIFEST} and run repo install with --adopt. Nothing was changed.`);
}
// Callers finish every check before they call this. Copies of existing files go to the Harness root first; a failed write restores the files already written.
async function commit(root:string,dir:string,changes:Change[]) {
  const backup=join('.state','backups','repo',new Date().toISOString().replace(/[:.]/g,'-'));
  for(const c of changes)if(c.before!==null)await atomic(join(root,backup,c.path),c.before);
  const put=async(path:string,text:string|null)=>{
    const file=join(dir,path);
    if(text===null)return unlink(file);
    const mode=await stat(file).then(s=>s.mode&0o777,e=>{if(missing(e))return undefined;throw e;});
    await atomic(file,text);
    if(mode!==undefined)await chmod(file,mode);
  };
  const done:Change[]=[];
  try{for(const c of changes){await put(c.path,c.after);done.push(c);}}
  catch(e){for(const c of done.reverse())await put(c.path,c.before);throw e;}
  return backup;
}
export async function repoInstall(root:string,repo:string,options:{version?:string;adopt?:boolean;dryRun?:boolean;pointer?:boolean}={}) {
  const r=options.version?await readRelease(root,options.version):await current(root);
  const {dir,files,aliases}=await layout(repo), manifestText=await read(dir,MANIFEST), old=parseManifest(manifestText);
  if(old)sameLayout(old,files);
  const oldPolicy=await ownedPolicy(dir,old,!!options.pointer), full=render(r)['codex/AGENTS.md'].trim(), policy=full+'\n';
  const body=options.pointer?`${full.split('\n').slice(0,2).join('\n')}\nThis project uses the Agentic Harness engineering policy. If that policy is not already in your instructions, read \`${POLICY}\` now and follow it in every task.`:full;
  const text=`${MARK[0]}\n${body}\n${MARK[1]}`;
  const claude=files.length===2?await read(dir,'CLAUDE.md'):null, viaImport=files.length===2&&(claude===null||importsAgents(claude));
  const manifest:RepoManifest={schemaVersion:1,release:{version:r.version,digest:r.digest},installedAt:new Date().toISOString(),files:[],aliases,...(viaImport?{claudeViaImport:true}:{}),...(options.pointer?{mode:'pointer' as const,policy:{path:POLICY,hash:hash(policy)}}:{})};
  const changes:Change[]=[], writes:{path:string;action:string}[]=[];
  for(const path of files){
    const before=await read(dir,path), prior=old?.files.find(f=>f.path===path), base=before??'';
    if(viaImport&&path==='CLAUDE.md'){
      // An owned block here comes from an earlier two-file install: remove it. A missing owned block is drift, as before.
      if(prior){changes.push({path,before,after:without(base,prior)});writes.push({path,action:'remove owned block'});}
      else if(before===null){changes.push({path,before,after:STUB});writes.push({path,action:'create import stub'});}
      else if(block(before,path))throw new Error(`${path} imports AGENTS.md and holds a Harness block that this command did not install. Remove that block by hand, then run repo install again. Nothing was changed.`);
      continue;
    }
    const at=prior?owned(before,prior):before===null?null:block(before,path);
    if(at&&!prior&&!options.adopt)throw new Error(`${path} holds a Harness block that this command did not install. Run repo install with --adopt to replace and own it. Nothing was changed.`);
    const sep=at?['','']:[base?(base.endsWith('\n')?'\n':'\n\n'):'','\n'];
    manifest.files.push({path,blockHash:hash(text),created:prior?prior.created:before===null,before:prior?prior.before:sep[0],after:prior?prior.after:sep[1]});
    changes.push({path,before,after:at?base.slice(0,at[0])+text+base.slice(at[1]):base+sep[0]+text+sep[1]});
    writes.push({path,action:prior?'replace owned block':at?'adopt and replace block':before===null?'create file':'append block'});
  }
  const deletes:string[]=[];
  if(options.pointer){changes.push({path:POLICY,before:oldPolicy,after:policy});writes.push({path:POLICY,action:oldPolicy===null?'create policy file':'replace policy file'});}
  else if(oldPolicy!==null){changes.push({path:POLICY,before:oldPolicy,after:null});deletes.push(POLICY);}
  changes.push({path:MANIFEST,before:manifestText,after:JSON.stringify(manifest,null,2)+'\n'});
  writes.push({path:MANIFEST,action:old?'update receipt':'create receipt'});
  const plan={release:manifest.release,mode:options.pointer?'pointer':'full',writes,deletes,aliases};
  if(options.dryRun)return {dryRun:true,...plan};
  return {dryRun:false,...plan,backup:await commit(root,dir,changes),verification:'files installed; fresh-session behavior not yet verified'};
}
// Reads only the manifest and the target files, so it works in a clone with no releases/ folder.
export async function repoVerify(repo:string) {
  const dir=await repoRoot(repo), m=parseManifest(await read(dir,MANIFEST));
  if(!m)throw new Error(`No Harness repo install found: ${MANIFEST} is missing.`);
  const files=await Promise.all(m.files.map(async f=>{
    try{
      if((await lstat(join(dir,f.path))).isSymbolicLink())return {path:f.path,matches:false};
      const s=(await read(dir,f.path))!, at=block(s,f.path);
      return {path:f.path,matches:!!at&&hash(s.slice(...at))===f.blockHash};
    }catch{return {path:f.path,matches:false};}
  }));
  const aliases=await Promise.all(m.aliases.map(async a=>({...a,matches:await realpath(join(dir,a.path)).then(p=>p===join(dir,a.target),()=>false)})));
  // A missing CLAUDE.md passes: Claude Code then reads AGENTS.md directly.
  const imported=m.claudeViaImport?await lstat(join(dir,'CLAUDE.md')).then(async s=>s.isFile()&&importsAgents((await read(dir,'CLAUDE.md'))??IMPORT)).catch(missing):true;
  const single=m.claudeViaImport?{claudeViaImport:true,claudeImport:{path:'CLAUDE.md',matches:imported,...(imported?{}:{problem:`CLAUDE.md is not a regular file with the line ${IMPORT}, so Claude Code no longer receives the Harness block. Add the line, or run repo install again to put the block in CLAUDE.md.`})}}:{};
  const owner=m.policy, policy=owner?[{path:owner.path,matches:await lstat(join(dir,POLICY)).then(async s=>s.isFile()&&hash((await read(dir,POLICY))??'')===owner.hash,()=>false)}]:[];
  return {release:m.release,installedAt:m.installedAt,files,aliases,...single,...(owner?{mode:'pointer',policy:policy[0]}:{}),configurationVerified:files.length>0&&imported&&[...files,...aliases,...policy].every(f=>f.matches),behaviorVerified:false};
}
export async function repoUninstall(root:string,repo:string,options:{dryRun?:boolean}={}) {
  const {dir,files}=await layout(repo), manifestText=await read(dir,MANIFEST), m=parseManifest(manifestText);
  if(!m)throw new Error(`No Harness repo install found: ${MANIFEST} is missing. Nothing was changed.`);
  sameLayout(m,files);
  const changes:Change[]=[];
  for(const f of m.files){
    const text=(await read(dir,f.path))??'', rest=without(text,f);
    changes.push({path:f.path,before:text,after:f.created&&!rest.trim()?null:rest});
  }
  // The stub is shared, not owned: delete it only when it is untouched and no AGENTS.md is left to import.
  if(m.claudeViaImport&&changes[0].after===null&&await readFile(join(dir,'CLAUDE.md')).then(b=>b.equals(Buffer.from(STUB)),e=>{if(missing(e))return false;throw e;}))changes.push({path:'CLAUDE.md',before:STUB,after:null});
  const policy=await ownedPolicy(dir,m,false);
  if(policy!==null)changes.push({path:POLICY,before:policy,after:null});
  changes.push({path:MANIFEST,before:manifestText,after:null});
  const plan={release:m.release,writes:changes.filter(c=>c.after!==null).map(c=>({path:c.path,action:'remove owned block'})),deletes:changes.filter(c=>c.after===null).map(c=>c.path)};
  if(options.dryRun)return {dryRun:true,...plan};
  const backup=await commit(root,dir,changes);
  await rmdir(join(dir,DIR)).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOTEMPTY')throw e;});
  return {dryRun:false,...plan,backup};
}
