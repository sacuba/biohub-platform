import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import {chromium,expect,type Page} from '@playwright/test';
import assert from 'node:assert/strict';
import {resolveSafe} from './runtime.mjs';
const base='http://192.168.6.111:3200',prefix='theme-ledger-'+crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(token).digest('hex');
const db=new Database(resolveSafe(path.resolve('../dev-runtime/platform/platform.sqlite')));db.pragma('foreign_keys=ON');
db.transaction(()=>{
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(prefix,prefix+'@example.test','!','admin',1,1,'{}',new Date().toISOString());
 db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash,prefix,'fixture',Date.now()+600000);
 for(let i=0;i<205;i++)db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(prefix+'-'+i,prefix,'ADMIN_ADJUSTMENT',1,'fixture-'+i,'合成流水 '+String(i).padStart(3,'0'),new Date().toISOString());
})();
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-sandbox']});const errors:string[]=[];
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function ledgerRows(page:Page,count:number){await expect(page.locator('.creditLedger tbody tr')).toHaveCount(count);await expect(page.getByText('正在加载积分流水…',{exact:true})).toHaveCount(0);}
async function contrast(page:Page,selector:string){
 const colors=await page.locator(selector).first().evaluate(element=>{
  let parent:Element|null=element;let background='';while(parent){background=getComputedStyle(parent).backgroundColor;if(background!=='rgba(0, 0, 0, 0)')break;parent=parent.parentElement;}
  return {fg:getComputedStyle(element).color,bg:background};
 });
 const luminance=(color:string)=>color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>{const v=value/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0);
 const fg=luminance(colors.fg),bg=luminance(colors.bg),ratio=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);assert.ok(ratio>=4.5,selector+' contrast '+ratio);
}
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce'});await context.addCookies([{name:'biohub_session',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/workspace');await expect(page.locator('.sidebar')).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.getByRole('link',{name:'平台首页',exact:false})).toBeVisible();
 // Verify client navigation preserves the shell and JS document, never reappears as a login gate.
 await page.evaluate(()=>{(window as any).navigationFixture='same-document';(window as any).gateAppeared=false;new MutationObserver(()=>{if(document.querySelector('.workspaceGate'))(window as any).gateAppeared=true;}).observe(document.body,{childList:true,subtree:true});});
 for(const [name,title] of [['积分中心','积分中心'],['个人账户','个人账户'],['平台管理','平台管理'],['我的任务','我的任务'],['工具大厅','工具大厅']]){await page.locator('.sidebar').getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{name:title,exact:title!=='工具大厅'})).toBeVisible();assert.equal(await page.evaluate(()=>(window as any).navigationFixture),'same-document');}
 assert.equal(await page.evaluate(()=>(window as any).gateAppeared),false);
 await page.goBack();await expect(page.getByRole('heading',{name:'我的任务',exact:true})).toBeVisible();await page.goForward();await expect(page.getByRole('heading',{name:'工具大厅',exact:false})).toBeVisible();
 console.log('PASS menu navigation preserves workspace shell, no opening gate flash, browser back/forward works');
 await contrast(page,'.sectionHeading p');await contrast(page,'.navCaption');await page.screenshot({path:'test-results/platform-light-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'切换深色模式',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await contrast(page,'.sectionHeading p');await contrast(page,'.navCaption');await page.screenshot({path:'test-results/platform-dark-desktop.png',fullPage:true});
 const second=await context.newPage();await second.goto(base);await expect(second.locator('html')).toHaveAttribute('data-theme','dark');await expect(second.getByRole('button',{name:'切换浅色模式',exact:true})).toBeVisible();await noOverflow(second);await contrast(second,'.landingHeroCopy>p');await second.screenshot({path:'test-results/platform-home-dark.png',fullPage:true});
 await second.getByRole('button',{name:'切换浅色模式',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await second.close();
 await page.getByRole('button',{name:'切换深色模式',exact:true}).click();await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.getByRole('button',{name:'切换浅色模式',exact:true})).toBeVisible();
 console.log('PASS readable copy contrast in both themes, saved preference across reload/homepage and synchronization across tabs');
 await page.locator('.sidebar').getByRole('button',{name:'平台管理',exact:true}).click();await page.getByRole('searchbox',{name:'邮箱或账号名称'}).fill(prefix);await expect(page.locator('.userTable tbody tr')).toHaveCount(1);await page.getByRole('button',{name:'管理工具权限',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Yinglan 科研生图权限')).toHaveValue('');await contrast(page,'.toolPermissionDialog .hint');await page.screenshot({path:'test-results/platform-permissions-dark.png',fullPage:true});await page.keyboard.press('Escape');
 await page.locator('.sidebar').getByRole('button',{name:'积分中心',exact:true}).click();await ledgerRows(page,20);const ledger=page.locator('.creditLedger');await expect(ledger).toContainText('共 205 条流水 · 第 1 / 11 页');await expect(ledger.locator('tbody tr').first()).toContainText('合成流水 204');
 for(const size of ['50','100','20']){await ledger.getByLabel('流水每页条数').selectOption(size);await ledgerRows(page,Number(size));}
 await ledger.getByRole('button',{name:'下一页',exact:true}).click();await ledgerRows(page,20);await expect(ledger).toContainText('第 2 / 11 页');await expect(ledger.locator('tbody tr').first()).toContainText('合成流水 184');await ledger.getByRole('button',{name:'上一页',exact:true}).click();await ledgerRows(page,20);
 await contrast(page,'.creditLedger th');await contrast(page,'.creditLedger .cellHint');await page.screenshot({path:'test-results/platform-credits-dark.png',fullPage:true});
 // Error recovery, page-boundary reduction and no stale data when a page request resolves late.
 await page.route('**/api/v1/wallet/ledger?**',route=>route.fulfill({status:503,json:{error:{message:'模拟流水读取错误'}}}));await ledger.getByRole('button',{name:'刷新流水'}).click();await expect(ledger.getByRole('alert')).toContainText('模拟流水读取错误');await page.unrouteAll();await ledger.getByRole('button',{name:'重试',exact:true}).click();await ledgerRows(page,20);
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});let seen!:()=>void;const started=new Promise<void>(resolve=>{seen=resolve;});
 await page.route('**/api/v1/wallet/ledger?**',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('page')==='2'){const response=await route.fetch();seen();await barrier;await route.fulfill({response});}else await route.continue();});
 await ledger.getByRole('button',{name:'下一页',exact:true}).click();await started;await expect(ledger.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();await ledger.getByLabel('流水每页条数').selectOption('100');await ledgerRows(page,100);release();await page.unrouteAll({behavior:'wait'});await expect(ledger).toContainText('第 1 / 3 页');await expect(ledger.locator('tbody tr').first()).toContainText('合成流水 204');
 await ledger.getByRole('button',{name:'下一页',exact:true}).click();await ledgerRows(page,100);await ledger.getByRole('button',{name:'下一页',exact:true}).click();await ledgerRows(page,5);db.prepare('DELETE FROM ledger WHERE user_id=? AND reference IN (?,?,?,?,?)').run(prefix,'fixture-0','fixture-1','fixture-2','fixture-3','fixture-4');await ledger.getByRole('button',{name:'刷新流水'}).click();await ledgerRows(page,100);await expect(ledger).toContainText('第 2 / 2 页');
 db.prepare('DELETE FROM ledger WHERE user_id=?').run(prefix);await ledger.getByRole('button',{name:'刷新流水'}).click();await ledgerRows(page,0);await expect(ledger.getByText('暂无积分流水',{exact:true})).toBeVisible();await expect(ledger).toContainText('第 1 / 1 页');
 console.log('PASS 205 ledger rows across pages, page sizes, error/retry, loading lock, stale requests, boundary adjustment and empty state');
 await page.getByRole('button',{name:'切换浅色模式',exact:true}).click();await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:'test-results/platform-credits-light-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'个人账户',exact:true}).click();await expect(page.getByRole('heading',{name:'个人账户',exact:true})).toBeVisible();await expect(page.locator('.sidebar')).not.toHaveClass(/open/);await noOverflow(page);
 const toggle=page.getByRole('button',{name:'切换深色模式',exact:true});await toggle.focus();await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await noOverflow(page);await page.screenshot({path:'test-results/platform-dark-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'打开导航'}).click();await page.getByRole('link',{name:'平台首页',exact:false}).click();await expect(page).toHaveURL(base+'/');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await noOverflow(page);
 const system=await browser.newContext({colorScheme:'dark'});const systemPage=await system.newPage();await systemPage.goto(base);await expect(systemPage.locator('html')).toHaveAttribute('data-theme','dark');await expect(systemPage.getByRole('button',{name:'切换浅色模式',exact:true})).toBeVisible();await systemPage.emulateMedia({colorScheme:'light'});await expect(systemPage.locator('html')).toHaveAttribute('data-theme','light');await system.close();
 const blocked=await browser.newContext();await blocked.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}});});const blockedPage=await blocked.newPage();await blockedPage.goto(base);await blockedPage.getByRole('button',{name:'切换深色模式',exact:true}).click();await expect(blockedPage.locator('html')).toHaveAttribute('data-theme','dark');await blocked.close();
 assert.deepEqual(errors,[]);console.log('PASS mobile navigation, keyboard theme switching, homepage link, system theme, unavailable browser storage and no browser exceptions');
}finally{await browser.close();db.transaction(()=>{for(const table of ['sessions','ledger','buckets'])db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(prefix);db.prepare('DELETE FROM users WHERE id=?').run(prefix);})();db.close();}
