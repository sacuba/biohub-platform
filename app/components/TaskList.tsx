'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import type {Operations,Tool} from '../../src/generated/platform';
const statusNames:Record<string,string>={queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已取消'};
const typeNames:Record<string,string>={generation:'文生图',edit:'图片编辑',batch:'批量生图',annotation:'抗体分析'};
type TaskPage=Operations['tasks']['response'];
export default function TaskList({api,tools}:{api:(route:string)=>Promise<TaskPage>;tools:Tool[]}){
 const [query,setQuery]=useState({index:0,size:20,cursors:['']}),[result,setResult]=useState<TaskPage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const request=useRef(0);
 function change(next:typeof query){request.current++;setLoading(true);setResult(null);setQuery(next);}
 function refresh(){change({...query,index:0,cursors:['']});setRevision(n=>n+1);}
 useEffect(()=>{const ticket=++request.current;let active=true;setLoading(true);setError('');setResult(null);
  const params=new URLSearchParams({limit:String(query.size)});if(query.cursors[query.index])params.set('cursor',query.cursors[query.index]);
  void api('tasks?'+params).then(page=>{
   if(!active||ticket!==request.current)return;
   if(!page.tasks.length&&!page.unavailable.length&&query.index>0){setQuery(current=>({...current,index:current.index-1,cursors:current.cursors.slice(0,current.index)}));return;}
   setResult(page);setLoading(false);
  }).catch(e=>{if(active&&ticket===request.current){setError(e.message);setLoading(false);}});
  return()=>{active=false;};
 },[api,query,revision]);
 const toolName=(id:string)=>tools.find(tool=>tool.id===id)?.name||id;
 return <><div className="pageHeading"><div className="eyebrow muted">YOUR RESEARCH ACTIVITY</div><h1>我的任务</h1><p>查看各工具任务进度，返回工具查看具体结果。</p></div><section className="panel taskList"><div className="panelHeading"><h2>任务记录</h2><button className="secondary" disabled={loading} onClick={refresh}>刷新任务</button></div>
  {error&&<div className="error" role="alert">{error} <button className="textButton" onClick={()=>setRevision(n=>n+1)}>重试</button></div>}
  {!!result?.unavailable.length&&<div className="error" role="alert">{result.unavailable.map(toolName).join('、')} 暂不可用，恢复后可继续翻页。 <button className="textButton" disabled={loading} onClick={()=>setRevision(n=>n+1)}>重试当前页</button></div>}
  <div className="tableWrap" aria-busy={loading}><table><thead><tr><th>任务</th><th>状态</th><th>积分</th><th>时间</th><th>结果</th></tr></thead><tbody>{!loading&&result?.tasks.map(task=><tr key={task.tool_id+':'+task.id}><td>{toolName(task.tool_id)} · {typeNames[task.type]||task.type}<small className="cellHint">{task.id.slice(-12)}</small></td><td>{statusNames[task.status]||task.status}<small className="cellHint">{task.wallet_status}</small></td><td>{task.credits}</td><td>{new Date(task.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td><td><a className="textLink" href={task.result_url}>返回工具 <ArrowUpRight size={14}/></a></td></tr>)}</tbody></table></div>
  {loading&&<div className="empty" role="status">正在加载任务…</div>}{!loading&&!error&&result&&!result.tasks.length&&!result.unavailable.length&&<div className="empty" role="status">暂无任务记录，使用工具后会显示在这里。</div>}
  <nav className="userPagination" aria-label="任务分页"><span role="status">第 {query.index+1} 页{result?` · 本页 ${result.tasks.length} 条任务`:''}</span><label>每页条数<select aria-label="任务每页条数" value={query.size} onChange={e=>change({index:0,size:Number(e.target.value),cursors:['']})}>{[20,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={loading||query.index===0} onClick={()=>change({...query,index:query.index-1})}>上一页</button><button className="secondary" disabled={loading||!result?.next_cursor||!!result?.unavailable.length} onClick={()=>change({...query,index:query.index+1,cursors:[...query.cursors.slice(0,query.index+1),result!.next_cursor!]})}>下一页</button></div></nav>
 </section></>;
}
