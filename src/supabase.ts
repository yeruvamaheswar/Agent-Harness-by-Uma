import {chunks} from './core.ts';
import type {Release} from './core.ts';
import {env} from './env.ts';

export type EmbeddingBatch={model:string;dimensions:number;vectors:Record<string,number[]>};
export function vector(value:unknown,dimensions:number):asserts value is number[]{
  if(!Number.isInteger(dimensions)||dimensions<1||dimensions>4096||!Array.isArray(value)||value.length!==dimensions||!value.every(v=>typeof v==='number'&&Number.isFinite(v))||!value.some(v=>v!==0))throw new Error('Invalid embedding vector or dimensions.');
}
export function indexingPayload(release:Release,batch:EmbeddingBatch,owner:string){
  if(!/^[0-9a-f-]{36}$/i.test(owner))throw new Error('SUPABASE_OWNER_ID must be a user UUID.');
  if(!batch.model?.trim())throw new Error('An explicit pinned embedding model is required.');
  return {p_owner:owner,p_release:{version:release.version,digest:release.digest,documents:release.documents},p_model:batch.model,p_dimensions:batch.dimensions,p_chunks:chunks(release.documents).map(c=>{const embedding=batch.vectors[c.contentHash];vector(embedding,batch.dimensions);return {...c,embedding};})};
}
async function rpc(name:string,body:unknown,publisher:boolean,request:typeof fetch=fetch){
  const base=new URL(env('SUPABASE_URL'));
  if(base.protocol!=='https:'||!base.hostname.endsWith('.supabase.co'))throw new Error('SUPABASE_URL must be your hosted HTTPS Supabase project URL.');
  const key=env(publisher?'SUPABASE_SERVICE_ROLE_KEY':'SUPABASE_PUBLISHABLE_KEY');
  const token=publisher?key:env('SUPABASE_ACCESS_TOKEN');
  const r=await request(new URL('/rest/v1/rpc/'+name,base),{method:'POST',headers:{apikey:key,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error(`Supabase ${name} failed (${r.status}); check schema, authentication, owner, model, and release. No credential or response body is logged.`);
  const text=await r.text();return text?JSON.parse(text):null;
}
export async function indexRelease(release:Release,batch:EmbeddingBatch){return rpc('publish_harness_release',indexingPayload(release,batch,env('SUPABASE_OWNER_ID')),true);}
export async function vectorSearch(version:string,model:string,query:number[],domain?:string){vector(query,query.length);return rpc('search_harness',{p_version:version,p_model:model,p_vector:query,p_domain:domain??null,p_limit:5},false);}
