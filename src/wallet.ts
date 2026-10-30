import {molecularTools} from './catalog';
import crypto from 'node:crypto';
import {db,setting,AppError,demand} from './db';
import {uid,now,hash} from './config';
import type {Rules,Tier,Quote,Reservation} from './generated/platform';
// AbTrace developer policy: change only after a separate pricing approval.
export const annotationPricing={unit:'sample_analysis_run',credits:Number(process.env.SANGER_ANALYSIS_CREDITS||0),version:Number(process.env.SANGER_PRICE_VERSION||1)} as const;
if(!Number.isSafeInteger(annotationPricing.credits)||annotationPricing.credits<0||!Number.isSafeInteger(annotationPricing.version)||annotationPricing.version<1)throw new Error('Invalid annotation pricing configuration');
export function rules(){return setting<Rules>('rules');}
export function grant(userId:string,amount:number,kind:string,reference:string,expires:string|null=null,reason=''){
 demand(Number.isSafeInteger(amount)&&amount>=0,'INVALID_AMOUNT','积分必须是非负整数');
 const existing=db.prepare('SELECT id FROM buckets WHERE user_id=? AND kind=? AND reference=?').get(userId,kind,reference);if(existing)return;
 const id=uid('bucket');db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?,?)').run(id,userId,kind,amount,amount,expires,reference,now());
 db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid('ledger'),userId,kind,amount,reference,reason,now());
}
export function expire(userId:string){
 const rows=db.prepare('SELECT * FROM buckets WHERE user_id=? AND remaining>0 AND expires_at IS NOT NULL AND expires_at<=?').all(userId,now()) as any[];
 for(const row of rows){db.prepare('UPDATE buckets SET remaining=0 WHERE id=?').run(row.id);db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid('ledger'),userId,'EXPIRED',-row.remaining,row.id+':'+uid('expiry'),'赠送积分到期',now());}
}
// Read a current snapshot without writing expiry ledgers when an administrator browses users.
export function creditSummary(userId:string){return db.prepare(`SELECT
 COALESCE((SELECT SUM(remaining) FROM buckets WHERE user_id=@userId AND (expires_at IS NULL OR expires_at>@at)),0) available_credits,
 COALESCE((SELECT SUM(amount) FROM reservations WHERE user_id=@userId AND state='reserved'),0) frozen_credits
 `).get({userId,at:now()}) as {available_credits:number;frozen_credits:number};}
