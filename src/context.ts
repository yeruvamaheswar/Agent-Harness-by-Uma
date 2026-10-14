import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { saveJSON } from './core.ts';
import { claudeHome, codexHome } from './install.ts';
import { frontmatter } from './rules.ts';

// Read-only audit of what each platform loads at session start. It never writes outside .state/context-baseline/, and only with save.
type Base='claude'|'codex'|'cursor'|'home';
type Loc={base:Base;path:string};
type Root=Loc&{source:string};
// Where each platform keeps its always-loaded sources. src/platforms.ts is a data record only; this audit keeps its own copy.
// hide: the skill flag that keeps a skill out of the start list. rootsVerified: whether a measured session listed these roots.
export const PLATFORMS={
  claude:{
    instructions:[{base:'claude',path:'CLAUDE.md'}] as Loc[],
    ruleDir:{base:'claude',path:'rules'} as Loc,
    skillRoots:[{source:'user ~/.claude/skills',base:'claude',path:'skills'}] as Root[],
    syncedSkills:{base:'claude',path:'skills/synced'} as Loc,
    syncedPlugins:{base:'claude',path:'plugins/synced'} as Loc,
    installedPlugins:{base:'claude',path:'plugins/installed_plugins.json'} as Loc,
    settings:{base:'claude',path:'settings.json'} as Loc,
    hide:'disable-model-invocation',
    rootsVerified:'claude /context lists User, claude.ai sync, Plugin, and Built-in sources',
    notOnDisk:'built-in skills and claude.ai connectors: unknown (not in files; pass --claude-context)',
  },
  codex:{
    instructions:[{base:'codex',path:'AGENTS.md'},{base:'codex',path:'AGENTS.override.md'}] as Loc[],
    skillRoots:[{source:'user ~/.codex/skills',base:'codex',path:'skills'},{source:'shared ~/.agents/skills',base:'home',path:'.agents/skills'},{source:'system ~/.codex/skills/.system',base:'codex',path:'skills/.system'}] as Root[],
    pluginCache:{base:'codex',path:'plugins/cache'} as Loc,
    config:{base:'codex',path:'config.toml'} as Loc,
    sessions:{base:'codex',path:'sessions'} as Loc,
    hide:'allow_implicit_invocation',
    rootsVerified:'the skill roots table in a Codex session log lists these roots',
  },
  cursor:{
    ruleDir:{base:'cursor',path:'rules'} as Loc,
    skillRoots:[{source:'user ~/.cursor/skills',base:'cursor',path:'skills'},{source:'built-in ~/.cursor/skills-cursor',base:'cursor',path:'skills-cursor'},{source:'shared ~/.agents/skills',base:'home',path:'.agents/skills'},{source:'~/.claude/skills',base:'home',path:'.claude/skills'},{source:'~/.codex/skills',base:'home',path:'.codex/skills'}] as Root[],
    pluginCache:{base:'cursor',path:'plugins/cache'} as Loc,
    mcp:{base:'cursor',path:'mcp.json'} as Loc,
    rootsVerified:'unknown: no Cursor log lists its skill roots; these roots are assumed',
    userRules:'unknown: User Rules live in the Cursor app UI and are not readable from files',
    descriptions:'Cursor drops descriptions when the list is long (2026-10-06 review), so chars are an upper bound',
  },
} as const;

