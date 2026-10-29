import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
export function migrateYinglan(db:Database.Database,source:any,encrypt:(v:string)=>string){
 if(source.version!==1||!Array.isArray(source.users)||!source.users.length)throw new Error('Invalid Yinglan migration export');
 const digest=crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
 db.exec('CREATE TABLE IF NOT EXISTS migration_records(source TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,kind,id))');
 const prior=db.prepare("SELECT value FROM settings WHERE key='yinglan_migration'").get() as any;
 if(prior){if(JSON.parse(prior.value).sha256!==digest)throw new Error('Different source already imported');return JSON.parse(prior.value);}
 if((db.prepare('SELECT COUNT(*) n FROM users').get() as any).n)throw new Error('Migration requires an empty platform database');
 if(source.subscriptions?.some((s:any)=>s.status==='active'))throw new Error('Active subscriptions require explicit migration support');
 const at=Date.parse(source.exported_at);if(!Number.isFinite(at))throw new Error('Invalid source time');
 const identities=new Set<string>(),emails=new Set<string>();const expected=new Map<string,number>();
 const archive=(kind:string,id:string,value:any)=>db.prepare('INSERT INTO migration_records VALUES(?,?,?,?)').run('yinglan',kind,id,JSON.stringify(value));
 const setting=(key:string,value:any)=>db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));
 return db.transaction(()=>{
  for(const u of source.users){
   const email=u.email.trim().toLowerCase();if(identities.has(u.id)||emails.has(email)||!/^\$2[aby]\$/.test(u.passwordHash))throw new Error('Invalid or duplicate source account');identities.add(u.id);emails.add(email);
   db.prepare('INSERT INTO users(id,email,password_hash,role,verified,active,tool_roles,created_at) VALUES(?,?,?,?,?,1,?,?)').run(u.id,email,u.passwordHash,u.role,u.verified?1:0,JSON.stringify({yinglan:u.role}),u.createdAt);expected.set(u.id,0);
  }
  for(const l of source.ledger){
   if(!identities.has(l.ownerId)||!Number.isSafeInteger(l.amount)||!Number.isSafeInteger(l.remaining)||l.remaining<0)throw new Error('Invalid ledger owner or amount');
   const reference=l.kind==='REGISTER_GIFT'?'registration':l.reference||'legacy:'+l.id;
   db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(l.id,l.ownerId,l.kind,l.amount,reference,l.reason||'',l.createdAt);
   if(l.amount>=0){db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?,?,?)').run('legacy_'+l.id,l.ownerId,l.kind,l.amount,l.remaining,l.expiresAt||null,reference,l.createdAt);if(!l.expiresAt||Date.parse(l.expiresAt)>at)expected.set(l.ownerId,expected.get(l.ownerId)!+l.remaining);}
   else if(l.remaining)throw new Error('Negative ledger with spendable credits');
   archive('ledger',l.id,l);
  }
  const batches=new Set<string>();
  for(const c of source.codes){
   if(!batches.has(c.batchId)){db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run(c.batchId,c.batchName||'历史批次 '+c.batchId,c.credits,c.createdAt);batches.add(c.batchId);}
   if(c.redeemedBy&&!identities.has(c.redeemedBy))throw new Error('Unknown redemption user');
   db.prepare('INSERT INTO codes VALUES(?,?,?,?,?,?,?)').run(c.id,c.code,c.batchId,c.credits,c.status,c.redeemedBy||null,c.createdAt);archive('code',c.id,c);
  }
  const r=source.rules;setting('rules',{registration:r.registration,daily:r.daily,gift_hours:r.giftHours,image_cost:5,version:r.version});
  setting('tiers',source.tiers.map((t:any)=>({id:t.id,name:t.name,credits:t.credits,enabled:t.enabled,activity_price_cents:t.activityPriceCents??0})));
  if(source.mail)setting('mail',{...source.mail,password:source.mail.password?encrypt(source.mail.password):''});
  for(const [id,balance]of expected){const actual=(db.prepare('SELECT COALESCE(SUM(remaining),0) n FROM buckets WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)').get(id,source.exported_at) as any).n;if(actual!==balance)throw new Error('Balance reconciliation mismatch');}
  const result={sha256:digest,imported_at:new Date().toISOString(),source_time:source.exported_at,users:source.users.length,ledger:source.ledger.length,codes:source.codes.length,batches:batches.size,available_total:[...expected.values()].reduce((a,b)=>a+b,0),counts:source.counts};
  setting('yinglan_migration',result);return result;
 })();
}
