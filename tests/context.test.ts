import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {contextAudit,skillMeta,parseClaudeContext} from '../src/context.ts';
import type {SkillSource} from '../src/context.ts';

async function put(file:string,text:string){await mkdir(dirname(file),{recursive:true});await writeFile(file,text);}
const skill=(name:string,description:string,extra='')=>`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\nBody text that never loads at start.\n`;
const CONTEXT=`## Context Usage\n\n**Tokens:** 24.1k / 1m (2%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.5k | 0.2% |\n| Skills | 7.4k | 0.7% |\n\n### MCP Tools\n\n| Tool | Server | Tokens |\n|------|--------|--------|\n| mcp__notion__search | notion | 2.6k |\n\n### Memory Files\n\n| Type | Path | Tokens |\n|------|------|--------|\n| User | /h/.claude/CLAUDE.md | 1.2k |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| grill-me | User | ~90 |\n| data:analyze | Plugin (data) | ~80 |\n| data:explore | Plugin (data) | ~100 |\n`;

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'harness-test-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
  const claude=join(home,'.claude'),codex=join(home,'.codex');
  await put(join(claude,'CLAUDE.md'),'x'.repeat(400));
  await put(join(claude,'rules','always.md'),'y'.repeat(80));
  await put(join(claude,'rules','scoped.md'),'---\npaths:\n  - src/**\n---\nOnly for src.\n');
  await put(join(home,'.agents','skills','shared','SKILL.md'),skill('shared','Shared skill used by every agent.'));
  await mkdir(join(claude,'skills'),{recursive:true});
  await symlink(join(home,'.agents','skills','shared'),join(claude,'skills','shared'));
  await put(join(claude,'skills','own','SKILL.md'),skill('own','Claude only.'));
  await put(join(claude,'skills','quiet','SKILL.md'),skill('quiet','Invoked by the user only.','disable-model-invocation: true\n'));
  const cplugin=join(claude,'plugins','cache','dir','helper','1');
  await put(join(cplugin,'skills','help','SKILL.md'),skill('help','Plugin help.'));
  await put(join(claude,'plugins','installed_plugins.json'),JSON.stringify({version:2,plugins:{'helper@dir':[{scope:'user',installPath:cplugin}]}}));
  await put(join(claude,'settings.json'),JSON.stringify({enabledPlugins:{'helper@dir':false}}));
  await put(join(home,'.claude.json'),JSON.stringify({mcpServers:{notion:{type:'http',headers:{Authorization:'Bearer s3cret-claude'}}}}));
  await put(join(codex,'AGENTS.md'),'z'.repeat(200));
  await put(join(codex,'skills','tool','SKILL.md'),skill('tool','A Codex tool. Posts to #channel-name'));
  await put(join(codex,'skills','off','SKILL.md'),skill('off','Switched off in config.'));
  await put(join(codex,'plugins','cache','market','on','1.0.0','skills','p1','SKILL.md'),skill('p1','Enabled plugin skill.'));
  await put(join(codex,'plugins','cache','market','off','1.0.0','skills','p2','SKILL.md'),skill('p2','Disabled plugin skill.'));
  await put(join(codex,'config.toml'),`model = "m"\n\n[plugins."on@market"]\nenabled = true\n\n[plugins."off@market"]\nenabled = false\n\n[mcp_servers.alpha]\ncommand = "node"\nargs = ["--token", "secret-arg"]\n\n[mcp_servers.alpha.env]\nTOKEN = "s3cret-env"\n\n[[skills.config]]\npath = ${JSON.stringify(join(codex,'skills','off','SKILL.md'))}\nenabled = false\n`);
  const block='<skills_instructions>\n## Skills\n### Available skills\n- tool: A Codex tool. (file: r0/tool/SKILL.md)\n- p1: Enabled plugin skill. (file: r3/p1/SKILL.md)\n</skills_instructions>';
  const lines=[{type:'session_meta',payload:{}},{type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'other'},{type:'input_text',text:block}]}},{type:'event_msg',payload:{type:'token_count',info:null}},{type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:12345}}}},{type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:99999}}}}];
  await put(join(codex,'sessions','2026','10','05','rollout-a.jsonl'),lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
  // A newer log without a token_count event is skipped.
  await put(join(codex,'sessions','2026','10','06','rollout-b.jsonl'),JSON.stringify({type:'session_meta',payload:{}})+'\n');
  await put(join(home,'.cursor','mcp.json'),JSON.stringify({mcpServers:{beta:{env:{KEY:'s3cret-cursor'}}}}));
  const ctx=join(home,'ctx.md');await put(ctx,CONTEXT);
  return {root,home,block,ctx};
}
const source=(list:SkillSource[],name:string)=>{const s=list.find(s=>s.source===name);assert.ok(s,name);return s;};
const exists=(p:string)=>access(p).then(()=>true,()=>false);

