import express from 'express';
import next from 'next';
import {config} from './src/config';
import {setupOidc} from './src/oidc';
import {setupApi,errorHandler} from './src/api';
import {setupMock} from './src/mock';
const app=express();app.disable('x-powered-by');
app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');next();});
setupMock(app);
await setupOidc(app);
setupApi(app);
app.use(errorHandler);
const host=process.env.NODE_ENV==='production'?'0.0.0.0':'192.168.6.111';
const web=next({dev:process.env.NODE_ENV!=='production',hostname:host,port:config.port});await web.prepare();
const handle=web.getRequestHandler();app.use((req,res)=>handle(req,res));
const server=app.listen(config.port,host,()=>console.log(`BioHub development: ${config.appUrl}`));
function stop(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
