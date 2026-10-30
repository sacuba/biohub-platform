// Reviewed application-to-tool bindings. Never take these lists from a remote client.
import {config} from './config';
import {molecularTools} from './catalog';
import {demand} from './db';
import type {HostingApplication} from './generated/platform';
export function applications():HostingApplication[]{return [
 {id:'yinglan',oidc_client_id:'yinglan',worker_client_id:'yinglan-worker',tool_ids:['yinglan']},
 ...(config.sangerEnabled?[{id:'sanger',oidc_client_id:'sanger',worker_client_id:'sanger-worker',tool_ids:['sanger']}]:[]),
 ...(config.molecularEnabled?[{id:'molecular-tools',oidc_client_id:'molecular-tools',worker_client_id:'molecular-tools-worker',tool_ids:molecularTools().map(t=>t.id)}]:[])
];}
export function applicationForClient(client:string,kind:'user'|'service'){
 return applications().find(a=>(kind==='user'?a.oidc_client_id:a.worker_client_id)===client);
}
export function selectTool(access:{toolIds:string[];user?:{tool_roles:Record<string,string>}},requested:unknown){
 demand(requested===undefined||typeof requested==='string','INVALID_INPUT','tool_id 必须为字符串');
 demand(requested!==undefined||access.toolIds.length===1,'TOOL_REQUIRED','多工具应用必须指定逻辑 tool_id');
 const id=typeof requested==='string'?requested:access.toolIds[0];
 demand(access.toolIds.includes(id),'TOOL_FORBIDDEN','此承载应用不允许提供该工具',403);
 if(access.user)demand(!!access.user.tool_roles[id],'TOOL_FORBIDDEN','没有该具体工具的使用权限',403);
 return id;
}
