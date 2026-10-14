import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PLATFORM_RECORDS} from '../src/platforms.ts';
import type {PlatformRecord} from '../src/platforms.ts';

const FIELDS=['id','platform','environment','instructions','skillRoots','scopedRules','mcp','hooks','runtime','manualSteps','versionCheck','probe','evidence','sources'];
const STATES=['configured','tested','behaviorally verified','unknown'];
const STATUS=['documented','observed','unknown'];
const IDS=['claude-local','claude-cloud','codex-local','codex-cloud','cursor-ide','cursor-cli','cursor-cloud','generic'];
const STUB:PlatformRecord={id:'stub',platform:'generic',environment:'cloud',instructions:{user:[],repo:[{path:'AGENTS.md',status:'unknown'}]},skillRoots:{user:[],repo:[]},scopedRules:'unknown',mcp:{user:null,repo:null,note:'none'},hooks:'unknown',runtime:'none',manualSteps:[],versionCheck:'harness repo verify PATH',probe:'unknown',evidence:{state:'unknown',date:'unknown',note:'stub'},sources:[]};

function problems(r:PlatformRecord){
  const p:string[]=[];
  for(const f of FIELDS)if(!(f in r)||(r as Record<string,unknown>)[f]===undefined)p.push(`${r.id}: missing ${f}`);
  for(const s of ['user','repo'] as const)for(const x of [...r.instructions[s],...r.skillRoots[s]])if(!x.path||!STATUS.includes(x.status))p.push(`${r.id}: bad target ${x.path}`);
  if(!STATES.includes(r.evidence.state))p.push(`${r.id}: bad evidence state`);
  if(r.environment==='cloud'){
    if(r.instructions.user.length)p.push(`${r.id}: cloud has a user-scope instruction target`);
    if(r.mcp.user!==null)p.push(`${r.id}: cloud has a local MCP registration`);
  }
  return p;
}

test('the table holds one record for each runtime',()=>assert.deepEqual(PLATFORM_RECORDS.map(r=>r.id),IDS));
test('every record has all required fields',()=>assert.deepEqual(PLATFORM_RECORDS.flatMap(problems).filter(m=>m.includes('missing')),[]));
test('ids are unique',()=>assert.equal(new Set(PLATFORM_RECORDS.map(r=>r.id)).size,PLATFORM_RECORDS.length));
test('cloud records have no user-scope instruction target and no local MCP registration',()=>{
  const cloud=PLATFORM_RECORDS.filter(r=>r.environment==='cloud');
  assert.equal(cloud.length,3);
  for(const r of cloud){assert.deepEqual(r.instructions.user,[]);assert.equal(r.mcp.user,null);}
});
test('every evidence state is one of the four values',()=>{for(const r of PLATFORM_RECORDS)assert.ok(STATES.includes(r.evidence.state),r.id);});
test('every record passes all checks',()=>assert.deepEqual(PLATFORM_RECORDS.flatMap(problems),[]));
test('a stub ninth record passes the same checks (a new platform needs one record)',()=>{
  const all=[...PLATFORM_RECORDS,STUB];
  assert.equal(new Set(all.map(r=>r.id)).size,9);
  assert.deepEqual(all.flatMap(problems),[]);
});
test('the checks reject a cloud record with a user-scope target',()=>{
  const bad:PlatformRecord={...STUB,id:'bad',instructions:{user:[{path:'.x/CLAUDE.md',status:'unknown'}],repo:[]},mcp:{user:'~/.x',repo:null,note:''}};
  assert.equal(problems(bad).length,2);
});
