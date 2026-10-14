import { homedir } from 'node:os';
import { join, dirname, basename, isAbsolute, delimiter } from 'node:path';
import { readFile, mkdir, lstat, unlink, readdir, access, realpath } from 'node:fs/promises';
import { atomic, saveJSON, json, current, readRelease, render, hash, inside } from './core.ts';
import { CODE_ROOT } from './env.ts';

const MARKERS={instructions:['<!-- BEGIN AGENTIC HARNESS -->','<!-- END AGENTIC HARNESS -->'],'codex-mcp':['# BEGIN AGENTIC HARNESS MCP','# END AGENTIC HARNESS MCP']} as const;
const MCP_KEY='agentic_harness';
// Installs before the User Rules decision wrote the policy to ~/.cursor/rules/ under this name. Cursor then loaded the policy twice: from this file and from User Rules.
const RETIRED_RULE='pragmatic-engineer.mdc';
// process.execPath resolves symlinks, so a versioned Homebrew path breaks on upgrade; prefer a PATH entry that points at the running binary.
export async function nodeCommand(path=process.env.PATH??'',exec=process.execPath):Promise<string> {
  const real=await realpath(exec).catch(()=>exec);
  for(const dir of path.split(delimiter).filter(Boolean)){const candidate=join(dir,'node');if(await realpath(candidate).then(r=>r===real,()=>false))return candidate;}
  return exec;
}
// Pack markers must never contain a base marker as a substring.
export const packMarkers=(id:string)=>[`<!-- BEGIN AGENTIC HARNESS PACK ${id} -->`,`<!-- END AGENTIC HARNESS PACK ${id} -->`] as const;
// Pack IDs allow only lowercase letters, digits, single hyphens, and one slash, so this name maps back to exactly one ID.
export const PACK_FILE=/^agentic-harness-pack-([a-z0-9-]+)__([a-z0-9-]+)\.mdc$/;
export const packFile=(id:string)=>`agentic-harness-pack-${id.replace('/','__')}.mdc`;
// Base installs name Cursor "cursor-files"; pack manifests and receipts name it "cursor".
export const packPlatform=(platform:string)=>platform==='cursor-files'?'cursor':platform;
export type Receipt={platform:string;version:string;files:{path:string;hash:string;backup:string;existed:boolean;scope?:'instructions'|'codex-mcp'|'cursor-mcp';ownedHash?:string}[];installedAt:string;verification:string};
// retired: the earlier Cursor rule file was removed and a copy saved. warnings: something the user must fix by hand. Neither is stored in the receipt.
export type InstallResult=Receipt&{retired?:{path:string;backup:string};warnings?:string[]};
// scope 'file' means the pack owns the whole file (Cursor); otherwise it owns one marker section.
export type PackReceipt={platform:string;pack:{id:string;version:string;digest:string};bytes:number;files:{path:string;ownedHash:string;backup:string;scope?:'file'}[];installedAt:string;verification:string};
export const packReceiptDir=(root:string,platform:string)=>join(root,'.state','installations','packs',platform);
export async function packReceipts(root:string,platform:string):Promise<PackReceipt[]> {
  const names=await readdir(packReceiptDir(root,platform)).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;});
  const receipts=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>json<PackReceipt>(join(packReceiptDir(root,platform),n))));
  return receipts.sort((a,b)=>a.installedAt.localeCompare(b.installedAt));
}
export function markers(scope:'instructions'|'codex-mcp') {
  return MARKERS[scope];
}
export function section(text:string,[begin,end]:readonly [string,string]):[number,number] {
  const a=text.indexOf(begin),b=text.indexOf(end);
  if(a<0||b<a||text.indexOf(begin,a+1)>=0||text.indexOf(end,b+1)>=0)throw new Error('Missing, malformed, or duplicate managed markers.');
  return [a,b+end.length];
}
function owned(text:string,scope:Receipt['files'][number]['scope']) {
  if(scope==='cursor-mcp'){const servers=JSON.parse(text).mcpServers;return JSON.stringify(servers?.[MCP_KEY]);}
  if(!scope)return text;
  return text.slice(...section(text,markers(scope)));
}
export function managed(existing:string, body:string) {
  const [BEGIN,END]=markers('instructions'), start=existing.indexOf(BEGIN), end=existing.indexOf(END);
  if ((start<0)!==(end<0) || (start>=0 && (end<start || existing.indexOf(BEGIN,start+1)>=0 || existing.indexOf(END,end+1)>=0))) throw new Error('Malformed or duplicate managed markers; resolve manually.');
  const block=`${MARKERS.instructions[0]}\n${body.trim()}\n${MARKERS.instructions[1]}`;
  return start<0 ? existing+(existing&&!existing.endsWith('\n')?'\n':'')+'\n'+block+'\n' : existing.slice(0,start)+block+existing.slice(end+END.length);
}
export const claudeHome=(home:string)=>home===homedir()?process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'):join(home,'.claude');
export const codexHome=(home:string)=>home===homedir()?process.env.CODEX_HOME||join(home,'.codex'):join(home,'.codex');
export async function safeRead(path:string):Promise<{text:string;existed:boolean}> {
  try {if((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${path}`);return {text:await readFile(path,'utf8'),existed:true};}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {text:'',existed:false};throw e;}
}
const exists=(path:string)=>access(path).then(()=>true,e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;});
// Receipts store backups relative to the harness root. Older receipts stored absolute paths, which break when the harness folder moves.
export async function backupFile(root:string,backup:string) {
  if(!isAbsolute(backup))return inside(root,backup);
  if(await exists(backup))return backup;
  const at=backup.lastIndexOf('/.state/backups/'), moved=at<0?undefined:inside(root,backup.slice(at+1));
  if(moved&&await exists(moved))return moved;
  throw new Error(`Backup not found: ${backup}${moved?` (also checked ${moved})`:''}. Nothing was restored.`);
}
const previousReceipt=(root:string,platform:string)=>json<Receipt>(join(root,'.state','installations',platform+'.json')).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
// Only a rule file that the previous receipt lists is considered. text is set only while the file is a regular file that still matches that receipt.
async function retiredRule(root:string):Promise<{path:string;text?:string}|undefined> {
  const listed=(await previousReceipt(root,'cursor-files'))?.files.find(f=>basename(f.path)===RETIRED_RULE);
  if(!listed)return;
  const found=await lstat(listed.path).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
  if(!found)return;
  const text=found.isFile()?await readFile(listed.path,'utf8'):undefined;
  return {path:listed.path,text:text!==undefined&&hash(text)===listed.hash?text:undefined};
}
export async function install(root:string,platform:string, home=homedir(), selected?:string):Promise<InstallResult> {
  if(!['codex','claude','cursor-files','generic'].includes(platform))throw new Error('Supported installers: codex, claude, cursor-files, generic. Grok Bot requires profile setup; see docs/platforms.md.');
  const r=selected?await readRelease(root,selected):await current(root), output=render(r);
  const files:{path:string;text:string}[]=[];
  if(platform==='codex') {
    const path=join(codexHome(home),'AGENTS.md');
    files.push({path,text:managed((await safeRead(path)).text,output['codex/AGENTS.md'])});
    const config=join(codexHome(home),'config.toml');
    const previous=await safeRead(config);
    const [begin,end]=markers('codex-mcp');
    const block=`${MARKERS['codex-mcp'][0]}\n[mcp_servers.${MCP_KEY}]\ncommand = ${JSON.stringify(await nodeCommand())}\nargs = ["--experimental-strip-types", ${JSON.stringify(join(CODE_ROOT,'src/mcp.ts'))}, "--root", ${JSON.stringify(root)}]\n${MARKERS['codex-mcp'][1]}`;
    let next=previous.text;
    if(next.includes(begin)){
      const a=next.indexOf(begin),b=next.indexOf(end,a);
      if(b<0)throw new Error('Malformed harness MCP configuration.');
      next=next.slice(0,a)+block+next.slice(b+end.length);
    } else {
      if(new RegExp(`\\[mcp_servers\\.(?:"?${MCP_KEY}"?)\\]`).test(next))throw new Error('Existing harness MCP entry is unmanaged. Reconcile before installing.');
      next+='\n'+block+'\n';
    }
    files.push({path:config,text:next});
  } else if(platform==='claude') {
    const path=join(claudeHome(home),'CLAUDE.md');
    files.push({path,text:managed((await safeRead(path)).text,output['claude/CLAUDE.md'])});
  } else if(platform==='cursor-files') {
    // Cursor keeps the policy in User Rules only, which no tool can write (see manual-steps.ts). This installer registers the MCP server.
    const mcpPath=join(home,'.cursor','mcp.json');
    const original=await safeRead(mcpPath);
    const config=original.text?JSON.parse(original.text):{};
    const command={command:await nodeCommand(),args:['--experimental-strip-types',join(CODE_ROOT,'src/mcp.ts'),'--root',root]};
    const old=config.mcpServers?.[MCP_KEY];
    if(old && ![CODE_ROOT,root].some(d=>JSON.stringify(old).includes(join(d,'src/mcp.ts'))))throw new Error('Existing harness MCP configuration points elsewhere.');
    const servers={...config.mcpServers};
    config.mcpServers={...servers,[MCP_KEY]:command};
    files.push({path:mcpPath,text:JSON.stringify(config,null,2)+'\n'});
  } else {
    // Keep writing to the path of an existing installation so an upgrade never leaves an orphaned copy.
    const previous=await previousReceipt(root,'generic');
    files.push({path:previous?.files[0]?.path??join(home,'.config','agentic-harness','instructions.md'),text:output['generic/instructions.md']});
  }
  const id=new Date().toISOString().replace(/[:.]/g,'-');
  const receipt:Receipt={platform,version:r.version,files:[],installedAt:id,verification:platform==='cursor-files'?'MCP entry installed; the policy is a manual step in Cursor User Rules (status lists it under manualSteps); fresh-session behavior not yet verified':'files installed; fresh-session behavior not yet verified'};
  const rule=platform==='cursor-files'?await retiredRule(root):undefined, ruleBackup=join('.state','backups',platform,id,RETIRED_RULE);
  // Back up every target before making the first change.
  for(const [i,file] of files.entries()){
    const old=await safeRead(file.path),backup=join('.state','backups',platform,id,`${i}.txt`);
    await atomic(join(root,backup),old.text);
    const scope=platform==='codex'?(i===0?'instructions':'codex-mcp'):platform==='claude'?'instructions':platform==='cursor-files'?'cursor-mcp':undefined;
    receipt.files.push({path:file.path,hash:hash(file.text),backup,existed:old.existed,scope,ownedHash:hash(owned(file.text,scope))});
  }
  if(rule?.text!==undefined)await atomic(join(root,ruleBackup),rule.text);
  const written:number[]=[];let removed=false;
  try {
    for(const [i,f] of files.entries()){await mkdir(dirname(f.path),{recursive:true});await atomic(f.path,f.text);written.push(i);}
    if(rule?.text!==undefined){await unlink(rule.path);removed=true;}
    await saveJSON(join(root,'.state','installations',platform+'.json'),receipt);
  } catch(e) {
    if(removed)await atomic(rule!.path,rule!.text!);
    for(const i of written.reverse()){const f=receipt.files[i];if(f.existed)await atomic(f.path,await readFile(join(root,f.backup),'utf8'));else await unlink(f.path);}
    throw e;
  }
  if(!rule)return receipt;
  return rule.text!==undefined?{...receipt,retired:{path:rule.path,backup:ruleBackup}}
    :{...receipt,warnings:[`${rule.path} changed after the harness installed it, so it was left in place. Cursor now loads the policy twice: from this file and from User Rules. Remove the file by hand.`]};
}
export async function verifyInstall(root:string,platform:string) {
  const r=await json<Receipt>(join(root,'.state','installations',platform+'.json'));
  const files=await Promise.all(r.files.map(async f=>{
    try{const s=await readFile(f.path,'utf8');return {path:f.path,matches:hash(owned(s,f.scope))===(f.ownedHash??f.hash),wholeFileUnchanged:hash(s)===f.hash};}
    catch{return {path:f.path,matches:false,wholeFileUnchanged:false};}
  }));
  let overrides:string[]=[];
  if(platform==='codex') {
    const p=join(dirname(r.files[0].path),'AGENTS.override.md');
    if((await safeRead(p)).existed)overrides.push(p);
  }
  return {platform,version:r.version,files,overrides,configurationVerified:files.every(f=>f.matches)&&overrides.length===0,behaviorVerified:false,note:r.verification,packs:await verifyPacks(root,packPlatform(platform))};
}
export async function verifyPacks(root:string,platform:string) {
  return Promise.all((await packReceipts(root,platform)).map(async p=>{
    const f=p.files[0];let matches=false;
    try{const s=await readFile(f.path,'utf8');matches=hash(f.scope==='file'?s:s.slice(...section(s,packMarkers(p.pack.id))))===f.ownedHash;}catch{}
    return {...p.pack,path:f.path,configurationVerified:matches,behaviorVerified:false};
  }));
}
export async function uninstall(root:string,platform:string) {
  const packs=await packReceipts(root,packPlatform(platform));
  if(packs.length)throw new Error(`Remove packs first: ${packs.map(p=>`pack remove ${p.pack.id} --platform ${packPlatform(platform)}`).join('; ')}`);
  const r=await json<Receipt>(join(root,'.state','installations',platform+'.json'));
  for(const f of r.files) if(hash(await readFile(f.path,'utf8'))!==f.hash)throw new Error('Installed file changed since installation. Refusing to overwrite newer user changes.');
  // Read every backup before the first write, so a missing backup leaves all targets untouched.
  const backups=await Promise.all(r.files.map(async f=>f.existed?readFile(await backupFile(root,f.backup),'utf8'):undefined));
  for(const [i,f] of r.files.entries()){const text=backups[i];if(text!==undefined)await atomic(f.path,text);else await unlink(f.path);}
  await unlink(join(root,'.state','installations',platform+'.json'));
  return {restored:true,platform};
}
