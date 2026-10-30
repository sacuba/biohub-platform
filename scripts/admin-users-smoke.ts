import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {chromium,expect,type Page} from '@playwright/test';
import assert from 'node:assert/strict';
import {resolveSafe} from './runtime.mjs';
// Development only: no production flag, no existing user credentials, no mail or tool calls.
const base='http://192.168.6.111:3200';
const db=new Database(resolveSafe(path.resolve('../dev-runtime/platform/platform.sqlite')));db.pragma('foreign_keys=ON');
const prefix='admin-ui-'+crypto.randomUUID().slice(0,8),email=(i:number)=>`${prefix}-${String(i).padStart(3,'0')}@example.test`,id=(i:number)=>`${prefix}-${i}`;
const token=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(token).digest('hex'),now=new Date().toISOString();
db.transaction(()=>{
 for(let i=0;i<105;i++)db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id(i),email(i),'!',i===0?'admin':'user',i%5===0?0:1,i>=102?0:1,JSON.stringify(i===0?{}:{yinglan:'user',sanger:'user'}),now);
 db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash,id(0),'fixture',Date.now()+600000);
 for(const [suffix,remaining,expires] of [['live',35,null],['expired',80,'2000-01-01T00:00:00.000Z']] as const)db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?,?)').run(prefix+suffix,id(0),'TEST',remaining,remaining,expires,prefix+suffix,now);
 db.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?)').run(prefix+'quote',id(0),'yinglan',prefix+'task',5,1,'fixture',now);
 db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(prefix+'hold',id(0),'yinglan',prefix+'task',prefix+'quote',5,'reserved','[]',now,now);
})();
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});
const errors:string[]=[];
async function rows(page:Page,count:number){await expect(page.locator('.userTable tbody tr')).toHaveCount(count);await expect(page.getByText('正在加载用户…',{exact:true})).toHaveCount(0);}
async function overflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await context.addCookies([{name:'biohub_session',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/workspace?view=admin');await page.getByRole('heading',{name:'用户与工具权限',exact:true}).waitFor();
 const search=page.getByRole('searchbox',{name:'邮箱或账号名称'});await search.fill(prefix);await rows(page,20);await expect(page.locator('.userPagination')).toContainText('共 105 位用户 · 第 1 / 6 页');
 const first=await page.locator('.userTable tbody tr td:first-child').allTextContents();await page.getByRole('button',{name:'下一页',exact:true}).click();await rows(page,20);const second=await page.locator('.userTable tbody tr td:first-child').allTextContents();assert.equal(first.some(value=>second.includes(value)),false);
 await page.getByRole('button',{name:'上一页',exact:true}).click();await rows(page,20);
 for(const size of ['50','100','20']){await page.getByLabel('每页条数').selectOption(size);await rows(page,Number(size));}
 await page.getByLabel('账号状态',{exact:true}).selectOption('inactive');await rows(page,3);await expect(page.locator('.userPagination')).toContainText('第 1 / 1 页');
 await page.getByLabel('账号状态',{exact:true}).selectOption('all');await rows(page,20);
 await page.getByLabel('平台角色筛选').selectOption('admin');await rows(page,1);await expect(page.locator('.userTable')).toContainText('35 积分');await expect(page.locator('.userTable')).toContainText('冻结 5 积分');
 await page.getByLabel('平台角色筛选').selectOption('all');await rows(page,20);await overflow(page);await page.screenshot({path:'test-results/admin-users-desktop.png',fullPage:true});
 console.log('PASS 105 fixtures: server pages, sizes, search, filters, no duplicate rows, admin spendable/frozen balance');
 await search.fill(email(1));await rows(page,1);const manage=page.getByRole('button',{name:'管理工具权限',exact:true});
 // Fetch current roles at open, independent of the stale row summary.
 db.prepare('UPDATE users SET tool_roles=? WHERE id=?').run(JSON.stringify({yinglan:'admin'}),id(1));
 await manage.click();const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Yinglan 科研生图权限')).toHaveValue('admin');await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('');await expect(dialog).toContainText(email(1));
 await dialog.getByLabel('Yinglan 科研生图权限').selectOption('');await dialog.getByLabel('Yinglan 科研生图权限').selectOption('admin');await expect(dialog.getByRole('button',{name:'保存权限'})).toBeDisabled();await dialog.getByRole('button',{name:'关闭工具权限弹窗'}).focus();
 await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'关闭工具权限弹窗'})).toBeFocused();
 await dialog.getByLabel('Sanger 抗体分析权限').selectOption('user');
 page.once('dialog',event=>event.dismiss());await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('user');
 page.once('dialog',event=>event.accept());await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(manage).toBeFocused();assert.deepEqual(JSON.parse((db.prepare('SELECT tool_roles FROM users WHERE id=?').get(id(1)) as any).tool_roles),{yinglan:'admin'});
 await manage.click();await expect(dialog.getByLabel('Yinglan 科研生图权限')).toHaveValue('admin');await dialog.getByLabel('Sanger 抗体分析权限').selectOption('user');
 const writeURL=base+'/api/v1/admin/users/'+id(1);let writes=0;let releaseSave!:()=>void;const blockedSave=new Promise<void>(resolve=>{releaseSave=resolve;});
 await page.route(writeURL,async route=>{if(route.request().method()!=='POST'){await route.continue();return;}writes++;await blockedSave;await route.fulfill({status:503,json:{error:{code:'TEST_FAILURE',message:'模拟保存失败，请重试'}}});});
 await dialog.getByRole('button',{name:'保存权限',exact:true}).click();await expect(dialog.getByRole('button',{name:'保存中…'})).toBeDisabled();await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeDisabled();await page.keyboard.press('Escape');await expect(dialog).toBeVisible();releaseSave();
 await expect(dialog.getByRole('alert')).toContainText('模拟保存失败');await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('user');assert.equal(writes,1);await page.unroute(writeURL);
 await dialog.getByRole('button',{name:'保存权限',exact:true}).click();await expect(dialog).toHaveCount(0);await rows(page,1);await expect(manage).toBeFocused();await expect(page.locator('.permissionSummary')).toContainText('已授权 2 个工具');assert.equal((db.prepare('SELECT role FROM users WHERE id=?').get(id(1)) as any).role,'user');
 console.log('PASS fresh permission reads, focus trap/return, dirty cancel/Escape, failed save retains edits, busy blocks repeats, retry updates summary');
 let finishRead!:()=>void;const readBarrier=new Promise<void>(resolve=>{finishRead=resolve;});
 await page.route(writeURL,async route=>{await readBarrier;await route.continue();});await manage.click();await expect(dialog.getByText('正在读取当前权限…')).toBeVisible();await expect(dialog.getByRole('button',{name:'保存权限'})).toBeDisabled();finishRead();await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('user');await page.unroute(writeURL);
 await dialog.getByLabel('Sanger 抗体分析权限').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('user');await page.keyboard.press('Tab');await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 // Empty registry and permission-read denial are explicit states and cannot submit.
 await page.route(base+'/api/v1/admin/tool-permissions',route=>route.fulfill({json:{tools:[]}}));await manage.click();await expect(dialog.getByText('暂无可管理的工具。')).toBeVisible();await expect(dialog.getByRole('button',{name:'保存权限'})).toBeDisabled();await page.keyboard.press('Escape');await page.unroute(base+'/api/v1/admin/tool-permissions');
 await page.route(writeURL,route=>route.fulfill({status:403,json:{error:{code:'FORBIDDEN',message:'需要平台管理员权限'}}}));await manage.click();await expect(dialog.getByRole('alert')).toContainText('需要平台管理员权限');await expect(dialog.getByRole('button',{name:'保存权限'})).toBeDisabled();await page.unroute(writeURL);await dialog.getByRole('button',{name:'重新读取'}).click();await expect(dialog.getByLabel('Yinglan 科研生图权限')).toHaveValue('admin');await page.keyboard.press('Escape');
 console.log('PASS empty controlled registry and denied permission reads, with retry');
 // Fail list load, then recover; empty search is distinct from failure.
 await page.route('**/api/v1/admin/users?**',route=>route.fulfill({status:503,json:{error:{message:'模拟列表错误'}}}));await page.getByRole('button',{name:'刷新列表'}).click();await expect(page.locator('.adminUsers').getByRole('alert')).toContainText('模拟列表错误');await page.unroute('**/api/v1/admin/users?**');await page.getByRole('button',{name:'重试',exact:true}).click();await rows(page,1);
 await search.fill(prefix+'-absent');await rows(page,0);await expect(page.getByText('暂无匹配用户，请调整搜索或筛选条件。')).toBeVisible();
 // Hold an older result, let a new request finish, then deliver the old response.
 let releaseOld!:()=>void;const oldBarrier=new Promise<void>(resolve=>{releaseOld=resolve;});let oldSeen!:()=>void;const oldStarted=new Promise<void>(resolve=>{oldSeen=resolve;});
 await page.route('**/api/v1/admin/users?**',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('keyword')===email(2)){const response=await route.fetch();oldSeen();await oldBarrier;await route.fulfill({response});}else await route.continue();});
 await search.fill(email(2));await oldStarted;await search.fill(email(3));await rows(page,1);await expect(page.locator('.userTable')).toContainText(email(3));releaseOld();await page.unrouteAll({behavior:'wait'});await expect(page.locator('.userTable')).toContainText(email(3));
 // Change page while an earlier request is pending, then leave/re-enter the tab.
 await search.fill(prefix);await rows(page,20);await page.getByRole('button',{name:'下一页',exact:true}).click();await rows(page,20);await search.fill(email(4));await rows(page,1);await expect(page.locator('.userPagination')).toContainText('第 1 / 1 页');
 let finishTab!:()=>void;const tabBarrier=new Promise<void>(resolve=>{finishTab=resolve;});let tabSeen!:()=>void;const tabStarted=new Promise<void>(resolve=>{tabSeen=resolve;});
 await page.route('**/api/v1/admin/users?**',async route=>{const response=await route.fetch();tabSeen();await tabBarrier;await route.fulfill({response});});await search.fill(email(5));await tabStarted;await page.getByRole('button',{name:'积分与售价',exact:true}).click();finishTab();await page.unrouteAll({behavior:'wait'});await page.getByRole('button',{name:'用户与权限',exact:true}).click();await search.fill(email(4));await rows(page,1);await expect(page.locator('.userTable')).toContainText(email(4));
 console.log('PASS list error/retry/empty states, stale responses cannot overwrite new search, search resets page');
 // Existing state, role and credits controls still work on synthetic users only.
 await page.getByRole('button',{name:'停用',exact:true}).click();await expect(page.getByRole('button',{name:'启用',exact:true})).toBeVisible();await page.getByRole('button',{name:'启用',exact:true}).click();await expect(page.getByRole('button',{name:'停用',exact:true})).toBeVisible();
 await page.getByLabel(email(4)+'平台角色').selectOption('admin');await expect(page.getByLabel(email(4)+'平台角色')).toHaveValue('admin');assert.deepEqual(JSON.parse((db.prepare('SELECT tool_roles FROM users WHERE id=?').get(id(4)) as any).tool_roles),{yinglan:'user',sanger:'user'});
 await page.getByRole('button',{name:'调整积分',exact:true}).click();await page.getByRole('dialog').getByLabel('积分',{exact:true}).fill('17');await page.getByRole('dialog').getByLabel('调整原因').fill('isolated admin UI test');await page.getByRole('button',{name:'确认调整',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await rows(page,1);await expect(page.locator('.userTable')).toContainText('17 积分');
 // End-page adjustment after state changes and independent fixture deletion.
 await search.fill(prefix);await page.getByLabel('账号状态',{exact:true}).selectOption('active');await rows(page,20);for(let i=0;i<5;i++){await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.userPagination')).toContainText(`第 ${i+2} / 6 页`);}await rows(page,2);
 db.prepare('UPDATE users SET active=0 WHERE id IN (?,?)').run(id(100),id(101));await page.getByRole('button',{name:'刷新列表'}).click();await rows(page,20);await expect(page.locator('.userPagination')).toContainText('第 5 / 5 页');
 console.log('PASS status toggles, separate platform role, credit adjustment and shrinking last page');
 await page.setViewportSize({width:390,height:844});await search.fill(email(1));await rows(page,1);await overflow(page);await page.screenshot({path:'test-results/admin-users-mobile.png',fullPage:true});await page.getByRole('button',{name:'管理工具权限',exact:true}).click();await expect(dialog.getByLabel('Sanger 抗体分析权限')).toHaveValue('user');await overflow(page);const bounds=await dialog.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.height<=844);await page.screenshot({path:'test-results/admin-permissions-mobile.png',fullPage:true});await page.keyboard.press('Escape');
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'管理工具权限',exact:true}).click();await expect(dialog.getByLabel('Yinglan 科研生图权限')).toHaveValue('admin');await page.screenshot({path:'test-results/admin-permissions-desktop.png',fullPage:true});await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
 console.log('PASS actual Edge desktop/mobile, native keyboard modal, no document overflow or browser exceptions');
 const guest=await browser.newContext();for(const route of ['admin/users?page=1','admin/tool-permissions','admin/users/'+id(1)])assert.equal((await guest.request.get(base+'/api/v1/'+route)).status(),401);await guest.close();
 console.log('Admin users browser checks passed; synthetic fixtures will be removed.');
}finally{
 await browser.close();db.transaction(()=>{
  for(let i=0;i<105;i++){
   for(const table of ['sessions','account_tokens','reservations','quotes','buckets','ledger'])db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id(i));
   db.prepare('DELETE FROM idempotency WHERE scope LIKE ?').run('%'+id(i)+'%');db.prepare('DELETE FROM audit WHERE actor_id=? OR target=?').run(id(i),id(i));db.prepare('DELETE FROM users WHERE id=?').run(id(i));
  }
 })();db.close();
}
