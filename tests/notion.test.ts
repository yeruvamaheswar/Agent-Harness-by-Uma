import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Notion,pluginPageContent} from '../src/notion.ts';

test('Notion export follows pagination and nested blocks',async()=>{
 const urls:string[]=[];
 const mock:typeof fetch=async(input)=>{
   const u=String(input);urls.push(u);
   const b=(id:string,text:string,children=false)=>({id,type:'paragraph',has_children:children,paragraph:{rich_text:[{plain_text:text}]}});
   const data=u.includes('/nested/')?{results:[b('c','Nested content')],has_more:false}:u.includes('start_cursor')?{results:[b('z','Second page')],has_more:false}:{results:[b('nested','First page',true)],has_more:true,next_cursor:'next'};
   return new Response(JSON.stringify(data),{status:200});
 };
 const text=await new Notion('fake','2022-06-28',mock).blocks('root');
 assert.match(text,/First page[\s\S]*Nested content[\s\S]*Second page/);assert.equal(urls.length,3);
});
test('Notion unknown blocks fail rather than silently dropping guidance',async()=>{
 const mock:typeof fetch=async()=>new Response(JSON.stringify({results:[{id:'x',type:'unsupported'}],has_more:false}));
 await assert.rejects(new Notion('fake','2022-06-28',mock).blocks('root'),/Unsupported/);
});
test('Notion authentication failure does not expose the credential or response body',async()=>{
 const mock:typeof fetch=async()=>new Response('sensitive debug payload',{status:401});
 await assert.rejects(new Notion('secret-value','2022-06-28',mock).blocks('root'),e=>e instanceof Error&&!e.message.includes('secret')&&!e.message.includes('payload')&&e.message.includes('401'));
});

test('plugin imports require complete matching mapped pages and reject duplicates',()=>{
 const p={schemaVersion:1,exportedAt:new Date().toISOString(),pages:[{url:'https://app.notion.com/p/abc123?pvs=204',text:'<page><content>Policy</content></page>',page_last_edited_at:'2026-09-25'}]};
 assert.equal(pluginPageContent(p,'abc123'),'Policy\n');
 assert.throws(()=>pluginPageContent(p,'missing'),/exactly one/);
 assert.throws(()=>pluginPageContent({...p,pages:[...p.pages,...p.pages]},'abc123'),/exactly one/);
 assert.throws(()=>pluginPageContent({...p,pages:[{...p.pages[0],truncated:true}]},'abc123'),/incomplete/);
});
