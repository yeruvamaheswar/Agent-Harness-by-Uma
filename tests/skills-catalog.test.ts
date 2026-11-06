import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {BEGIN, END, skillsCatalog, renderHtmlBlock, renderMarkdownBlock} from '../src/skills-catalog.ts';
import type {CatalogSkill} from '../src/skills-catalog.ts';

const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const cli=(root:string,...flags:string[])=>spawnSync(process.execPath,
  ['--experimental-strip-types',join(repo,'src/cli.ts'),'--root',root,'skills','catalog',...flags],{encoding:'utf8'});
const section=(name:string)=>`## ${name}\nGroup: Planning\nStatus: beta\nNeeds: A task.\nExample: /${name}\nResult: A plan.\n`;
const source=(name:string)=>`---\nname: ${name}\ndescription: Plan a task. Ask for details.\ndisable-model-invocation: true\n---\n# ${name}\n`;
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
  const root=await mkdtemp(join(tmpdir(),'skills-catalog-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'tools/agents/skills/alpha'),{recursive:true});
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'tools/agents/skills/alpha/SKILL.md'),source('alpha'));
  await writeFile(join(root,'docs/skills.md'),'# Reference\n\n'+section('alpha'));
  await writeFile(join(root,'README.md'),'# Fixture\n\nKeep this prose.\n');
  await writeFile(join(root,'docs/project-explainer.html'),'<main><section><h3>Skills: reference</h3><p>Keep this paragraph.</p></section></main>\n');
  assert.equal((await skillsCatalog(root,'write')).ok,true);
  return root;
}
async function edit(root:string,file:string,change:(text:string)=>string) {
  await writeFile(join(root,file),change(await readFile(join(root,file),'utf8')));
}
function fails(root:string,pattern:RegExp) {
  const result=cli(root,'--check');
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,pattern);
  return result.stderr;
}

test('--write then --check passes; default checks; writes preserve surrounding text and are idempotent',async t=>{
  const root=await fixture(t);
  for(const flags of [[],['--check'],['--write']]) {
    const result=cli(root,...flags);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,'skills catalog: ok (1 skills)\n');
  }
  const files=['README.md','docs/project-explainer.html','docs/skills.md'];
  const before=await Promise.all(files.map(file=>readFile(join(root,file),'utf8')));
  assert.match(before[0],/^# Fixture\n\nKeep this prose\.\n\n## Skills\n\n/);
  assert.match(before[1],/<h3>Skills: reference<\/h3>\n<!-- BEGIN GENERATED: skills -->/);
  assert.match(before[1],/<p>Keep this paragraph\.<\/p><\/section><\/main>\n$/);
  assert.equal((await skillsCatalog(root,'write')).ok,true);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(join(root,file),'utf8'))),before);
});

test('added folder fails until its reference section and both blocks match',async t=>{
  const root=await fixture(t);
  await mkdir(join(root,'tools/agents/skills/foo'));
  await writeFile(join(root,'tools/agents/skills/foo/SKILL.md'),source('foo'));
  fails(root,/docs\/skills\.md: missing section for "foo"/);
  await edit(root,'docs/skills.md',text=>text+'\n'+section('foo'));
  const errors=fails(root,/README\.md: row for "foo" is missing/ );
  assert.match(errors,/docs\/project-explainer\.html: item for "foo" is missing/);
  assert.equal(cli(root,'--write').status,0);
  assert.equal(cli(root,'--check').status,0);
});

test('reference section without a folder fails',async t=>{
  const root=await fixture(t);
  await edit(root,'docs/skills.md',text=>text+'\n'+section('ghost'));
  fails(root,/docs\/skills\.md: section for "ghost" has no skill folder/);
});

test('removed folder fails',async t=>{
  const root=await fixture(t);
  await rm(join(root,'tools/agents/skills/alpha'),{recursive:true});
  fails(root,/docs\/skills\.md: section for "alpha" has no skill folder/);
});

test('renamed folder reports stale section, missing section, and metadata mismatch',async t=>{
  const root=await fixture(t);
  await rename(join(root,'tools/agents/skills/alpha'),join(root,'tools/agents/skills/renamed'));
  const errors=fails(root,/name "alpha" differs from folder "renamed"/);
  assert.match(errors,/missing section for "renamed"/);
  assert.match(errors,/section for "alpha" has no skill folder/);
});

test('front matter name must equal its folder',async t=>{
  const root=await fixture(t);
  await edit(root,'tools/agents/skills/alpha/SKILL.md',text=>text.replace('name: alpha','name: wrong'));
  fails(root,/tools\/agents\/skills\/alpha\/SKILL\.md: name "wrong" differs from folder "alpha"/);
});

