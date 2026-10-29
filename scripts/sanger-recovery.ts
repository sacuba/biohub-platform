import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from '@playwright/test';
const exec=promisify(execFile),base='http://192.168.6.111:3200',tool='http://192.168.6.111:3202';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
const ctx=await browser.newContext();
const account=JSON.parse(fs.readFileSync('../dev-runtime/sanger/test-accounts.json','utf8'))[0];
const results:string[]=[];let platformStopped=false,toolStopped=false;
async function stack(command:string,app:string){await exec(process.execPath,['../scripts/dev-stack.mjs',command,app],{cwd:process.cwd(),env:{...process.env,BIOHUB_MAIL_TRANSPORT:'capture'},timeout:210000,maxBuffer:100000});}
async function api(path:string,body?:unknown){const me=await (await ctx.request.get(tool+'/api/auth/me')).json();const r=body===undefined?await ctx.request.get(tool+'/api/'+path):await ctx.request.post(tool+'/api/'+path,{headers:{'X-CSRF-Token':me.csrf_token,Origin:tool},data:body});const data=await r.json();assert.ok(r.ok(),JSON.stringify(data));return data;}
async function platform(path:string){const r=await ctx.request.get(base+'/api/v1/'+path);assert.ok(r.ok());return r.json();}
async function tasks(project:string){return api('projects/'+project+'/tasks');}
async function submit(project:string,name:string,content:Buffer){const me=await api('auth/me');const r=await ctx.request.post(tool+'/api/projects/'+project+'/tasks',{headers:{'X-CSRF-Token':me.csrf_token,Origin:tool},multipart:{metadata:JSON.stringify({sample_name:name}),files:{name:name+'.fa',mimeType:'text/plain',buffer:content}}});assert.equal(r.status(),202,await r.text());return r.json();}
async function waitTask(id:string,status:string){for(let n=0;n<90;n++){const data=await api('tasks/'+id);if(data.status===status)return data;if(data.status==='failed'&&status!=='failed')throw new Error(JSON.stringify(data));await new Promise(r=>setTimeout(r,300));}throw new Error('Timed out waiting '+id+' '+status);}
async function summary(run:string,wallet:string){for(let n=0;n<50;n++){const data=await platform('tasks');const row=data.tasks.find((t:any)=>t.id===run);if(row?.wallet_status===wallet)return row;await new Promise(r=>setTimeout(r,400));}throw new Error('Timed out waiting wallet '+run+' '+wallet);}
async function test(name:string,run:()=>Promise<void>){await run();results.push(name);console.log('PASS '+name);}
try{
 const page=await ctx.newPage();await page.goto(tool+'/');await page.getByLabel('邮箱',{exact:true}).fill(account.email);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录工作空间',exact:true}).click();await page.waitForURL(tool+'/**');
 const project=await api('projects',{name:'Recovery '+crypto.randomBytes(5).toString('hex'),species:'human',numbering_scheme:'imgt'});
 const sequence=fs.readFileSync('../dev-runtime/sanger/synthetic.fa');
 const before=await platform('wallet/balance');
 await test('invalid sequence fails and releases hold without charging',async()=>{
  const task=await submit(project.id,'invalid',Buffer.from('>invalid\nNOT-A-SEQUENCE\n'));await waitTask(task.id,'failed');assert.equal((await summary(task.run_id,'released')).status,'failed');
 });
 await test('cancellation is durable, computation stops before release, repeated cancellation is safe',async()=>{
  const task=await submit(project.id,'cancel',sequence);await api('tasks/'+task.id+'/cancel',{});await api('tasks/'+task.id+'/cancel',{});await waitTask(task.id,'cancelled');assert.equal((await summary(task.run_id,'released')).status,'cancelled');
 });
 await test('concurrent submissions use separate intents and one zero hold per run',async()=>{
  const submitted=await Promise.all([submit(project.id,'parallel-a',sequence),submit(project.id,'parallel-b',sequence)]);
  for(const task of submitted){await waitTask(task.id,'completed');const row=await summary(task.run_id,'settled');assert.equal(row.credits,0);}
  assert.equal(new Set(submitted.map(t=>t.run_id)).size,2);
 });
 await test('platform outage blocks protected access and wallet work; restart recovers',async()=>{
  // Preserve the CSRF value before taking the platform offline; tool cannot refresh authorization while offline.
  const me=await api('auth/me');const task=await submit(project.id,'network-recovery',sequence);
  await stack('stop','platform');platformStopped=true;
  const response=await ctx.request.get(tool+'/api/auth/me');assert.ok([500,503].includes(response.status()));
  const newTask=await ctx.request.post(tool+'/api/projects/'+project.id+'/tasks',{headers:{'X-CSRF-Token':me.csrf_token,Origin:tool},multipart:{metadata:JSON.stringify({sample_name:'blocked'}),files:{name:'blocked.fa',mimeType:'text/plain',buffer:sequence}}});assert.ok([500,503].includes(newTask.status()));
  await stack('start','platform');platformStopped=false;
  await waitTask(task.id,'completed');await summary(task.run_id,'settled');
  assert.ok(!(await tasks(project.id)).some((t:any)=>t.sample_name==='blocked'));
 });
 await test('worker interruption during calculation recovers the same run without orphan computation or duplicate charge',async()=>{
  const task=await submit(project.id,'worker-interruption',sequence);await waitTask(task.id,'running');
  const root=fs.realpathSync('../sanger');
  const workers=fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).filter(name=>{try{return fs.realpathSync('/proc/'+name+'/cwd')===root&&fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\0').includes('app.workers.worker')&&fs.readFileSync('/proc/'+fs.readFileSync('/proc/'+name+'/status','utf8').match(/^PPid:\s+(\d+)/m)![1]+'/cmdline','utf8').includes('scripts/dev-entry.py');}catch{return false;}});
  assert.equal(workers.length,1);process.kill(Number(workers[0]),'SIGKILL');
  await stack('stop','sanger');toolStopped=true;await stack('start','sanger');toolStopped=false;
  await waitTask(task.id,'completed');await summary(task.run_id,'settled');
  const runs=await api('tasks/'+task.id+'/runs');assert.equal(runs.length,1);assert.equal(runs[0].id,task.run_id);
 });
 await test('tool stop and restart retain task, input, result, provenance and wallet final state',async()=>{
  const task=await submit(project.id,'restart',sequence);await waitTask(task.id,'completed');await summary(task.run_id,'settled');
  const prior=await api('tasks/'+task.id+'/annotation');
  await stack('stop','sanger');toolStopped=true;await stack('start','sanger');toolStopped=false;
  const after=await api('tasks/'+task.id+'/annotation');assert.deepEqual(after,prior);await summary(task.run_id,'settled');
  const report=await ctx.request.get(tool+'/api/tasks/'+task.id+'/report?format=json');assert.equal(report.status(),200);const data=await report.json();assert.ok(data.provenance?.parameters?.rules_hash);assert.ok(data.provenance?.reference_databases?.snapshot);
 });
 await test('zero credit workflow preserves available balance and has no residual holds',async()=>{
  const after=await platform('wallet/balance');assert.equal(after.available,before.available);assert.equal(after.frozen,before.frozen);
 });
 fs.writeFileSync('../dev-runtime/sanger/recovery-results.json',JSON.stringify({passed:results},null,2)+'\n',{mode:0o600});console.log('AbTrace recovery: '+results.length+' passed');
}finally{if(platformStopped)await stack('start','platform');if(toolStopped)await stack('start','sanger');await browser.close();}
