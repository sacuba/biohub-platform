import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
process.env.DATA_DIR=path.resolve('../dev-runtime/platform-task-batch-tests',crypto.randomUUID());process.env.MAIL_TRANSPORT='capture';process.env.APP_URL='http://platform.test';process.env.YINGLAN_URL='http://yinglan.test';process.env.SANGER_URL='http://sanger.test';process.env.SANGER_ENABLED='true';
const {db}=await import('../src/db');const {hash,config}=await import('../src/config');const {setupApi,errorHandler}=await import('../src/api');
const tokens=Object.fromEntries(['admin','ordinary','empty'].map(id=>[id,crypto.randomUUID()]));
db.transaction(()=>{
 for(const [id,token] of Object.entries(tokens)){db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id,id+'@example.test','!',id==='admin'?'admin':'user',1,1,JSON.stringify(id==='empty'?{}:{yinglan:'user',sanger:'user'}),new Date().toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),id,'fixture',Date.now()+600000);}
 for(let i=0;i<105;i++){db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run('batch-'+i,'Test batch '+String(i).padStart(3,'0'),30,new Date().toISOString());if(i!==104)for(const status of ['active','redeemed','revoked'])db.prepare('INSERT INTO codes VALUES(?,?,?,?,?,?,?)').run('code-'+i+'-'+status,'TEST-'+i+'-'+status,'batch-'+i,30,status,status==='redeemed'?'ordinary':null,new Date().toISOString());}
})();
const app=express();setupApi(app);app.use(errorHandler);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
const realFetch=globalThis.fetch;let failedTool='';const toolCalls:URL[]=[];
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.href==='http://platform.test/oidc/token')return Response.json({access_token:'synthetic-service-token'});
 if(['http://yinglan.test','http://sanger.test'].includes(url.origin)){
  toolCalls.push(url);const tool=url.origin.includes('yinglan')?'yinglan':'sanger';if(failedTool===tool)return Response.json({error:'synthetic outage'},{status:503});
  assert.equal(url.pathname,'/api/v1/tool/tasks');assert.equal(url.searchParams.get('user_id'),'admin');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-service-token');
  const start=Number(url.searchParams.get('cursor')),size=Number(url.searchParams.get('limit')),total=tool==='yinglan'?53:54;
  const end=Math.min(total,start+size),tasks=Array.from({length:end-start},(_,n)=>({id:tool+'-'+(start+n),user_id:'admin',tool_id:tool,type:tool==='yinglan'?'generation':'annotation',status:'succeeded',created_at:'2026-10-30T00:00:00.000Z',updated_at:'2026-10-30T00:00:00.000Z',credits:tool==='yinglan'?5:0,wallet_status:'settled',result_url:url.origin+'/?task='+tool+'-'+(start+n)}));
  return Response.json({tasks,next_cursor:end<total?String(end):null});
 }
 return realFetch(input,init);
};
async function get(route:string,account='admin'){return fetch(base+'/api/v1/'+route,{headers:{Cookie:'biohub_session='+(tokens[account]||'')}});}
after(async()=>{globalThis.fetch=realFetch;await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();fs.rmSync(process.env.DATA_DIR!,{recursive:true,force:true});});
test('batch pages cover 105 batches without duplication and preserve status counts and old cursors',async()=>{
 const ids:string[]=[];for(let page=1;page<=6;page++){const response=await get('admin/batches?page='+page);assert.equal(response.status,200);const data=await response.json();assert.equal(data.total,105);assert.equal(data.total_pages,6);assert.equal(data.batches.length,page===6?5:20);ids.push(...data.batches.map((b:any)=>b.id));for(const batch of data.batches)assert.deepEqual([batch.count,batch.redeemed,batch.revoked],batch.id==='batch-104'?[0,0,0]:[3,1,1]);}
 assert.equal(new Set(ids).size,105);assert.deepEqual(ids,Array.from({length:105},(_,i)=>'batch-'+i));
 for(const size of [50,100])assert.equal((await (await get('admin/batches?page=1&page_size='+size)).json()).batches.length,size);
 const legacy=await (await get('admin/batches?limit=100')).json();assert.equal(legacy.batches.length,100);assert.ok(legacy.next_cursor);assert.equal(legacy.total,undefined);assert.equal((await (await get('admin/batches?cursor='+legacy.next_cursor)).json()).batches.length,5);
});
test('batch search, empty results, out-of-range correction, strict paging and authorization work',async()=>{
 const search=await (await get('admin/batches?page=4&keyword=TEST%20BATCH%2000')).json();assert.equal(search.total,10);assert.equal(search.page,1);
 const literal=await (await get('admin/batches?page=6&keyword=%25')).json();assert.equal(literal.total,0);assert.equal(literal.total_pages,1);assert.equal(literal.page,1);
 for(const query of ['page=0','page=-1','page=NaN','page=1.5','page=9007199254740992','page=1&page_size=10','page=1&cursor=20','page=1&limit=50','page=1&page=2'])assert.equal((await get('admin/batches?'+query)).status,400,query);
 assert.equal((await get('admin/batches?page=1','ordinary')).status,403);assert.equal((await get('admin/batches?page=1','guest')).status,401);
 db.prepare("DELETE FROM codes WHERE batch_id IN ('batch-100','batch-101','batch-102','batch-103','batch-104')").run();db.prepare("DELETE FROM batches WHERE id IN ('batch-100','batch-101','batch-102','batch-103','batch-104')").run();const shrunk=await (await get('admin/batches?page=6')).json();assert.equal(shrunk.page,5);assert.equal(shrunk.total,100);
});
test('batch revoke updates counts and protects redeemed codes; legacy code-list remains available',async()=>{
 const me=await get('auth/me'),payload=await me.json(),cookie='biohub_session='+tokens.admin+'; '+me.headers.getSetCookie()[0].split(';')[0];
 const response=await fetch(base+'/api/v1/admin/batches/batch-2/revoke',{method:'POST',headers:{Cookie:cookie,Origin:config.appUrl,'X-CSRF-Token':payload.csrf_token,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,200);
 const batch=(await (await get('admin/batches?page=1&keyword=batch-2')).json()).batches.find((b:any)=>b.id==='batch-2');assert.equal(batch.count,3);assert.equal(batch.redeemed,1);assert.equal(batch.revoked,2);
 const codes=await (await get('admin/codes?batch_id=batch-2')).json();assert.equal(codes.codes.length,3);assert.equal(codes.codes.filter((c:any)=>c.status==='redeemed').length,1);
});
test('task composite cursors cover both tools exactly once for page sizes 20, 50 and 100',async()=>{
 for(const size of [20,50,100]){const seen=new Set<string>();let cursor:string|null='';let pages=0;
 do{const response=await get('tasks?limit='+size+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.unavailable,[]);assert.ok(data.tasks.length<=size);for(const task of data.tasks){const key=task.tool_id+':'+task.id;assert.equal(seen.has(key),false);seen.add(key);}cursor=data.next_cursor;pages++;assert.ok(pages<10);}while(cursor);
 assert.equal(seen.size,107);assert.equal(pages,Math.ceil(107/size));}
 assert.ok(toolCalls.length>0);
});
test('task scope stays server-owned; empty permissions, invalid cursor and tool outage stay explicit',async()=>{
 assert.equal((await get('tasks','guest')).status,401);const none=await (await get('tasks','empty')).json();assert.deepEqual(none.tasks,[]);assert.equal(none.next_cursor,null);
 assert.equal((await get('tasks?limit=0')).status,400);assert.equal((await get('tasks?limit=101')).status,400);assert.equal((await get('tasks?cursor=forged')).status,400);
 await get('tasks?limit=20&user_id=ordinary');assert.equal(toolCalls.at(-1)!.searchParams.get('user_id'),'admin');
 failedTool='sanger';const partial=await (await get('tasks?limit=100')).json();assert.deepEqual(partial.unavailable,['sanger']);assert.equal(partial.tasks.length,53);failedTool='';
 const retried=await (await get('tasks?limit=100')).json();assert.deepEqual(retried.unavailable,[]);assert.equal(retried.tasks.length,100);
});
