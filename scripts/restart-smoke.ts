import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from '@playwright/test';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const run=promisify(execFile);
const stack=(command:string,app:string)=>run(process.execPath,[path.join(workspace,'scripts/dev-stack.mjs'),command,app],{cwd:workspace,timeout:110000});
const base='http://192.168.6.111:3200',tool='http://192.168.6.111:3201';
const account=JSON.parse(fs.readFileSync(path.join(workspace,'dev-runtime/platform/test-accounts.json'),'utf8'))[0];
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
const context=await browser.newContext();
async function platform(route:string,body?:unknown){const me=await context.request.get(base+'/api/v1/auth/me');const csrf=(await me.json()).csrf_token;const response=await context.request.fetch(base+'/api/v1/'+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-CSRF-Token':csrf},data:body});assert.equal(response.status(),200);return response.json();}
async function job(id:string){const response=await context.request.get(tool+'/api/jobs/'+id);assert.equal(response.status(),200);return (await response.json()).job;}
try{
 await platform('auth/login',account);const page=await context.newPage();await page.goto(tool+'/api/platform/login');await page.waitForURL(tool+'/',{timeout:30000});
 const before=(await platform('wallet/balance')).available;
 const response=await context.request.post(tool+'/api/jobs/generation',{headers:{Origin:tool,'Idempotency-Key':crypto.randomUUID()},data:{prompt:'Persistent restart smoke research diagram'}});assert.equal(response.status(),202);const id=(await response.json()).job.id;
 const until=Date.now()+40000;let completed;while(Date.now()<until){const j=await job(id);if(j.status==='succeeded'&&j.platformWallet.state==='settled'){completed=j;break;}await new Promise(r=>setTimeout(r,250));}assert.ok(completed);assert.equal((await platform('wallet/balance')).available,before-5);
 await stack('stop','yinglan');const unavailable=await platform('tasks');assert.deepEqual(unavailable.unavailable,['yinglan']);console.log('PASS task center reports unavailable development tool');
 await stack('start','yinglan');const recovered=await job(id);assert.equal(recovered.status,'succeeded');assert.deepEqual(recovered.resultAssetIds,completed.resultAssetIds);assert.equal((await platform('wallet/balance')).available,before-5);console.log('PASS tool process restart preserves task results, authorization and settled credits');
 await stack('stop','platform');const denied=await context.request.post(tool+'/api/jobs/generation',{headers:{Origin:tool,'Idempotency-Key':crypto.randomUUID()},data:{prompt:'Must not execute while identity and wallet are offline'}});assert.ok(denied.status()>=400);console.log('PASS platform outage prevents unauthorized execution');
 await stack('start','platform');assert.equal((await platform('wallet/balance')).available,before-5);assert.equal((await job(id)).platformWallet.state,'settled');assert.equal((await context.request.get(tool+'/api/assets/'+recovered.resultAssetIds[0]+'/download')).status(),200);console.log('PASS platform restart restores persisted authorization and wallet without another charge');
 await platform('auth/logout',{});
}finally{
 await browser.close();await stack('start','platform');await stack('start','yinglan');
}
