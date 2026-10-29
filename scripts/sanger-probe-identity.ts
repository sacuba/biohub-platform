/** Creates/removes only fresh release probe identities; no real user's password is read or used. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
const [command,file]=process.argv.slice(2);
if(!['create','cleanup'].includes(command)||!file)throw new Error('Usage: sanger-probe-identity.ts create|cleanup PROTECTED_FILE');
const root=fs.realpathSync(process.env.BIOHUB_RELEASE_ROOT||'/opt/sci_image/platform-prod');
if(!root.endsWith('/platform-prod'))throw new Error('Unexpected platform data root');
const db=new Database(path.join(root,'data/platform.sqlite'),{fileMustExist:true});
try{
 if(command==='create'){
  if(fs.existsSync(file))throw new Error('Probe state already exists');
  const accounts=[0,1].map(i=>{const id='sanger_release_probe_'+crypto.randomUUID();return {id,email:id+'@biohub.invalid',password:crypto.randomBytes(24).toString('base64url'),role:i===0?'user':'admin',tool_roles:{sanger:'user',yinglan:'user'}};});
  fs.writeFileSync(file,JSON.stringify(accounts,null,2)+'\n',{mode:0o600,flag:'wx'});
  const hashes=await Promise.all(accounts.map(a=>bcrypt.hash(a.password,12)));
  const at=new Date().toISOString(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  db.transaction(()=>{for(const [i,a] of accounts.entries()){
   db.prepare('INSERT INTO users(id,email,password_hash,role,verified,active,tool_roles,created_at) VALUES(?,?,?,?,1,1,?,?)').run(a.id,a.email,hashes[i],a.role,JSON.stringify(a.tool_roles),at);
   db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?,?)').run('probe_'+crypto.randomUUID(),a.id,'DAILY_GIFT',0,0,null,'daily:'+day,at);
  }})();console.log('Two temporary release identities created; credentials saved only in protected file.');
 }else{
  const accounts=JSON.parse(fs.readFileSync(file,'utf8'));
  db.transaction(()=>{for(const a of accounts){
   if(!String(a.id).startsWith('sanger_release_probe_')||a.email!==a.id+'@biohub.invalid')throw new Error('Refusing cleanup of non-probe identity');
   for(const table of ['sessions','account_tokens','reservations','quotes','buckets','ledger'])db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(a.id);
   db.prepare('DELETE FROM oidc WHERE account_id=?').run(a.id);
   db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').run('%'+a.email+'%');
   db.prepare('DELETE FROM idempotency WHERE scope LIKE ? OR result LIKE ?').run('%'+a.id+'%','%'+a.id+'%');
   db.prepare('DELETE FROM users WHERE id=? AND email=?').run(a.id,a.email);
  }})();console.log('Temporary platform identities and their zero-value wallet records removed.');
 }
}finally{db.close();}
