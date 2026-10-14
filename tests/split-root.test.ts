import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Engine code runs from this repository; harness content lives in a separate temp folder.
const repo=join(dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
async function content(){
 const root=await mkdtemp(join(tmpdir(),'harness-content-')),home=await mkdtemp(join(tmpdir(),'harness-home-'));
 await writeFile(join(root,'core.md'),'# Rules\nBuild a tracer bullet and verify it.');
 await writeFile(join(root,'reference.md'),'# Tracer bullets\nSave one expense first.');
 await writeFile(join(root,'harness.config.json'),JSON.stringify({core:'core.md',documents:[{id:'guide',title:'Engineering',domain:'engineering',path:'reference.md',sourceUrl:'https://example.com/guide'}]}));
 const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:join(home,'claude-config'),HARNESS_ROOT:''};
 const cli=async(...args:string[])=>JSON.parse((await run(process.execPath,['--experimental-strip-types',join(repo,'src/cli.ts'),...args],{cwd:tmpdir(),env})).stdout);
 return {root,home,env,cli};
}
test('the CLI runs from the code folder against a separate harness root',async()=>{
 const {root,home,cli}=await content();
 const p=await cli('--root',root,'preview');assert.equal(p.core,'# Rules\nBuild a tracer bullet and verify it.');
 await cli('publish','1.0.0','--approve-sha',p.digest,'--bootstrap','--root',root);
 await access(join(root,'releases/1.0.0'));
 const i=await cli('--root',root,'install','claude');assert.ok(i);
 assert.match(await readFile(join(home,'claude-config/CLAUDE.md'),'utf8'),/Build a tracer bullet/);
 const s=await cli('--root',root,'status');
 assert.equal(s.root,root);assert.equal(s.activeVersion,'1.0.0');assert.equal(s.installations[0].configurationVerified,true);
 // The public catalog resolves from the code folder because the content root has no catalog/.
 assert.ok((await cli('--root',root,'pack','list')).available.length>0);
});
test('HARNESS_ROOT selects the root, the MCP entry points at code plus root, and the content root holds the release',async()=>{
 const {root,home,cli}=await content();
 const p=await cli('--root',root,'preview');await cli('--root',root,'publish','1.0.0','--approve-sha',p.digest,'--bootstrap');
 await access(join(root,'releases/1.0.0'));
 await cli('--root',root,'install','cursor-files');
 const server=JSON.parse(await readFile(join(home,'.cursor/mcp.json'),'utf8')).mcpServers.agentic_harness;
 assert.deepEqual(server.args,['--experimental-strip-types',join(repo,'src/mcp.ts'),'--root',root]);
});