test('skillMeta reads folded values and drops YAML comments only in plain values',()=>{
  assert.deepEqual(skillMeta('---\nname: a\ndescription: >\n  one\n  two #three\n---\n'),{name:'a',description:'one two #three'});
  assert.equal(skillMeta('---\ndescription: post to #channel now\n---\n').description,'post to');
  assert.equal(skillMeta('---\ndescription: "keep #this"\n---\n').description,'keep #this');
  assert.equal(skillMeta('---\ndescription: first line\n  continued\n---\n').description,'first line continued');
  assert.deepEqual(skillMeta('# no front matter'),{});
});

test('parseClaudeContext reads the total, categories, skills by source, MCP servers, and memory files',()=>{
  const c=parseClaudeContext(CONTEXT);
  assert.equal(c.label,'measured (claude /context estimate)');
  assert.equal(c.totalTokens,24100);
  assert.deepEqual(c.categories,{'System prompt':2500,Skills:7400});
  assert.deepEqual(c.skills,{count:3,tokens:270,bySource:{User:{count:1,tokens:90},'Plugin (data)':{count:2,tokens:180}}});
  assert.deepEqual(c.mcpServers,['notion']);
  assert.deepEqual(c.memoryFiles,[{type:'User',path:'/h/.claude/CLAUDE.md',tokens:1200}]);
});

test('context audit reports sizes per platform, dedupes symlinks, respects enablement, and writes nothing',async()=>{
  const {root,home,block,ctx}=await fixture();
  const r=await contextAudit(root,{home,claudeContext:ctx});
  const {claude,codex,cursor}=r.platforms;
  assert.equal(r.saved,null);
  assert.equal(await exists(join(root,'.state')),false,'nothing written without save');

  // Claude: CLAUDE.md and an unscoped rule load at start; a paths rule loads on demand.
  assert.deepEqual(claude.instructions.total,{chars:480,estimatedTokens:120});
  assert.equal(claude.instructions.files.find(f=>f.path.endsWith('scoped.md'))?.loads,'on demand (paths)');
  const user=source(claude.skills.sources,'user ~/.claude/skills');
  assert.deepEqual(user.skills,[{name:'own',chars:15},{name:'shared',chars:39}]);
  assert.deepEqual(user.hidden,['quiet']);
  assert.deepEqual({count:user.count,chars:user.chars,estimatedTokens:user.estimatedTokens},{count:2,chars:54,estimatedTokens:14});
  assert.equal(source(claude.skills.sources,'plugin helper@dir').enablement,'disabled');
  assert.deepEqual(claude.skills.counted,{count:2,chars:54,estimatedTokens:14});
  assert.deepEqual(claude.skills.excluded,{count:1,chars:16,estimatedTokens:4});
  assert.deepEqual(claude.mcpServers.configured,['notion']);
  assert.ok(typeof claude.measured!=='string'&&claude.measured.skills.tokens===270);

  // Codex: a config-disabled skill and a disabled plugin are excluded; the enabled plugin counts.
  assert.equal(source(codex.skills.sources,'user ~/.codex/skills').count,1);
  assert.deepEqual(source(codex.skills.sources,'user ~/.codex/skills').disabledByConfig,['off']);
  assert.deepEqual(source(codex.skills.sources,'user ~/.codex/skills').skills,[{name:'tool',chars:'tool'.length+'A Codex tool. Posts to'.length}]);
  assert.equal(source(codex.skills.sources,'plugin on@market').enablement,'enabled');
  const off=source(codex.skills.sources,'plugin off@market');
  assert.equal(off.enablement,'disabled');
  assert.equal(off.skills,undefined);
  assert.deepEqual(codex.skills.counted.count,3);
  assert.deepEqual(codex.skills.excluded.count,1);
  assert.deepEqual(codex.instructions.total,{chars:200,estimatedTokens:50});
  assert.deepEqual(codex.mcpServers.configured,['alpha']);
  assert.ok(typeof codex.measured!=='string');
  assert.equal(codex.measured.label,'measured');
  assert.equal(codex.measured.logDate,'2026-10-05');
  assert.equal(codex.measured.firstCallInputTokens,12345);
  assert.deepEqual(codex.measured.skillsBlock,{chars:block.length,listed:2,estimatedTokens:Math.round(block.length/4)});

  // Cursor: the symlinked skill counts once; User Rules and plugin enablement are unknown.
  assert.equal(source(cursor.skills.sources,'shared ~/.agents/skills').count,1);
  assert.deepEqual(source(cursor.skills.sources,'~/.claude/skills').duplicates,['shared']);
  assert.match(cursor.instructions.userRules,/^unknown/);
  assert.deepEqual(cursor.mcpServers.configured,['beta']);

  const out=JSON.stringify(r);
  for(const secret of ['s3cret-claude','secret-arg','s3cret-env','s3cret-cursor'])assert.ok(!out.includes(secret),secret);
});

test('context audit --save writes one dated baseline file under .state/context-baseline',async()=>{
  const {root,home}=await fixture();
  const r=await contextAudit(root,{home,save:true,now:new Date(2026,9,6,9,30)});
  const file=join(root,'.state','context-baseline','2026-10-06.json');
  assert.equal(r.saved,file);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(saved.platforms.codex.skills.counted,r.platforms.codex.skills.counted);
  assert.equal(saved.saved,file);
});
