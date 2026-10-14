import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';

export type Document = { id: string; title: string; domain: string; sourceUrl: string | null; content: string };
export type Snapshot = { core: string; documents: Document[]; provenance: string };
export type Release = Snapshot & { version: string; digest: string; createdAt: string };
export type Config = { schemaVersion: number; notionVersion: string; core: string; coreNotionPageId: string | null; documents: (Omit<Document, 'content'> & {path: string; notionPageId: string | null})[] };
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const digest = (s: Snapshot) => hash(JSON.stringify(s));
export function version(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value)) throw new Error('Version must be semver, for example 1.0.0.');
  return value;
}
export function inside(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path must stay inside the harness directory.');
  return target;
}
export async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')); }
export async function atomic(file: string, text: string) {
  await mkdir(dirname(file), {recursive:true});
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, text, {mode:0o600});
  await rename(tmp, file);
}
export async function saveJSON(file: string, value: unknown) { await atomic(file, JSON.stringify(value, null, 2) + '\n'); }
export async function loadSnapshot(root: string): Promise<Snapshot> {
  const c = await json<Config>(join(root, 'harness.config.json'));
  const documents = await Promise.all(c.documents.map(async d => ({id:d.id,title:d.title,domain:d.domain,sourceUrl:d.sourceUrl,content:await readFile(inside(root,d.path),'utf8')})));
  if (new Set(documents.map(d=>d.id)).size !== documents.length) throw new Error('Document IDs must be unique.');
  if (documents.some(d=>!['engineering','communication'].includes(d.domain))) throw new Error('This release only allows engineering and communication.');
  const core = await readFile(inside(root,c.core),'utf8');
  if (!core.trim() || documents.some(d=>!d.content.trim())) throw new Error('Empty core or reference document.');
  let provenance = 'bootstrap-local; live Notion reconciliation pending';
  try {
    const p = await json<{contentHash:string; fetchedAt:string; source?:string}>(join(root,'.state/notion-import.json'));
    if (p.contentHash === hash(JSON.stringify({core,documents}))) provenance = `${p.source==='notion-plugin-export'?'notion-plugin-export':'notion-import'}:${p.fetchedAt}`;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return {core, documents, provenance};
}
export function render(r: Release) {
  // Claude Code hides HTML comments, so the plain-text first line is how an agent can report its release.
  // Keep the comment: the rules scanner matches "Agentic harness release".
  const body = `Harness release ${r.version}.\n<!-- Agentic harness release ${r.version}; digest ${r.digest} -->\n${r.core.trim()}\n`;
  return {
    'codex/AGENTS.md':body,
    'claude/CLAUDE.md':body,
    'cursor/user-rules.md':body,
    'cursor/agentic-harness.mdc':`---\ndescription: Shared global engineering policy export\nalwaysApply: true\n---\n\n${body}`,
    'grok-bot/bot-description.md':body,
    'grok-bot/SKILL.md':`---\nname: agentic-harness\ndescription: Shared pragmatic engineering policy; use for all engineering tasks.\n---\n\n${body}`,
    'generic/instructions.md':body
  };
}
export async function publish(root: string, v: string, approvedDigest: string, bootstrap = false) {
  version(v);
  const s = await loadSnapshot(root);
  if (digest(s) !== approvedDigest) throw new Error('Source changed or digest not approved. Run preview and review again.');
  if (!bootstrap && !/^notion-(?:import|plugin-export):/.test(s.provenance)) throw new Error('Import Notion first, or use --bootstrap for a release made from local files.');
  const r: Release = {...s,version:v,digest:digest(s),createdAt:new Date().toISOString()};
  const dir = join(root,'releases',v);
  try { const old = await readRelease(root,v); if (old.digest === r.digest) return old; throw new Error('Release versions are immutable. Choose a new version.'); }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const tmp = join(root,'.state','release-'+randomUUID());
  await saveJSON(join(tmp,'release.json'),r);
  for (const [name,content] of Object.entries(render(r))) await atomic(join(tmp,name),content);
  for (const platform of ['codex','claude','cursor','grok-bot','generic']) await atomic(join(tmp,platform,'README.md'),`# ${platform} release ${v}\n\nGenerated from approved core policy. Do not edit this copy. Read docs/README.md and docs/platforms.md in the harness repository for global installation, verification, rollback, and limitations. Source digest: ${r.digest}.\n\n${platform==='cursor'?'Use user-rules.md in global User Rules. The .mdc file is an optional project-format export; it does not establish global coverage.':platform==='grok-bot'?'Install bot-description.md in each Bot description and the skill in its shared computer. Profile installation and fresh-task verification are still required.':'Install the complete instructions in the platform global configuration, not only a link.'}\n`);
  await atomic(join(tmp,'README.md'),`# Harness ${v}\n\nImmutable reviewed release. Provenance: ${r.provenance}. Digest: ${r.digest}. Platform instructions are generated from the same core. See the root README for installation and source editing.\n`);
  await mkdir(dirname(dir),{recursive:true}); await rename(tmp,dir);
  await activate(root,v);
  return r;
}
export async function readRelease(root: string, v: string): Promise<Release> {
  const r = await json<Release>(join(root,'releases',version(v),'release.json'));
  if(r.version!==v || digest({core:r.core,documents:r.documents,provenance:r.provenance})!==r.digest) throw new Error('Release integrity check failed.');
  return r;
}
export async function activate(root:string,v:string) { await readRelease(root,v); await saveJSON(join(root,'.state/current.json'),{version:v}); }
export async function activeVersion(root:string):Promise<string|null> {
  try { return (await json<{version:string}>(join(root,'.state/current.json'))).version; }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return null; }
}
export async function current(root:string):Promise<Release> {
  const v=await activeVersion(root);
  if(!v) throw new Error('No active release. Run activate VERSION after cloning, or publish a release.');
  return readRelease(root,v);
}
export type Chunk = { id:string; documentId:string; title:string; heading:string; domain:string; sourceUrl:string | null; content:string; contentHash:string };
export function chunks(documents:Document[], max=2400):Chunk[] {
  const out:Chunk[]=[];
  for(const d of documents) {
    let heading=d.title, buffer='', index=0;
    const flush=()=>{if(buffer.trim()){const content=buffer.trim();out.push({id:`${d.id}:${index++}`,documentId:d.id,title:d.title,heading,domain:d.domain,sourceUrl:d.sourceUrl,content,contentHash:hash(content)});buffer='';}};
    for(const line of d.content.split('\n')) {
      if(/^#{1,6}\s/.test(line)){flush();heading=line.replace(/^#+\s/,'');}
      for(let i=0;i<Math.max(line.length,1);i+=max){const part=line.slice(i,i+max);if(buffer.length+part.length+1>max)flush();buffer+=part+'\n';}
    }
    flush();
  }
  return out;
}
export function localSearch(r:Release, query:string, limit=5, domain?:string) {
  const terms=[...new Set(query.toLowerCase().match(/[a-z0-9-]{2,}/g)||[])];
  return chunks(r.documents).filter(c=>!domain||c.domain===domain).map(c=>({...c,score:terms.reduce((n,t)=>n+(c.content.toLowerCase().includes(t)?1:0)+(c.heading.toLowerCase().includes(t)?2:0),0)})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,Math.min(Math.max(limit,1),10));
}