for(const [field,bad] of [['Status','ready'],['Group','Unknown']])test(`bad ${field} fails`,async t=>{
  const root=await fixture(t);
  await edit(root,'docs/skills.md',text=>text.replace(new RegExp(`^${field}:.*$`,'m'),`${field}: ${bad}`));
  fails(root,new RegExp(`docs/skills\\.md: bad ${field} for "alpha"`));
});

for(const field of ['Group','Status','Needs','Example','Result'])test(`missing ${field} line fails`,async t=>{
  const root=await fixture(t);
  await edit(root,'docs/skills.md',text=>text.replace(new RegExp(`^${field}:.*\\n`,'m'),''));
  fails(root,new RegExp(`"alpha" needs exactly one nonempty ${field}: line`));
});

test('duplicate reference section and duplicate field fail',async t=>{
  const root=await fixture(t);
  await edit(root,'docs/skills.md',text=>text+'Status: stable\n\n'+section('alpha')+'Status: stable\n');
  const errors=fails(root,/duplicate section for "alpha"/);
  assert.match(errors,/exactly one nonempty Status: line/);
});

test('edited README block fails; default does not write; --write repairs it',async t=>{
  const root=await fixture(t);
  await edit(root,'README.md',text=>text.replace('Plan a task.','Wrong purpose.'));
  const before=await readFile(join(root,'README.md'),'utf8');
  fails(root,/README\.md: row for "alpha" differs/);
  assert.equal(cli(root).status,1);
  assert.equal(await readFile(join(root,'README.md'),'utf8'),before);
  assert.equal(cli(root,'--write').status,0);
  assert.equal(cli(root,'--check').status,0);
});

for(const [label,change] of [
  ['list structure',(text:string)=>text.replace('<ul class="skill-catalog">','<ol class="skill-catalog">')],
  ['skill attribute',(text:string)=>text.replace('data-skill="alpha"','data-skill="wrong"')],
  ['group attribute',(text:string)=>text.replace('data-group="Planning"','data-group="Quality"')],
  ['status attribute',(text:string)=>text.replace('data-status="beta"','data-status="stable"')],
  ['purpose',(text:string)=>text.replace('Plan a task.','Wrong purpose.')],
] satisfies [string,(text:string)=>string][])test(`edited explainer ${label} fails and --write repairs it`,async t=>{
  const root=await fixture(t);
  await edit(root,'docs/project-explainer.html',change);
  fails(root,label==='list structure'?/docs\/project-explainer\.html: block has unexpected content/:/docs\/project-explainer\.html: item for "alpha" (differs|is missing)/);
  assert.equal(cli(root,'--write').status,0);
  assert.equal(cli(root,'--check').status,0);
});

for(const file of ['README.md','docs/project-explainer.html']) {
  for(const marker of [BEGIN,END]) {
    for(const action of ['missing','duplicated'])test(`${file}: ${action} ${marker} fails`,async t=>{
      const root=await fixture(t);
      await edit(root,file,text=>text.replace(marker,action==='missing'?'':marker+'\n'+marker));
      fails(root,/missing, duplicated, or out-of-order generated block marker for skills/);
      assert.equal(cli(root,'--write').status,1,'Do not guess how to repair ambiguous markers.');
    });
  }
}

test('source description and invocation changes require block regeneration',async t=>{
  const root=await fixture(t);
  await edit(root,'tools/agents/skills/alpha/SKILL.md',text=>text.replace('description: Plan a task. Ask for details.','description: >\n  Updated purpose.\n  More detail.').replace('invocation: true','invocation: false'));
  fails(root,/README\.md: row for "alpha" differs/);
  assert.equal(cli(root,'--write').status,0);
  assert.equal(cli(root).status,0);
  const readme=await readFile(join(root,'README.md'),'utf8');
  assert.match(readme,/Updated purpose\./);
  assert.doesNotMatch(readme,/More detail/);
  assert.match(readme,/Also loads by description/);
});

