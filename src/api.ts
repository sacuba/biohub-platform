import express from 'express';
import type {Express,Request,Response,NextFunction} from 'express';
import {z} from 'zod';
import QRCode from 'qrcode';
import {db,demand,AppError,audit,setSetting,setting,revokeUser,limit} from './db';
import {config,uid} from './config';
import * as auth from './auth';
import * as wallet from './wallet';
import {bearer,serviceToken} from './oidc';
import {tools} from './catalog';
import type {Rules,Tier} from './generated/platform';
const ok={ok:true};
const key=(req:Request)=>String(req.headers['idempotency-key']||'');
function pagination(req:Request){const cursor=Number(req.query.cursor||0),limit=Number(req.query.limit||50);demand(Number.isSafeInteger(cursor)&&cursor>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_PAGE','分页参数无效');return {cursor,limit};}
function rowsPage(rows:any[],limit:number){const hasMore=rows.length>limit;const list=rows.slice(0,limit);return {list:list.map(({cursor_id:_cursor,...row})=>row),next_cursor:hasMore?String(list.at(-1).cursor_id):null};}
export function setupApi(app:Express){
 app.use('/api/v1',express.json({limit:'1mb'}));
 app.use('/api/v1',(req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Request-Id',uid('request'));next();});
 app.use('/api/v1',async(req,res,next)=>{try{if(req.method!=='GET'){
 if(req.headers.authorization)demand(!req.headers.cookie,'AMBIGUOUS_AUTH','不要混用浏览器会话与服务授权',403);
 else auth.checkCsrf(req);
 }next();}catch(e){next(e);}});
 app.get('/api/v1/health',(_req,res)=>{db.prepare('SELECT 1').get();res.json({ok:true,service:'biohub-platform'});});
 app.get('/api/v1/tools',(_req,res)=>res.json({tools:tools(),brand:config.brand}));
 app.get('/api/v1/auth/me',(req,res)=>res.json({user:auth.session(req)?.user||null,csrf_token:auth.csrf(req,res)}));
 app.post('/api/v1/auth/login',async(req,res)=>{await auth.login(req.body,req,res);res.json(ok);});
 app.post('/api/v1/auth/register',async(req,res)=>{limit('register-ip:'+req.ip,10);const input=z.object({email:z.string(),password:z.string().min(8).max(128),confirm_password:z.string()}).parse(req.body);auth.password(input.password,input.confirm_password);const user=await auth.createUser(input);await auth.issueToken(user,'register');res.json(ok);});
 app.post('/api/v1/auth/verify',(req,res)=>{auth.verifyCode(req.body);res.json(ok);});
 app.post('/api/v1/auth/resend-code',async(req,res)=>{const email=auth.email(req.body.email);limit('resend:'+email,3);const user=db.prepare('SELECT * FROM users WHERE email=? AND verified=0 AND active=1').get(email) as any;if(user)await auth.issueToken(user,'register');res.json(ok);});
 app.post('/api/v1/auth/forgot-password',async(req,res)=>{const email=auth.email(req.body.email);limit('forgot:'+email,3);limit('forgot-ip:'+req.ip,10);const user=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email) as any;if(user)await auth.issueToken(user,'reset');res.json(ok);});
 app.post('/api/v1/auth/reset-password',async(req,res)=>{limit('reset-ip:'+req.ip,15);await auth.resetPassword(req.body);res.json(ok);});
 app.get('/api/v1/service/identity',async(req,res)=>{res.json((await bearer(req,'user')).user);});
 app.get('/api/v1/service/validate',async(req,res)=>{const access=await bearer(req,'service');res.json({tool_id:access.toolId,scopes:access.scopes});});
 app.get('/api/v1/wallet/balance',async(req,res)=>{const user=req.headers.authorization?(await bearer(req,'user')).user:auth.session(req)?.user;demand(user,'UNAUTHORIZED','请先登录',401);res.json(wallet.balance(user.id));});
 app.post('/api/v1/wallet/quotes',async(req,res)=>{const a=await bearer(req,'user');const input=z.object({task_id:z.string().min(1).max(200),parameters_hash:z.string().min(1).max(128),capability:z.enum(['generation','edit','batch','annotation'])}).parse(req.body);res.json(wallet.quote(a.user!.id,a.toolId,input,key(req)));});
 app.post('/api/v1/wallet/reservations',async(req,res)=>{const a=await bearer(req,'user');const input=z.object({quote_id:z.string().min(1).max(200),task_id:z.string().min(1).max(200),parameters_hash:z.string().min(1).max(128)}).parse(req.body);res.json(wallet.reserve(a.user!.id,a.toolId,input,key(req)));});
 app.get('/api/v1/wallet/operations/:task_id',async(req,res)=>{let a;try{a=await bearer(req,'service');}catch{a=await bearer(req,'user');}res.json({reservation:wallet.operation(a.toolId,String(req.params.task_id),a.user?.id)});});
 for(const action of ['settle','release'] as const)app.post('/api/v1/wallet/reservations/:reservation_id/'+action,async(req,res)=>{const a=await bearer(req,'service');demand(['yinglan','sanger'].includes(a.toolId)&&a.scopes.includes('wallet:finish'),'FORBIDDEN','服务不具备钱包结算权限',403);res.json(wallet.finish(a.toolId,String(req.params.reservation_id),action,key(req)));});
 app.post('/api/v1/wallet/operations/:task_id/release',async(req,res)=>{const a=await bearer(req,'service');demand(['yinglan','sanger'].includes(a.toolId)&&a.scopes.includes('wallet:finish'),'FORBIDDEN','没有释放权限',403);res.json(wallet.abandon(a.toolId,String(req.params.task_id),key(req)));});
 app.post('/api/v1/auth/logout',async(req,res,next)=>{if(!req.headers.authorization){next();return;}const a=await bearer(req,'user');auth.logout(a.user!.id,res);res.json(ok);});
 app.post('/api/v1/wallet/daily',async(req,res,next)=>{if(!req.headers.authorization){next();return;}const a=await bearer(req,'user');res.json(wallet.daily(a.user!.id));});
 // Browser-only routes. A service token cannot impersonate a browser user/admin.
 app.use('/api/v1',(req,_res,next)=>{try{demand(auth.session(req),'UNAUTHORIZED','请先登录',401);next();}catch(e){next(e);}});
 app.post('/api/v1/auth/logout',(req,res)=>{auth.logout(auth.session(req)!.user.id,res);res.json(ok);});
 app.post('/api/v1/auth/change-password',async(req,res)=>{await auth.changePassword(auth.session(req)!.user.id,req.body,res);res.json(ok);});
 app.post('/api/v1/wallet/daily',(req,res)=>{res.json(wallet.daily(auth.session(req)!.user.id));});
 app.post('/api/v1/wallet/redeem',(req,res)=>{limit('redeem:'+auth.session(req)!.user.id,20);res.json(wallet.redeem(auth.session(req)!.user.id,z.string().min(1).max(40).parse(req.body.code)));});
 app.get('/api/v1/shop-qr',async(_req,res)=>res.json({url:'https://wzyp.cn/shop/ATDJI0I4',qr:await QRCode.toDataURL('https://wzyp.cn/shop/ATDJI0I4',{width:200,margin:1})}));
 app.get('/api/v1/tasks',async(req,res)=>{
 const user=auth.session(req)!.user;const limit=Number(req.query.limit||50);demand(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_PAGE','分页参数无效');
 // Versioned composite cursor keeps independent per-tool positions without dropping rows.
 let positions:Record<string,string>={yinglan:'0',sanger:'0'};
 if(req.query.cursor){try{const parsed=JSON.parse(Buffer.from(String(req.query.cursor),'base64url').toString());demand(parsed.v===1,'INVALID_PAGE','分页参数无效');for(const id of ['yinglan','sanger'])demand(typeof parsed[id]==='string'&&/^(\d+|done)$/.test(parsed[id]),'INVALID_PAGE','分页参数无效');positions=parsed;}catch{demand(false,'INVALID_PAGE','分页参数无效');}}
 const unavailable:string[]=[];const tasks:any[]=[];let more=false;
 try{const token=await serviceToken();
 for(const [id,base] of [['yinglan',config.yinglanUrl],['sanger',config.sangerUrl]]){
 if(!user.tool_roles[id]||positions[id]==='done'||(id==='sanger'&&!config.sangerEnabled))continue;
 const remaining=limit-tasks.length;if(remaining<=0){more=true;continue;}
 try{const url=new URL(base+'/api/v1/tool/tasks');url.searchParams.set('user_id',user.id);url.searchParams.set('cursor',positions[id]);url.searchParams.set('limit',String(remaining));
 const r=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});demand(r.ok,'TOOL_UNAVAILABLE','工具暂不可用',503);const data=await r.json();tasks.push(...data.tasks);if(data.next_cursor){positions[id]=data.next_cursor;more=true;}else{positions[id]='done';}
 }catch{unavailable.push(id);}
 }
 }catch{unavailable.push(...['yinglan','sanger'].filter(id=>user.tool_roles[id]));}
 // A completed source must not replay on the next source's page.
 const next=more?Buffer.from(JSON.stringify({v:1,...positions})).toString('base64url'):null;
 res.json({tasks:tasks.sort((a,b)=>b.created_at.localeCompare(a.created_at)),unavailable,next_cursor:next});
 });
 app.use('/api/v1/admin',(req,_res,next)=>{try{demand(auth.session(req)!.user.role==='admin','FORBIDDEN','需要平台管理员权限',403);next();}catch(e){next(e);}});
 app.get('/api/v1/admin/users',(req,res)=>{const p=pagination(req);const data=rowsPage(db.prepare('SELECT rowid cursor_id,* FROM users WHERE rowid>? ORDER BY rowid LIMIT ?').all(p.cursor,p.limit+1),p.limit);res.json({users:db.transaction(()=>data.list.map(row=>({...auth.publicUser(row),...wallet.creditSummary(row.id)})))(),next_cursor:data.next_cursor});});
 app.post('/api/v1/admin/users',async(req,res)=>{const input=z.object({email:z.string(),password:z.string().min(8).max(128),role:z.enum(['user','admin']).optional(),tool_roles:z.partialRecord(z.enum(['yinglan','sanger']),z.enum(['user','admin'])).optional()}).parse(req.body);const u=await auth.createUser(input,true);audit(auth.session(req)!.user.id,'create_user',u.id,{email:u.email});res.json(ok);});
 app.post('/api/v1/admin/users/:user_id',(req,res)=>{const input=z.object({active:z.boolean().optional(),role:z.enum(['user','admin']).optional(),tool_roles:z.partialRecord(z.enum(['yinglan','sanger']),z.enum(['user','admin'])).optional()}).strict().parse(req.body);const id=String(req.params.user_id);db.transaction(()=>{const u=auth.userRow(id);demand(u,'NOT_FOUND','用户不存在',404);if(u.role==='admin'&&(input.role==='user'||input.active===false)){const n=(db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get() as any).n;demand(n>1,'LAST_ADMIN','不能停用或降级最后一个管理员');}db.prepare('UPDATE users SET active=?,role=?,tool_roles=? WHERE id=?').run(input.active===undefined?u.active:Number(input.active),input.role||u.role,input.tool_roles?JSON.stringify(input.tool_roles):u.tool_roles,id);if(input.active===false)revokeUser(id);audit(auth.session(req)!.user.id,'update_user',id,input);})();res.json(ok);});
 app.post('/api/v1/admin/adjustments',(req,res)=>{const input=z.object({user_id:z.string(),direction:z.enum(['add','subtract']),amount:z.number().int().min(1).max(10000000),reason:z.string().min(1).max(200)}).parse(req.body);const actor=auth.session(req)!.user.id;const result=wallet.adjust(input.user_id,input.direction,input.amount,input.reason,key(req),actor);audit(actor,'adjust_credits',input.user_id,input);res.json(result);});
 app.get('/api/v1/admin/rules',(_req,res)=>res.json(wallet.rules()));
 app.post('/api/v1/admin/rules',(req,res)=>{const input=z.object({registration:z.number().int().min(0).max(10000),daily:z.number().int().min(0).max(10000),gift_hours:z.number().int().min(1).max(8760),image_cost:z.number().int().min(0).max(10000),version:z.number().int()}).parse(req.body);const r:Rules={...input,version:wallet.rules().version+1};setSetting('rules',r);audit(auth.session(req)!.user.id,'update_rules','rules',r);res.json(r);});
 app.get('/api/v1/admin/tiers',(_req,res)=>res.json({tiers:setting<Tier[]>('tiers')}));
 app.post('/api/v1/admin/tiers',(req,res)=>{const input=z.object({tiers:z.array(z.object({id:z.string().min(1).max(80),name:z.string().min(1).max(80),credits:z.number().int().min(1).max(1000000),activity_price_cents:z.number().int().min(0).max(100000000),enabled:z.boolean()})).min(1).max(30)}).parse(req.body);demand(new Set(input.tiers.map(t=>t.id)).size===input.tiers.length,'DUPLICATE_TIER','档位 ID 不能重复');setSetting('tiers',input.tiers as Tier[]);audit(auth.session(req)!.user.id,'update_tiers','tiers',input);res.json(ok);});
 app.get('/api/v1/admin/batches',(req,res)=>{const p=pagination(req),keyword=String(req.query.keyword||'').slice(0,100);const data=rowsPage(db.prepare("SELECT b.rowid cursor_id,b.*,COUNT(c.id) count,SUM(c.status='redeemed') redeemed,SUM(c.status='revoked') revoked FROM batches b LEFT JOIN codes c ON c.batch_id=b.id WHERE b.rowid>? AND (instr(b.name,?)>0 OR instr(b.id,?)>0) GROUP BY b.id ORDER BY b.rowid LIMIT ?").all(p.cursor,keyword,keyword,p.limit+1),p.limit);res.json({batches:data.list,next_cursor:data.next_cursor});});
 app.post('/api/v1/admin/batches',(req,res)=>{const input=z.object({name:z.string().trim().min(1).max(80),tier_id:z.string(),count:z.number().int().min(1).max(500)}).parse(req.body);const result=wallet.createBatch(input.name,input.tier_id,input.count);audit(auth.session(req)!.user.id,'create_batch',result.batch_id,input);res.json(result);});
 app.post('/api/v1/admin/batches/:batch_id/revoke',(req,res)=>{const id=String(req.params.batch_id);db.prepare("UPDATE codes SET status='revoked' WHERE batch_id=? AND status='active'").run(id);audit(auth.session(req)!.user.id,'revoke_batch',id,{});res.json(ok);});
 app.get('/api/v1/admin/codes',(req,res)=>{const p=pagination(req);const data=rowsPage(db.prepare('SELECT c.rowid cursor_id,c.id,c.code,c.batch_id,c.credits,c.status,u.email redeemed_by,c.created_at FROM codes c LEFT JOIN users u ON c.redeemed_by=u.id WHERE c.rowid>? AND c.batch_id=? ORDER BY c.rowid LIMIT ?').all(p.cursor,String(req.query.batch_id||''),p.limit+1),p.limit);res.json({codes:data.list,next_cursor:data.next_cursor});});
 app.get('/api/v1/admin/mail',(_req,res)=>res.json(auth.mailConfig()));
 app.post('/api/v1/admin/mail',(req,res)=>{auth.saveMail(req.body);audit(auth.session(req)!.user.id,'update_mail','mail',{host:req.body.host});res.json(ok);});
 app.use('/api/v1',(_req,_res,next)=>next(new AppError('NOT_FOUND','接口不存在',404)));
}
export function errorHandler(error:any,_req:Request,res:Response,_next:NextFunction){
 const known=error instanceof AppError;const status=known?error.status:error instanceof z.ZodError||error?.type==='entity.parse.failed'?400:error?.type==='entity.too.large'?413:500;
 if(status===500)console.error('API error',error);
 res.status(status).json({error:{code:known?error.code:status===400?'INVALID_INPUT':status===413?'PAYLOAD_TOO_LARGE':'INTERNAL_ERROR',message:known?error.message:status===400?'输入格式不正确':status===413?'请求内容过大':'服务暂时不可用',request_id:String(res.getHeader('X-Request-Id')||uid('request'))}});
}
