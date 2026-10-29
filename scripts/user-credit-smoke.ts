import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const production=process.argv.includes('--production');
const base=production?'https://biohub.zhangwuji.work:49998':'http://192.168.6.111:3200';
const tool=production?'https://image.zhangwuji.work:49998':'http://192.168.6.111:3201';
const database=production?'/opt/sci_image/platform-prod/data/platform.sqlite':path.resolve('../dev-runtime/platform/platform.sqlite');
const db=new Database(database);const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex');
// Operator-generated short-lived verification session; never needs a real user's password.
const admin=db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get() as {id:string};
db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash,admin.id,crypto.randomBytes(24).toString('hex'),Date.now()+300000);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext();await context.addCookies([{name:'biohub_session',value:raw,url:base,httpOnly:true,secure:production,sameSite:'Lax'}]);
 const page=await context.newPage();await page.goto(base+'/workspace?view=admin');await expect(page.getByRole('heading',{name:'用户与工具权限',exact:true})).toBeVisible();await expect(page.getByRole('columnheader',{name:'积分余额',exact:true})).toBeVisible();
 const result=await context.request.get(base+'/api/v1/admin/users');assert.equal(result.status(),200);const payload=await result.json();assert.ok(payload.users.length);
 const at=new Date().toISOString();for(const user of payload.users){const expected=db.prepare("SELECT COALESCE((SELECT SUM(remaining) FROM buckets WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)),0) available,COALESCE((SELECT SUM(amount) FROM reservations WHERE user_id=? AND state='reserved'),0) frozen").get(user.id,at,user.id) as any;assert.equal(user.available_credits,expected.available);assert.equal(user.frozen_credits,expected.frozen);const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:user.email,exact:false})});await expect(row.getByRole('cell').nth(1)).toContainText(user.available_credits+' 积分');await expect(row.getByRole('cell').nth(1)).toContainText('冻结 '+user.frozen_credits+' 积分');}
 console.log('PASS admin user list shows current spendable and frozen credits matching the wallet');
 const guest=await browser.newContext();const guestPage=await guest.newPage();await guestPage.goto(tool+'/');await guestPage.waitForURL(url=>url.origin===base,{timeout:30000});await expect(guestPage.getByRole('dialog')).toBeVisible();await expect(guestPage.getByRole('heading',{name:'使用统一科研账号'})).toHaveCount(0);console.log('PASS guest Yinglan root automatically redirects to platform login');
 const unauthorized=await guest.request.get(base+'/api/v1/admin/users');assert.equal(unauthorized.status(),401);console.log('PASS guest cannot read admin users or balances');
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('columnheader',{name:'积分余额',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);console.log('PASS admin balance table stays inside mobile layout');
}finally{await browser.close();db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);db.close();}