export function balance(userId:string,includeLedger=true){return db.transaction(()=>{
 expire(userId);
 const available=(db.prepare('SELECT COALESCE(SUM(remaining),0) n FROM buckets WHERE user_id=?').get(userId) as any).n;
 const frozen=(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM reservations WHERE user_id=? AND state='reserved'").get(userId) as any).n;
 const ledger=includeLedger?db.prepare('SELECT l.*,COALESCE(b.remaining,0) remaining,b.expires_at FROM ledger l LEFT JOIN buckets b ON b.user_id=l.user_id AND b.kind=l.kind AND b.reference=l.reference WHERE l.user_id=? ORDER BY l.rowid DESC LIMIT 200').all(userId) as any[]:[];
 return {available,frozen,ledger:ledger.map(({user_id:_user,...r})=>r),tiers:setting<Tier[]>('tiers').filter(t=>t.enabled),rules:rules()};
})()}
// Account scope comes from the server session, never from browser query parameters.
export function ledgerPage(userId:string,page=1,pageSize=20){return db.transaction(()=>{
 demand(Number.isSafeInteger(page)&&page>=1&&[20,50,100].includes(pageSize),'INVALID_PAGE','分页参数无效');
 expire(userId);
 const total=(db.prepare('SELECT COUNT(*) total FROM ledger WHERE user_id=?').get(userId) as {total:number}).total;
 const totalPages=Math.max(1,Math.ceil(total/pageSize)),current=Math.min(page,totalPages);
 const ledger=db.prepare('SELECT l.id,l.kind,l.amount,l.reference,l.reason,l.created_at,COALESCE(b.remaining,0) remaining,b.expires_at FROM ledger l LEFT JOIN buckets b ON b.user_id=l.user_id AND b.kind=l.kind AND b.reference=l.reference WHERE l.user_id=? ORDER BY l.rowid DESC LIMIT ? OFFSET ?').all(userId,pageSize,(current-1)*pageSize);
 return {ledger,total,page:current,page_size:pageSize,total_pages:totalPages};
})()}
export function daily(userId:string){return db.transaction(()=>{const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const r=rules();grant(userId,r.daily,'DAILY_GIFT','daily:'+day,new Date(Date.now()+r.gift_hours*3600000).toISOString());return {ok:true};})()}
export function registrationGift(userId:string){const r=rules();grant(userId,r.registration,'REGISTER_GIFT','registration',new Date(Date.now()+r.gift_hours*3600000).toISOString());}
export function idempotent<T>(scope:string,key:string,input:unknown,fn:()=>T):T{
 demand(typeof key==='string'&&key.length>=1&&key.length<=200,'IDEMPOTENCY_REQUIRED','需要有效的 Idempotency-Key');
 return db.transaction(()=>{const requestHash=hash(JSON.stringify(input));const prior=db.prepare('SELECT * FROM idempotency WHERE scope=? AND key=?').get(scope,key) as any;
 if(prior){demand(prior.request_hash===requestHash,'IDEMPOTENCY_CONFLICT','幂等键已用于不同参数',409);return JSON.parse(prior.result);}
 const result=fn();db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope,key,requestHash,JSON.stringify(result));return result;
 })();
}
export function quote(userId:string,toolId:string,input:{task_id:string;parameters_hash:string;capability:string},key:string):Quote{
 demand((toolId==='yinglan'&&['generation','edit','batch'].includes(input.capability))||(toolId==='sanger'&&input.capability==='annotation')||(molecularTools().some(t=>t.id===toolId)&&input.capability==='compute'),'CAPABILITY_NOT_ALLOWED','工具能力未开放',403);
 return idempotent('quote:'+userId+':'+toolId,key,input,()=>{const r=rules();const q:Quote={id:uid('quote'),user_id:userId,tool_id:toolId,task_id:input.task_id,amount:toolId.startsWith('mol-')?0:toolId==='sanger'?annotationPricing.credits:r.image_cost,price_version:toolId.startsWith('mol-')?1:toolId==='sanger'?annotationPricing.version:r.version,parameters_hash:input.parameters_hash,expires_at:new Date(Date.now()+600000).toISOString()};db.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?)').run(q.id,q.user_id,q.tool_id,q.task_id,q.amount,q.price_version,q.parameters_hash,q.expires_at);return q;});
}
function publicReservation(row:any):Reservation{const {allocations:_allocations,quote_id:_quote_id,updated_at:_updated,...safe}=row;return safe;}
export function operation(toolId:string,taskId:string,userId?:string){const row=db.prepare('SELECT * FROM reservations WHERE tool_id=? AND task_id=?').get(toolId,taskId) as any;if(row&&userId)demand(row.user_id===userId,'FORBIDDEN','任务不属于当前用户',403);return row?publicReservation(row):null;}
export function reserve(userId:string,toolId:string,input:{quote_id:string;task_id:string;parameters_hash:string},key:string):Reservation{
 return idempotent('reserve:'+userId+':'+toolId,key,input,()=>{
 demand(!db.prepare("SELECT 1 FROM cancelled_operations WHERE tool_id=? AND task_id=?").get(toolId,input.task_id),"TASK_CANCELLED","任务已取消，不能冻结积分",409);
 const q=db.prepare('SELECT * FROM quotes WHERE id=?').get(input.quote_id) as Quote|undefined;
 demand(q&&q.user_id===userId&&q.tool_id===toolId&&q.task_id===input.task_id&&q.parameters_hash===input.parameters_hash,'QUOTE_MISMATCH','报价与任务不匹配',403);
 const previous=db.prepare('SELECT * FROM reservations WHERE tool_id=? AND task_id=?').get(toolId,input.task_id) as any;
 if(previous){demand(previous.quote_id===q.id,'TASK_CONFLICT','任务已有其他冻结',409);return publicReservation(previous);}
 demand(Date.parse(q.expires_at)>Date.now(),'QUOTE_EXPIRED','报价已过期，请重新提交',409);
 expire(userId);
 const buckets=db.prepare('SELECT * FROM buckets WHERE user_id=? AND remaining>0 ORDER BY COALESCE(expires_at,\'9999\'),rowid').all(userId) as any[];
 demand(buckets.reduce((s,r)=>s+r.remaining,0)>=q.amount,'INSUFFICIENT_CREDITS','积分不足，请前往积分中心兑换',402);
 let left=q.amount;const allocations=[];
 for(const b of buckets){if(!left)break;const amount=Math.min(left,b.remaining);db.prepare('UPDATE buckets SET remaining=remaining-? WHERE id=?').run(amount,b.id);allocations.push({bucket_id:b.id,amount});left-=amount;}
 const r:Reservation={id:uid('reservation'),user_id:userId,tool_id:toolId,task_id:q.task_id,amount:q.amount,state:'reserved',created_at:now()};
 db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.id,userId,toolId,q.task_id,q.id,r.amount,r.state,JSON.stringify(allocations),r.created_at,now());return r;
 });
}
export function finish(toolId:string,reservationId:string,action:'settle'|'release',key:string):Reservation{
 return idempotent(action+':'+toolId,key,{reservation_id:reservationId},()=>{
 const r=db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId) as any;
 demand(r&&r.tool_id===toolId,'FORBIDDEN','不能处理其他工具的冻结',403);
 const target=action==='settle'?'settled':'released';
 demand(r.state==='reserved'||r.state===target,'RESERVATION_FINAL','积分操作已结束，不能反转',409);
 if(r.state===target)return publicReservation(r);
 if(action==='release'){
 for(const a of JSON.parse(r.allocations))db.prepare('UPDATE buckets SET remaining=remaining+? WHERE id=?').run(a.amount,a.bucket_id);
 expire(r.user_id);
 }
 db.prepare('UPDATE reservations SET state=?,updated_at=? WHERE id=?').run(target,now(),r.id);
 db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid('ledger'),r.user_id,action==='settle'?'USAGE':'RELEASE',action==='settle'?-r.amount:0,r.task_id,action==='settle'?toolId+' 任务消费':'失败或取消，释放冻结积分',now());
 return publicReservation({...r,state:target});
 });
}
export function adjust(userId:string,direction:'add'|'subtract',amount:number,reason:string,key:string,actorId:string){return idempotent('adjust:'+actorId,key,{userId,direction,amount,reason},()=>{
 demand(Number.isSafeInteger(amount)&&amount>0,'INVALID_AMOUNT','调整积分必须是正整数');
 demand(db.prepare('SELECT id FROM users WHERE id=?').get(userId),'NOT_FOUND','用户不存在',404);
 if(direction==='add')grant(userId,amount,'ADMIN_ADJUSTMENT',key,null,reason);
 else{expire(userId);const rows=db.prepare('SELECT * FROM buckets WHERE user_id=? AND remaining>0 ORDER BY COALESCE(expires_at,\'9999\')').all(userId) as any[];demand(rows.reduce((s,b)=>s+b.remaining,0)>=amount,'INSUFFICIENT_CREDITS','可用积分不足',402);let left=amount;for(const b of rows){const n=Math.min(left,b.remaining);db.prepare('UPDATE buckets SET remaining=remaining-? WHERE id=?').run(n,b.id);left-=n;if(!left)break;}db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid('ledger'),userId,'ADMIN_ADJUSTMENT',-amount,key,reason,now());}
 return {ok:true};});}
