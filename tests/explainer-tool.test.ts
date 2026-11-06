import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {findChrome} from '../tools/explainer.ts';

const chrome = await findChrome();
const tool = resolve('tools/explainer.ts');
function run(args:string[]) {
  return new Promise<{code:number|null;output:string}>((ok,fail)=>{
    const child=spawn(process.execPath,['--experimental-strip-types',tool,...args],{env:process.env});
    let output=''; child.stdout.on('data',v=>{output+=v;});child.stderr.on('data',v=>{output+=v;});
    const timer=setTimeout(()=>{child.kill('SIGTERM');fail(new Error(`Tool timed out: ${output}`));},25000);
    child.on('error',fail);child.on('close',code=>{clearTimeout(timer);ok({code,output});});
  });
}
const page=(extra='')=>`<!doctype html><html><head><title>Fixture</title><style>
body {background:white;color:black;margin:8px;font:16px Arial} * {box-sizing:border-box}
a {color:#000} button,input {color:black;background:white;border:2px solid black}
:focus {outline:3px solid black;outline-offset:2px}
</style></head><body><h1>Explainer fixture</h1><button onclick="this.textContent=this.textContent==='Open'?'Close':'Open'">Open</button><a href="#skills">Skills</a><section id="skills"><h2>Skills explorer</h2><ul class="skill-catalog"><li>Run checks</li></ul></section><figure id="orchestration"><h2>Plan with agents</h2><p>Build, review, and verify.</p></figure>${extra}</body></html>`;

// Headless Chrome depends on the machine and the environment (it times out under an empty environment or in some CI sandboxes),
// so the browser test is opt-in: set EXPLAINER_CHROME_TESTS=1. The explainer gate itself runs `tools/explainer.ts check`.
const skip = process.env.EXPLAINER_CHROME_TESTS !== '1' ? 'set EXPLAINER_CHROME_TESTS=1 to run the browser integration test' : !chrome ? 'Chrome not found; set CHROME_PATH to run browser integration tests' : false;
describe('explainer tool with real Chrome', {skip,timeout:59000},()=>{
  test('check fails broken content, passes clean content, and capture writes small PNGs',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'explainer-test-'));
    try {
      const bad=join(dir,'bad.html'),clean=join(dir,'clean.html'),report=join(dir,'checks.json'),captures=join(dir,'captures');
      await writeFile(bad,page('<a href="missing.html">Missing</a><p style="color:#eee">Low contrast</p><div style="width:2000px">Too wide</div><button onclick="console.error(&quot;control error&quot;)">Error</button><style>button:focus{outline:none;box-shadow:none}@keyframes bad{to{opacity:.8}}div{animation:bad 10s infinite}</style>'));
      await writeFile(clean,page());
      const broken=await run(['check',bad,'--json',report]);assert.equal(broken.code,1,broken.output);assert.match(broken.output,/overflow/,`No check results: ${broken.output}`);
      const data:unknown=JSON.parse(await readFile(report,'utf8'));
      assert.ok(data && typeof data==='object' && 'checks' in data && Array.isArray(data.checks));
      for(const name of ['overflow','links','contrast','console','keyboard','motion']) assert.ok(data.checks.some((c: {name:string;pass:boolean})=>c.name===name&&!c.pass),name);
      const good=await run(['check',clean,'--json',report]);assert.equal(good.code,0,good.output);
      const capture=await run(['capture',clean,captures,'--system-design',clean]);assert.equal(capture.code,0,capture.output);
      const files=(await readdir(captures)).filter(f=>f.endsWith('.png'));assert.equal(files.length,6);
      for(const file of files) {
        const png=await readFile(join(captures,file));assert.ok(png.length<400000,file);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      }
      const readme=await readFile(join(captures,'README.md'),'utf8');assert.match(readme,/Source page SHA-256: [a-f0-9]{64}/);assert.match(readme,/Plan with agents/);assert.match(readme,/--system-design/);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
