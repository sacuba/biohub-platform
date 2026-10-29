import Database from 'better-sqlite3';
import path from 'node:path';
import {config,now} from './config';
export const db=new Database(path.join(config.dataDir,'platform.sqlite'));
db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',verified INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,tool_roles TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS buckets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),remaining INTEGER NOT NULL CHECK(remaining>=0),expires_at TEXT,reference TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,kind,reference));
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,amount INTEGER NOT NULL,reference TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,UNIQUE(user_id,kind,reference));
CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),tool_id TEXT NOT NULL,task_id TEXT NOT NULL,amount INTEGER NOT NULL,price_version INTEGER NOT NULL,parameters_hash TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),tool_id TEXT NOT NULL,task_id TEXT NOT NULL,quote_id TEXT NOT NULL REFERENCES quotes(id),amount INTEGER NOT NULL,state TEXT NOT NULL,allocations TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(tool_id,task_id));
CREATE TABLE IF NOT EXISTS cancelled_operations(tool_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(tool_id,task_id));
CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,name TEXT NOT NULL,credits INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codes(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,batch_id TEXT NOT NULL REFERENCES batches(id),credits INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',redeemed_by TEXT REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oidc(model TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER,grant_id TEXT,user_code TEXT,uid TEXT,account_id TEXT,PRIMARY KEY(model,id));
CREATE INDEX IF NOT EXISTS oidc_account ON oidc(account_id);
CREATE INDEX IF NOT EXISTS oidc_grant ON oidc(grant_id);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
`);
export const defaults={registration:10,daily:5,gift_hours:720,image_cost:5,version:1};
const tiers=[{id:'tier_30',name:'轻量体验',credits:30,activity_price_cents:390,enabled:true},{id:'tier_100',name:'日常科研',credits:100,activity_price_cents:990,enabled:true},{id:'tier_500',name:'进阶探索',credits:500,activity_price_cents:3990,enabled:true},{id:'tier_1000',name:'高效研究',credits:1000,activity_price_cents:6990,enabled:true}];
for(const [key,value]of Object.entries({rules:defaults,tiers}))db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));
export function setting<T>(key:string):T{return JSON.parse((db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}).value);}
export function setSetting(key:string,value:unknown){db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
export function audit(actor:string,action:string,target:string,detail:unknown){db.prepare('INSERT INTO audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)').run(actor,action,target,JSON.stringify(detail),now());}
export function revokeUser(userId:string){db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);db.prepare('DELETE FROM oidc WHERE account_id=?').run(userId);}
export class AppError extends Error{constructor(public code:string,message:string,public status=400){super(message);}}
export function demand(ok:unknown,code:string,message:string,status=400):asserts ok{if(!ok)throw new AppError(code,message,status);}
export function limit(key:string,max=10,windowMs=900000){db.transaction(()=>{const row=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key) as any;if(!row||row.reset_at<Date.now())db.prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,reset_at=excluded.reset_at').run(key,Date.now()+windowMs);else{demand(row.count<max,'RATE_LIMITED','操作过于频繁，请稍后重试',429);db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);}})();}