export function redeem(userId:string,input:string){return db.transaction(()=>{const code=input.trim().toUpperCase();const r=db.prepare('SELECT * FROM codes WHERE code=?').get(code) as any;demand(r&&r.status==='active','CODE_INVALID','兑换码无效、已使用或已作废');db.prepare("UPDATE codes SET status='redeemed',redeemed_by=? WHERE id=? AND status='active'").run(userId,r.id);grant(userId,r.credits,'REDEEM',r.id);return {ok:true};})()}
export function createBatch(name:string,tierId:string,count:number){return db.transaction(()=>{
 const tier=setting<Tier[]>('tiers').find(t=>t.id===tierId&&t.enabled);demand(tier,'TIER_INVALID','面值档位不存在或未启用');demand(count>=1&&count<=500&&Number.isInteger(count),'INVALID_COUNT','每批生成 1–500 张');
 const id=uid('batch');db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run(id,name,tier.credits,now());const codes=[];
 for(let n=0;n<count;n++){const code=crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-');db.prepare('INSERT INTO codes(id,code,batch_id,credits,created_at) VALUES(?,?,?,?,?)').run(uid('code'),code,id,tier.credits,now());codes.push(code);}
 return {batch_id:id,codes};})()}
export {AppError};

export function abandon(toolId:string,taskId:string,key:string){return idempotent("abandon:"+toolId,key,{taskId},()=>{db.prepare("INSERT OR IGNORE INTO cancelled_operations VALUES(?,?)").run(toolId,taskId);const r=operation(toolId,taskId);if(r?.state==="reserved")finish(toolId,r.id,"release","abandon:"+taskId);demand(!r||r.state!=="settled","RESERVATION_FINAL","任务已结算",409);return {ok:true};});}
