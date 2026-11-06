import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {skillMeta} from './context.ts';
import {frontmatter} from './rules.ts';

export const SKILL_GROUPS = ['Planning', 'Execution', 'Quality', 'Communication', 'Platform'] as const;
const STATUSES = ['stable', 'beta', 'experimental'] as const;
const FIELDS = ['Group', 'Status', 'Needs', 'Example', 'Result'] as const;
export const BEGIN = '<!-- BEGIN GENERATED: skills -->';
export const END = '<!-- END GENERATED: skills -->';
const REFERENCE = 'docs/skills.md';
const GENERATED = ['README.md', 'docs/project-explainer.html'] as const;

export type CatalogSkill = {
  name:string;
  description:string;
  hidden:boolean;
  group:typeof SKILL_GROUPS[number];
  status:typeof STATUSES[number];
};

async function read(root:string, file:string):Promise<string|undefined> {
  try {return await readFile(join(root,file),'utf8');}
  catch(error) {if(error instanceof Error && 'code' in error && error.code==='ENOENT')return undefined; throw error;}
}

async function catalog(root:string) {
  const differences:string[]=[], skills:CatalogSkill[]=[];
  const source='tools/agents/skills';
  // Match the installer's source-folder rule: visible directories, sorted by name.
  const folders=(await readdir(join(root,source),{withFileTypes:true}))
    .filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).map(entry=>entry.name).sort();
  const reference=await read(root,REFERENCE);
  if(reference===undefined)differences.push(`${REFERENCE}: missing file`);
  const sections=new Map<string,string>();
  for(const match of (reference??'').matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    const name=match[1].trim();
    if(sections.has(name))differences.push(`${REFERENCE}: duplicate section for "${name}"`);
    sections.set(name,match[2]);
  }
  for(const name of sections.keys())if(!folders.includes(name))differences.push(`${REFERENCE}: section for "${name}" has no skill folder`);
  for(const folder of folders) {
    const file=`${source}/${folder}/SKILL.md`, text=await read(root,file);
    const meta=skillMeta(text??'');
    if(text===undefined)differences.push(`${file}: missing SKILL.md for "${folder}"`);
    else {
      const parsed=frontmatter(text);
      if(parsed.error)differences.push(`${file}: "${folder}": ${parsed.error}`);
      if(meta.name!==folder)differences.push(`${file}: name "${meta.name??''}" differs from folder "${folder}"`);
      if(!meta.description)differences.push(`${file}: missing description for "${folder}"`);
      if(meta['disable-model-invocation']!==undefined&&!['true','false'].includes(meta['disable-model-invocation']))
        differences.push(`${file}: invalid disable-model-invocation for "${folder}"`);
    }
    const section=sections.get(folder);
    if(section===undefined) {differences.push(`${REFERENCE}: missing section for "${folder}"`);continue;}
    const fields=new Map<string,string>();
    for(const field of FIELDS) {
      const matches=[...section.matchAll(new RegExp(`^${field}:[ \\t]*(.*)$`,'gm'))];
      if(matches.length!==1||!matches[0][1].trim())differences.push(`${REFERENCE}: "${folder}" needs exactly one nonempty ${field}: line`);
      fields.set(field,matches[0]?.[1].trim()??'');
    }
    const group=SKILL_GROUPS.find(value=>value===fields.get('Group'));
    const status=STATUSES.find(value=>value===fields.get('Status'));
    if(!group)differences.push(`${REFERENCE}: bad Group for "${folder}" (allowed: ${SKILL_GROUPS.join(', ')})`);
    if(!status)differences.push(`${REFERENCE}: bad Status for "${folder}" (allowed: ${STATUSES.join(', ')})`);
    if(group&&status)skills.push({name:folder,description:meta.description??'',hidden:meta['disable-model-invocation']==='true',group,status});
  }
  return {skills,count:folders.length,differences};
}

const purpose=(skill:CatalogSkill)=>skill.description.match(/^.*?[.!?](?=\s|$)/)?.[0]??skill.description;
const usage=(skill:CatalogSkill)=>`/${skill.name}; Codex $${skill.name}. ${skill.hidden?'Load only by name.':'Also loads by description.'}`;
const html=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]??char));
const markdown=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'&#124;').replace(/\n/g,' ');

export function renderMarkdownBlock(skills:CatalogSkill[]):string {
  return [BEGIN,'| Skill | Status | What it does | How to use |','| --- | --- | --- | --- |',
    ...skills.map(skill=>`| ${markdown(skill.name)} | ${skill.status} | ${markdown(purpose(skill))} | ${markdown(usage(skill))} |`),END].join('\n');
}

