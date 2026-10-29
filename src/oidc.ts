import fs from 'node:fs';
import path from 'node:path';
import {generateKeyPair,exportJWK} from 'jose';
import Provider from 'oidc-provider';
import type {Express,Request} from 'express';
import {db,demand} from './db';
import {config,issuer} from './config';
import {session,userRow,publicUser} from './auth';

class Adapter {
 constructor(private model:string){}
 async upsert(id:string,payload:any,expiresIn:number){db.prepare('INSERT INTO oidc VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,grant_id=excluded.grant_id,user_code=excluded.user_code,uid=excluded.uid,account_id=excluded.account_id').run(this.model,id,JSON.stringify(payload),expiresIn?Date.now()+expiresIn*1000:null,payload.grantId||null,payload.userCode||null,payload.uid||null,payload.accountId||null);}
 async find(id:string){const row=db.prepare('SELECT * FROM oidc WHERE model=? AND id=?').get(this.model,id) as any;return this.decode(row);}
 decode(row:any){if(!row||(row.expires_at&&row.expires_at<=Date.now()))return undefined;const p=JSON.parse(row.payload);if(p.accountId){const user=userRow(p.accountId);if(!user?.active||!user.verified)return undefined;}return p;}
 async findByUid(uid:string){return this.decode(db.prepare('SELECT * FROM oidc WHERE model=? AND uid=?').get(this.model,uid));}
 async findByUserCode(code:string){return this.decode(db.prepare('SELECT * FROM oidc WHERE model=? AND user_code=?').get(this.model,code));}
 async destroy(id:string){db.prepare('DELETE FROM oidc WHERE model=? AND id=?').run(this.model,id);}
 async revokeByGrantId(id:string){db.prepare('DELETE FROM oidc WHERE grant_id=?').run(id);}
 async consume(id:string){const payload=await this.find(id);if(payload)db.prepare('UPDATE oidc SET payload=? WHERE model=? AND id=?').run(JSON.stringify({...payload,consumed:Math.floor(Date.now()/1000)}),this.model,id);}
}
export let provider:Provider;
export async function setupOidc(app:Express){
 const keyFile=path.join(config.dataDir,'oidc-jwks.json');
 if(!fs.existsSync(keyFile)){const {privateKey}=await generateKeyPair('RS256',{extractable:true});const key=await exportJWK(privateKey);fs.writeFileSync(keyFile,JSON.stringify({keys:[{...key,kid:'primary',use:'sig',alg:'RS256'}]}),{mode:0o600,flag:'wx'});}
 demand(config.userClientSecret&&config.workerSecret&&config.aggregatorSecret,'CONFIG_MISSING','请配置身份服务凭据');
 provider=new Provider(issuer,{
 adapter:Adapter,
 clients:[
 {client_id:'yinglan',client_secret:config.userClientSecret,redirect_uris:[config.yinglanUrl+'/api/platform/callback'],post_logout_redirect_uris:[config.appUrl+'/'],response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'client_secret_post'},
 {client_id:'yinglan-worker',client_secret:config.workerSecret,redirect_uris:[],response_types:[],grant_types:['client_credentials'],token_endpoint_auth_method:'client_secret_post'},
 {client_id:'platform-service',client_secret:config.aggregatorSecret,redirect_uris:[],response_types:[],grant_types:['client_credentials'],token_endpoint_auth_method:'client_secret_post'}
 ],
 jwks:JSON.parse(fs.readFileSync(keyFile,'utf8')),
 cookies:{keys:[config.cookieSecret],names:{session:'biohub_oidc',interaction:'biohub_interaction',resume:'biohub_resume'},long:{secure:config.appUrl.startsWith('https:')},short:{secure:config.appUrl.startsWith('https:')}},
 features:{devInteractions:{enabled:false},clientCredentials:{enabled:true},revocation:{enabled:true},introspection:{enabled:true},rpInitiatedLogout:{enabled:false}},
 claims:{openid:['sub'],email:['email','email_verified'],profile:['tool_roles']},scopes:['openid','email','profile','offline_access','wallet','wallet:finish','task:read'],
 ttl:{AccessToken:900,ClientCredentials:120,AuthorizationCode:60,RefreshToken:14*86400,Session:14*86400,Interaction:600,Grant:14*86400},
 pkce:{required:(_ctx,client)=>client.clientId==='yinglan'},
 interactions:{url:(_ctx,interaction)=>config.appUrl+'/interaction/'+interaction.uid},
 async findAccount(_ctx,id){const row=userRow(id);if(!row?.active||!row.verified)return undefined;return {accountId:id,async claims(){const u=publicUser(userRow(id));return {sub:u.id,email:u.email,email_verified:u.verified,tool_roles:u.tool_roles};}};},
 async extraTokenClaims(_ctx,token){return {tool_id:token.clientId==='yinglan'||token.clientId==='yinglan-worker'?'yinglan':undefined};},
 });
 if(process.env.NODE_ENV==='production')provider.proxy=true;
 app.get('/interaction/:uid',async(req,res,next)=>{try{
 const details=await provider.interactionDetails(req,res);const current=session(req);
 if(!current){res.redirect('/?login=1&return_to='+encodeURIComponent('/interaction/'+details.uid));return;}
 demand(details.params.client_id==='yinglan'&&!!current.user.tool_roles.yinglan,'TOOL_FORBIDDEN','你没有此工具的使用权限',403);
 if(details.prompt.name==='login'){await provider.interactionFinished(req,res,{login:{accountId:current.user.id,remember:true}},{mergeWithLastSubmission:false});return;}
 if(details.prompt.name==='consent'){
 const grant=details.grantId?await provider.Grant.find(details.grantId):new provider.Grant({accountId:current.user.id,clientId:'yinglan'});
 demand(grant,'GRANT_INVALID','登录授权已失效',401);
 const d=details.prompt.details as any;
 if(d.missingOIDCScope)grant.addOIDCScope(d.missingOIDCScope.join(' '));
 if(d.missingOIDCClaims)grant.addOIDCClaims(d.missingOIDCClaims);
 for(const [resource,scope]of Object.entries(d.missingResourceScopes||{}))grant.addResourceScope(resource,(scope as string[]).join(' '));
 const grantId=await grant.save();await provider.interactionFinished(req,res,{consent:{grantId}},{mergeWithLastSubmission:true});return;
 }
 throw new Error('Unsupported OIDC interaction');
 }catch(e){next(e);}});
 app.use('/oidc',provider.callback());
}
export async function bearer(req:Request,kind:'user'|'service'){
 const token=(req.headers.authorization||'').replace(/^Bearer /,'');demand(token,'UNAUTHORIZED','需要授权',401);
 if(kind==='user'){
 const access=await provider.AccessToken.find(token);demand(access&&access.accountId&&access.clientId==='yinglan'&&access.scope?.split(' ').includes('wallet'),'UNAUTHORIZED','用户授权已失效',401);
 const user=userRow(access.accountId);demand(user?.active&&user.verified,'UNAUTHORIZED','账号不可用',401);const u=publicUser(user);demand(u.tool_roles.yinglan,'TOOL_FORBIDDEN','工具权限已取消',403);return {user:u,toolId:'yinglan',scopes:access.scope!.split(' ')};
 }
 const access=await provider.ClientCredentials.find(token);demand(access,'UNAUTHORIZED','服务授权已失效',401);
 const scopes=access.scope?.split(' ')||[];return {toolId:access.clientId==='yinglan-worker'?'yinglan':access.clientId==='platform-service'?'platform':'',scopes,user:undefined};
}
export async function serviceToken(){const r=await fetch(issuer+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:'platform-service',client_secret:config.aggregatorSecret,scope:'task:read'}),signal:AbortSignal.timeout(5000)});demand(r.ok,'SERVICE_UNAVAILABLE','任务授权服务不可用',503);return (await r.json()).access_token as string;}
