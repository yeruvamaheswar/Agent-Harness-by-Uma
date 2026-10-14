import { homedir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink, rm } from 'node:fs/promises';
import { hash, atomic, saveJSON, json } from './core.ts';
import { safeRead, markers, section, packMarkers, PACK_FILE, claudeHome, codexHome, backupFile, verifyPacks } from './install.ts';
import type { PackReceipt } from './install.ts';
import { scanRules, frontmatter, ruleMarkers, packSource, readIgnores, ignoreFile } from './rules.ts';
import type { Agent, Format, RuleRecord, RulesScan } from './rules.ts';
import { planPack, localPack, writeLocalPack, packReceipt, packReceiptPath } from './packs.ts';
import type { Pack } from './packs.ts';

type PackPlatform='cursor'|'claude'|'codex';
type Op={proposal:string}&({kind:'write';text:string;create:boolean}|{kind:'delete'}|{kind:'splice';range:[number,number];expect:string;text:string;cut:boolean;name?:string}|{kind:'append';text:string;name:string}|{kind:'pack';platform:PackPlatform;pack:Pack;file:boolean});
// packs lists the add-on packs this change installs; their receipts are ordinary pack receipts, so pack list, verify, and pack remove see them.
export type RuleChange={path:string;agent:Agent;proposals:string[];change:'create'|'modify'|'delete';before:string|null;after:string|null;diff:string;owned:'file'|'sections';sections:{name:string;hash:string}[];removed:[number,number][];packs:{id:string;version:string;platform:PackPlatform;block:string;scope?:'file'}[]};
export type AdoptedPack={proposal:string;pack:Pack;exists:boolean;dir:string};
export type RulesPreview={home:string;proposals:{id:string;rule:string;action:string;reason:string}[];changes:RuleChange[];packs:AdoptedPack[];diff:string;digest:string;approve:string};
export type RuleReceipt={id:string;applyId:string;appliedAt:string;digest:string;proposals:string[];agent:Agent;path:string;existed:boolean;backup:string;beforeHash:string|null;writtenHash:string|null;owned:'file'|'sections';sections:{name:string;hash:string}[];removed:[number,number][];packs?:{id:string;platform:PackPlatform}[];verification:string};

const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACK=/<!-- (?:BEGIN|END) AGENTIC HARNESS PACK (\S+) -->/g;
const notFound=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export const ruleReceiptDir=(root:string)=>join(root,'.state','installations','rules');
const changed=(path:string)=>new Error(`${path} changed since the scan. Nothing was written. Run rules preview again.`);

