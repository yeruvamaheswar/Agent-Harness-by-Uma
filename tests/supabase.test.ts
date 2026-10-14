import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexingPayload,vector} from '../src/supabase.ts';
import {chunks} from '../src/core.ts';
import type {Release} from '../src/core.ts';

const release:Release={version:'1.0.0',digest:'d',createdAt:'now',provenance:'test',core:'policy',documents:[{id:'doc',title:'Doc',domain:'engineering',sourceUrl:'https://example.com',content:'A useful reference.'}]};
test('incomplete or malformed embedding batches cannot be published',()=>{
 assert.throws(()=>indexingPayload(release,{model:'test',dimensions:3,vectors:{}},'00000000-0000-0000-0000-000000000001'),/Invalid embedding/);
 assert.throws(()=>vector([0,0,0],3),/Invalid/);
 assert.throws(()=>vector([1,NaN,2],3),/Invalid/);
});
test('indexing uses the exact released chunk text and source identity',()=>{
 const c=chunks(release.documents)[0];
 const p=indexingPayload(release,{model:'test',dimensions:3,vectors:{[c.contentHash]:[1,2,3]}},'00000000-0000-0000-0000-000000000001');
 assert.equal(p.p_chunks[0].content,c.content);assert.equal(p.p_chunks[0].sourceUrl,'https://example.com');assert.equal(p.p_release.version,'1.0.0');
});