export type Size={chars:number;estimatedTokens:number};
// enabled and always count toward the start list; unknown is reported apart; disabled and not-in-config are excluded.
export type Enablement='always'|'enabled'|'unknown'|'disabled'|'not in config';
export type SkillSource=Size&{source:string;path:string;enablement:Enablement;count:number;skills?:{name:string;chars:number}[];hidden?:string[];duplicates?:string[];disabledByConfig?:string[];note?:string};
const size=(chars:number):Size=>({chars,estimatedTokens:Math.round(chars/4)});
const absent=(e:unknown)=>['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??'');
const maybe=<T>(p:Promise<T>)=>p.catch(e=>{if(absent(e))return undefined;throw e;});
const text=(path:string)=>maybe(readFile(path,'utf8'));
const dirs=async(path:string)=>((await maybe(readdir(path)))??[]).filter(n=>!n.startsWith('.')).sort();
async function jsonFile<T>(path:string):Promise<T|undefined> {
  const t=await text(path);if(t===undefined)return undefined;
  try{return JSON.parse(t) as T;}catch(e){throw new Error(`Cannot parse ${path}: ${(e as Error).message}`);}
}

// name and description from SKILL.md front matter, including folded and multi-line values.
// In a plain (unquoted) value, " #" starts a YAML comment; Codex drops the rest, so the audit does too.
export function skillMeta(source:string):Record<string,string> {
  const lines=source.replace(/\r\n/g,'\n').split('\n');
  if(lines[0].trim()!=='---')return {};
  const end=lines.findIndex((l,i)=>i>0&&l.trim()==='---'), out:Record<string,string>={};
  for(let i=1;i<end;i++){
    const m=lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);if(!m)continue;
    const v=m[2].trim(), block=/^[>|][-+]?$/.test(v), quoted=/^(['"]).*\1$/.test(v), plain=(s:string)=>s.replace(/(^|\s)#.*$/,'').trim();
    const parts=block?[]:[quoted?v.slice(1,-1):plain(v)];
    while(i+1<end&&/^\s+\S/.test(lines[i+1])){const l=lines[++i].trim();parts.push(block?l:plain(l));}
    out[m[1]]=parts.filter(Boolean).join(' ');
  }
  return out;
}

type Found={name:string;chars:number;real:string;file:string;hidden:boolean};
async function skillsIn(dir:string,hide?:string):Promise<Found[]> {
  const out:Found[]=[];
  for(const n of await dirs(dir)){
    const file=join(dir,n,'SKILL.md'), body=await text(file);if(body===undefined)continue;
    const meta=skillMeta(body), name=meta.name||n;
    const hidden=hide==='disable-model-invocation'?meta['disable-model-invocation']==='true'
      :hide==='allow_implicit_invocation'?/allow_implicit_invocation:\s*false/.test((await text(join(dir,n,'agents','openai.yaml')))??''):false;
    out.push({name,chars:name.length+(meta.description??'').length,real:await realpath(join(dir,n)),file:await realpath(file),hidden});
  }
  return out;
}
// The version folder Codex and Cursor use: the newest by modification time, as rules scan does.
async function newest(dir:string) {
  const versions=await Promise.all((await dirs(dir)).map(async v=>({v,t:(await stat(join(dir,v))).mtimeMs})));
  return versions.sort((a,b)=>b.t-a.t)[0]?.v;
}
type Candidate={source:string;path:string;enablement:Enablement;found:Found[];note?:string};
function sources(candidates:Candidate[],disabledFiles=new Set<string>()):SkillSource[] {
  const seen=new Set<string>();
  return candidates.map(c=>{
    const hidden:string[]=[],duplicates:string[]=[],disabledByConfig:string[]=[],kept:Found[]=[];
    for(const f of c.found){
      if(seen.has(f.real))duplicates.push(f.name);
      else if(disabledFiles.has(f.file))disabledByConfig.push(f.name);
      else if(f.hidden)hidden.push(f.name);
      else kept.push(f);
      seen.add(f.real);
    }
    const counted=['always','enabled','unknown'].includes(c.enablement), chars=kept.reduce((s,f)=>s+f.chars,0);
    return {source:c.source,path:c.path,enablement:c.enablement,count:kept.length,...size(chars),
      ...(counted&&kept.length?{skills:kept.map(f=>({name:f.name,chars:f.chars}))}:{}),
      ...(hidden.length?{hidden}:{}),...(duplicates.length?{duplicates}:{}),...(disabledByConfig.length?{disabledByConfig}:{}),...(c.note?{note:c.note}:{})};
  });
}
function totals(list:SkillSource[]) {
  const sum=(pick:(s:SkillSource)=>boolean)=>{const l=list.filter(pick);return {count:l.reduce((n,s)=>n+s.count,0),...size(l.reduce((n,s)=>n+s.chars,0))};};
  return {counted:sum(s=>s.enablement==='always'||s.enablement==='enabled'),enablementUnknown:sum(s=>s.enablement==='unknown'),excluded:sum(s=>s.enablement==='disabled'||s.enablement==='not in config')};
}
async function instructionFiles(paths:{path:string;loads:string}[]) {
  const files=[];
  for(const p of paths){const t=await text(p.path);if(t!==undefined)files.push({path:p.path,loads:p.loads,...size(t.length)});}
  return {files,total:size(files.filter(f=>f.loads==='start').reduce((n,f)=>n+f.chars,0))};
}

// Minimal TOML reading: table headers, plugin enabled flags, skill overrides, and MCP server names. Values of other keys are never returned.
export function codexConfig(toml:string) {
  const plugins:Record<string,boolean>={},disabledSkills:string[]=[],mcpServers:string[]=[];
  let table='',skill:{path?:string;enabled?:boolean}|undefined;
  const flush=()=>{if(skill?.path&&skill.enabled===false)disabledSkills.push(skill.path);skill=undefined;};
  for(const raw of toml.split('\n')){
    const line=raw.trim();
    if(line.startsWith('[')){
      flush();table=line;
      if(line==='[[skills.config]]')skill={};
      const m=line.match(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/);if(m)mcpServers.push(m[1]??m[2]);
      continue;
    }
    const kv=line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);if(!kv)continue;
    const plugin=table.match(/^\[plugins\."([^"]+)"\]$/);
    if(plugin&&kv[1]==='enabled')plugins[plugin[1]]=kv[2].trim()==='true';
    if(skill&&kv[1]==='enabled')skill.enabled=kv[2].trim()==='true';
    if(skill&&kv[1]==='path'){try{skill.path=JSON.parse(kv[2].trim());}catch{skill.path=kv[2].trim().replace(/^'|'$/g,'');}}
  }
  flush();
  return {plugins,disabledSkills,mcpServers};
}

// The first model call of the newest Codex session log that has a token_count event.
export async function codexMeasured(sessions:string) {
  for(const y of (await dirs(sessions)).reverse())for(const m of (await dirs(join(sessions,y))).reverse())for(const d of (await dirs(join(sessions,y,m))).reverse())
    for(const n of (await dirs(join(sessions,y,m,d))).filter(n=>n.endsWith('.jsonl')).reverse()){
      const log=join(sessions,y,m,d,n);let skills:{chars:number;listed:number}|undefined,input:number|undefined;
      for(const line of ((await text(log))??'').split('\n')){
        if(!line.trim())continue;
        let entry;try{entry=JSON.parse(line);}catch{continue;}
        const p=entry?.payload;
        if(!skills&&p?.type==='message')for(const c of p.content??[]){
          const t:string=c?.text??'',a=t.indexOf('<skills_instructions>'),b=t.indexOf('</skills_instructions>');
          if(a<0||b<a)continue;
          const block=t.slice(a,b+'</skills_instructions>'.length), list=block.split('### Available skills')[1]?.split(/\n###? /)[0]??'';
          skills={chars:block.length,listed:(list.match(/^- \S/gm)??[]).length};
        }
        if(p?.type==='token_count'&&p.info?.last_token_usage){input=p.info.last_token_usage.input_tokens;break;}
      }
      if(input!==undefined)return {label:'measured',log,logDate:`${y}-${m}-${d}`,firstCallInputTokens:input,skillsBlock:skills?{...skills,estimatedTokens:Math.round(skills.chars/4)}:'unknown: no skills_instructions block in this log'};
    }
  return 'unknown: no Codex session log with a token_count event';
}

// Parses the markdown that `claude -p "/context"` prints. Its numbers are Claude Code's own estimate.
export function parseClaudeContext(md:string) {
  const tokens=(s:string)=>{const m=s.trim().replace(/^~/,'').match(/^([\d.]+)\s*([km]?)$/i);return m?Math.round(parseFloat(m[1])*({'':1,k:1e3,m:1e6} as Record<string,number>)[m[2].toLowerCase()]):undefined;};
  const rows=(heading:string)=>{
    const part=md.split(/^### /m).find(s=>s.startsWith(heading));
    return (part?.split('\n').filter(l=>l.trim().startsWith('|'))??[]).slice(1).map(l=>l.trim().split('|').slice(1,-1).map(c=>c.trim())).filter(c=>!c.every(x=>/^-+$/.test(x)));
  };
  const categories:Record<string,number|undefined>={};for(const [name,t] of rows('Estimated usage by category'))categories[name]=tokens(t);
  const bySource:Record<string,{count:number;tokens:number}>={};
  for(const [,source,t] of rows('Skills')){const s=bySource[source]??={count:0,tokens:0};s.count++;s.tokens+=tokens(t)??0;}
  const total=md.match(/\*\*Tokens:\*\*\s*([\d.]+[km]?)/i)?.[1];
  return {label:'measured (claude /context estimate)',totalTokens:total?tokens(total):undefined,categories,
    skills:{count:Object.values(bySource).reduce((n,s)=>n+s.count,0),tokens:Object.values(bySource).reduce((n,s)=>n+s.tokens,0),bySource},
    mcpServers:[...new Set(rows('MCP Tools').map(r=>r[1]))],memoryFiles:rows('Memory Files').map(([type,path,t])=>({type,path,tokens:tokens(t)}))};
}

const localDate=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export async function contextAudit(root:string,opts:{home?:string;claudeContext?:string;save?:boolean;now?:Date}={}) {
  const home=opts.home??homedir(), now=opts.now??new Date();
  const bases:Record<Base,string>={claude:claudeHome(home),codex:codexHome(home),cursor:join(home,'.cursor'),home};
  const at=(l:Loc)=>join(bases[l.base],l.path);
  const fromRoots=async(roots:readonly Root[],hide?:string)=>Promise.all(roots.map(async r=>({source:r.source,path:at(r),enablement:'always' as Enablement,found:await skillsIn(at(r),hide)})));

  // Claude Code
  const C=PLATFORMS.claude;
  const rules=(await maybe(readdir(at(C.ruleDir),{recursive:true})))?.filter(n=>n.endsWith('.md')).sort()??[];
  const ruleLoads=await Promise.all(rules.map(async n=>({path:join(at(C.ruleDir),n),loads:frontmatter((await text(join(at(C.ruleDir),n)))??'').fields.paths?'on demand (paths)':'start'})));
  const settings=await jsonFile<{enabledPlugins?:Record<string,boolean>}>(at(C.settings));
  const installed=await jsonFile<{plugins?:Record<string,{scope:string;installPath:string}[]>}>(at(C.installedPlugins));
  const claudeCandidates:Candidate[]=await fromRoots(C.skillRoots,C.hide);
  for(const bucket of await dirs(at(C.syncedSkills)))
    claudeCandidates.push({source:'claude.ai sync',path:join(at(C.syncedSkills),bucket),enablement:'unknown',found:await skillsIn(join(at(C.syncedSkills),bucket),C.hide),note:'set on claude.ai, not in files'});
  for(const bucket of await dirs(at(C.syncedPlugins))){
    const manifest=await jsonFile<{plugins?:{name:string;installationPreference?:string}[]}>(join(at(C.syncedPlugins),bucket,'manifest.json'));
    for(const p of manifest?.plugins??[])claudeCandidates.push({source:`claude.ai plugin ${p.name}`,path:join(at(C.syncedPlugins),bucket,p.name),enablement:'unknown',found:await skillsIn(join(at(C.syncedPlugins),bucket,p.name,'skills'),C.hide),note:`installationPreference: ${p.installationPreference??'unknown'}`});
  }
  for(const [id,entries] of Object.entries(installed?.plugins??{}))for(const e of entries.filter(e=>e.scope==='user')){
    const flag=settings?.enabledPlugins?.[id];
    claudeCandidates.push({source:`plugin ${id}`,path:e.installPath,enablement:flag===true?'enabled':flag===false?'disabled':'unknown',found:await skillsIn(join(e.installPath,'skills'),C.hide)});
  }
  const claudeJson=bases.claude===join(home,'.claude')?join(home,'.claude.json'):join(bases.claude,'.claude.json');
  const claudeSkills=sources(claudeCandidates);
  const claude={
    instructions:await instructionFiles([...C.instructions.map(l=>({path:at(l),loads:'start'})),...ruleLoads]),
    skills:{sources:claudeSkills,...totals(claudeSkills),rootsVerified:C.rootsVerified,notOnDisk:C.notOnDisk},
    mcpServers:{configured:Object.keys((await jsonFile<{mcpServers?:Record<string,unknown>}>(claudeJson))?.mcpServers??{}),file:claudeJson,notInFiles:'claude.ai connectors and plugin servers: unknown'},
    measured:opts.claudeContext?parseClaudeContext(await readFile(opts.claudeContext,'utf8')):'not given: pass --claude-context FILE from claude -p "/context"',
  };

  // Codex
  const X=PLATFORMS.codex, config=codexConfig((await text(at(X.config)))??'');
  const codexCandidates:Candidate[]=await fromRoots(X.skillRoots,X.hide);
  for(const market of await dirs(at(X.pluginCache)))for(const plugin of await dirs(join(at(X.pluginCache),market))){
    const id=`${plugin}@${market}`, version=await newest(join(at(X.pluginCache),market,plugin));if(!version)continue;
    const flag=config.plugins[id], dir=join(at(X.pluginCache),market,plugin,version);
    codexCandidates.push({source:`plugin ${id}`,path:dir,enablement:flag===true?'enabled':flag===false?'disabled':'not in config',found:await skillsIn(join(dir,'skills'),X.hide)});
  }
  const disabledFiles=new Set(await Promise.all(config.disabledSkills.map(p=>realpath(p).catch(e=>{if(absent(e))return p;throw e;}))));
  const codexSkills=sources(codexCandidates,disabledFiles);
  const codex={
    instructions:{...await instructionFiles(X.instructions.map(l=>({path:at(l),loads:'start'}))),...((await text(at(X.instructions[1])))!==undefined?{note:'AGENTS.override.md exists; Codex reads it instead of AGENTS.md'}:{})},
    skills:{sources:codexSkills,...totals(codexSkills),rootsVerified:X.rootsVerified},
    mcpServers:{configured:config.mcpServers,file:at(X.config)},
    measured:await codexMeasured(at(X.sessions)),
  };

  // Cursor
  const R=PLATFORMS.cursor;
  const cursorCandidates:Candidate[]=await fromRoots(R.skillRoots);
  for(const market of await dirs(at(R.pluginCache)))for(const plugin of await dirs(join(at(R.pluginCache),market))){
    const version=await newest(join(at(R.pluginCache),market,plugin));if(!version)continue;
    const dir=join(at(R.pluginCache),market,plugin,version);
    cursorCandidates.push({source:`plugin ${plugin}@${market}`,path:dir,enablement:'unknown',found:await skillsIn(join(dir,'skills')),note:'enablement is set in the Cursor app UI'});
  }
  const cursorRules=(await dirs(at(R.ruleDir))).filter(n=>n.endsWith('.mdc')).map(n=>({path:join(at(R.ruleDir),n),loads:'unknown'}));
  const cursorSkills=sources(cursorCandidates);
  const cursor={
    instructions:{...await instructionFiles(cursorRules),userRules:R.userRules},
    skills:{sources:cursorSkills,...totals(cursorSkills),rootsVerified:R.rootsVerified,note:R.descriptions},
    mcpServers:{configured:Object.keys((await jsonFile<{mcpServers?:Record<string,unknown>}>(at(R.mcp)))?.mcpServers??{}),file:at(R.mcp),notInFiles:'plugin servers: unknown'},
    measured:'unknown: Cursor reports run totals only',
  };

  const report={generatedAt:now.toISOString(),home,labels:{estimatedTokens:'estimate: chars / 4',skillChars:'name + description from SKILL.md',measured:'read from a platform log or report'},platforms:{claude,codex,cursor}};
  if(!opts.save)return {...report,saved:null};
  const file=join(root,'.state','context-baseline',`${localDate(now)}.json`);
  await saveJSON(file,{...report,saved:file});
  return {...report,saved:file};
}
