'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Plus,X} from 'lucide-react';
import type {AdminUser,AdminUsersPage,ToolPermissionDefinition,User} from '../../src/generated/platform';

type Api=(route:string,body?:unknown,key?:string)=>Promise<any>;
const roleName=(role:string)=>role==='admin'?'工具管理员':role==='user'?'工具用户':'无权限';

export default function AdminUsers({api,revision,onCreate,onAdjust,refresh,notify}:{api:Api;revision:number;onCreate:()=>void;onAdjust:(user:AdminUser)=>void;refresh:()=>Promise<void>;notify:(text:string)=>void}){
 const [query,setQuery]=useState({page:1,page_size:20,keyword:'',status:'all',role:'all'});
 const [result,setResult]=useState<AdminUsersPage|null>(null),[tools,setTools]=useState<ToolPermissionDefinition[]>([]);
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0),[writing,setWriting]=useState(false),[selected,setSelected]=useState<AdminUser|null>(null);
 const writeLock=useRef(false),request=useRef(0);
 // Invalidate immediately in event handlers, including the gap before the next effect runs.
 function change(patch:Partial<typeof query>){request.current++;setLoading(true);setResult(null);setQuery(q=>({...q,...patch}));}
 const reloadUsers=useCallback(()=>{request.current++;setReload(n=>n+1);},[]);
 useEffect(()=>{
  const ticket=++request.current;let active=true;setLoading(true);setError('');setResult(null);
  const params=new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)]));
  void Promise.all([api('admin/users?'+params),api('admin/tool-permissions')]).then(([page,registry])=>{
   if(!active||ticket!==request.current)return;
   if(page.page!==query.page){setQuery(q=>({...q,page:page.page}));return;}
   setResult(page);setTools(registry.tools);setLoading(false);
  }).catch(e=>{if(active&&ticket===request.current){setError(e.message);setLoading(false);}});
  return()=>{active=false;};
 },[api,query,revision,reload]);
 async function update(user:AdminUser,body:unknown,message:string){
  if(writeLock.current)return;writeLock.current=true;setWriting(true);setError('');
  try{await api('admin/users/'+encodeURIComponent(user.id),body);notify(message);reloadUsers();await refresh();}
  catch(e){setError((e as Error).message);}finally{writeLock.current=false;setWriting(false);}
 }
 const disabled=loading||writing;
 return <section className="panel adminUsers"><div className="panelHeading"><div><h2>用户与工具权限</h2><p className="hint">平台角色与工具权限独立配置。</p></div><button className="primary" disabled={writing} onClick={onCreate}><Plus size={16}/>创建用户</button></div>
  <div className="userFilters"><label>邮箱或账号名称<input type="search" placeholder="搜索邮箱或 @ 前的名称" maxLength={100} value={query.keyword} onChange={e=>change({keyword:e.target.value,page:1})}/></label><label>账号状态<select aria-label="账号状态" value={query.status} onChange={e=>change({status:e.target.value,page:1})}><option value="all">全部状态</option><option value="active">正常</option><option value="inactive">停用</option><option value="unverified">待验证</option></select></label><label>平台角色筛选<select aria-label="平台角色筛选" value={query.role} onChange={e=>change({role:e.target.value,page:1})}><option value="all">全部角色</option><option value="user">普通用户</option><option value="admin">平台管理员</option></select></label><button className="secondary" disabled={disabled} onClick={reloadUsers}>刷新列表</button></div>
  {error&&<div className="error" role="alert">{error} <button className="textButton" disabled={disabled} onClick={reloadUsers}>重试</button></div>}
  <div className="tableWrap" aria-busy={loading}><table className="userTable"><thead><tr><th>邮箱</th><th>积分余额</th><th>平台角色</th><th>工具权限</th><th>状态</th><th>操作</th></tr></thead><tbody>{!loading&&result?.users.map(user=><tr key={user.id}><td className="userEmail">{user.email}<small className="cellHint">{user.verified?'已验证':'待验证'}</small></td><td><strong>{user.available_credits} 积分</strong><small className="cellHint">冻结 {user.frozen_credits} 积分</small></td><td><select aria-label={user.email+'平台角色'} value={user.role} disabled={writing} onChange={e=>void update(user,{role:e.target.value},'平台角色已更新')}><option value="user">普通用户</option><option value="admin">管理员</option></select></td><td><span className="permissionSummary">{Object.keys(user.tool_roles).length?'已授权 '+Object.keys(user.tool_roles).length+' 个工具':'无工具权限'}</span><small className="cellHint">{tools.filter(tool=>user.tool_roles[tool.id]).map(tool=>tool.name+' · '+roleName(user.tool_roles[tool.id])).join('；')}</small></td><td><span className={'status '+(user.active?'available':'coming_soon')}>{user.active?'正常':'停用'}</span></td><td><div className="rowActions userActions"><button disabled={writing} onClick={()=>setSelected(user)}>管理工具权限</button><button disabled={writing} onClick={()=>onAdjust(user)}>调整积分</button><button disabled={writing} onClick={()=>void update(user,{active:!user.active},user.active?'账号已停用':'账号已启用')}>{user.active?'停用':'启用'}</button></div></td></tr>)}</tbody></table>
   {loading&&<div className="empty" role="status">正在加载用户…</div>}{!loading&&!error&&!result?.users.length&&<div className="empty" role="status">暂无匹配用户，请调整搜索或筛选条件。</div>}
  </div>
  <nav className="userPagination" aria-label="用户列表分页"><span role="status">{result?`共 ${result.total} 位用户 · 第 ${result.page} / ${result.total_pages} 页`:'用户总数与页码加载后显示'}</span><label>每页条数<select aria-label="每页条数" value={query.page_size} onChange={e=>change({page_size:Number(e.target.value),page:1})}>{[20,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={disabled||!result||query.page<=1} onClick={()=>change({page:query.page-1})}>上一页</button><button className="secondary" disabled={disabled||!result||query.page>=(result.total_pages??1)} onClick={()=>change({page:query.page+1})}>下一页</button></div></nav>
  {selected&&<ToolPermissions user={selected} api={api} close={()=>setSelected(null)} saved={roles=>{setResult(current=>current?{...current,users:current.users.map(user=>user.id===selected.id?{...user,tool_roles:roles}:user)}:current);notify('工具权限已保存');void refresh().catch(e=>notify(e.message));}}/>}
 </section>;
}

function ToolPermissions({user,api,close,saved}:{user:AdminUser;api:Api;close:()=>void;saved:(roles:Record<string,string>)=>void}){
 const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false);
 const [tools,setTools]=useState<ToolPermissionDefinition[]>([]),[roles,setRoles]=useState<Record<string,string>>({}),[original,setOriginal]=useState<Record<string,string>>({});
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const dirty=Object.keys({...original,...roles}).some(id=>roles[id]!==original[id]);
 const requestClose=()=>{if(lock.current)return;if(!dirty||window.confirm('工具权限尚未保存，确定放弃修改吗？'))close();};
 useEffect(()=>{
  const element=dialog.current!;const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;
  element.showModal();document.body.style.overflow='hidden';
  return()=>{element.close();document.body.style.overflow=overflow;previous?.focus();};
 },[]);
 useEffect(()=>{
  let active=true;setLoading(true);setReady(false);setError('');
  void Promise.all([api('admin/users/'+encodeURIComponent(user.id)),api('admin/tool-permissions')]).then(([current,registry]:[User,{tools:ToolPermissionDefinition[]}])=>{
   if(active){setTools(registry.tools);setRoles(current.tool_roles);setOriginal(current.tool_roles);setReady(true);}
  }).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
 },[api,user.id,retry]);
 useEffect(()=>{if(!dirty)return;const before=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[dirty]);
 async function save(event:React.FormEvent){event.preventDefault();if(lock.current||!ready||!dirty)return;lock.current=true;setBusy(true);setError('');
  try{await api('admin/users/'+encodeURIComponent(user.id),{tool_roles:roles});saved(roles);close();}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 return <dialog ref={dialog} className="modal toolPermissionDialog" aria-labelledby="permission-title" aria-describedby="permission-user" onCancel={event=>{event.preventDefault();requestClose();}} onKeyDown={event=>{
   if(event.key!=='Tab')return;
   const elements=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)'));
   const first=elements[0],last=elements.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}><button className="modalClose iconButton" aria-label="关闭工具权限弹窗" disabled={busy} onClick={requestClose}><X size={20}/></button><h2 id="permission-title">管理工具权限</h2><p id="permission-user" className="permissionUser">当前操作用户：<strong>{user.email}</strong></p><p className="hint">各工具独立授权；保存工具权限不会变更平台管理员角色。</p>
  {loading&&<p role="status">正在读取当前权限…</p>}{error&&<div className="error" role="alert">{error}{!ready&&<button className="textButton" onClick={()=>setRetry(n=>n+1)}>重新读取</button>}</div>}
  <form onSubmit={event=>void save(event)}>{ready&&!loading&&<><div className="filters">{[...new Set(tools.map(t=>t.category||'其他工具'))].map(category=><span key={category}><button type="button" disabled={busy} onClick={()=>setRoles(current=>({...current,...Object.fromEntries(tools.filter(t=>(t.category||'其他工具')===category).map(t=>[t.id,'user']))}))}>授权{category}</button><button type="button" disabled={busy} onClick={()=>setRoles(current=>Object.fromEntries(Object.entries(current).filter(([id])=>!tools.some(t=>t.id===id&&(t.category||'其他工具')===category))))}>清除{category}</button></span>)}</div>{tools.length?<div className="toolPermissionList">{tools.map(tool=><label key={tool.id}><span>{tool.name}</span><select aria-label={tool.name+'权限'} value={roles[tool.id]||''} disabled={busy} onChange={event=>{const next={...roles};if(event.target.value)next[tool.id]=event.target.value;else delete next[tool.id];setRoles(next);}}><option value="">无权限</option>{tool.roles.map(role=><option key={role} value={role}>{roleName(role)}</option>)}</select></label>)}</div>:<div className="empty" role="status">暂无可管理的工具。</div>}</>}
   <div className="permissionFooter"><span aria-live="polite">{busy?'正在保存…':dirty?'有未保存的修改':'权限尚未更改'}</span><div><button type="button" className="secondary" disabled={busy} onClick={requestClose}>取消</button><button className="primary" disabled={busy||loading||!ready||!dirty||!tools.length}>{busy?'保存中…':'保存权限'}</button></div></div>
  </form></dialog>;
}
