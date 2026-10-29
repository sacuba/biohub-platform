import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const prod=process.env.BIOHUB_PROD_DIR||'/opt/sci_image/platform-prod';
const env=Object.fromEntries(fs.readFileSync(path.join(prod,'.env'),'utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
const db=new Database(path.join(prod,'data/platform.sqlite'));const source=JSON.parse(fs.readFileSync(process.env.BIOHUB_MIGRATION_EXPORT!,'utf8'));
const token=crypto.randomBytes(32).toString('hex'),probeFile=path.join(prod,'data/.migration-probe');fs.writeFileSync(probeFile,token,{mode:0o600});fs.chownSync(probeFile,1000,1000);
const id='migration_probe_'+crypto.randomUUID(),email=id+'@biohub.invalid',password=crypto.randomBytes(24).toString('base64url');
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 assert.equal((db.prepare('SELECT COUNT(*) n FROM users').get() as any).n,source.users.length);
 for(const u of source.users){const actual=db.prepare('SELECT * FROM users WHERE id=?').get(u.id) as any;assert.equal(actual.email,u.email.trim().toLowerCase());assert.equal(actual.password_hash,u.passwordHash);assert.equal(actual.role,u.role);}
 assert.equal((db.prepare('SELECT COUNT(*) n FROM codes').get() as any).n,source.codes.length);assert.equal((db.prepare('SELECT COUNT(*) n FROM ledger').get() as any).n,source.ledger.length);console.log('PASS all original account hashes, IDs, ledger and code counts preserved');
 db.prepare('INSERT INTO users(id,email,password_hash,role,verified,active,tool_roles,created_at) VALUES(?,?,?,\'user\',1,1,?,?)').run(id,email,await bcrypt.hash(password,12),JSON.stringify({yinglan:'user'}),new Date().toISOString());
 // Skip gift on this controlled probe login by recording a zero-amount daily bucket.
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?,?)').run('probe_daily',id,'DAILY_GIFT',0,0,null,'daily:'+day,new Date().toISOString());
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});const context=await browser.newContext({extraHTTPHeaders:{'X-Biohub-Migration-Probe':token}});const page=await context.newPage();
 await page.goto(env.APP_URL+'/?login=1');await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录工作空间',exact:true}).click();await expect(page).toHaveURL(env.APP_URL+'/workspace');await page.getByRole('button',{name:'进入工具',exact:true}).click();await page.waitForURL(env.YINGLAN_URL+'/',{timeout:45000});await page.getByTestId('credit-balance').waitFor();
 const me=await (await context.request.get(env.YINGLAN_URL+'/api/auth/me')).json();assert.equal(me.user.email,email);assert.equal(me.user.role,'user');const templates=await (await context.request.get(env.YINGLAN_URL+'/api/templates')).json();assert.equal(templates.platformTemplates.length,54);
 console.log('PASS production HTTPS, secure Cookies, PKCE/OIDC login and template catalog');
 await page.getByRole('link',{name:'返回工具大厅',exact:false}).click();await expect(page).toHaveURL(env.APP_URL+'/workspace');await page.goto(env.APP_URL+'/workspace?view=account');await page.getByRole('button',{name:'退出平台及所有工具',exact:true}).click();await expect(page).toHaveURL(env.APP_URL+'/');assert.equal((await (await context.request.get(env.YINGLAN_URL+'/api/auth/me')).json()).user,null);console.log('PASS production return navigation and global token revocation');
}finally{
 await browser?.close();fs.rmSync(probeFile,{force:true});
 db.transaction(()=>{for(const table of ['sessions','account_tokens','buckets','ledger'])db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(id);db.prepare('DELETE FROM oidc WHERE account_id=?').run(id);db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').run('%'+email+'%');db.prepare('DELETE FROM users WHERE id=?').run(id);})();db.close();
 // Operator cleanup of the single ephemeral tool identity, before public writes reopen.
 const toolData=process.env.BIOHUB_TOOL_DATA_DIR||'/opt/sci_image/yinglan-prod/data';
 const toolDb=new Database(path.join(toolData,'yinglan.sqlite'));try{toolDb.transaction(()=>{const row=toolDb.prepare('SELECT state FROM app_state WHERE id=1').get() as any;const store=JSON.parse(row.state);const ids=new Set(store.users.filter((u:any)=>u.platformSubject===id).map((u:any)=>u.id));store.sessions=store.sessions.filter((s:any)=>!ids.has(s.userId));store.users=store.users.filter((u:any)=>!ids.has(u.id));toolDb.prepare('UPDATE app_state SET state=?,updated_at=? WHERE id=1').run(JSON.stringify(store),new Date().toISOString());})();}finally{toolDb.close();}
}
