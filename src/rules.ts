import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { readFile, readdir, lstat, stat } from 'node:fs/promises';
import { hash, activeVersion, readRelease, json } from './core.ts';
import { markers, section, packMarkers, PACK_FILE, claudeHome, codexHome } from './install.ts';
import type { Receipt } from './install.ts';
import { lintRules, LOCAL_AUTHOR } from './packs.ts';


// Rules are proposed for these agents only; the generic instructions file is scanned read-only.
const AGENTS=['cursor','claude','codex'] as const;
export type Agent=typeof AGENTS[number]|'generic';
export type Format='cursor-mdc'|'claude-rule'|'claude-md-section'|'codex-agents-section'|'generic-instructions';
export type Scope='global'|'path'|'manual';
export type RuleRecord={id:string;agent:Agent;path:string;name:string;management:'harness'|'pack'|'plugin'|'unmanaged';format:Format;scope:Scope;writable:boolean;plugin?:string;range?:[number,number];text:string;body:string;hash:string};
export type FindingKind='malformed'|'content-drift'|'missing'|'duplicate-of-core'|'stale-release'|'unmanaged-text'|'plugin-copy';
// hash covers the finding's message and the text of its records, so an ignored finding resurfaces when a copy changes.
export type Finding={id:string;kind:FindingKind;rule:string;records:string[];message:string;hash:string};
// replaces names the record this target supersedes; it can be in another file, as when a CLAUDE.md section moves to ~/.claude/rules/.
export type Target={agent:Agent;path:string;format:Format;replaces?:string};
// adopt: turn from into the local pack, install it on pack.platforms, and remove every target (the loose copies).
export type Proposal={id:string;finding:string;rule:string;action:'add'|'merge'|'remove'|'adopt'|'none';from?:string;targets:Target[];reason:string;pack?:{id:string;name:string;platforms:Agent[]}};
export type IgnoredFinding=Finding&{reason:string;ignoredAt:string};
export type RulesScan={home:string;activeVersion:string|null;rules:RuleRecord[];findings:Finding[];proposals:Proposal[];ignored:IgnoredFinding[]};
export type Ignore={finding:string;hash:string;reason:string;ignoredAt:string};
export const ignoreFile=(root:string)=>join(root,'.state','rules-ignored.json');
export async function readIgnores(root:string):Promise<Ignore[]> {
  return (await json<{ignored:Ignore[]}>(ignoreFile(root)).catch(e=>{if(absent(e))return {ignored:[]};throw e;})).ignored;
}
// The text a local pack carries: the body without front matter, HTML comments, or rule markers, which pack lint rejects.
export function packSource(r:RuleRecord) {
  const rules=(r.range?r.text:frontmatter(r.text).body).replace(/<!--[\s\S]*?-->/g,'').replace(/\n{3,}/g,'\n\n').trim()+'\n';
  const heading=rules.match(/^#{1,6} (.+)$/m)?.[1].trim();
  return {rules,title:heading&&heading.length<=60&&!/[<>]|https?:|www\./i.test(heading)?heading:r.name};
}

// Rule markers must never contain a base or pack marker as a substring.
export const ruleMarkers=(name:string)=>[`<!-- BEGIN AGENTIC HARNESS RULE ${name} -->`,`<!-- END AGENTIC HARNESS RULE ${name} -->`] as const;
const RULE_MARKER=/<!-- (?:BEGIN|END) AGENTIC HARNESS RULE (\S+) -->/g;
const HARNESS='agentic-harness';
// Cursor has no installer entry: its only harness record is the retired rule file. The policy itself is in Cursor User Rules.
const INSTALLER:Record<Exclude<Agent,'cursor'>,string>={claude:'claude',codex:'codex',generic:'generic'};
const RELEASE=/\bagentic(?: agent)? harness release (\d+\.\d+\.\d+)/gi;
const HARNESS_FILE=/Pragmatic engineer harness|Agentic harness release/;
const short=(s:string)=>hash(s).slice(0,12);
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
export const ruleName=(file:string)=>slug(basename(file).replace(/\.mdc?$/i,''));
const absent=(e:unknown)=>['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??'');
const names=(dir:string,recursive=false)=>readdir(dir,{recursive}).catch(e=>{if(absent(e))return [] as string[];throw e;});
async function read(path:string) {
  try{return {text:(await readFile(path,'utf8')).replace(/\r\n/g,'\n'),link:(await lstat(path)).isSymbolicLink()};}
  catch(e){if(absent(e))return undefined;throw e;}
}

export function frontmatter(text:string):{fields:Record<string,string|string[]>;body:string;error?:string} {
  const lines=text.split('\n');
  if(lines[0].trim()!=='---')return {fields:{},body:text};
  const end=lines.findIndex((l,i)=>i>0&&l.trim()==='---');
  if(end<0)return {fields:{},body:text,error:'Front matter has no closing --- line.'};
  const fields:Record<string,string|string[]>={},body=lines.slice(end+1).join('\n');let key='';
  for(const [i,line] of lines.slice(1,end).entries()){
    const m=line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if(m){key=m[1];fields[key]=m[2].trim();continue;}
    if(key&&/^\s+-\s+\S/.test(line)){const v=fields[key];fields[key]=[...(Array.isArray(v)?v:v?[v]:[]),line.replace(/^\s+-\s+/,'').trim()];continue;}
    if(line.trim()&&!/^\s*#/.test(line)&&!(key&&/^\s+\S/.test(line)))return {fields:{},body,error:`Front matter line ${i+2} is not "key: value" or a list item.`};
  }
  return {fields,body};
}
export const normalize=(text:string)=>frontmatter(text).body.replace(/<!--[\s\S]*?-->/g,'').split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
const filled=(v:string|string[]|undefined)=>Array.isArray(v)?v.length>0:!!v;

function segments(text:string,offset:number):[number,number][] {
  const out:[number,number][]=[];let start=-1,end=0,content=false,pos=0,blank=true;
  for(const line of text.split('\n')){
    const t=line.trim();
    if(t){
      if(start>=0&&content&&blank&&/^(?:<!--|# )/.test(t)){out.push([offset+start,offset+end]);start=-1;content=false;}
      if(start<0)start=pos;
      if(!/^<!--.*-->$/.test(t))content=true;
      end=pos+line.length;
    }
    blank=!t;pos+=line.length+1;
  }
  if(start>=0&&content)out.push([offset+start,offset+end]);
  return out;
}
function sectionName(text:string,known:string[]) {
  const source=text.match(/Source:[^\n]*?(?<![\w-])([\w-]+)\.mdc?\b/i)?.[1];
  if(source)return ruleName(source);
  const first=text.split('\n').map(l=>l.trim()).find(l=>l&&!/^<!--.*-->$/.test(l))??'';
  const heading=first.match(/^#{1,6} (.+)$/)?.[1];
  if(heading){const s=slug(heading);return known.filter(n=>s===n||s.startsWith(n+'-')).sort((a,b)=>b.length-a.length)[0]??s;}
  return first.match(/^([a-z0-9]+(?:-[a-z0-9]+)*):$/)?.[1]??`untitled-${short(normalize(text)).slice(0,8)}`;
}
const owned=(r:RuleRecord)=>r.management==='harness'||r.management==='pack';
const supports=(agent:Agent,scope:Scope)=>scope==='global'||(scope==='path'&&agent!=='codex')||(scope==='manual'&&agent==='cursor');

export async function scanRules(root:string,home=homedir()):Promise<RulesScan> {
  const version=await activeVersion(root), core=version?normalize((await readRelease(root,version)).core):'';
  const rules:RuleRecord[]=[], findings:Finding[]=[], proposals:Proposal[]=[], broken=new Set<string>(), errors:{rule:string;records:string[];message:string}[]=[], loose:RuleRecord[]=[];
  const add=(r:Omit<RuleRecord,'id'|'body'|'hash'>,suffix='')=>{
    const body=normalize(r.text);let id=`${r.agent}:${r.path}${suffix}`;
    for(let n=2;rules.some(x=>x.id===id);n++)id=`${r.agent}:${r.path}${suffix}-${n}`;
    const record={id,...r,body,hash:hash(body)};rules.push(record);return record;
  };
  const cursorRules=join(home,'.cursor','rules'), claudeRules=join(claudeHome(home),'rules');
  const native=(agent:Agent,name:string):Target=>agent==='cursor'?{agent,path:join(cursorRules,name+'.mdc'),format:'cursor-mdc'}:agent==='claude'?{agent,path:join(claudeRules,name+'.md'),format:'claude-rule'}:{agent,path:join(codexHome(home),'AGENTS.md'),format:'codex-agents-section'};
  const replace=(r:RuleRecord):Target=>({agent:r.agent,path:r.path,format:r.format,replaces:r.id});

  async function ruleFile(agent:Agent,path:string,plugin?:string) {
    const file=await read(path);
    if(!file){errors.push({rule:ruleName(path),records:[],message:`${path}: unreadable (broken symlink).`});return;}
    const f=frontmatter(file.text), name=ruleName(path);
    const harness=!plugin&&path===join(cursorRules,'pragmatic-engineer.mdc')&&HARNESS_FILE.test(file.text);
    const packName=!plugin&&agent==='cursor'&&dirname(path)===cursorRules?PACK_FILE.exec(basename(path)):null, pack=packName&&`${packName[1]}/${packName[2]}`;
    const scope:Scope=agent==='claude'?(!f.error&&filled(f.fields.paths)?'path':'global'):f.fields.alwaysApply==='true'?'global':filled(f.fields.globs)?'path':'manual';
    const r=add({agent,path,name:harness?HARNESS:pack?`pack:${pack}`:name,management:plugin?'plugin':harness?'harness':pack?'pack':'unmanaged',format:agent==='claude'?'claude-rule':'cursor-mdc',scope,writable:!plugin&&!harness&&!pack&&!file.link,...(plugin?{plugin}:{}),text:file.text});
    if(pack){
      try{section(file.text,packMarkers(pack));}
      catch(e){errors.push({rule:r.name,records:[r.id],message:`${path}: ${(e as Error).message} This add-on pack file no longer matches what pack add wrote. Undo the edit, or see Recovery in docs/packs.md.`});}
    }
    if(f.error){broken.add(r.id);errors.push({rule:name,records:[r.id],message:`${path}: ${f.error}${agent==='claude'?' Claude Code ignores unparseable front matter and loads the rule in every session.':''}`});}
  }
  for(const n of (await names(cursorRules)).filter(n=>n.endsWith('.mdc')).sort())await ruleFile('cursor',join(cursorRules,n));
  const cache=join(home,'.cursor','plugins','cache');
  for(const market of (await names(cache)).sort()) for(const plugin of (await names(join(cache,market))).sort()) {
    const versions=await Promise.all((await names(join(cache,market,plugin))).map(async v=>({v,t:(await stat(join(cache,market,plugin,v))).mtimeMs})));
    const latest=versions.sort((a,b)=>b.t-a.t)[0]?.v;
    if(!latest)continue;
    const dir=join(cache,market,plugin,latest,'rules');
    for(const n of (await names(dir)).filter(n=>n.endsWith('.mdc')).sort())await ruleFile('cursor',join(dir,n),`${market}/${plugin}`);
  }
  for(const n of (await names(claudeRules,true)).filter(n=>n.endsWith('.md')).sort())await ruleFile('claude',join(claudeRules,n));
  const known=[...new Set(rules.filter(r=>!owned(r)).map(r=>r.name))];

  async function sharedFile(agent:Agent,path:string,format:Format,readOnly=false) {
    const file=await read(path);
    if(!file)return;
    // Installs now write the plain-text release line first, so the release comment can be line 2.
    if(agent==='generic'&&HARNESS_FILE.test(file.text.split('\n',2).join('\n'))){add({agent,path,name:HARNESS,management:'harness',format,scope:'global',writable:false,text:file.text});return;}
    const {text}=file, managed:[number,number,string][]=[], marked:[number,number,string][]=[];
    try{
      const m=markers('instructions');
      if(text.includes(m[0])||text.includes(m[1]))managed.push([...section(text,m),HARNESS]);
      for(const id of new Set([...text.matchAll(/<!-- (?:BEGIN|END) AGENTIC HARNESS PACK (\S+) -->/g)].map(x=>x[1])))managed.push([...section(text,packMarkers(id)),`pack:${id}`]);
      for(const id of new Set([...text.matchAll(RULE_MARKER)].map(x=>x[1])))marked.push([...section(text,ruleMarkers(id)),id]);
      const all=[...managed,...marked].sort((a,b)=>a[0]-b[0]);
      if(all.some(([a],i)=>i>0&&a<all[i-1][1]))throw new Error('Nested or overlapping managed markers.');
    }catch(e){errors.push({rule:ruleName(path),records:[],message:`${path}: ${(e as Error).message} The scanner skipped this file.`});return;}
    managed.sort((a,b)=>a[0]-b[0]);marked.sort((a,b)=>a[0]-b[0]);
    for(const [a,b,name] of managed)add({agent,path,name,management:name===HARNESS?'harness':'pack',format,scope:'global',writable:false,range:[a,b],text:text.slice(a,b)},`#${name}`);
    // Rule sections are user rules the rules manager wrapped: writable, and not loose text.
    for(const [a,b,name] of marked)add({agent,path,name,management:'unmanaged',format,scope:'global',writable:!readOnly&&!file.link,range:[a,b],text:text.slice(a,b)},`#${name}`);
    const gaps=[0,...[...managed,...marked].sort((a,b)=>a[0]-b[0]).flatMap(([a,b])=>[a,b]),text.length];
    for(let i=0;i<gaps.length;i+=2) for(const [a,b] of segments(text.slice(gaps[i],gaps[i+1]),gaps[i])) {
      const segment=text.slice(a,b), name=sectionName(segment,known);
      const r=add({agent,path,name,management:'unmanaged',format,scope:'global',writable:!readOnly&&!file.link,range:[a,b],text:segment},`#${name}`);
      if(managed.length&&!readOnly)loose.push(r);
    }
  }
  await sharedFile('claude',join(claudeHome(home),'CLAUDE.md'),'claude-md-section');
  await sharedFile('codex',join(codexHome(home),'AGENTS.md'),'codex-agents-section');
  // Read-only sources: Codex reads AGENTS.override.md instead of AGENTS.md, and the generic file is copied by hand into other tools.
  await sharedFile('codex',join(codexHome(home),'AGENTS.override.md'),'codex-agents-section',true);
  const generic=await json<Receipt>(join(root,'.state','installations','generic.json')).then(r=>r.files[0]?.path,e=>{if(absent(e))return undefined;throw e;});
  for(const path of new Set([join(home,'.config','agentic-harness','instructions.md'),...(generic?.startsWith(home+'/')?[generic]:[])]))await sharedFile('generic',path,'generic-instructions',true);

  const flag=(kind:FindingKind,rule:string,records:string[],message:string,proposal:Omit<Proposal,'id'|'finding'|'rule'>)=>{
    const id=`${kind}:${rule}:${short(records.join('\n')||message)}`;
    const text=short(JSON.stringify([message,records.map(r=>rules.find(x=>x.id===r)?.hash??r)]));
    findings.push({id,kind,rule,records,message,hash:text});proposals.push({id:`proposal:${id}`,finding:id,rule,...proposal});
    return id;
  };
  const none=(reason:string)=>({action:'none' as const,targets:[],reason});
  const stale=new Map<string,string>();
  for(const r of rules){
    const old=version?[...new Set([...r.text.matchAll(RELEASE)].map(m=>m[1]))].filter(v=>v!==version):[];
    const notes=[...(old.length?[`References release ${old.join(', ')}; the active release is ${version}.`]:[])];
    if(notes.length)stale.set(r.id,notes.join(' '));
  }
  const rank=(r:RuleRecord)=>[r.management==='plugin'?0:1,stale.has(r.id)?1:0,[...AGENTS,'generic'].indexOf(r.agent),r.range?1:0];
  const order=(a:RuleRecord,b:RuleRecord)=>{const x=rank(a),y=rank(b),i=x.findIndex((v,j)=>v!==y[j]);return i<0?0:x[i]-y[i];};
  const canonical=(group:RuleRecord[])=>[...group].sort(order)[0];
  const why=(r:RuleRecord)=>r.management==='plugin'?`the read-only plugin rule from ${r.plugin}`:'the first copy without a stale release reference, in Cursor, Claude, Codex order';
  const groups=new Map<string,RuleRecord[]>();
  for(const r of rules) if(!owned(r)&&!broken.has(r.id))groups.set(r.name,[...(groups.get(r.name)??[]),r]);
  const covered=new Set<string>();

  for(const e of errors)flag('malformed',e.rule,e.records,e.message,none('Fix this by hand. The scanner does not propose changes to malformed files.'));
  for(const [name,group] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
    const from=canonical(group);
    // A copy whose agent cannot express the rule's scope must be reworded by hand, so it is never drift.
    const comparable=group.filter(r=>supports(r.agent,from.scope));
    const texts=new Set(comparable.map(r=>r.hash)).size;
    let anchor:string|undefined;
    if(texts>1){
      const targets=comparable.filter(r=>r.hash!==from.hash&&r.writable);
      for(const t of targets)covered.add(t.id);
      const skipped=comparable.filter(r=>r.hash!==from.hash&&!targets.includes(r));
      anchor=flag('content-drift',name,comparable.map(r=>r.id),`${comparable.length} copies of ${name} have ${texts} different texts (${[...new Set(comparable.map(r=>r.agent))].join(', ')}).`,
        targets.length?{action:'merge',from:from.id,targets:targets.map(replace),reason:`Sync to ${from.path}, ${why(from)}.${skipped.length?` Not changed: ${skipped.map(r=>r.id).join(', ')} (read-only).`:''}`}
          :none(`No copy can be synced from ${from.path}: every copy with different text is read-only.`));
    }
    const present=new Set(group.map(r=>r.agent)), missing=AGENTS.filter(a=>!present.has(a)&&supports(a,from.scope));
    if(group.some(r=>r.management==='unmanaged')&&missing.length){
      const id=flag('missing',name,group.map(r=>r.id),`${name} exists for ${[...present].join(', ')} but not for ${missing.join(', ')}.`,{action:'add',from:from.id,targets:missing.map(a=>native(a,name)),reason:`Add ${from.path} in each missing agent's native format.`});
      anchor??=id;
    }
    const plugin=group.find(r=>r.management==='plugin');
    // Plugin rules stay owned by their plugin: no adopt proposal, only keep (ignore) or remove for each hand copy.
    if(plugin) for(const r of group.filter(r=>r.management==='unmanaged'))
      flag('plugin-copy',name,[r.id],`${r.path} is a hand copy of the ${plugin.plugin} plugin rule ${name}. The plugin updates its own rule in Cursor, not this copy.`,
        r.writable?{action:'remove',targets:[replace(r)],reason:`Remove this hand copy. ${r.agent==='cursor'?'Cursor still loads the plugin rule.':`${r.agent} has no plugin, so it stops getting this rule.`} To keep the copy, ignore this finding with a reason.`}:none('Read-only copy; it cannot be removed here.'));
    else if(anchor&&from.scope==='global'&&group.every(r=>r.writable)&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)&&name.length>=3&&name.length<=40&&!lintRules(packSource(from).rules))
      proposals.push({id:`proposal:adopt:${anchor}`,finding:anchor,rule:name,action:'adopt',from:from.id,targets:group.map(replace),pack:{id:`${LOCAL_AUTHOR}/${name}`,name:packSource(from).title,platforms:[...AGENTS]},
        reason:`Make ${from.path} (${why(from)}) the local add-on pack ${LOCAL_AUTHOR}/${name}, install it on ${AGENTS.join(', ')}, and remove ${group.length===1?'the loose copy':`all ${group.length} loose copies`}. Comments and front matter are dropped; the pack loads in every session.`});
  }
  const coreLines=new Set(core.split('\n').filter(l=>l.length>=20));
  for(const r of rules){
    if(owned(r)||broken.has(r.id)||!coreLines.size)continue;
    const lines=r.body.split('\n').filter(l=>l.length>=20), shared=lines.filter(l=>coreLines.has(l)).length;
    if(lines.length>=3&&shared/lines.length>=0.6)
      flag('duplicate-of-core',r.name,[r.id],`${r.path}: ${shared} of ${lines.length} lines repeat the core policy of release ${version}.`,r.writable?{action:'remove',targets:[replace(r)],reason:'The installed harness policy already contains these lines.'}:none('Read-only rule; it cannot be removed here.'));
  }
  for(const r of rules){
    const note=stale.get(r.id);
    if(!note)continue;
    const from=groups.get(r.name)&&canonical(groups.get(r.name)!);
    flag('stale-release',r.name,[r.id],`${r.path}: ${note}`,
      r.management==='harness'?none(r.agent==='cursor'?'This rule file is retired: Cursor gets the policy from User Rules. Run install cursor-files, which removes the file when it is unchanged since an earlier install; otherwise remove it by hand.':`Run install ${INSTALLER[r.agent]} to install release ${version}.`)
        :covered.has(r.id)?none(`Covered by the content-drift merge for ${r.name}.`)
        :from&&from!==r&&!stale.has(from.id)&&r.writable?{action:'merge',from:from.id,targets:[replace(r)],reason:`Sync to ${from.path}, which has no stale reference.`}
        :none(r.writable?'Edit or remove the outdated reference by hand; no current copy of this rule exists.':'Read-only rule; it cannot be changed here.'));
  }
  for(const r of loose){
    const same=rules.filter(x=>x!==r&&x.agent===r.agent&&x.name===r.name&&!owned(x)), file=r.agent==='claude'?'CLAUDE.md':'AGENTS.md';
    const twin=same.find(x=>x.hash===r.hash);
    flag('unmanaged-text',r.name,[r.id],`${r.path} has text outside the harness markers: ${r.name}.`,
      covered.has(r.id)?none(`Covered by the content-drift merge for ${r.name}.`)
        :!r.writable?none(`${r.path} is a symlink; edit it by hand.`)
        :twin?{action:'remove',targets:[replace(r)],reason:`An identical copy already exists at ${twin.path}.`}
        :same.length?none(`Another ${r.agent} copy with different text exists at ${same[0].path}; resolve it by hand.`)
        :r.agent==='claude'?{action:'add',from:r.id,targets:[{...native('claude',r.name),replaces:r.id}],reason:`Move this ${file} text to its own rule file.`}
        :{action:'add',from:r.id,targets:[replace(r)],reason:`Wrap this ${file} text in its own marked section.`});
  }
  const ignores=await readIgnores(root), ignored:IgnoredFinding[]=[];
  for(const f of findings){const i=ignores.find(i=>i.finding===f.id&&i.hash===f.hash);if(i)ignored.push({...f,reason:i.reason,ignoredAt:i.ignoredAt});}
  const hidden=new Set(ignored.map(f=>f.id));
  return {home,activeVersion:version,rules,findings:findings.filter(f=>!hidden.has(f.id)),proposals:proposals.filter(p=>!hidden.has(p.finding)),ignored};
}
