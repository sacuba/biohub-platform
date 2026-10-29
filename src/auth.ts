import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import type {Request,Response} from 'express';
import {db,demand,setting,setSetting,revokeUser,limit} from './db';
import {config,uid,hash,now,encrypt,decrypt} from './config';
import {registrationGift,daily} from './wallet';
import type {User} from './generated/platform';
export function cookies(req:Request){return Object.fromEntries((req.headers.cookie||'').split(';').map(p=>p.trim().split(/=(.*)/s)).filter(p=>p[0]).map(([k,v])=>[k,decodeURIComponent(v||'')]));}
export function publicUser(row:any):User{return {id:row.id,email:row.email,role:row.role,verified:!!row.verified,active:!!row.active,tool_roles:JSON.parse(row.tool_roles),created_at:row.created_at};}
export function userRow(id:string){return db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;}
export function session(req:Request){const raw=cookies(req).biohub_session;if(!raw)return null;const r=db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(hash(raw),Date.now()) as any;return r?{user:publicUser(r),csrf:r.csrf}:null;}
const cookieOptions={httpOnly:true,sameSite:'lax' as const,secure:config.appUrl.startsWith('https:'),path:'/'};
export function csrf(req:Request,res:Response){const existing=cookies(req).biohub_csrf;const raw=existing?.split('.')[0];if(raw&&existing===signCsrf(raw))return existing;const value=signCsrf(crypto.randomBytes(24).toString('hex'));res.cookie('biohub_csrf',value,{...cookieOptions,maxAge:86400000});return value;}
function signCsrf(raw:string){return raw+'.'+crypto.createHmac('sha256',config.cookieSecret).update(raw).digest('hex');}
export function checkCsrf(req:Request){const value=req.headers['x-csrf-token'];const cookie=cookies(req).biohub_csrf;demand(req.headers.origin===new URL(config.appUrl).origin&&typeof value==='string'&&value===cookie&&value===signCsrf(value.split('.')[0]),'CSRF_INVALID','请求来源或安全校验无效',403);}
export function createSession(userId:string,res:Response){const raw=crypto.randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(raw),userId,crypto.randomBytes(24).toString('hex'),Date.now()+14*86400000);res.cookie('biohub_session',raw,{...cookieOptions,maxAge:14*86400000});}
export function logout(userId:string,res:Response){revokeUser(userId);res.clearCookie('biohub_session',cookieOptions);}
export function email(input:unknown){demand(typeof input==='string'&&input.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input),'INVALID_EMAIL','请输入正确邮箱');return input.trim().toLowerCase();}
export function password(input:unknown,confirm:unknown){demand(typeof input==='string'&&input.length>=8&&input.length<=128,'INVALID_PASSWORD','密码需要 8–128 位');demand(input===confirm,'PASSWORD_MISMATCH','两次密码不一致');return input;}
export async function createUser(input:{email:string;password:string;role?:'user'|'admin';tool_roles?:Record<string,string>},verified=false){
 const normalized=email(input.email);const pw=password(input.password,input.password);const passwordHash=await bcrypt.hash(pw,12);const id=uid('user');
 db.transaction(()=>{demand(!db.prepare('SELECT id FROM users WHERE email=?').get(normalized),'ACCOUNT_EXISTS','该邮箱已注册');db.prepare('INSERT INTO users(id,email,password_hash,role,verified,tool_roles,created_at) VALUES(?,?,?,?,?,?,?)').run(id,normalized,passwordHash,input.role||'user',verified?1:0,JSON.stringify(input.tool_roles||{yinglan:'user',...(config.sangerEnabled?{sanger:'user'}:{})}),now());if(verified)registrationGift(id);})();return publicUser(userRow(id));
}
export function mailConfig(){const row=db.prepare("SELECT value FROM settings WHERE key='mail'").get() as any;const value=row?JSON.parse(row.value):{};return {...value,password:undefined,has_password:!!value.password,host:value.host||'',port:value.port||587,secure:!!value.secure,user:value.user||'',from:value.from||'',capture:config.capture};}
export function saveMail(input:any){demand(typeof input.host==='string'&&input.host.length>0&&Number.isInteger(input.port)&&input.port>=1&&input.port<=65535&&typeof input.from==='string','INVALID_MAIL_CONFIG','请检查邮件服务器参数');const prior=db.prepare("SELECT value FROM settings WHERE key='mail'").get() as any;const previous=prior?JSON.parse(prior.value):{};setSetting('mail',{host:input.host,port:input.port,secure:!!input.secure,user:String(input.user||''),from:input.from,password:input.password?encrypt(String(input.password)):previous.password||''});}
async function send(email:string,kind:string,value:string){
 if(config.capture){const file=path.join(config.dataDir,'mail-capture.jsonl');fs.appendFileSync(file,JSON.stringify({email,kind,value,created_at:now()})+'\n',{mode:0o600});return;}
 const c=setting<any>('mail');demand(c?.host&&c?.from,'MAIL_UNAVAILABLE','邮件服务未配置',503);
 const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.secure,auth:c.user?{user:c.user,pass:c.password?decrypt(c.password):''}:undefined});
 const text=kind==='register'?`你的 BioHub 注册验证码为 ${value}，10 分钟内有效。`:`请通过此地址重置密码：${config.appUrl}/?reset=${encodeURIComponent(value)}`;
 await transport.sendMail({from:c.from,to:email,subject:kind==='register'?'BioHub 注册验证码':'BioHub 重置密码',text});
}
export async function issueToken(user:any,kind:'register'|'reset'){
 const value=kind==='register'?String(crypto.randomInt(100000,1000000)):crypto.randomBytes(32).toString('base64url');
 db.prepare('DELETE FROM account_tokens WHERE user_id=? AND kind=?').run(user.id,kind);
 db.prepare('INSERT INTO account_tokens(id,user_id,kind,token_hash,expires_at) VALUES(?,?,?,?,?)').run(uid('token'),user.id,kind,hash(value),Date.now()+(kind==='register'?600000:3600000));
 await send(user.email,kind,value);
}
export function verifyCode(input:any){const normalized=email(input.email);limit('verify:'+normalized,10,600000);const user=db.prepare('SELECT * FROM users WHERE email=?').get(normalized) as any;
 const r=user?db.prepare("SELECT * FROM account_tokens WHERE user_id=? AND kind='register'").get(user.id) as any:null;
 if(r)db.prepare('UPDATE account_tokens SET attempts=attempts+1 WHERE id=?').run(r.id);
 demand(r&&r.expires_at>Date.now()&&r.attempts<6&&r.token_hash===hash(String(input.code||'')),'INVALID_CODE','验证码无效或已过期');
 db.transaction(()=>{db.prepare('UPDATE users SET verified=1 WHERE id=?').run(user.id);db.prepare('DELETE FROM account_tokens WHERE id=?').run(r.id);registrationGift(user.id);})();
}
export async function login(input:any,req:Request,res:Response){const normalized=email(input.email);limit('login:'+normalized);limit('login-ip:'+req.ip,40);const row=db.prepare('SELECT * FROM users WHERE email=?').get(normalized) as any;const valid=await bcrypt.compare(String(input.password||''),row?.password_hash||'$2b$12$LCsB2cUTPddQYtHrAbXoFeEKXkmm.CbyqsTzVLrqRC6wm/fm.r6Zq');demand(row&&valid,'INVALID_CREDENTIALS','邮箱或密码错误',401);demand(row.active&&row.verified,'ACCOUNT_UNAVAILABLE','账号未验证或已停用',403);createSession(row.id,res);daily(row.id);}
export async function changePassword(userId:string,input:any,res:Response){const row=userRow(userId);demand(await bcrypt.compare(String(input.current_password||''),row.password_hash),'INVALID_PASSWORD','原密码不正确');const next=await bcrypt.hash(password(input.password,input.confirm_password),12);db.transaction(()=>{db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(next,userId);revokeUser(userId);})();createSession(userId,res);}
export async function resetPassword(input:any){const value=String(input.token||'');const r=db.prepare("SELECT * FROM account_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?").get(hash(value),Date.now()) as any;demand(r,'INVALID_TOKEN','重置链接无效或已过期');const next=await bcrypt.hash(password(input.password,input.confirm_password),12);db.transaction(()=>{const still=db.prepare('SELECT id FROM account_tokens WHERE id=?').get(r.id);demand(still,'INVALID_TOKEN','链接已使用');db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(next,r.user_id);revokeUser(r.user_id);db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(r.user_id);})();}
