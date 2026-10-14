import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { CODE_ROOT } from './env.ts';
import { z } from 'zod';
import { hash, atomic, saveJSON, json, version, inside } from './core.ts';
import { safeRead, section, markers, packMarkers, packFile, packReceipts, packReceiptDir, verifyPacks } from './install.ts';
import type { Receipt, PackReceipt } from './install.ts';

const CATEGORIES=['security','writing','data','testing','agent-design'] as const;
const LICENSES=['MIT','Apache-2.0','CC-BY-4.0','CC0-1.0'] as const;
const PLATFORMS=['codex','claude','cursor','generic'] as const;
// Pack platform -> base installer whose receipt locates the target file.
const BASE:Record<string,string>={claude:'claude',codex:'codex',cursor:'cursor-files'};
const MAX_PACK=8*1024, MAX_PLATFORM=24*1024;
const SLUG='[a-z0-9]+(?:-[a-z0-9]+)*';
const ID=new RegExp(`^(?=[^/]{1,39}/)${SLUG}/(?=.{3,40}$)${SLUG}$`);
const PRECEDENCE='These rules add to the base Agentic Harness policy. If a rule here conflicts with the base policy, follow the base policy. If two add-on packs conflict, follow the base policy and tell the user about the conflict. Pack order does not set priority.';
const LINT:[RegExp,string][]=[
  [/<[a-z!\/?]/i,'HTML or HTML comments'],
  [/^---[ \t]*\n/,'front matter'],
  [/\b(?:BEGIN|END) AGENTIC(?: AGENT)? HARNESS|\bagentic harness (?:release|pack)\b/i,'harness marker strings'],
  [/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/,'zero-width or bidirectional control characters'],
  [/[\u0000-\u0008\u000B-\u001F\u007F]/,'control characters'],
  [/[A-Za-z0-9+\/=]{201,}/,'an encoded-looking run over 200 characters']
];
const semver=z.string().refine(v=>{try{version(v);return true;}catch{return false;}},'Must be semver, for example 1.0.0.');
const plain=(max:number)=>z.string().min(1).max(max).refine(s=>!/[\n<>]|https?:|www\./i.test(s),'Plain text only: no line breaks, HTML, or URLs.');
const Manifest=z.strictObject({
  schemaVersion:z.literal(1),
  id:z.string().regex(ID,'Pack ID must be author/pack-id using lowercase letters, digits, and single hyphens.'),
  name:plain(60),
  category:z.enum(CATEGORIES),
  version:semver,
  author:z.strictObject({name:plain(60),github:z.string().max(39).regex(new RegExp(`^${SLUG}$`))}),
  license:z.enum(LICENSES),
  description:plain(200),
  minHarness:semver,
  platforms:z.array(z.enum(PLATFORMS)).min(1).refine(p=>new Set(p).size===p.length,'Platforms must be unique.'),
  digest:z.string().regex(/^[0-9a-f]{64}$/,'Digest must be 64 lowercase hex characters.')
}).refine(m=>m.id.startsWith(m.author.github+'/'),{message:'The pack ID namespace must equal author.github.',path:['id']});
export type Pack=z.infer<typeof Manifest>&{rules:string};
type Index={schemaVersion:1;categories:readonly string[];packs:{id:string;name:string;category:string;author:{name:string;github:string};license:string;description:string;versions:{version:string;digest:string;bytes:number;minHarness:string;platforms:string[];path:string}[]}[]};

