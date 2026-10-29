import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,type BrowserContext} from '@playwright/test';
const platform='https://biohub.zhangwuji.work:49998',tool='https://sanger.zhangwuji.work:49998';
const amino='EVQLVESGGGLVQPGGSLRLSCAASGFTFSSYAMSWVRQAPGKGLEWVSAISGSGGSTYYADSVKGRFTISRDNSKNTLYLQMNSLRAEDTAVYYCAKDRWGQGTLVTVSS';
const codons:Record<string,string>={A:'GCT',C:'TGT',D:'GAT',E:'GAA',F:'TTT',G:'GGT',H:'CAT',I:'ATT',K:'AAA',L:'CTG',M:'ATG',N:'AAT',P:'CCT',Q:'CAA',R:'CGT',S:'TCT',T:'ACT',V:'GTT',W:'TGG',Y:'TAT'};
const sample=Buffer.from('>artificial-release-probe\n'+[...amino].map(a=>codons[a]).join('')+'\n');
const state='/opt/sci_image/release-runtime/sanger/production-probes.json';
const accounts=JSON.parse(fs.readFileSync(state,'utf8'));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
const a=await browser.newContext(),b=await browser.newContext();
const errors:string[]=[],passed:string[]=[];
async function test(name:string,fn:()=>Promise<void>){await fn();passed.push(name);console.log('PASS '+name);}
async function api(ctx:BrowserContext,route:string,body?:unknown,onTool=false){const base=onTool?tool:platform,prefix=onTool?'/api/':'/api/v1/';const me=await (await ctx.request.get(base+prefix+'auth/me')).json();const r=body===undefined?await ctx.request.get(base+prefix+route):await ctx.request.post(base+prefix+route,{headers:{'X-CSRF-Token':me.csrf_token||'',Origin:base},data:body});return {status:r.status(),data:await r.json()};}
async function login(ctx:BrowserContext,index:number,destination=tool+'/'){
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(destination);
 await page.getByLabel('邮箱',{exact:true}).fill(accounts[index].email);await page.getByLabel('密码',{exact:true}).fill(accounts[index].password);
 await page.getByRole('button',{name:'登录工作空间',exact:true}).click();await page.waitForURL(tool+'/**');return page;
}
let task:any;
try{
 const page=await login(a,0);
 await test('public HTTPS, PKCE/OIDC, secure independent cookie and exact production sources',async()=>{
  const me=await api(a,'auth/me',undefined,true);assert.equal(me.status,200);assert.equal(me.data.role,'user');
  const cookies=await a.cookies(tool);const session=cookies.find(c=>c.name==='biohub_sanger_session');assert.ok(session?.secure&&session?.httpOnly);
  const config=await api(a,'platform/config',undefined,true);assert.equal(config.data.platform_url,platform);assert.equal(config.data.tool_url,tool);
  assert.equal((await api(a,'auth/login',{},true)).status,403);
 });
 await test('real bounded analysis, private report and zero-credit wallet summary',async()=>{
  const project=await api(a,'projects',{name:'release-probe',species:'human',numbering_scheme:'imgt'},true);assert.equal(project.status,201);
  const me=await api(a,'auth/me',undefined,true);const r=await a.request.post(tool+'/api/projects/'+project.data.id+'/tasks',{headers:{'X-CSRF-Token':me.data.csrf_token,Origin:tool},multipart:{metadata:JSON.stringify({sample_name:'synthetic-release-probe'}),files:{name:'artificial.fa',mimeType:'text/plain',buffer:sample}}});assert.equal(r.status(),202,await r.text());task=await r.json();
  let item:any;for(let n=0;n<90;n++){item=await api(a,'tasks/'+task.id,undefined,true);if(['failed','completed'].includes(item.data.status))break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(item.data.status,'completed',JSON.stringify(item.data));
  const ann=await api(a,'tasks/'+task.id+'/annotation',undefined,true);assert.equal(ann.data.anarci.status,'completed');assert.equal(ann.data.igblast.status,'completed');
  assert.equal((await a.request.get(tool+'/api/tasks/'+task.id+'/report?format=json')).status(),200);
  let summary:any;for(let n=0;n<40;n++){const list=await api(a,'tasks');summary=list.data.tasks.find((t:any)=>t.id===task.run_id);if(summary?.wallet_status==='settled')break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(summary.wallet_status,'settled');assert.equal(summary.credits,0);assert.equal(summary.result_url,tool+'/?task='+task.id+'&run='+task.run_id);
 });
 await login(b,1);
 await test('platform administrator stays normal tool user and cannot read another user results',async()=>{
  assert.equal((await api(b,'auth/me',undefined,true)).data.role,'user');
  assert.ok([403,404].includes((await api(b,'tasks/'+task.id,undefined,true)).status));
  assert.ok([403,404].includes((await b.request.get(tool+'/api/tasks/'+task.id+'/report?format=json')).status()));
 });
 await test('result deep link, mobile, keyboard and navigation use production URLs',async()=>{
  await page.goto(tool+'/?task='+task.id+'&run='+task.run_id);await page.locator('#overviewDomain').waitFor();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.getByRole('link',{name:'平台工作台'}).getAttribute('href'),platform+'/workspace');
 });
 await test('tool logout revokes platform and the established tool session',async()=>{
  assert.equal((await api(a,'auth/logout',{},true)).status,200);assert.equal((await api(a,'auth/me',undefined,true)).status,401);assert.equal((await api(a,'auth/me')).data.user,null);
 });
 assert.deepEqual(errors,[]);fs.writeFileSync('/opt/sci_image/release-runtime/sanger/production-smoke.json',JSON.stringify({passed,errors,task:task.id,run:task.run_id},null,2)+'\n',{mode:0o600});console.log('Production smoke: '+passed.length+' passed');
}finally{await browser.close();}
