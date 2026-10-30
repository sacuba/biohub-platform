'use client';
import {useEffect,useRef,useState} from 'react';
import type {LedgerPage} from '../../src/generated/platform';
const names:Record<string,string>={REGISTER_GIFT:'注册赠送',DAILY_GIFT:'每日赠送',REDEEM:'兑换积分',ADMIN_ADJUSTMENT:'管理员调整',USAGE:'任务消费',RELEASE:'释放冻结',EXPIRED:'赠送到期'};
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export default function CreditLedger({api,revision}:{api:(route:string)=>Promise<LedgerPage>;revision:number}){
 const [query,setQuery]=useState({page:1,page_size:20}),[result,setResult]=useState<LedgerPage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const request=useRef(0);
 function change(patch:Partial<typeof query>){request.current++;setLoading(true);setResult(null);setQuery(current=>({...current,...patch}));}
 useEffect(()=>{let active=true;const ticket=++request.current;setLoading(true);setError('');setResult(null);
  void api(`wallet/ledger?page=${query.page}&page_size=${query.page_size}`).then(page=>{if(!active||ticket!==request.current)return;if(page.page!==query.page){setQuery(current=>({...current,page:page.page}));return;}setResult(page);setLoading(false);}).catch(e=>{if(active&&ticket===request.current){setError(e.message);setLoading(false);}});
  return()=>{active=false;};
 },[api,revision,query,reload]);
 return <section className="panel creditLedger" aria-labelledby="ledger-title"><div className="panelHeading"><h2 id="ledger-title">积分流水</h2><button className="secondary" disabled={loading} onClick={()=>{request.current++;setReload(n=>n+1);}}>刷新流水</button></div>
  {error&&<div className="error" role="alert">{error} <button className="textButton" onClick={()=>setReload(n=>n+1)}>重试</button></div>}
  <div className="tableWrap" aria-busy={loading}><table><thead><tr><th>时间</th><th>类型</th><th>积分变化</th><th>剩余 / 有效期</th></tr></thead><tbody>{!loading&&result?.ledger.map(entry=><tr key={entry.id}><td>{date(entry.created_at)}</td><td>{names[entry.kind]||entry.kind}<small className="cellHint">{entry.reason}</small></td><td className={entry.amount>0?'positive':''}>{entry.amount>0?'+':''}{entry.amount}</td><td>{entry.remaining}{entry.expires_at&&<small className="cellHint">{date(entry.expires_at)}</small>}</td></tr>)}</tbody></table></div>
  {loading&&<div className="empty" role="status">正在加载积分流水…</div>}{!loading&&!error&&!result?.ledger.length&&<div className="empty" role="status">暂无积分流水</div>}
  <nav className="userPagination" aria-label="积分流水分页"><span role="status">{result?`共 ${result.total} 条流水 · 第 ${result.page} / ${result.total_pages} 页`:'流水总数与页码加载后显示'}</span><label>每页条数<select aria-label="流水每页条数" value={query.page_size} onChange={e=>change({page_size:Number(e.target.value),page:1})}>{[20,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={loading||!result||query.page<=1} onClick={()=>change({page:query.page-1})}>上一页</button><button className="secondary" disabled={loading||!result||query.page>=(result?.total_pages??1)} onClick={()=>change({page:query.page+1})}>下一页</button></div></nav>
 </section>;
}