// Fixed key order, like readRelease() rebuilding {core, documents, provenance}: contributor key order must not change the digest.
export const packDigest=(p:Omit<Pack,'digest'>)=>hash(JSON.stringify({schemaVersion:p.schemaVersion,id:p.id,name:p.name,category:p.category,version:p.version,author:{name:p.author.name,github:p.author.github},license:p.license,description:p.description,minHarness:p.minHarness,platforms:p.platforms,rules:p.rules}));
const parts=(v:string)=>v.split('-')[0].split('.').map(Number);
const compare=(a:string,b:string)=>{const x=parts(a),y=parts(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const notFound=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
function packId(id:string){if(!ID.test(id))throw new Error('Pack ID must be author/pack-id, for example example-author/security-basics.');return id;}
export const packReceiptPath=(root:string,platform:string,id:string)=>join(packReceiptDir(root,platform),id.replace('/','__')+'.json');
const backupPath=(platform:string)=>join('.state','backups','packs',platform,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.txt`);
// The "local" author is reserved for packs that rules apply adopts from your own rule files. They stay private in .state/packs/local/, never in the public catalog.
export const LOCAL_AUTHOR='local';
const isLocal=(id:string)=>id.startsWith(LOCAL_AUTHOR+'/');
const packHome=(id:string)=>isLocal(id)?join('.state','packs'):join('catalog','packs');
// The public catalog ships with the engine code. A harness root that has its own catalog/ folder (a maintainer clone or a fork) uses that one instead.
const catalogBase=(root:string)=>existsSync(join(root,'catalog'))?root:CODE_ROOT;
const packBase=(root:string,id:string)=>isLocal(id)?root:catalogBase(root);
const harnessVersion=async()=>(await json<{version:string}>(fileURLToPath(new URL('../package.json',import.meta.url)))).version;

export function lintRules(rules:string):string|undefined {
  const bytes=Buffer.byteLength(rules);
  if(bytes>MAX_PACK)return `rules.md is ${bytes} bytes; the limit is ${MAX_PACK}.`;
  if(!rules.trim())return 'rules.md is empty.';
  for(const [pattern,label] of LINT) if(pattern.test(rules))return `rules.md contains ${label}.`;
}
async function checkPack(manifest:unknown,rules:string):Promise<Pack> {
  const lint=lintRules(rules);
  if(lint)throw new Error(lint);
  const parsed=Manifest.safeParse(manifest);
  if(!parsed.success)throw new Error('Invalid pack.json: '+parsed.error.issues.map(i=>`${i.path.join('.')||'manifest'}: ${i.message}`).join('; '));
  const pack={...parsed.data,rules};
  if(packDigest(pack)!==pack.digest)throw new Error('Pack digest mismatch: pack.json digest does not match the manifest and rules.md.');
  const harness=await harnessVersion();
  if(compare(harness,pack.minHarness)<0)throw new Error(`Pack needs harness ${pack.minHarness} or later; this is ${harness}.`);
  return pack;
}
export async function loadPack(dir:string):Promise<Pack> {
  const entries=await readdir(dir,{withFileTypes:true});
  if(entries.map(e=>e.name).sort().join()!=='pack.json,rules.md'||entries.some(e=>!e.isFile()))throw new Error('A pack folder must contain exactly pack.json and rules.md as regular files.');
  const bytes=await readFile(join(dir,'rules.md'));
  if(bytes.length>MAX_PACK)throw new Error(`rules.md is ${bytes.length} bytes; the limit is ${MAX_PACK}.`);
  let rules:string;
  try{rules=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n/g,'\n');}catch{throw new Error('rules.md must be valid UTF-8.');}
  return checkPack(await json(join(dir,'pack.json')),rules);
}
export async function readPack(root:string,ref:string):Promise<Pack> {
  const at=ref.lastIndexOf('@');
  if(at<0)throw new Error('Name an exact version: AUTHOR/ID@VERSION. There is no latest.');
  const id=packId(ref.slice(0,at)),v=version(ref.slice(at+1)),dir=inside(packBase(root,id),join(packHome(id),id,v)),where=isLocal(id)?'.state/packs/':'catalog/';
  const pack=await loadPack(dir).catch(async e=>{
    if(!notFound(e))throw e;
    const versions=await readdir(inside(packBase(root,id),join(packHome(id),id))).catch(e=>{if(notFound(e))return [];throw e;});
    throw new Error(`${id}@${v} is not in ${where}. Available versions: ${versions.filter(n=>!n.startsWith('.')).sort(compare).join(', ')||'none'}.`);
  });
  if(pack.id!==id||pack.version!==v)throw new Error(`pack.json id and version must match the ${where} folder.`);
  // Local packs have no catalog index; rules apply wrote them after you approved their digest.
  if(isLocal(id))return pack;
  const index=await json<Index>(join(catalogBase(root),'catalog','index.json'));
  if(index.packs.find(p=>p.id===id)?.versions.find(x=>x.version===v)?.digest!==pack.digest)throw new Error('catalog/index.json does not list this pack digest. Run catalog build and review the change.');
  return pack;
}
// Reuses the newest local version when its title and text are unchanged; otherwise plans the next patch version. Writes nothing.
export async function localPack(root:string,name:string,title:string,rules:string,description:string):Promise<{pack:Pack;exists:boolean}> {
  const id=packId(`${LOCAL_AUTHOR}/${name}`), base=inside(root,join(packHome(id),id));
  const latest=(await readdir(base).catch(e=>{if(notFound(e))return [] as string[];throw e;})).filter(v=>!v.startsWith('.')).sort(compare).at(-1);
  if(latest){const old=await loadPack(join(base,latest));if(old.rules===rules&&old.name===title)return {pack:old,exists:true};}
  const [x,y,z]=latest?parts(latest):[1,0,-1];
  const manifest={schemaVersion:1 as const,id,name:title,category:'agent-design' as const,version:`${x}.${y}.${z+1}`,author:{name:'Local rules',github:LOCAL_AUTHOR},license:'CC0-1.0' as const,description,minHarness:await harnessVersion(),platforms:['claude','codex','cursor'] as Pack['platforms']};
  return {pack:await checkPack({...manifest,digest:packDigest({...manifest,rules})},rules),exists:false};
}
export async function writeLocalPack(root:string,pack:Pack) {
  if(!isLocal(pack.id))throw new Error(`${pack.id} is not a local pack.`);
  const dir=inside(root,join(packHome(pack.id),pack.id,pack.version)), {rules,...manifest}=pack;
  await atomic(join(dir,'rules.md'),rules);
  await saveJSON(join(dir,'pack.json'),manifest);
  return dir;
}
export function renderPack(p:Pack) {
  const [begin,end]=packMarkers(p.id);
  return `${begin}\n<!-- Agentic harness pack ${p.id} ${p.version}; digest ${p.digest} -->\n## Add-on rule pack: ${p.name} (${p.version})\n${PRECEDENCE}\n\n${p.rules.trim()}\n${end}`;
}
export const renderPackFile=(p:Pack)=>`---\ndescription: Agentic Harness add-on pack ${p.id} ${p.version}\nalwaysApply: true\n---\n\n${renderPack(p)}\n`;
function basePlatform(platform:string) {
  const base=BASE[platform];
  if(!base)throw new Error(`Packs install into ${Object.keys(BASE).join(', ')} in this version.`);
  return base;
}
export type PackPlan={pack:Pack;path:string;text:string;block:string;next:string;afterLine?:number;scope?:'file'};
const plan=async(root:string,ref:string,platform:string)=>planPack(root,await readPack(root,ref),platform);
// current replaces the target file text, so rules apply can place the pack after its own edits to the same file.
export async function planPack(root:string,pack:Pack,platform:string,current?:string):Promise<PackPlan> {
  const baseName=basePlatform(platform);
  if(!pack.platforms.some(p=>p===platform))throw new Error(`${pack.id} does not support ${platform}.`);
  const receipts=await packReceipts(root,platform);
  if(receipts.some(r=>r.pack.id===pack.id))throw new Error(`${pack.id} is already installed on ${platform}. Remove it first.`);
  const total=receipts.reduce((n,r)=>n+r.bytes,0)+Buffer.byteLength(pack.rules);
  if(total>MAX_PLATFORM)throw new Error(`Packs on ${platform} would total ${total} bytes; the limit is ${MAX_PLATFORM}.`);
  const base=await json<Receipt>(join(root,'.state','installations',baseName+'.json')).catch(e=>{if(notFound(e))throw new Error(`Install the base policy first: install ${baseName}.`);throw e;});
  if(platform==='cursor') {
    // The Cursor base install owns only the MCP entry in ~/.cursor/mcp.json; the base policy is in User Rules. Pack files go in the rules folder next to mcp.json.
    const basePath=base.files.find(f=>f.scope==='cursor-mcp')?.path;
    if(!basePath||!(await safeRead(basePath)).existed)throw new Error(`The base install file ${basePath??'mcp.json'} is missing; run install cursor-files first.`);
    const path=join(dirname(basePath),'rules',packFile(pack.id));
    if((await safeRead(path)).existed)throw new Error(`An unmanaged file for ${pack.id} already exists at ${path}. Remove it manually.`);
    const file=renderPackFile(pack);
    return {pack,path,text:'',block:file,next:file,scope:'file'};
  }
  const path=base.files[0].path, text=current??(await safeRead(path)).text;
  let at:number;
  try{at=section(text,markers('instructions'))[1];}
  catch(e){throw new Error(`${(e as Error).message} The base policy block in ${path} is required; run install ${platform} first.`);}
  if(packMarkers(pack.id).some(m=>text.includes(m)))throw new Error(`An unmanaged section for ${pack.id} already exists in ${path}. Remove it manually.`);
  for(const r of receipts)at=Math.max(at,section(text,packMarkers(r.pack.id))[1]);
  const block=renderPack(pack);
  return {pack,path,text,block,next:text.slice(0,at)+'\n\n'+block+text.slice(at),afterLine:text.slice(0,at).split('\n').length};
}
export async function previewPack(root:string,ref:string,platform:string) {
  const {pack:{rules,...manifest},path,block,afterLine}=await plan(root,ref,platform);
  return {...manifest,bytes:Buffer.byteLength(rules),target:path,afterLine,block,approve:`pack add ${manifest.id}@${manifest.version} --platform ${platform} --approve-sha ${manifest.digest}`};
}
export const packReceipt=(platform:string,p:Pick<PackPlan,'pack'|'path'|'block'|'scope'>,backup:string,installedAt=new Date().toISOString()):PackReceipt=>({platform,pack:{id:p.pack.id,version:p.pack.version,digest:p.pack.digest},bytes:Buffer.byteLength(p.pack.rules),files:[{path:p.path,ownedHash:hash(p.block),backup,...(p.scope?{scope:p.scope}:{})}],installedAt,verification:'files installed; fresh-session behavior not yet verified'});
export async function addPack(root:string,ref:string,platform:string,approvedDigest:string) {
  const p=await plan(root,ref,platform);
  if(p.pack.digest!==approvedDigest)throw new Error('Digest not approved. Run pack add without --approve-sha, read the full text, and approve its digest.');
  const backup=backupPath(platform), receipt=packReceipt(platform,p,backup);
  await atomic(join(root,backup),p.text);
  await atomic(p.path,p.next);
  try{await saveJSON(packReceiptPath(root,platform,p.pack.id),receipt);}
  catch(e){if(p.scope==='file')await unlink(p.path);else await atomic(p.path,p.text);throw e;}
  return receipt;
}
export async function removePack(root:string,id:string,platform:string) {
  basePlatform(platform);
  const file=packReceiptPath(root,platform,packId(id));
  const r=await json<PackReceipt>(file).catch(e=>{if(notFound(e))throw new Error(`${id} is not installed on ${platform}.`);throw e;});
  const {path,ownedHash,scope}=r.files[0], {text,existed}=await safeRead(path);
  if(!existed)throw new Error(`${path} no longer exists. Delete the receipt ${file} to finish the removal.`);
  if(scope==='file') {
    if(hash(text)!==ownedHash)throw new Error('Pack file changed since installation. Refusing to delete newer user changes.');
    await atomic(join(root,backupPath(platform)),text);
    await unlink(path);
    try{await unlink(file);}
    catch(e){await atomic(path,text);throw e;}
    return {removed:id,platform,path};
  }
  const [a,b]=section(text,packMarkers(id));
  if(hash(text.slice(a,b))!==ownedHash)throw new Error('Pack section changed since installation. Refusing to overwrite newer user changes.');
  await atomic(join(root,backupPath(platform)),text);
  // Cut the blank line the installer added, so the file returns to its exact pre-add bytes.
  await atomic(path,text.slice(0,text.slice(a-2,a)==='\n\n'?a-2:a)+text.slice(b));
  try{await unlink(file);}
  catch(e){await atomic(path,text);throw e;}
  return {removed:id,platform,path};
}
export async function listPacks(root:string) {
  const index=await json<Index>(join(catalogBase(root),'catalog','index.json'));
  return {available:index.packs.map(p=>({id:p.id,name:p.name,category:p.category,license:p.license,description:p.description,versions:p.versions.map(v=>v.version)})),installed:{claude:await verifyPacks(root,'claude'),codex:await verifyPacks(root,'codex'),cursor:await verifyPacks(root,'cursor')}};
}
async function folders(dir:string) {
  const entries=(await readdir(dir,{withFileTypes:true})).filter(e=>!e.name.startsWith('.'));
  const files=entries.filter(e=>!e.isDirectory());
  if(files.length)throw new Error(`Only folders are allowed in ${dir}: ${files.map(e=>e.name).join(', ')}`);
  return entries.map(e=>e.name).sort();
}
export async function buildCatalog(root:string) {
  const base=join(catalogBase(root),'catalog','packs'), index:Index={schemaVersion:1,categories:CATEGORIES,packs:[]};
  const authors=await folders(base);
  if(authors.includes(LOCAL_AUTHOR))throw new Error(`catalog/packs/${LOCAL_AUTHOR} is reserved for packs adopted by rules apply, which live in .state/packs/${LOCAL_AUTHOR}/. Rename that folder.`);
  for(const author of authors) for(const name of await folders(join(base,author))) {
    const id=packId(`${author}/${name}`), loaded:Pack[]=[];
    for(const v of (await folders(join(base,author,name))).sort(compare)) {
      const pack=await loadPack(join(base,author,name,version(v)));
      if(pack.id!==id||pack.version!==v)throw new Error(`pack.json id and version must match the folder ${author}/${name}/${v}.`);
      loaded.push(pack);
    }
    const {category,author:by,license,description,name:title}=loaded[loaded.length-1];
    index.packs.push({id,name:title,category,author:by,license,description,versions:loaded.map(p=>({version:p.version,digest:p.digest,bytes:Buffer.byteLength(p.rules),minHarness:p.minHarness,platforms:p.platforms,path:`packs/${id}/${p.version}`}))});
  }
  await saveJSON(join(catalogBase(root),'catalog','index.json'),index);
  return index;
}
