import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import next from 'next';
import {config} from './src/config';
import {setupOidc} from './src/oidc';
import {setupApi,errorHandler} from './src/api';
import {setupMock} from './src/mock';
const app=express();app.disable('x-powered-by');if(process.env.NODE_ENV==='production')app.set('trust proxy',1);
app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');next();});
app.use((req,res,next)=>{
 if(!fs.existsSync(path.join(config.dataDir,'.maintenance'))){next();return;}
 const probeFile=path.join(config.dataDir,'.migration-probe');
 const probe=req.headers['x-biohub-migration-probe'];
 if(typeof probe==='string'&&fs.existsSync(probeFile)){
  const expected=fs.readFileSync(probeFile,'utf8').trim();
  if(probe.length===expected.length&&crypto.timingSafeEqual(Buffer.from(probe),Buffer.from(expected))){next();return;}
 }
 const worker=req.path==='/oidc/token'||/^\/api\/v1\/wallet\/(operations\/|reservations\/[^/]+\/(settle|release)$)/.test(req.path);
 if(req.method!=='GET'&&!worker){res.setHeader('Retry-After','120');res.status(503).json({error:{code:'MAINTENANCE',message:'系统升级中，请稍后重试',request_id:crypto.randomUUID()}});return;}
 if(req.path==='/'||req.path.startsWith('/workspace')||req.path.startsWith('/interaction/')){res.status(503).set({'Cache-Control':'no-store','Retry-After':'120'}).send(fs.readFileSync(path.resolve('public/upgrade.html'),'utf8'));return;}
 next();
});
setupMock(app);
await setupOidc(app);
setupApi(app);
app.use(errorHandler);
const host=process.env.NODE_ENV==='production'?'0.0.0.0':'192.168.6.111';
const web=next({dev:process.env.NODE_ENV!=='production',hostname:host,port:config.port});await web.prepare();
const handle=web.getRequestHandler();app.use((req,res)=>handle(req,res));
const server=app.listen(config.port,host,()=>console.log(`BioHub: ${config.appUrl}`));
function stop(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
