/** Operator-only release metadata/permission tool; accesses only the platform's own database. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
const [command,output,email]=process.argv.slice(2);
const root=fs.realpathSync(process.env.BIOHUB_RELEASE_ROOT||'/opt/sci_image/platform-prod');
if(!['plan','grant','rollback-grants','fingerprint','verify-fingerprint'].includes(command)||!output||!email)throw new Error('Usage: sanger-release.ts plan|grant|rollback-grants OUTPUT EMAIL');
if(!root.endsWith('/platform-prod')||fs.realpathSync(path.join(root,'data'))!==path.join(root,'data'))throw new Error('Unexpected platform data directory');
const db=new Database(path.join(root,'data/platform.sqlite'),{readonly:['plan','fingerprint','verify-fingerprint'].includes(command),fileMustExist:true});
try{
 const user=db.prepare('SELECT id,email,active,verified,role,tool_roles FROM users WHERE email=? COLLATE NOCASE').get(email) as any;
 if(!user?.active||!user.verified)throw new Error('Explicit target account must exist, be active and verified');
 if(command==='fingerprint'||command==='verify-fingerprint'){
  const tables=['users','buckets','ledger','reservations','quotes','codes','batches','settings'];
  const summary=Object.fromEntries(tables.map(table=>{const rows=(db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all() as any[]).map(row=>{if(table==='users'){const {tool_roles:_roles,...rest}=row;return rest;}return row;});return [table,{count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}];}));
  if(command==='fingerprint')fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});
  else if(JSON.stringify(summary)!==JSON.stringify(JSON.parse(fs.readFileSync(output,'utf8'))))throw new Error('Original account/wallet data fingerprint changed');
  console.log('Original identity and wallet records '+(command==='fingerprint'?'fingerprinted':'preserved')+' without disclosing account data.');
 }else if(command==='plan'){
  const report={target:{id:user.id,email:user.email,tool_roles:JSON.parse(user.tool_roles)},eligible_accounts:(db.prepare('SELECT COUNT(*) n FROM users WHERE active=1 AND verified=1').get() as any).n};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});console.log('Platform identity plan saved; no account changes.');
 }else if(command==='grant'){
  const journal={created_at:new Date().toISOString(),changes:[] as any[]};
  db.transaction(()=>{
   const rows=db.prepare('SELECT id,tool_roles FROM users WHERE active=1 AND verified=1').all() as any[];
   for(const row of rows){const roles=JSON.parse(row.tool_roles);if(roles.sanger)continue;const after={...roles,sanger:'user'};journal.changes.push({id:row.id,before:roles,after});}
   // Persist rollback inputs before applying; contains roles and IDs, never hashes/passwords.
   fs.writeFileSync(output,JSON.stringify(journal,null,2)+'\n',{mode:0o600,flag:'wx'});
   for(const change of journal.changes){db.prepare('UPDATE users SET tool_roles=? WHERE id=?').run(JSON.stringify(change.after),change.id);db.prepare('INSERT INTO audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)').run(user.id,'grant_sanger_release',change.id,JSON.stringify({tool_id:'sanger',role:change.after.sanger}),new Date().toISOString());}
  })();console.log('Granted explicit sanger roles to '+journal.changes.length+' existing accounts.');
 }else{
  const journal=JSON.parse(fs.readFileSync(output,'utf8'));
  db.transaction(()=>{for(const change of journal.changes){const current=db.prepare('SELECT tool_roles FROM users WHERE id=?').get(change.id) as any;if(!current)continue;const roles=JSON.parse(current.tool_roles);if(roles.sanger!==change.after.sanger)throw new Error('Permission was changed after release; manual reconciliation required');if(change.before.sanger)roles.sanger=change.before.sanger;else delete roles.sanger;db.prepare('UPDATE users SET tool_roles=? WHERE id=?').run(JSON.stringify(roles),change.id);}})();console.log('Restored only release-granted sanger permissions.');
 }
}finally{db.close();}
