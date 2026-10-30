'use client';
import {useEffect,useRef,useState} from 'react';
import {Plus,Search} from 'lucide-react';
import type {CodeBatchesPage} from '../../src/generated/platform';
export default function CodeBatches({api,revision,busy,onGenerate,onShow,onCopy,onRevoke}:{api:(route:string)=>Promise<CodeBatchesPage>;revision:number;busy:boolean;onGenerate:()=>void;onShow:(id:string)=>void;onCopy:(id:string)=>void;onRevoke:(id:string)=>void}){
 const [query,setQuery]=useState({page:1,size:20,keyword:''}),[result,setResult]=useState<CodeBatchesPage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const request=useRef(0);
 function change(patch:Partial<typeof query>){request.current++;setLoading(true);setResult(null);setQuery(current=>({...current,...patch}));}
 function refresh(){request.current++;setReload(n=>n+1);}
 useEffect(()=>{let active=true;const ticket=++request.current;setLoading(true);setResult(null);setError('');
  const params=new URLSearchParams({page:String(query.page),page_size:String(query.size),keyword:query.keyword});
  void api('admin/batches?'+params).then(page=>{if(!active||ticket!==request.current)return;if(page.page!==query.page){setQuery(current=>({...current,page:page.page!}));return;}setResult(page);setLoading(false);}).catch(e=>{if(active&&ticket===request.current){setError(e.message);setLoading(false);}});
  return()=>{active=false;};
 },[api,query,revision,reload]);
 return <section className="panel codeBatches"><div className="panelHeading"><h2>兑换码批次</h2><button className="primary" disabled={busy} onClick={onGenerate}><Plus size={16}/>批量生成</button></div>
  <form className="inlineForm" onSubmit={event=>{event.preventDefault();refresh();}}><label className="search"><Search size={16}/><input aria-label="批次关键词" placeholder="按批次名称或 ID 查询" maxLength={100} value={query.keyword} onChange={e=>change({keyword:e.target.value,page:1})}/></label><button className="secondary" disabled={loading}>查询</button></form>
  {error&&<div className="error" role="alert">{error} <button className="textButton" disabled={loading} onClick={refresh}>重试</button></div>}
  <div className="tableWrap" aria-busy={loading}><table><thead><tr><th>批次名称</th><th>面值</th><th>张数 / 已兑换 / 已作废</th><th>操作</th></tr></thead><tbody>{!loading&&result?.batches.map(batch=><tr key={batch.id}><td>{batch.name}<small className="cellHint">{new Date(batch.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></td><td>{batch.credits} 积分</td><td>{batch.count} / {batch.redeemed} / {batch.revoked}</td><td><div className="rowActions"><button disabled={busy} onClick={()=>onShow(batch.id)}>查看</button><button disabled={busy} onClick={()=>onCopy(batch.id)}>复制整批</button><button disabled={busy} onClick={()=>onRevoke(batch.id)}>作废未用码</button></div></td></tr>)}</tbody></table></div>
  {loading&&<div className="empty" role="status">正在加载兑换码批次…</div>}{!loading&&!error&&!result?.batches.length&&<div className="empty" role="status">暂无匹配批次，可调整关键词或创建批次。</div>}
  <nav className="userPagination" aria-label="兑换码批次分页"><span role="status">{result?`共 ${result.total} 个批次 · 第 ${result.page} / ${result.total_pages} 页`:'批次总数与页码加载后显示'}</span><label>每页条数<select aria-label="批次每页条数" value={query.size} onChange={e=>change({size:Number(e.target.value),page:1})}>{[20,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={loading||busy||!result||query.page<=1} onClick={()=>change({page:query.page-1})}>上一页</button><button className="secondary" disabled={loading||busy||!result||query.page>=(result.total_pages??1)} onClick={()=>change({page:query.page+1})}>下一页</button></div></nav>
 </section>;
}
