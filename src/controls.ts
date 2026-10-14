import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { atomic, saveJSON, json, hash } from './core.ts';
import { CODE_ROOT } from './env.ts';
import { claudeHome, safeRead, backupFile } from './install.ts';

// Controls are enforced by the platform, not by the model. The source is controls/controls.json in the engine folder.
export type Effect='deny'|'ask';
export type Control={id:string;why:string;effect:Effect;claude:string[]};
export type ControlsFile={schemaVersion:1;controls:Control[]};
// owned lists only the entries this install added, so an entry the user already had survives uninstall.
export type ControlsReceipt={platform:'claude';path:string;sourceHash:string;owned:Record<Effect,string[]>;hash:string;backup:string;existed:boolean;installedAt:string;verification:string};
const EFFECTS:Effect[]=['deny','ask'];
const receiptPath=(root:string)=>join(root,'.state','installations','controls-claude.json');
const supported=(platform:string)=>{if(platform!=='claude')throw new Error('Supported controls platforms: claude. Controls for Codex and Cursor are not built yet.');};

export async function loadControls(file=join(CODE_ROOT,'controls','controls.json')) {
  const text=await readFile(file,'utf8'), c=JSON.parse(text) as ControlsFile;
  if(c.schemaVersion!==1||!Array.isArray(c.controls))throw new Error('controls.json: unsupported schema.');
  const ids=new Set<string>();
  for(const x of c.controls){
    if(!x.id||ids.has(x.id))throw new Error(`controls.json: missing or duplicate id ${x.id}.`);
    if(!EFFECTS.includes(x.effect))throw new Error(`controls.json: ${x.id} effect must be deny or ask.`);
    if(!Array.isArray(x.claude)||x.claude.some(r=>typeof r!=='string'||!r))throw new Error(`controls.json: ${x.id} claude rules must be strings.`);
    ids.add(x.id);
  }
  return {controls:c.controls,sourceHash:hash(text)};
}
export function claudeRules(controls:Control[],root:string,code=CODE_ROOT):Record<Effect,string[]> {
  const out:Record<Effect,string[]>={deny:[],ask:[]};
  for(const c of controls)for(const r of c.claude){const rule=r.replaceAll('{HARNESS_ROOT}',root).replaceAll('{CODE_ROOT}',code);if(!out[c.effect].includes(rule))out[c.effect].push(rule);}
  return out;
}
function parse(text:string,path:string) {
  if(!text.trim())return {};
  try{const v=JSON.parse(text);if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}
  catch{throw new Error(`${path} is not a JSON object. Nothing was written.`);}
}
function strip(settings:any,owned:Record<Effect,string[]>) {
  for(const e of EFFECTS){
    const list=settings.permissions?.[e];if(!Array.isArray(list))continue;
    settings.permissions[e]=list.filter((r:string)=>!owned[e].includes(r));
    if(!settings.permissions[e].length)delete settings.permissions[e];
  }
  if(settings.permissions&&!Object.keys(settings.permissions).length)delete settings.permissions;
  return settings;
}
const previous=(root:string)=>json<ControlsReceipt>(receiptPath(root)).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});

export async function controlsInstall(root:string,platform:string,home=homedir(),source?:string) {
  supported(platform);
  const {controls,sourceHash}=await loadControls(source), wanted=claudeRules(controls,root), path=join(claudeHome(home),'settings.json');
  const old=await previous(root), current=await safeRead(path), settings=parse(current.text,path);
  // A reinstall first drops the entries the last install added, so a rule removed from controls.json leaves the file.
  if(old)strip(settings,old.owned);
  const owned:Record<Effect,string[]>={deny:[],ask:[]};
  for(const e of EFFECTS){
    const list:string[]=Array.isArray(settings.permissions?.[e])?settings.permissions[e]:[];
    for(const r of wanted[e])if(!list.includes(r)){list.push(r);owned[e].push(r);}
    if(list.length)settings.permissions={...settings.permissions,[e]:list};
  }
  const text=JSON.stringify(settings,null,2)+'\n', id=new Date().toISOString().replace(/[:.]/g,'-');
  // The first install keeps the original file as its backup, so uninstall can return to the state before any controls.
  const backup=old?.backup??join('.state','backups','controls-claude',id,'settings.json');
  if(!old)await atomic(join(root,backup),current.text);
  const receipt:ControlsReceipt={platform:'claude',path,sourceHash,owned,hash:hash(text),backup,existed:old?.existed??current.existed,installedAt:id,verification:'settings written; fresh-session refusal not yet verified'};
  await mkdir(dirname(path),{recursive:true});
  await atomic(path,text);
  try{await saveJSON(receiptPath(root),receipt);}
  catch(e){await atomic(path,current.text);throw e;}
  return {...receipt,rules:wanted};
}
export async function controlsVerify(root:string,platform:string,source?:string) {
  supported(platform);
  const r=await previous(root);
  if(!r)return {platform,installed:false,configurationVerified:false,behaviorVerified:false,missing:[],note:'Not installed. Run: harness controls install claude'};
  const {controls,sourceHash}=await loadControls(source), wanted=claudeRules(controls,root);
  let settings:any={};try{settings=parse((await safeRead(r.path)).text,r.path);}catch{}
  const missing=EFFECTS.flatMap(e=>wanted[e].filter(rule=>!(settings.permissions?.[e]??[]).includes(rule)).map(rule=>({effect:e,rule})));
  const sourceChanged=sourceHash!==r.sourceHash;
  return {platform,installed:true,path:r.path,rules:wanted.deny.length+wanted.ask.length,missing,sourceChanged,configurationVerified:!missing.length&&!sourceChanged,behaviorVerified:false,note:sourceChanged?'controls.json changed since install. Run: harness controls install claude':r.verification};
}
export async function controlsUninstall(root:string,platform:string) {
  supported(platform);
  const r=await previous(root);
  if(!r)throw new Error('Controls are not installed for claude. Nothing was changed.');
  const now=await safeRead(r.path);
  // Untouched since install: restore the original bytes. Changed since: remove only the owned entries and keep the rest.
  if(hash(now.text)===r.hash){const original=await readFile(await backupFile(root,r.backup),'utf8');if(r.existed)await atomic(r.path,original);else await unlink(r.path);}
  else await atomic(r.path,JSON.stringify(strip(parse(now.text,r.path),r.owned),null,2)+'\n');
  await unlink(receiptPath(root));
  return {removed:true,platform,path:r.path,restoredOriginalBytes:hash(now.text)===r.hash};
}
