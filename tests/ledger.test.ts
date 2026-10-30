import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
process.env.DATA_DIR=path.resolve('../dev-runtime/platform-ledger-tests',crypto.randomUUID());process.env.MAIL_TRANSPORT='capture';
const {db}=await import('../src/db');const {hash}=await import('../src/config');const wallet=await import('../src/wallet');const {setupApi,errorHandler}=await import('../src/api');
for(const id of ['owner','other','empty'])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id,id+'@example.test','!','user',1,1,'{}','2026-10-30T00:00:00.000Z');
const tokens=Object.fromEntries(['owner','other','empty'].map(id=>[id,crypto.randomUUID()]));
for(const [id,token] of Object.entries(tokens))db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),id,'csrf',Date.now()+600000);
db.transaction(()=>{for(let i=0;i<205;i++)wallet.grant('owner',1,'TEST','entry-'+i,null,'entry '+i);wallet.grant('other',99,'TEST','private',null,'other private record');})();
const app=express();setupApi(app);app.use(errorHandler);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
async function get(query='',account='owner'){return fetch(base+'/api/v1/wallet/ledger'+query,{headers:{Cookie:'biohub_session='+(tokens[account]||'')}});}
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();fs.rmSync(process.env.DATA_DIR!,{recursive:true,force:true});});
test('ledger uses stable server pages beyond the old 200-row limit with accurate totals and sizes',async()=>{
 const ids:string[]=[];const references:string[]=[];
 for(let page=1;page<=11;page++){const response=await get('?page='+page);assert.equal(response.status,200);const data=await response.json();assert.equal(data.total,205);assert.equal(data.total_pages,11);assert.equal(data.page,page);assert.equal(data.ledger.length,page===11?5:20);ids.push(...data.ledger.map((row:any)=>row.id));references.push(...data.ledger.map((row:any)=>row.reference));for(const row of data.ledger)assert.equal(row.user_id,undefined);}
 assert.equal(new Set(ids).size,205);assert.deepEqual(references,Array.from({length:205},(_,i)=>'entry-'+(204-i)));
 for(const size of [50,100]){const data=await (await get('?page=1&page_size='+size)).json();assert.equal(data.page_size,size);assert.equal(data.ledger.length,size);}
 const legacy=await fetch(base+'/api/v1/wallet/balance',{headers:{Cookie:'biohub_session='+tokens.owner}}).then(r=>r.json());assert.equal(legacy.ledger.length,200);assert.equal(legacy.available,205);
 const summary=await fetch(base+'/api/v1/wallet/balance?include_ledger=false',{headers:{Cookie:'biohub_session='+tokens.owner}}).then(r=>r.json());assert.equal(summary.ledger.length,0);assert.equal(summary.available,205);
});
test('ledger scopes to session and rejects impersonation, service identity and malformed pages',async()=>{
 const other=await (await get('','other')).json();assert.equal(other.total,1);assert.equal(other.ledger[0].reference,'private');
 assert.equal((await get('','guest')).status,401);
 assert.equal((await fetch(base+'/api/v1/wallet/ledger',{headers:{Authorization:'Bearer fake'}})).status,401);
 for(const query of ['?user_id=other','?page=0','?page=-1','?page=1.5','?page=NaN','?page=9007199254740992','?page_size=10','?page_size=101','?page=1&page=2'])assert.equal((await get(query)).status,400,query);
});
test('empty ledger, page clamping after deletion and current gift expiry are consistent',async()=>{
 const empty=await (await get('?page=999','empty')).json();assert.equal(empty.page,1);assert.equal(empty.total_pages,1);assert.equal(empty.total,0);assert.deepEqual(empty.ledger,[]);
 db.prepare("DELETE FROM ledger WHERE user_id='owner' AND reference IN ('entry-0','entry-1','entry-2','entry-3','entry-4')").run();const last=await (await get('?page=11')).json();assert.equal(last.page,10);assert.equal(last.total,200);assert.equal(last.ledger.length,20);
 wallet.grant('empty',8,'REGISTER_GIFT','expired-gift','2000-01-01T00:00:00.000Z');const expiry=await (await get('','empty')).json();assert.equal(expiry.total,2);assert.equal(expiry.ledger[0].kind,'EXPIRED');assert.equal(expiry.ledger[0].amount,-8);assert.equal(expiry.ledger[1].remaining,0);
 assert.equal((await (await get('','empty')).json()).total,2);
});
