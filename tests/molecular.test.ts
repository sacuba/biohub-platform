import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
process.env.DATA_DIR=path.resolve('../dev-runtime/platform-molecular-tests',crypto.randomUUID());
process.env.MAIL_TRANSPORT='capture';process.env.MOLECULAR_ENABLED='true';
const {db}=await import('../src/db');
const {applications,applicationForClient,selectTool}=await import('../src/applications');
const {tools,permissionTools,molecularTools}=await import('../src/catalog');
const wallet=await import('../src/wallet');
db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('molecular-test','molecular@example.test','!','user',1,1,'{}',new Date().toISOString());
after(()=>{db.close();fs.rmSync(process.env.DATA_DIR!,{recursive:true,force:true});});
test('reviewed application has exactly19 logical tools, each only user role',()=>{
 const app=applicationForClient('molecular-tools','user')!;assert.equal(app.tool_ids.length,19);assert.equal(applicationForClient('arbitrary','user'),undefined);
 assert.equal(applicationForClient('molecular-tools-worker','service')!.id,app.id);
 assert.equal(molecularTools().length,19);assert.equal(tools().filter(t=>t.application_id==='molecular-tools').length,19);
 assert.ok(permissionTools().filter(t=>t.application_id==='molecular-tools').every(t=>t.roles.length===1&&t.roles[0]==='user'));
 assert.equal(applications().filter(a=>a.id==='molecular-tools').length,1);
});
test('tool selector is constrained by both registered application and current specific user rights',()=>{
 const ids=applicationForClient('molecular-tools','user')!.tool_ids;
 const access={toolIds:ids,user:{tool_roles:{'mol-gc-content':'user'}}};
 assert.equal(selectTool(access,'mol-gc-content'),'mol-gc-content');
 for(const id of [undefined,'mol-translation','yinglan','sanger','fake'])assert.throws(()=>selectTool(access,id));
 assert.equal(selectTool({toolIds:['yinglan']},undefined),'yinglan');
 assert.throws(()=>selectTool({toolIds:ids},'yinglan'));
});
test('free compute quotes/reservations stay attached to the logical tool; cross-tool finish is denied',()=>{
 const quote=wallet.quote('molecular-test','mol-degenerate-design',{task_id:'same',parameters_hash:'x',capability:'compute'},'quote');
 assert.equal(quote.amount,0);assert.equal(quote.tool_id,'mol-degenerate-design');
 const hold=wallet.reserve('molecular-test','mol-degenerate-design',{quote_id:quote.id,task_id:'same',parameters_hash:'x'},'reserve');
 assert.equal(hold.amount,0);assert.throws(()=>wallet.finish('mol-synonymous-sites',hold.id,'settle','cross'));
 assert.equal(wallet.finish('mol-degenerate-design',hold.id,'settle','finish').state,'settled');
 assert.throws(()=>wallet.quote('molecular-test','yinglan',{task_id:'x',parameters_hash:'x',capability:'compute'},'bad'));
 assert.throws(()=>wallet.quote('molecular-test','mol-gc-content',{task_id:'x',parameters_hash:'x',capability:'generation'},'bad'));
});
