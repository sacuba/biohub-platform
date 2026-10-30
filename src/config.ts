import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function resolvedPath(input:string):string {
 const target=path.resolve(input);
 if(fs.existsSync(target))return fs.realpathSync(target);
 const parent=path.dirname(target);
 return path.join(parent===target?parent:resolvedPath(parent),path.basename(target));
}
export function safeDataDir(input:string){
 const target=resolvedPath(input);
 if(process.env.NODE_ENV!=='production'&&target.split(path.sep).some(part=>part.endsWith('-prod')||part==='yinglan-prod'))throw new Error('禁止在开发平台中使用生产目录');
 return target;
}
export const dataDir=safeDataDir(process.env.DATA_DIR||path.resolve('..','dev-runtime','platform'));
fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
const secretsFile=path.join(dataDir,'secrets.json');
if(!fs.existsSync(secretsFile))fs.writeFileSync(secretsFile,JSON.stringify({cookie:crypto.randomBytes(32).toString('hex'),encryption:crypto.randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
const secrets=JSON.parse(fs.readFileSync(secretsFile,'utf8'));
export const config={
 dataDir, appUrl:(process.env.APP_URL||'http://192.168.6.111:3200').replace(/\/$/,''),
 yinglanUrl:(process.env.YINGLAN_URL||'http://192.168.6.111:3201').replace(/\/$/,''),
 sangerEnabled:process.env.SANGER_ENABLED==='true'||(process.env.NODE_ENV!=='production'&&process.env.SANGER_ENABLED!=='false'),
 sangerUrl:(process.env.SANGER_URL||'http://192.168.6.111:3202').replace(/\/$/,''),
 sangerClientSecret:process.env.SANGER_CLIENT_SECRET||'',sangerWorkerSecret:process.env.SANGER_WORKER_SECRET||'',
 molecularEnabled:process.env.NODE_ENV!=='production'&&process.env.MOLECULAR_ENABLED==='true',
 molecularUrl:'http://192.168.6.111:3203',
 molecularClientSecret:process.env.MOLECULAR_CLIENT_SECRET||'',molecularWorkerSecret:process.env.MOLECULAR_WORKER_SECRET||'',
 brand:process.env.PLATFORM_BRAND||'BioHub', port:Number(process.env.PORT||3200),
 cookieSecret:process.env.SESSION_SECRET||secrets.cookie,encryptionKey:process.env.ENCRYPTION_KEY||secrets.encryption,
 userClientSecret:process.env.YINGLAN_CLIENT_SECRET||'',workerSecret:process.env.YINGLAN_WORKER_SECRET||'',
 aggregatorSecret:process.env.PLATFORM_SERVICE_SECRET||'',mockSecret:process.env.MOCK_API_SECRET||'',
 capture:process.env.MAIL_TRANSPORT!=='smtp'&&process.env.NODE_ENV!=='production',
};
if(process.env.NODE_ENV==='production'){
 if(!config.appUrl.startsWith('https://')||!config.yinglanUrl.startsWith('https://'))throw new Error('Production requires HTTPS');
 if(!process.env.DATA_DIR||!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32||!process.env.ENCRYPTION_KEY||!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY))throw new Error('Production data directory and independent secrets required');
 for(const secret of [config.userClientSecret,config.workerSecret,config.aggregatorSecret])if(secret.length<32)throw new Error('Production service secrets required');
 if(config.sangerEnabled){
  const sanger=new URL(config.sangerUrl);if(sanger.protocol!=='https:'||sanger.username||sanger.password||sanger.pathname!=='/'||sanger.search||sanger.hash||!process.env.SANGER_URL)throw new Error('Sanger production requires an exact HTTPS origin');
  if(config.sangerClientSecret.length<32||config.sangerWorkerSecret.length<32||config.sangerClientSecret===config.sangerWorkerSecret)throw new Error('Sanger production requires independent user/worker secrets');
 }
 if(process.env.DEV_MOCK_IMAGES==='true')throw new Error('Production must not use mock images');
}
export const issuer=config.appUrl+'/oidc';
export const uid=(prefix:string)=>prefix+'_'+crypto.randomUUID();
export const hash=(v:string)=>crypto.createHash('sha256').update(v).digest('hex');
export const now=()=>new Date().toISOString();
export function encrypt(v:string){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',Buffer.from(config.encryptionKey,'hex'),iv);const body=Buffer.concat([c.update(v),c.final()]);return [iv,c.getAuthTag(),body].map(v=>v.toString('base64url')).join('.');}
export function decrypt(v:string){const [iv,tag,body]=v.split('.').map(v=>Buffer.from(v,'base64url'));const d=crypto.createDecipheriv('aes-256-gcm',Buffer.from(config.encryptionKey,'hex'),iv);d.setAuthTag(tag);return Buffer.concat([d.update(body),d.final()]).toString();}
