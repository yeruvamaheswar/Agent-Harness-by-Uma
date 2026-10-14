import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {json,atomic,saveJSON,inside,loadSnapshot,hash} from './core.ts';
import type {Config} from './core.ts';
import {env} from './env.ts';

type RichText={plain_text?:string;text?:{content:string;link?:{url:string}}};
type Block={id:string;type:string;has_children?:boolean;[key:string]:unknown};
export class Notion {
  private token:string;
  private apiVersion:string;
  private request:typeof fetch;
  constructor(token:string,apiVersion:string,request:typeof fetch=fetch){this.token=token;this.apiVersion=apiVersion;this.request=request;}
  async get(path:string):Promise<any>{
    for(let attempt=0;attempt<4;attempt++){
      const r=await this.request('https://api.notion.com/v1/'+path,{headers:{Authorization:`Bearer ${this.token}`,'Notion-Version':this.apiVersion},signal:AbortSignal.timeout(30000)});
      if(r.ok)return r.json();
      if((r.status===429||r.status>=500)&&attempt<3){await new Promise(resolve=>setTimeout(resolve,Math.min(Number(r.headers.get('retry-after'))||2**attempt,10)*1000));continue;}
      throw new Error(`Notion request failed (${r.status}). Verify page sharing and credentials; no content was imported.`);
    }
    throw new Error('Notion retries exhausted.');
  }
  async blocks(id:string,depth=0):Promise<string>{
    if(depth>20)throw new Error('Notion nesting exceeds supported depth.');
    let cursor:string|undefined,lines:string[]=[];
    do {
      const page=await this.get(`blocks/${encodeURIComponent(id)}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);
      for(const b of page.results as Block[]){
        const value=b[b.type] as any;
        const text=(value?.rich_text||[]).map((t:RichText)=>t.plain_text??t.text?.content??'').join('');
        let line='';
        if(b.type.startsWith('heading_'))line='#'.repeat(Number(b.type.slice(-1)))+' '+text;
        else if(['paragraph','toggle','quote','callout'].includes(b.type))line=text;
        else if(b.type==='bulleted_list_item')line='- '+text;
        else if(b.type==='numbered_list_item')line='1. '+text;
        else if(b.type==='to_do')line=`- [${value.checked?'x':' '}] ${text}`;
        else if(b.type==='code')line='```'+(value.language||'')+'\n'+text+'\n```';
        else if(b.type==='divider')line='---';
        else if(['bookmark','link_preview','embed'].includes(b.type))line=value.url;
        else if(b.type==='table_row')line='| '+value.cells.map((cell:RichText[])=>cell.map(t=>t.plain_text??t.text?.content??'').join('')).join(' | ')+' |';
        else if(['table','column','column_list','synced_block'].includes(b.type))line='';
        else if(b.type==='child_page')line=`[Child page: ${value.title}](https://www.notion.so/${b.id.replaceAll('-','')})`;
        else throw new Error(`Unsupported Notion block ${b.type}; refusing an incomplete import.`);
        if(line)lines.push(line);
        if(b.has_children&&b.type!=='child_page')lines.push(await this.blocks(b.id,depth+1));
      }
      cursor=page.has_more?page.next_cursor:undefined;
      if(page.has_more&&!cursor)throw new Error('Notion pagination cursor missing.');
    }while(cursor);
    return lines.join('\n\n')+'\n';
  }
}
export async function importNotion(root:string){
  const config=await json<Config>(join(root,'harness.config.json'));
  if(!config.coreNotionPageId||config.documents.some(d=>!d.notionPageId))throw new Error('Map the core and all approved reference pages first. See docs/notion.md.');
  const client=new Notion(env('NOTION_TOKEN'),config.notionVersion);
  const targets=[{id:config.coreNotionPageId,path:config.core},...config.documents.map(d=>({id:d.notionPageId!,path:d.path}))];
  const fetched:{path:string;text:string;previous:string}[]=[];
  for(const t of targets){
    const metadata=await client.get(`pages/${t.id}`);
    if(metadata.archived||metadata.in_trash)throw new Error('A mapped page is archived. Remove it from the allowlist deliberately before publishing.');
    const text=await client.blocks(t.id);
    const after=await client.get(`pages/${t.id}`);
    if(metadata.last_edited_time!==after.last_edited_time)throw new Error('Notion page changed during export. Retry after editing finishes.');
    if(!text.trim())throw new Error('Mapped Notion page is empty; refusing incomplete import.');
    const path=inside(root,t.path);fetched.push({path,text,previous:await readFile(path,'utf8')});
  }
  const written:typeof fetched=[];
  try{
    for(const f of fetched){await atomic(f.path,f.text);written.push(f);}
    const {core,documents}=await loadSnapshot(root);
    await saveJSON(join(root,'.state/notion-import.json'),{fetchedAt:new Date().toISOString(),contentHash:hash(JSON.stringify({core,documents}))});
  }catch(e){for(const f of written.reverse())await atomic(f.path,f.previous);throw e;}
  return {imported:fetched.length,next:'Run preview, review the changed source files, then publish with the new digest.'};
}

export type PluginExport={schemaVersion:number;exportedAt:string;pages:{url:string;text:string;page_last_edited_at?:string;truncated?:boolean;unknown_block_count?:number}[]};
export function pluginPageContent(payload:PluginExport,id:string){
  if(payload.schemaVersion!==1||!Number.isFinite(Date.parse(payload.exportedAt)))throw new Error('Invalid Notion plugin export metadata.');
  const normalize=(s:string)=>s.replaceAll('-','').toLowerCase();
  const matches=payload.pages.filter(p=>{const u=new URL(p.url);if(!['app.notion.com','www.notion.so','notion.so'].includes(u.hostname))return false;return normalize(u.pathname).endsWith(normalize(id));});
  if(matches.length!==1)throw new Error('Expected exactly one exported page for mapped ID '+id);
  const page=matches[0];
  if(page.truncated||page.unknown_block_count||page.text.includes('<unknown ')||!page.page_last_edited_at)throw new Error('Notion plugin export is incomplete or lacks page metadata.');
  const a=page.text.indexOf('<content>'),b=page.text.lastIndexOf('</content>');
  if(a<0||b<a)throw new Error('Missing complete Notion page content.');
  const content=page.text.slice(a+9,b).trim();
  if(!content)throw new Error('Mapped Notion page is empty.');
  return content+'\n';
}
export async function importPluginExport(root:string,file:string){
  const config=await json<Config>(join(root,'harness.config.json'));
  if(!config.coreNotionPageId||config.documents.some(d=>!d.notionPageId))throw new Error('Map all Notion pages first.');
  const payload=await json<PluginExport>(file);
  const targets=[{id:config.coreNotionPageId,path:config.core},...config.documents.map(d=>({id:d.notionPageId!,path:d.path}))];
  const writes=await Promise.all(targets.map(async t=>({path:inside(root,t.path),text:pluginPageContent(payload,t.id),previous:await readFile(inside(root,t.path),'utf8')})));
  const written:typeof writes=[];
  try{
    for(const w of writes){await atomic(w.path,w.text);written.push(w);}
    const {core,documents}=await loadSnapshot(root);
    await saveJSON(join(root,'.state/notion-import.json'),{source:'notion-plugin-export',fetchedAt:payload.exportedAt,contentHash:hash(JSON.stringify({core,documents})),pageIds:targets.map(t=>t.id)});
  }catch(e){for(const w of written.reverse())await atomic(w.path,w.previous);throw e;}
  return {imported:writes.length,source:'notion-plugin-export',next:'Review the diff, then preview and publish. Plugin exports are validated local inputs, not cryptographically authenticated snapshots.'};
}
