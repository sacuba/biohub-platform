import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function resolveSafe(input){const absolute=path.resolve(input);const resolved=fs.existsSync(absolute)?fs.realpathSync(absolute):path.join(resolveSafe(path.dirname(absolute)),path.basename(absolute));if(resolved.split(path.sep).some(x=>x.endsWith('-prod')))throw new Error('Development paths must not resolve to production');return resolved;}
export const runtime=resolveSafe(path.join(workspace,'dev-runtime'));fs.mkdirSync(runtime,{recursive:true,mode:0o700});
export function environment(app){if(!['platform','yinglan'].includes(app))throw new Error('Unknown development application');resolveSafe(path.join(workspace,app,'.next-integration'));const file=resolveSafe(path.join(runtime,'integration-secrets.json'));if(!fs.existsSync(file)){const value=Object.fromEntries(['user','worker','aggregator','mock','platformSession','yinglanSession'].map(k=>[k,crypto.randomBytes(32).toString('hex')]));fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}const s=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const k of ['sangerUser','sangerWorker','molecularUser','molecularWorker'])if(!s[k]){s[k]=crypto.randomBytes(32).toString('hex');fs.writeFileSync(file,JSON.stringify(s,null,2)+'\n',{mode:0o600});}
 const env={...process.env,NODE_ENV:'development',AUTH_MODE:app==='yinglan'?'platform':'standalone',DATA_DIR:resolveSafe(path.join(runtime,app)),DATABASE_URL:'',REDIS_URL:'',SQLITE_FILE:resolveSafe(path.join(runtime,app,app+'.sqlite')),SESSION_SECRET:app==='yinglan'?s.yinglanSession:s.platformSession,ENCRYPTION_KEY:'',APP_URL:'http://192.168.6.111:'+(app==='platform'?'3200':'3201'),PORT:app==='platform'?'3200':'3201',PLATFORM_URL:'http://192.168.6.111:3200',OIDC_ISSUER:'http://192.168.6.111:3200/oidc',YINGLAN_URL:'http://192.168.6.111:3201',YINGLAN_CLIENT_SECRET:s.user,YINGLAN_WORKER_SECRET:s.worker,MOLECULAR_ENABLED:'true',MOLECULAR_CLIENT_SECRET:s.molecularUser,MOLECULAR_WORKER_SECRET:s.molecularWorker,SANGER_URL:'http://192.168.6.111:3202',SANGER_ANALYSIS_CREDITS:'0',SANGER_PRICE_VERSION:'1',SANGER_CLIENT_SECRET:s.sangerUser,SANGER_WORKER_SECRET:s.sangerWorker,PLATFORM_SERVICE_SECRET:s.aggregator,MOCK_API_SECRET:s.mock,DEV_MOCK_IMAGES:'true',MAIL_TRANSPORT:'capture',MAIL_CAPTURE_FILE:'',NEXT_OUTPUT_DIR:'.next-integration',REGISTRATION_ENABLED:'false',NEXT_TELEMETRY_DISABLED:'1'};
 const preferencesFile=resolveSafe(path.join(runtime,'preferences.json'));
 const preferences=fs.existsSync(preferencesFile)?JSON.parse(fs.readFileSync(preferencesFile,'utf8')):{};
 env.MAIL_TRANSPORT=process.env.BIOHUB_MAIL_TRANSPORT||preferences.mail_transport||'capture';
 if(!['capture','smtp'].includes(env.MAIL_TRANSPORT))throw new Error('Invalid mail transport');
 fs.mkdirSync(env.DATA_DIR,{recursive:true,mode:0o700});fs.chmodSync(env.DATA_DIR,0o700);
 for(const k of ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','REAL_API_KEY','REAL_API_URL','ADMIN_PASSWORD'])env[k]='';return env;
}