export function renderHtmlBlock(skills:CatalogSkill[]):string {
  return [BEGIN,'<ul class="skill-catalog">',...skills.map(skill=>
    `  <li data-skill="${html(skill.name)}" data-group="${skill.group}" data-status="${skill.status}"><code>${html(skill.name)}</code> <span>${skill.status}</span><p>${html(purpose(skill))}</p><p>${html(usage(skill))}</p></li>`),'</ul>',END].join('\n');
}

function blockRange(text:string):[number,number]|undefined {
  const start=text.indexOf(BEGIN), end=text.indexOf(END);
  if(start<0||end<start||text.split(BEGIN).length!==2||text.split(END).length!==2)return undefined;
  return [start,end+END.length];
}

function blockItems(file:typeof GENERATED[number], block:string):Map<string,string[]> {
  const items=new Map<string,string[]>();
  const matches=file==='README.md'
    ? block.matchAll(/^\| ([^|]+) \|.*$/gm)
    : block.matchAll(/<li\b[^>]*\bdata-skill="([^"]*)"[^>]*>[\s\S]*?<\/li>/g);
  for(const match of matches) {
    const name=match[1].trim();
    if(file==='README.md'&&(name==='Skill'||name==='---'))continue;
    const entries=items.get(name)??[];
    entries.push(match[0]);
    items.set(name,entries);
  }
  return items;
}

function blockDifferences(file:typeof GENERATED[number], actual:string, expected:string):string[] {
  const differences:string[]=[];
  const actualItems=blockItems(file,actual), expectedItems=blockItems(file,expected);
  const kind=file==='README.md'?'row':'item';
  for(const [name,entries] of expectedItems) {
    const found=actualItems.get(name);
    if(!found)differences.push(`${file}: ${kind} for "${name}" is missing`);
    else if(found.length!==1||found[0]!==entries[0])
      differences.push(`${file}: ${kind} for "${name}" differs from tools/agents/skills/${name}/SKILL.md`);
  }
  for(const name of actualItems.keys())if(!expectedItems.has(name))
    differences.push(`${file}: ${kind} for "${name}" has no skill folder`);
  if(!differences.length)differences.push(`${file}: block has unexpected content`);
  return differences;
}

function insertBlock(file:typeof GENERATED[number], text:string, block:string):string {
  if(file==='README.md') {
    const heading=/^## Skills[ \t]*$/m.exec(text);
    if(heading)return text.slice(0,heading.index+heading[0].length)+'\n\n'+block+text.slice(heading.index+heading[0].length);
    return text.trimEnd()+'\n\n## Skills\n\n'+block+'\n';
  }
  const heading=/<h[2-4]\b[^>]*>Skills\b[^<]*<\/h[2-4]>/i.exec(text);
  if(heading)return text.slice(0,heading.index+heading[0].length)+'\n'+block+text.slice(heading.index+heading[0].length);
  if(!text.includes('</main>'))throw new Error(`${file}: cannot insert skills block without </main>`);
  return text.replace('</main>',`<section id="skills">\n<h2>Skills</h2>\n${block}\n</section>\n</main>`);
}

export async function skillsCatalog(root:string, mode:'check'|'write'='check') {
  const {skills,count,differences}=await catalog(root);
  const invalidReference=differences.some(difference=>difference.startsWith(REFERENCE+':'));
  const updates:{file:string;text:string}[]=[];
  for(const file of GENERATED) {
    const text=await read(root,file);
    if(text===undefined) {differences.push(`${file}: missing file`);continue;}
    const block=file==='README.md'?renderMarkdownBlock(skills):renderHtmlBlock(skills);
    const range=blockRange(text);
    if(!range) {
      if(mode==='write'&&!text.includes(BEGIN)&&!text.includes(END))updates.push({file,text:insertBlock(file,text,block)});
      else differences.push(`${file}: missing, duplicated, or out-of-order generated block marker for skills`);
    } else if(mode==='write')updates.push({file,text:text.slice(0,range[0])+block+text.slice(range[1])});
    else if(text.slice(...range)!==block)differences.push(...blockDifferences(file,text.slice(...range),block));
    if(file==='README.md'&&range&&!/^## Skills[ \t]*$/m.test(text))differences.push(`${file}: missing ## Skills heading`);
  }
  if(mode==='write'&&!differences.length)for(const update of updates)await writeFile(join(root,update.file),update.text);
  if(mode==='write'&&invalidReference)differences.push(`fix ${REFERENCE} first; nothing was written`);
  return {ok:differences.length===0,count,differences};
}