test('HTML renderer exposes list structure and data attributes; escapes source text',()=>{
  const skills:CatalogSkill[]=[{name:'alpha',description:'Use <file> & "text". More detail.',hidden:true,group:'Quality',status:'beta'},
    {name:'bravo',description:'Inspect a render.yaml file. More detail.',hidden:false,group:'Platform',status:'stable'}];
  const block=renderHtmlBlock(skills);
  assert.equal((block.match(/<ul\b[^>]*class="skill-catalog"[^>]*>/g)??[]).length,1);
  const items=[...block.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)];
  assert.equal(items.length,skills.length);
  for(const [index,item] of items.entries()) {
    const attributes=Object.fromEntries([...item[1].matchAll(/(data-[\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
    assert.deepEqual(attributes,{'data-skill':skills[index].name,'data-group':skills[index].group,'data-status':skills[index].status});
    assert.match(item[2],new RegExp(`<code>${skills[index].name}</code>`));
    assert.match(item[2],new RegExp(`Codex \\$${skills[index].name}`));
  }
  assert.match(block,/Use &lt;file&gt; &amp; &quot;text&quot;\./);
  assert.match(block,/Load only by name/);
  assert.match(block,/Also loads by description/);
  assert.match(block,/Inspect a render\.yaml file\./);
  assert.doesNotMatch(block,/More detail/);
  assert.match(renderMarkdownBlock(skills),/\| Skill \| Status \| What it does \| How to use \|/);
});

test('inserts into an existing README Skills heading and falls back to an HTML skills section',async t=>{
  const root=await fixture(t);
  await writeFile(join(root,'README.md'),'# Fixture\n\n## Skills\n\nExisting notes.\n\n## Other\nKeep.\n');
  await writeFile(join(root,'docs/project-explainer.html'),'<main><p>Keep.</p></main>');
  assert.equal(cli(root,'--write').status,0);
  assert.equal(cli(root).status,0);
  const readme=await readFile(join(root,'README.md'),'utf8');
  assert.equal((readme.match(/^## Skills$/gm)??[]).length,1);
  assert.match(readme,/Existing notes\.\n\n## Other\nKeep\./);
  assert.match(await readFile(join(root,'docs/project-explainer.html'),'utf8'),/<section id="skills">[\s\S]*<\/section>\n<\/main>/);
});

test('invalid reference prevents --write from altering generated files',async t=>{
  const root=await fixture(t);
  const before=await readFile(join(root,'README.md'),'utf8');
  await edit(root,'docs/skills.md',text=>text.replace('Status: beta','Status: bad'));
  const result=cli(root,'--write');
  assert.equal(result.status,1);
  assert.match(result.stderr,/fix docs\/skills\.md first; nothing was written/);
  assert.equal(await readFile(join(root,'README.md'),'utf8'),before);
});

test('real repository catalog check passes and CLI flags are exclusive',async()=>{
  const result=await skillsCatalog(repo);
  assert.deepEqual(result.differences,[]);
  assert.equal(result.ok,true);
  assert.equal(result.count,(await readFile(join(repo,'docs/skills.md'),'utf8')).match(/^## /gm)?.length);
  const command=cli(repo,'--check');
  assert.equal(command.status,0,command.stderr);
  assert.equal(command.stdout,`skills catalog: ok (${result.count} skills)\n`);
  assert.equal(cli(repo,'--write','--check').status,1);
  assert.equal(cli(repo,'--unknown').status,1);
});

for(const [label,file,change,files] of [
  ['description','tools/agents/skills/alpha/SKILL.md',(text:string)=>text.replace('Plan a task.','Changed purpose.'),['README.md','docs/project-explainer.html']],
  ['README cell','README.md',(text:string)=>text.replace('Plan a task.','Changed purpose.'),['README.md']],
  ['explainer data-status','docs/project-explainer.html',(text:string)=>text.replace('data-status="beta"','data-status="stable"'),['docs/project-explainer.html']],
] satisfies [string,string,(text:string)=>string,string[]][])test(`${label} diagnostic names only the changed skill`,async t=>{
  const root=await fixture(t);
  await mkdir(join(root,'tools/agents/skills/bravo'));
  await writeFile(join(root,'tools/agents/skills/bravo/SKILL.md'),source('bravo'));
  await edit(root,'docs/skills.md',text=>text+'\n'+section('bravo'));
  assert.equal(cli(root,'--write').status,0);
  await edit(root,file,change);
  const result=cli(root,'--check');
  assert.equal(result.status,1);
  const lines=result.stderr.trim().split('\n');
  assert.equal(lines.length,files.length,result.stderr);
  for(const file of files)assert.ok(lines.some(line=>line.startsWith(file+':')&&line.includes('"alpha"')&&line.includes('differs')),result.stderr);
  assert.doesNotMatch(result.stderr,/bravo/);
});

for(const file of ['README.md','docs/project-explainer.html']) {
  test(`${file} reports an extra skill by name`,async t=>{
    const root=await fixture(t);
    await edit(root,file,text=>file==='README.md'?text.replace('| alpha |','| ghost |'):text.replace('data-skill="alpha"','data-skill="ghost"'));
    const errors=fails(root,/for "alpha" is missing/);
    assert.match(errors,/for "ghost" has no skill folder/);
  });
  test(`${file} reports stray block content`,async t=>{
    const root=await fixture(t);
    await edit(root,file,text=>text.replace(END,'Unexpected text\n'+END));
    const errors=fails(root,/block has unexpected content/);
    assert.ok(errors.startsWith(file+':'),errors);
  });
}