function content(r:RuleRecord) {
  let t=r.range?r.text:frontmatter(r.text).body;
  const [begin,end]=ruleMarkers(r.name);
  if(t.startsWith(begin+'\n')&&t.endsWith('\n'+end))t=t.slice(begin.length+1,-end.length-1);
  return t.replace(/^\n+/,'').replace(/\n*$/,'\n');
}
function patterns(r:RuleRecord) {
  const v=frontmatter(r.text).fields[r.agent==='claude'?'paths':'globs'];
  const list=(Array.isArray(v)?v:String(v??'').split(',')).map(s=>s.trim().replace(/^(['"])(.*)\1$/,'$2')).filter(Boolean);
  if(!list.length)throw new Error(`${r.id} is path-scoped but lists no patterns.`);
  return list;
}
function renderFile(format:Format,from:RuleRecord) {
  if(format===from.format&&!from.range)return from.text;
  const body=content(from);
  if(from.scope==='manual')throw new Error(`${from.id} is a manual Cursor rule; only Cursor can express it.`);
  if(format==='cursor-mdc')return from.scope==='path'?`---\nglobs: ${patterns(from).join(',')}\nalwaysApply: false\n---\n\n${body}`:`---\nalwaysApply: true\n---\n\n${body}`;
  if(format==='claude-rule')return from.scope==='path'?`---\npaths:\n${patterns(from).map(p=>`  - ${JSON.stringify(p)}`).join('\n')}\n---\n\n${body}`:body;
  throw new Error(`Cannot write ${format} as a whole file.`);
}
function guarded(text:string,path:string) {
  try{
    const out:string[]=[], m=markers('instructions');
    if(text.includes(m[0])||text.includes(m[1]))out.push(text.slice(...section(text,m)));
    for(const id of new Set([...text.matchAll(PACK)].map(x=>x[1])))out.push(text.slice(...section(text,packMarkers(id))));
    return JSON.stringify(out);
  }catch(e){throw new Error(`${path}: ${(e as Error).message} Fix the harness markers by hand first.`);}
}
// Removing a section also removes the blank lines before it, so a cut undoes the append that created it.
function cutRange(text:string,[a,b]:[number,number]):[number,number] {
  let s=a,e=b;
  while(s>0&&/\s/.test(text[s-1]))s--;
  if(s===0)while(e<text.length&&/\s/.test(text[e]))e++;
  return [s,e];
}

const lines=(t:string|null)=>t?t.match(/[^\n]*\n|[^\n]+$/g)!:[];
function diffLines(a:string[],b:string[]) {
  let p=0,s=0;
  while(p<a.length&&p<b.length&&a[p]===b[p])p++;
  while(s<a.length-p&&s<b.length-p&&a[a.length-1-s]===b[b.length-1-s])s++;
  const x=a.slice(p,a.length-s),y=b.slice(p,b.length-s),L=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)L[i][j]=x[i]===y[j]?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
  const ops:[string,string][]=a.slice(0,p).map(l=>[' ',l]);
  for(let i=0,j=0;i<x.length||j<y.length;){
    if(i<x.length&&j<y.length&&x[i]===y[j]){ops.push([' ',x[i]]);i++;j++;}
    else if(i<x.length&&(j===y.length||L[i+1][j]>=L[i][j+1]))ops.push(['-',x[i++]]);
    else ops.push(['+',y[j++]]);
  }
  return [...ops,...a.slice(a.length-s).map(l=>[' ',l] as [string,string])];
}
export function unifiedDiff(path:string,before:string|null,after:string|null,context=3) {
  const ops=diffLines(lines(before),lines(after)), at=[[0,0]];
  for(const [t] of ops){const [o,n]=at[at.length-1];at.push([o+(t!=='+'?1:0),n+(t!=='-'?1:0)]);}
  const out=[`--- ${before===null?'/dev/null':'a'+path}`,`+++ ${after===null?'/dev/null':'b'+path}`], changes=ops.flatMap(([t],i)=>t===' '?[]:[i]);
  for(let k=0;k<changes.length;k++){
    const start=Math.max(0,changes[k]-context);
    while(k+1<changes.length&&changes[k+1]-changes[k]<=2*context+1)k++;
    const end=Math.min(ops.length,changes[k]+context+1), o=at[end][0]-at[start][0], n=at[end][1]-at[start][1];
    out.push(`@@ -${at[start][0]+(o?1:0)},${o} +${at[start][1]+(n?1:0)},${n} @@`);
    for(const [t,l] of ops.slice(start,end))out.push(t+l.replace(/\n$/,''),...(l.endsWith('\n')?[]:['\\ No newline at end of file']));
  }
  return out.join('\n')+'\n';
}

export async function planRules(root:string,scan:RulesScan,ids:string[]) {
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))throw new Error('Name at least one proposal ID from rules scan.');
  if(new Set(ids).size!==ids.length)throw new Error('Each proposal ID may appear only once.');
  const record=(id:string)=>{const r=scan.rules.find(r=>r.id===id);if(!r)throw new Error(`${id} is not in the current scan. Run rules scan again.`);return r;};
  const cursorRules=join(scan.home,'.cursor','rules'), claudeRules=join(claudeHome(scan.home),'rules'), agentsMd=join(codexHome(scan.home),'AGENTS.md'), plugins=join(scan.home,'.cursor','plugins')+sep;
  const files=new Map<string,{agent:Agent;ops:Op[]}>(), adopted:AdoptedPack[]=[];
  const add=(agent:Agent,path:string,op:Op)=>{const f=files.get(path)??{agent,ops:[]};f.ops.push(op);files.set(path,f);};
  const cut=(r:RuleRecord,proposal:string)=>r.range?add(r.agent,r.path,{proposal,kind:'splice',range:r.range,expect:r.text,text:'',cut:true}):add(r.agent,r.path,{proposal,kind:'delete'});
  const proposals=ids.map(id=>{const p=scan.proposals.find(p=>p.id===id);if(!p)throw new Error(`${id} is not in the current scan. Run rules scan again.`);return p;});
  if(proposals.filter(p=>p.action==='adopt').length>1)throw new Error('Apply one adopt proposal at a time.');
  for(const p of proposals){
    if(p.action==='none'||!p.targets.length)throw new Error(`${p.id} has action none: ${p.reason}`);
    if(!SLUG.test(p.rule)&&p.action!=='remove')throw new Error(`${p.rule} is not a valid rule name.`);
    const from=p.from?record(p.from):undefined;
    if(p.action==='adopt'){
      const plugin=scan.rules.find(r=>r.name===p.rule&&r.management==='plugin');
      if(plugin)throw new Error(`${p.id}: ${p.rule} is a plugin rule (${plugin.id}). Plugin rules stay owned by their plugin and are never adopted as packs; keep or remove the hand copies instead.`);
      if(!from||from.management!=='unmanaged')throw new Error(`${p.id}: adopt needs an unmanaged source rule.`);
      if(from.scope!=='global')throw new Error(`${p.id}: ${from.id} is a ${from.scope} rule. A pack loads in every session, so only global rules can be adopted.`);
      const removing=new Set(p.targets.map(t=>t.replaces)), left=scan.rules.filter(r=>r.name===p.rule&&r.management==='unmanaged'&&!removing.has(r.id));
      if(left.length)throw new Error(`${p.id}: adopt must remove every loose copy of ${p.rule}; ${left.map(r=>r.id).join(', ')} would remain.`);
      const source=packSource(from), {pack,exists}=await localPack(root,p.rule,source.title,source.rules,`Adopted by rules apply from the ${from.agent} rule ${p.rule}.`);
      if(p.pack?.id!==pack.id)throw new Error(`${p.id}: the proposal names pack ${p.pack?.id}, but the rule maps to ${pack.id}.`);
      adopted.push({proposal:p.id,pack,exists,dir:join('.state','packs',pack.id,pack.version)});
      for(const platform of ['cursor','claude','codex'] as const){const t=await planPack(root,pack,platform);add(platform,t.path,{proposal:p.id,kind:'pack',platform,pack,file:t.scope==='file'});}
    }
    for(const t of p.targets){
      const old=t.replaces?record(t.replaces):undefined;
      if(t.path.startsWith(plugins)||old?.management==='plugin')throw new Error(`${p.id}: ${old?.id??t.path} is a plugin rule; the rules manager never changes plugin rules.`);
      if(old?.management==='harness')throw new Error(`${p.id}: ${old.id} is a harness block or pack section; use install or pack commands instead.`);
      if(old?.management==='pack'||(dirname(t.path)===cursorRules&&PACK_FILE.test(basename(t.path))))throw new Error(`${p.id}: ${old?.id??t.path} is an add-on pack; use pack commands instead.`);
      if(old&&!old.writable)throw new Error(`${p.id}: ${old.id} is read-only (writable=false, for example a symlink); edit it by hand.`);
      if(t.path===join(cursorRules,'pragmatic-engineer.mdc'))throw new Error(`${p.id}: ${t.path} is the retired harness Cursor rule file; the rules manager never writes it.`);
      const where=t.format==='cursor-mdc'?dirname(t.path)===cursorRules&&t.path.endsWith('.mdc'):t.format==='claude-rule'?t.path.startsWith(claudeRules+sep)&&t.path.endsWith('.md'):t.format==='codex-agents-section'&&t.path===agentsMd;
      if(p.action==='remove'||p.action==='adopt'){if(!old)throw new Error(`${p.id}: ${p.action} needs a record to replace.`);cut(old,p.id);continue;}
      if(!where)throw new Error(`${p.id}: ${t.path} is not a ${t.format} location the rules manager writes.`);
      if(!from)throw new Error(`${p.id} has no source record.`);
      if(t.format==='codex-agents-section'){
        if(from.scope!=='global')throw new Error(`${p.id}: Codex cannot express a ${from.scope} rule.`);
        const [begin,end]=ruleMarkers(p.rule), wrap=old&&old.id===from.id;
        const text=wrap?`${begin}\n${old.text}\n${end}`:`${begin}\n${content(from)}${end}`;
        if(wrap&&old.text.startsWith(begin))throw new Error(`${p.id}: ${old.id} is already a marked rule section.`);
        if(!old)add(t.agent,t.path,{proposal:p.id,kind:'append',text,name:p.rule});
        else if(old.path===t.path&&old.range)add(t.agent,t.path,{proposal:p.id,kind:'splice',range:old.range,expect:old.text,text,cut:false,name:p.rule});
        else throw new Error(`${p.id}: ${old.id} is not a section of ${t.path}.`);
        continue;
      }
      add(t.agent,t.path,{proposal:p.id,kind:'write',text:renderFile(t.format,from),create:!old||old.path!==t.path});
      if(old&&old.path!==t.path)cut(old,p.id);
      else if(old?.range)throw new Error(`${p.id}: ${old.id} is a section, not the file ${t.path}.`);
    }
  }
  const changes:RuleChange[]=[];
  for(const [path,{agent,ops}] of [...files].sort(([a],[b])=>a.localeCompare(b))){
    const {text:raw,existed}=await safeRead(path), before=existed?raw:null, by=[...new Set(ops.map(o=>o.proposal))];
    const whole=ops.filter(o=>o.kind==='write'||o.kind==='delete'||(o.kind==='pack'&&o.file));
    if(whole.length&&ops.length>1)throw new Error(`${path}: more than one selected change targets this file (${by.join(', ')}). Apply them separately.`);
    let after:string|null, owned:RuleChange['owned']='file';
    const sections:RuleChange['sections']=[], removed:RuleChange['removed']=[], packs:RuleChange['packs']=[];
    if(whole.length){
      const o=whole[0];
      if(o.kind==='pack'){
        if(existed)throw changed(path);
        const t=await planPack(root,o.pack,o.platform);
        after=t.next;packs.push({id:o.pack.id,version:o.pack.version,platform:o.platform,block:t.block,scope:'file'});
      } else {
        if(o.kind==='write'?o.create===existed:!existed)throw changed(path);
        after=o.kind==='write'?o.text:null;
      }
    } else {
      owned='sections';
      if(raw.includes('\r'))throw new Error(`${path} has Windows line endings; convert it to LF before applying section changes.`);
      const splices=ops.flatMap(o=>o.kind==='splice'?[o]:[]);
      for(const s of splices)if(raw.slice(...s.range)!==s.expect)throw changed(path);
      const edits=splices.map(s=>({...s,at:s.cut?cutRange(raw,s.range):s.range})).sort((a,b)=>b.at[0]-a.at[0]);
      if(edits.some((e,i)=>i>0&&e.at[1]>edits[i-1].at[0]))throw new Error(`${path}: the selected changes overlap (${by.join(', ')}). Apply them separately.`);
      let text=raw;
      for(const e of edits)text=text.slice(0,e.at[0])+e.text+text.slice(e.at[1]);
      for(const o of ops)if(o.kind==='append')text+=(text&&!text.endsWith('\n')?'\n':'')+(text?'\n':'')+o.text+'\n';
      if(guarded(raw,path)!==guarded(text,path))throw new Error(`${path}: the change would alter a harness block or pack section. Nothing was written.`);
      for(const o of ops)if((o.kind==='splice'||o.kind==='append')&&o.name){
        const [a,b]=(()=>{try{return section(text,ruleMarkers(o.name!));}catch{throw new Error(`${path}: rule section ${o.name} would be missing or duplicated.`);}})();
        sections.push({name:o.name,hash:hash(text.slice(a,b))});
      }
      for(const s of splices)if(s.cut)removed.push(s.range);
      // The pack goes in last, through the same planner as pack add, after the guard check above.
      for(const o of ops)if(o.kind==='pack'){const t=await planPack(root,o.pack,o.platform,text);text=t.next;packs.push({id:o.pack.id,version:o.pack.version,platform:o.platform,block:t.block});}
      after=text;
    }
    if(after===before)throw new Error(`${path}: the selected proposals change nothing.`);
    changes.push({path,agent,proposals:by,change:before===null?'create':after===null?'delete':'modify',before,after,diff:unifiedDiff(path,before,after),owned,sections,removed,packs});
  }
  return {proposals:proposals.map(p=>({id:p.id,rule:p.rule,action:p.action,reason:p.reason})),changes,packs:adopted};
}
export async function previewRules(root:string,ids:string[],home=homedir()):Promise<RulesPreview> {
  const scan=await scanRules(root,home), {proposals,changes,packs}=await planRules(root,scan,ids);
  const digest=hash(JSON.stringify({proposals:ids,changes:changes.map(c=>({path:c.path,before:c.before===null?null:hash(c.before),after:c.after})),...(packs.length?{packs:packs.map(a=>a.pack.digest)}:{})}));
  return {home:scan.home,proposals,changes,packs,diff:changes.map(c=>c.diff).join('\n'),digest,approve:`rules apply ${ids.join(' ')} --approve-sha ${digest}`};
}
export async function ruleReceipts(root:string):Promise<RuleReceipt[]> {
  const names=await readdir(ruleReceiptDir(root)).catch(e=>{if(notFound(e))return [];throw e;});
  const receipts=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>json<RuleReceipt>(join(ruleReceiptDir(root),n))));
  return receipts.sort((a,b)=>a.appliedAt.localeCompare(b.appliedAt)||a.id.localeCompare(b.id));
}
export async function applyRules(root:string,ids:string[],approvedDigest:string,home=homedir()) {
  const p=await previewRules(root,ids,home);
  if(p.digest!==approvedDigest)throw new Error('The approved digest does not match the current plan: a target file or the scan changed since the preview, or the digest is wrong. Nothing was written. Run rules preview again and review the new diff.');
  for(const c of p.changes){const now=await safeRead(c.path);if((now.existed?now.text:null)!==c.before)throw changed(c.path);}
  const applyId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`, appliedAt=new Date().toISOString();
  const receipts:RuleReceipt[]=p.changes.map((c,i)=>({id:`${applyId}-${i}`,applyId,appliedAt,digest:p.digest,proposals:c.proposals,agent:c.agent,path:c.path,existed:c.before!==null,backup:join('.state','backups','rules',applyId,`${i}.txt`),beforeHash:c.before===null?null:hash(c.before),writtenHash:c.after===null?null:hash(c.after),owned:c.owned,sections:c.sections,removed:c.removed,...(c.packs.length?{packs:c.packs.map(({id,platform})=>({id,platform}))}:{}),verification:'rule files written; fresh-session behavior not yet verified'}));
  // Back up every target before the first write.
  for(const [i,c] of p.changes.entries())await atomic(join(root,receipts[i].backup),c.before??'');
  const written:number[]=[], saved:string[]=[], created:string[]=[];
  try{
    for(const a of p.packs)if(!a.exists){created.push(join(root,a.dir));await writeLocalPack(root,a.pack);}
    for(const [i,c] of p.changes.entries()){if(c.after===null)await unlink(c.path);else await atomic(c.path,c.after);written.push(i);}
    for(const c of p.changes){const now=await safeRead(c.path);if((now.existed?now.text:null)!==c.after)throw new Error(`Verification failed: ${c.path} does not contain the planned text after writing.`);}
    for(const [i,c] of p.changes.entries())for(const x of c.packs){
      const file=packReceiptPath(root,x.platform,x.id), pack=p.packs.find(a=>a.pack.id===x.id)!.pack;
      await saveJSON(file,packReceipt(x.platform,{pack,path:c.path,block:x.block,...(x.scope?{scope:x.scope}:{})},receipts[i].backup,appliedAt));saved.push(file);
    }
    for(const r of receipts){const file=join(ruleReceiptDir(root),r.id+'.json');await saveJSON(file,r);saved.push(file);}
  }catch(e){
    try{
      for(const file of saved)await unlink(file);
      for(const i of written.reverse()){const c=p.changes[i];if(c.before===null)await unlink(c.path).catch(e=>{if(!notFound(e))throw e;});else await atomic(c.path,c.before);}
      for(const dir of created)await rm(dir,{recursive:true,force:true});
    }catch(r){throw new Error(`${(e as Error).message} Rollback also failed: ${(r as Error).message}. Backups are in .state/backups/rules/${applyId}/.`);}
    throw new Error(`${(e as Error).message} All written files were restored.`);
  }
  return {applyId,digest:p.digest,receipts:receipts.map(({id,path,proposals,existed})=>({id,path,proposals,existed})),packs:p.packs.map(a=>({id:a.pack.id,version:a.pack.version,digest:a.pack.digest,dir:a.dir})),verification:(await verifyRules(root)).filter(v=>v.applyId===applyId)};
}
export async function verifyRules(root:string) {
  return Promise.all((await ruleReceipts(root)).map(async r=>{
    const now=await safeRead(r.path).catch(()=>undefined), text=now?.existed?now.text:null;
    let ok=!!now;
    if(ok&&r.owned==='file')ok=r.writtenHash===null?text===null:text!==null&&hash(text)===r.writtenHash;
    else if(ok){
      ok=text!==null&&r.sections.every(s=>{try{return hash(text.slice(...section(text,ruleMarkers(s.name))))===s.hash;}catch{return false;}});
      if(ok&&r.removed.length){const old=await readFile(await backupFile(root,r.backup),'utf8');ok=r.removed.every(([a,b])=>!text!.includes(old.slice(a,b)));}
    }
    for(const x of r.packs??[])ok&&=!!(await verifyPacks(root,x.platform)).find(v=>v.id===x.id&&v.path===r.path)?.configurationVerified;
    return {id:r.id,applyId:r.applyId,agent:r.agent,path:r.path,proposals:r.proposals,packs:r.packs??[],configurationVerified:ok,wholeFileUnchanged:!!now&&(text===null?null:hash(text))===r.writtenHash,behaviorVerified:false,note:r.verification};
  }));
}
async function undoCheck(root:string,r:RuleReceipt) {
  const now=await safeRead(r.path), current=now.existed?now.text:null;
  if((current===null?null:hash(current))!==r.writtenHash)throw new Error(`${r.path} changed since receipt ${r.id} wrote it (a manual edit, a later apply, or pack remove). Refusing to overwrite newer changes. Undo later receipts first, or restore by hand from ${r.backup}.`);
  const old=await readFile(await backupFile(root,r.backup),'utf8');
  if(r.existed&&hash(old)!==r.beforeHash)throw new Error(`Backup ${r.backup} does not match the receipt. Nothing was restored.`);
  const packs:{file:string;receipt:PackReceipt}[]=[];
  for(const x of r.packs??[]){
    const file=packReceiptPath(root,x.platform,x.id), receipt=await json<PackReceipt>(file).catch(e=>{if(notFound(e))return undefined;throw e;});
    if(receipt&&receipt.files[0].path!==r.path)throw new Error(`The ${x.platform} pack receipt for ${x.id} points at ${receipt.files[0].path}, not ${r.path}. Nothing was restored.`);
    if(receipt)packs.push({file,receipt});
  }
  return {r,current,old,packs};
}
// Restores the file and deletes the pack receipts the apply created, so the pack is no longer listed as installed.
async function undoOne(root:string,{r,current,old,packs}:Awaited<ReturnType<typeof undoCheck>>) {
  if(r.existed)await atomic(r.path,old);else await unlink(r.path);
  const gone:typeof packs=[];
  try{
    for(const p of packs){await unlink(p.file);gone.push(p);}
    await unlink(join(ruleReceiptDir(root),r.id+'.json'));
  }catch(e){
    for(const p of gone)await saveJSON(p.file,p.receipt);
    if(current===null)await unlink(r.path);else await atomic(r.path,current);
    throw e;
  }
  return {undone:r.id,path:r.path,restored:r.existed?'previous file':'file removed',...(packs.length?{packsRemoved:packs.map(p=>`${p.receipt.pack.id} (${p.receipt.platform})`)}:{})};
}
// Accepts one receipt ID, or an apply ID to undo every file of that apply. All files are checked before the first restore.
export async function undoRules(root:string,id:string) {
  if(typeof id!=='string'||!/^[\w.-]+$/.test(id))throw new Error('Name a receipt ID or apply ID from rules verify.');
  const group=(await ruleReceipts(root)).filter(r=>r.applyId===id);
  if(group.length){
    const checked=[];
    for(const r of group.reverse())checked.push(await undoCheck(root,r));
    const receipts=[];
    for(const c of checked)receipts.push(await undoOne(root,c));
    return {undone:id,receipts};
  }
  const r=await json<RuleReceipt>(join(ruleReceiptDir(root),id+'.json')).catch(e=>{if(notFound(e))throw new Error(`Receipt ${id} not found. Run rules verify to list receipts.`);throw e;});
  return undoOne(root,await undoCheck(root,r));
}
// Moves a receipt that no longer verifies to retired/, with a reason. The backup under .state/backups/ stays.
export async function retireRule(root:string,id:string,reason:string) {
  if(typeof id!=='string'||!/^[\w.-]+$/.test(id))throw new Error('Name a receipt ID from rules verify.');
  if(typeof reason!=='string'||!reason.trim())throw new Error('Give a reason for retiring this receipt.');
  if(reason.length>500)throw new Error('Keep the reason to 500 characters or fewer.');
  const receipt=(await ruleReceipts(root)).find(r=>r.id===id);
  if(!receipt)throw new Error(`Receipt ${id} not found among active receipts. Run rules verify to list receipts.`);
  const check=(await verifyRules(root)).find(v=>v.id===id);
  if(check?.configurationVerified)throw new Error(`Receipt ${id} still verifies: the rule is still in place. To remove the rule, run rules undo ${id}. Only a receipt that no longer verifies can be retired.`);
  const active=join(ruleReceiptDir(root),id+'.json'), retired=join(ruleReceiptDir(root),'retired',id+'.json');
  if(await safeRead(retired).then(f=>f.existed))throw new Error(`Receipt ${id} is already retired: ${retired} exists. Nothing was changed.`);
  const entry={...receipt,retired:{at:new Date().toISOString(),reason:reason.trim()}};
  await saveJSON(retired,entry);
  try{await unlink(active);}
  catch(e){await unlink(retired);throw e;}
  return {retired:id,path:retired,reason:entry.retired.reason,note:`The backup ${receipt.backup} is kept. To reverse, move ${retired} back to ${active} and delete the retired field.`};
}
export async function ignoreFinding(root:string,finding:string,reason:string,home=homedir()) {
  if(typeof finding!=='string'||!finding)throw new Error('Name a finding ID from rules scan.');
  if(typeof reason!=='string'||!reason.trim())throw new Error('Give a reason for ignoring this finding.');
  if(reason.length>500)throw new Error('Keep the reason to 500 characters or fewer.');
  const scan=await scanRules(root,home), f=scan.findings.find(f=>f.id===finding);
  if(!f)throw new Error(scan.ignored.some(i=>i.id===finding)?`${finding} is already ignored.`:`${finding} is not in the current scan. Run rules scan again.`);
  const entry={finding:f.id,hash:f.hash,reason:reason.trim(),ignoredAt:new Date().toISOString()};
  await saveJSON(ignoreFile(root),{schemaVersion:1,ignored:[...(await readIgnores(root)).filter(i=>i.finding!==f.id),entry]});
  return entry;
}
export async function unignoreFinding(root:string,finding:string) {
  const ignores=await readIgnores(root);
  if(typeof finding!=='string'||!ignores.some(i=>i.finding===finding))throw new Error(`${finding} is not ignored.`);
  await saveJSON(ignoreFile(root),{schemaVersion:1,ignored:ignores.filter(i=>i.finding!==finding)});
  return {unignored:finding};
}
