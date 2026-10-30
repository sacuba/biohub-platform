import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
process.env.DATA_DIR=path.resolve('../dev-runtime/platform-admin-tests',crypto.randomUUID());
process.env.MAIL_TRANSPORT='capture';
const {db}=await import('../src/db');
const {hash,config}=await import('../src/config');
const wallet=await import('../src/wallet');
const {setupApi,errorHandler}=await import('../src/api');
const {permissionTools}=await import('../src/catalog');
const app=express();setupApi(app);app.use(errorHandler);
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
const adminToken=crypto.randomUUID(),userToken=crypto.randomUUID();
db.transaction(()=>{
 for(let i=0;i<105;i++)db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('test-'+i,`person${String(i).padStart(3,'0')}@example.test`,'!',i===0?'admin':'user',i%5!==0?1:0,i===104?0:1,JSON.stringify(i===0?{}:{yinglan:'user'}),'2026-10-30T00:00:00.000Z');
 for(const [token,user] of [[adminToken,'test-0'],[userToken,'test-1']])db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),user,'test',Date.now()+600000);
 wallet.grant('test-0',40,'TEST','balance',null);wallet.grant('test-0',50,'TEST','expired','2000-01-01T00:00:00.000Z');
})();
const quote=wallet.quote('test-0','yinglan',{task_id:'held-task',parameters_hash:'x',capability:'generation'},'quote');wallet.reserve('test-0','yinglan',{quote_id:quote.id,task_id:quote.task_id,parameters_hash:'x'},'hold');
const me=await fetch(base+'/api/v1/auth/me',{headers:{Cookie:'biohub_session='+adminToken}});const csrf=(await me.json()).csrf_token;
const cookie='biohub_session='+adminToken+'; '+me.headers.getSetCookie()[0].split(';')[0];
async function get(route:string,token:string=adminToken){return fetch(base+'/api/v1/'+route,{headers:{Cookie:'biohub_session='+token}});}
async function post(route:string,body:unknown,headers:Record<string,string>={}){return fetch(base+'/api/v1/'+route,{method:'POST',headers:{Cookie:cookie,Origin:config.appUrl,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},body:JSON.stringify(body)});}
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();fs.rmSync(process.env.DATA_DIR!,{recursive:true,force:true});});
test('server pages cover all users in stable order, expose totals and only calculate page balances',async()=>{
 const ids:string[]=[];for(let page=1;page<=6;page++){const r=await get('admin/users?page='+page);assert.equal(r.status,200);const data=await r.json();assert.equal(data.total,105);assert.equal(data.total_pages,6);assert.equal(data.page_size,20);assert.equal(data.users.length,page===6?5:20);ids.push(...data.users.map((u:any)=>u.id));if(page===1){assert.equal(data.users[0].available_credits,35);assert.equal(data.users[0].frozen_credits,5);}}
 assert.equal(new Set(ids).size,105);assert.deepEqual(ids,Array.from({length:105},(_,i)=>'test-'+i));
 for(const size of [50,100]){const data=await (await get('admin/users?page=1&page_size='+size)).json();assert.equal(data.users.length,size);}
 const legacy=await (await get('admin/users?limit=100')).json();assert.equal(legacy.users.length,100);assert.ok(legacy.next_cursor);assert.equal(legacy.total,undefined);
 const tail=await (await get('admin/users?cursor='+legacy.next_cursor)).json();assert.equal(tail.users.length,5);
});
test('literal case-insensitive email/name search and role/status filters compose',async()=>{
 const search=await (await get('admin/users?page=1&keyword=PERSON00')).json();assert.equal(search.total,10);
 const literal=await (await get('admin/users?page=1&keyword=%25')).json();assert.equal(literal.total,0);assert.equal(literal.page,1);assert.equal(literal.total_pages,1);
 const admins=await (await get('admin/users?page=1&role=admin&status=active')).json();assert.equal(admins.total,1);
 const unverified=await (await get('admin/users?page=1&status=unverified')).json();assert.equal(unverified.total,21);
 const inactive=await (await get('admin/users?page=1&status=inactive')).json();assert.equal(inactive.total,1);
});
test('clamps pages after status changes and deletion; rejects malformed paging and filters',async()=>{
 assert.equal((await post('admin/users/test-104',{active:true})).status,200);
 const empty=await (await get('admin/users?page=8&status=inactive')).json();assert.equal(empty.page,1);assert.equal(empty.total,0);
 db.prepare("DELETE FROM users WHERE id IN ('test-101','test-102','test-103','test-104')").run();
 const last=await (await get('admin/users?page=99')).json();assert.equal(last.page,6);assert.equal(last.users.length,1);
 for(const query of ['page=0','page=-1','page=1.1','page=9007199254740992','page=1&page_size=10','page=1&status=weird','page=1&role=root','page=1&cursor=1','page=1&page=2'])assert.equal((await get('admin/users?'+query)).status,400,query);
});
test('permissions are fresh, only accept registry roles, and never inherit platform admin',async()=>{
 const registry=await (await get('admin/tool-permissions')).json();assert.deepEqual(registry.tools,permissionTools());assert.deepEqual(registry.tools.map((t:any)=>t.id),['yinglan','sanger']);
 assert.equal((await post('admin/users/test-2',{role:'admin'})).status,200);
 assert.deepEqual((await (await get('admin/users/test-2')).json()).tool_roles,{yinglan:'user'});
 assert.equal((await post('admin/users/test-2',{tool_roles:{sanger:'admin'}})).status,200);
 const changed=await (await get('admin/users/test-2')).json();assert.equal(changed.role,'admin');assert.deepEqual(changed.tool_roles,{sanger:'admin'});assert.equal(changed.password_hash,undefined);
 assert.equal((await post('admin/users/test-2',{tool_roles:{}})).status,200);
 for(const body of [{tool_roles:{sequence:'user'}},{tool_roles:{evil:'admin'}},{tool_roles:{yinglan:'owner'}},{role:'root'},{permissions:{sanger:'admin'}}])assert.equal((await post('admin/users/test-2',body)).status,400);
 assert.equal((await post('admin/users',{email:'invalid@example.test',password:'only-test-password',tool_roles:{evil:'admin'}})).status,400);
 assert.equal((await get('admin/users/missing')).status,404);
});
test('guest, ordinary user, bearer-only, cross-origin and missing CSRF cannot access admin writes',async()=>{
 for(const route of ['admin/users?page=1','admin/users/test-2','admin/tool-permissions']){assert.equal((await get(route,'')).status,401);assert.equal((await get(route,userToken)).status,403);}
 assert.equal((await post('admin/users/test-2',{tool_roles:{yinglan:'admin'}},{Cookie:cookie.replace(adminToken,userToken)})).status,403);
 assert.equal((await post('admin/users/test-2',{active:false},{Origin:'https://other.example'})).status,403);
 assert.equal((await post('admin/users/test-2',{active:false},{'X-CSRF-Token':''})).status,403);
 assert.equal((await post('admin/users/test-2',{active:false},{Cookie:'',Authorization:'Bearer fake'})).status,401);
});
test('account changes revoke sessions and credit adjustments retain idempotent balances',async()=>{
 const headers={Cookie:cookie,Origin:config.appUrl,'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':'admin-adjust'};
 const body=JSON.stringify({user_id:'test-3',direction:'add',amount:12,reason:'isolated admin regression'});
 for(let i=0;i<2;i++)assert.equal((await fetch(base+'/api/v1/admin/adjustments',{method:'POST',headers,body})).status,200);
 assert.equal(wallet.creditSummary('test-3').available_credits,12);
 assert.equal((await post('admin/users/test-1',{active:false})).status,200);assert.equal((await get('auth/me',userToken).then(r=>r.json())).user,null);
 assert.equal((await post('admin/users/test-2',{role:'user'})).status,200);
 const last=await post('admin/users/test-0',{role:'user'});assert.equal(last.status,400);assert.equal((await last.json()).error.code,'LAST_ADMIN');
});
