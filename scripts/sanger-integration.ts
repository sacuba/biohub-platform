import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,type BrowserContext} from '@playwright/test';
const base='http://192.168.6.111:3200',tool='http://192.168.6.111:3202',runtime='../dev-runtime/sanger';
const rootAdmin=JSON.parse(fs.readFileSync('../dev-runtime/platform/test-accounts.json','utf8'))[0];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
const manager=await browser.newContext(),a=await browser.newContext({viewport:{width:1440,height:1000}}),b=await browser.newContext();
const errors:string[]=[],passed:string[]=[];
async function api(ctx:BrowserContext,path:string,body?:unknown,isTool=false){
 const origin=isTool?tool:base,prefix=isTool?'/api/':'/api/v1/';
 const me=await ctx.request.get(origin+prefix+'auth/me'),identity=me.ok()?await me.json():{};
 const response=body===undefined?await ctx.request.get(origin+prefix+path):await ctx.request.post(origin+prefix+path,{headers:{'X-CSRF-Token':identity.csrf_token||'',Origin:origin},data:body});
 return {status:response.status(),data:await response.json()};
}
const p=(ctx:BrowserContext,path:string,body?:unknown)=>api(ctx,path,body);
const s=(ctx:BrowserContext,path:string,body?:unknown)=>api(ctx,path,body,true);
const suffix=crypto.randomBytes(5).toString('hex');
const accounts=[{email:'sanger-user-'+suffix+'@biohub.test',password:crypto.randomBytes(24).toString('base64url'),role:'admin',tool_roles:{yinglan:'user',sanger:'user'}},{email:'sanger-admin-'+suffix+'@biohub.test',password:crypto.randomBytes(24).toString('base64url'),role:'user',tool_roles:{sanger:'admin'}}];
async function test(name:string,run:()=>Promise<void>){await run();passed.push(name);console.log('PASS '+name);}
async function login(ctx:BrowserContext,account:typeof accounts[0]){
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(tool+'/');
 await page.getByLabel('邮箱',{exact:true}).fill(account.email);await page.getByLabel('密码',{exact:true}).fill(account.password);
 await page.getByRole('button',{name:'登录工作空间',exact:true}).click();await page.waitForURL(tool+'/**',{timeout:30000});
 const me=await s(ctx,'auth/me');assert.equal(me.status,200,JSON.stringify(me.data));return page;
}
let task:any,runId="",secondaryId="",project:any;
try{
 assert.equal((await p(manager,'auth/login',rootAdmin)).status,200);
 for(const account of accounts)assert.equal((await p(manager,'admin/users',account)).status,200);
 fs.writeFileSync(runtime+'/test-accounts.json',JSON.stringify(accounts,null,2)+'\n',{mode:0o600});
 const page=await login(a,accounts[0]);
 await test('automatic OIDC and independent role; local accounts disabled',async()=>{
  const me=await s(a,'auth/me');assert.equal(me.data.role,'user');assert.equal(me.data.auth_mode,'platform');
  assert.equal((await s(a,'auth/login',{username:'x',password:'x'})).status,403);
  assert.equal((await s(a,'admin/users')).status,403);assert.equal((await a.request.get(tool+'/api/platform/callback?state=forged&code=forged')).status(),403);assert.ok((await a.cookies()).some(c=>c.name==='biohub_sanger_session'));
 });
 await test('owned project and small synthetic FASTA submission',async()=>{
  const result=await s(a,'projects',{name:'Synthetic integration '+suffix,species:'human',numbering_scheme:'imgt'});assert.equal(result.status,201,JSON.stringify(result.data));project=result.data;
  const me=await s(a,'auth/me');const response=await a.request.post(tool+'/api/projects/'+project.id+'/tasks',{headers:{'X-CSRF-Token':me.data.csrf_token,Origin:tool},multipart:{metadata:JSON.stringify({sample_name:'synthetic',reference_explicit_none:true}),files:{name:'synthetic.fa',mimeType:'text/plain',buffer:fs.readFileSync(runtime+'/synthetic.fa')}}});
  assert.equal(response.status(),202,await response.text());task=await response.json();runId=task.run_id;
 });
 await test('real local annotation, settled zero hold, provenance and report',async()=>{
  let value:any;for(let n=0;n<90;n++){value=await s(a,'tasks/'+task.id);if(['completed','failed'].includes(value.data.status))break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(value.data.status,'completed',JSON.stringify(value.data));
  const annotation=await s(a,'tasks/'+task.id+'/annotation');assert.equal(annotation.status,200);assert.equal(annotation.data.igblast.status,'completed');assert.equal(annotation.data.anarci.status,'completed');
  assert.ok((await s(a,'tasks/'+task.id+'/runs')).data[0].rules_hash);
  let list:any;for(let n=0;n<30;n++){list=await p(a,'tasks');if(list.data.tasks.some((t:any)=>t.id===runId&&t.wallet_status==='settled'))break;await new Promise(r=>setTimeout(r,1000));}
  const summary=list.data.tasks.find((t:any)=>t.id===runId);assert.equal(summary?.wallet_status,'settled',JSON.stringify(list.data));assert.equal(summary.credits,0);assert.equal(summary.status,'succeeded');assert.ok(!JSON.stringify(summary).includes('synthetic'));
  assert.equal((await a.request.get(tool+'/api/tasks/'+task.id+'/report?format=json')).status(),200);
  assert.equal((await p(a,'wallet/balance')).data.frozen,0);
 });
 await login(b,accounts[1]);
 await test('tool administrator cannot access another user files, tasks or reports',async()=>{
  assert.equal((await s(b,'auth/me')).data.role,'admin');assert.equal((await p(b,'admin/users')).status,403);assert.deepEqual((await s(b,'projects')).data,[]);
  for(const path of ['tasks/'+task.id,'tasks/'+task.id+'/annotation','tasks/'+task.id+'/report?format=json','projects/'+project.id])assert.ok([403,404].includes((await s(b,path)).status),path);
 });
 await test('result deep link, reload, mobile layout and platform navigation',async()=>{
  await page.goto(tool+'/?task='+task.id+'&run='+runId);await page.waitForFunction(()=>document.querySelector('#sampleTitle')?.textContent?.includes('synthetic'));
  assert.equal(new URL(page.url()).searchParams.get('task'),task.id);await page.locator('#overviewDomain').waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('#downloadReportBtn') as HTMLButtonElement)?.disabled);await page.screenshot({path:runtime+'/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForFunction(()=>document.querySelector('#sampleTitle')?.textContent?.includes('synthetic'));await page.locator('#overviewDomain').waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('#downloadReportBtn') as HTMLButtonElement)?.disabled);await page.screenshot({path:runtime+'/mobile.png',fullPage:true});
  await page.waitForTimeout(1000);const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,bad:[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(e).display!=='none').slice(0,20).map(e=>({tag:e.tagName,cl:e.className,w:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))}));assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));await page.locator('#mobileMenu').click();await page.getByRole('link',{name:'平台工作台'}).waitFor({state:'visible'});assert.equal(await page.getByRole('link',{name:'平台工作台'}).count(),1);await page.keyboard.press('Escape');
 });
 await test('keyboard dialog traps focus, Escape restores focus, and task pagination has no duplicates',async()=>{
  await page.setViewportSize({width:1440,height:1000});await page.goto(tool+'/');await page.locator('#newProjectBtn').click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));
  await dialog.locator('button').last().focus();await page.keyboard.press('Tab');assert.ok(await dialog.getByRole('button',{name:'关闭弹窗'}).evaluate(el=>el===document.activeElement));
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.ok(await page.locator('#newProjectBtn').evaluate(el=>el===document.activeElement));
  let cursor:string|null='';const seen=new Set<string>();do{const result=await p(a,'tasks?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(result.status,200);assert.ok(result.data.tasks.length<=1);for(const row of result.data.tasks){assert.ok(!seen.has(row.id));seen.add(row.id);}cursor=result.data.next_cursor;}while(cursor);assert.ok(seen.has(runId));
 });
 await test('revoked permissions and disabled accounts invalidate sessions',async()=>{
  const id=(await p(b,'auth/me')).data.user.id;secondaryId=id;assert.equal((await p(manager,'admin/users/'+id,{tool_roles:{}})).status,200);assert.equal((await s(b,'auth/me')).status,403);
  assert.equal((await p(manager,'admin/users/'+id,{tool_roles:{sanger:'admin'},active:false})).status,200);assert.equal((await s(b,'auth/me')).status,401);
 });
 await test('global logout revokes platform and AbTrace sessions',async()=>{
  assert.equal((await s(a,'auth/logout',{})).status,200);assert.equal((await s(a,'auth/me')).status,401);assert.equal((await p(a,'auth/me')).data.user,null);
 });
 const userId=(await p(a,'auth/login',accounts[0])).status===200?(await p(a,'auth/me')).data.user.id:null;if(userId)await p(manager,'admin/users/'+userId,{role:'user',tool_roles:{yinglan:'user',sanger:'user'}});
 const adminLogin=await p(b,'auth/login',accounts[1]);if(adminLogin.status!==200){await p(manager,'admin/users/'+secondaryId,{active:true,tool_roles:{sanger:'admin'}});}
 accounts[0].role='user';fs.writeFileSync(runtime+'/test-accounts.json',JSON.stringify(accounts,null,2)+'\n',{mode:0o600});
 assert.deepEqual(errors,[]);fs.writeFileSync(runtime+'/browser-results.json',JSON.stringify({passed,errors,task:task.id,run:runId},null,2)+'\n',{mode:0o600});console.log('AbTrace integration: '+passed.length+' passed');
}finally{await browser.close();}
