import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {config} from '../src/config';
import {db} from '../src/db';
import {createUser} from '../src/auth';
import {grant} from '../src/wallet';
const file=path.join(config.dataDir,'test-accounts.json');
if(!fs.existsSync(file)){
 const accounts=[{email:'admin@biohub.test',password:crypto.randomBytes(15).toString('base64url'),role:'admin' as const,tool_roles:{yinglan:'admin'}},{email:'researcher@biohub.test',password:crypto.randomBytes(15).toString('base64url'),role:'user' as const,tool_roles:{yinglan:'user'}}];
 for(const account of accounts){const prior=db.prepare('SELECT id FROM users WHERE email=?').get(account.email);if(prior)throw new Error('Seed collision: account exists without credentials file');const u=await createUser(account,true);db.transaction(()=>grant(u.id,100,'DEV_SEED','initial-development',null,'开发联调积分'))();}
 fs.writeFileSync(file,JSON.stringify(accounts,null,2)+'\n',{mode:0o600,flag:'wx'});console.log('Development accounts initialized; credentials are in the protected runtime file.');
}else console.log('Development seed already initialized.');
db.close();
