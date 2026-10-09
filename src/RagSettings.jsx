import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, CircleCheck, CircleX, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { api } from './api.js';

const fallbackText = {
  disabled: '当前使用关键词检索。保存并启用 Embedding 后，可加入语义检索。',
  indexing: '向量索引还在准备中，当前可用的资料继续参与关键词检索。',
  unavailable: '向量服务暂时不可用，本次已使用关键词检索。',
  empty: '还没有可检索的文字资料，先去资料库收录一份笔记吧。',
};

export default function RagSettings({ revision }) {
  const [status, setStatus] = useState(null), [query, setQuery] = useState(''), [result, setResult] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let disposed = false, pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try { const value = await api('/api/admin/rag/status'); if (!disposed) setStatus(value); }
      catch (issue) { if (!disposed) setError(issue.message); } finally { pending = false; }
    };
    load(); const timer = setInterval(load, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [revision]);
  const rebuild = async (force = false) => {
    if (busy) return; setBusy('index'); setError(''); setConfirm(false);
    try { setStatus(await api('/api/admin/rag/reindex', { method: 'POST', body: { force }, timeoutMs: 60000 })); }
    catch (issue) { setError(issue.message); } finally { setBusy(''); }
  };
  const search = async event => {
    event.preventDefault(); if (busy || !query.trim()) return; setBusy('search'); setError(''); setResult(null);
    try { setResult(await api(`/api/kb/search?q=${encodeURIComponent(query.trim())}`, { timeoutMs: 25000 })); }
    catch (issue) { setError(issue.message); } finally { setBusy(''); }
  };
  return <section className="ad-rag" aria-label="知识库检索">
    <div className="kh-section-title"><BookOpen size={18} /><div><h2>让小栗读懂你的资料</h2><p>语义与关键词一起找依据，出题仍然引用原资料。</p></div></div>
    {status && <div className="ad-rag-index">
      <div><strong>{status.ready}<span> / {status.total} 段</span></strong><small>{!status.configured ? '语义检索待配置' : status.working ? '正在建立索引' : status.ready === status.total ? '索引已就绪' : '资料分批准备中'}</small></div>
      <progress aria-label="向量索引进度" value={status.ready} max={Math.max(1, status.total)} />
      <button type="button" className="button ghost small" disabled={Boolean(busy) || !status.configured} onClick={() => rebuild()}>{busy === 'index' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}更新索引</button>
      {status.failed > 0 && <p className="ad-rag-warning">{status.failed} 段生成失败。检查模型连接后，点击「更新索引」重试。</p>}
    </div>}
    <p className="kh-input-hint">新资料会自动加入索引。更换服务地址、模型或维度后，使用对应的新索引；准备期间继续用关键词检索。</p>
    <form className="kh-form ad-rag-search" onSubmit={search}>
      <div className="field"><label htmlFor="rag-query">试着问一句</label><input id="rag-query" maxLength={100} placeholder="例如：怎么计算追上前面那个人的时间？" value={query} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} /></div>
      <button className="button primary" disabled={Boolean(busy) || !query.trim()}>{busy === 'search' ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}检索资料<ArrowRight size={14} /></button>
    </form>
    {error && <div className="kh-notice error" role="alert"><CircleX size={16} /><span>{error}</span></div>}
    {result && <div className="ad-rag-results" role="region" aria-label="检索结果">
      <div className="kh-notice" role="status"><CircleCheck size={16} /><span>{result.mode === 'hybrid' ? '已结合语义与关键词检索' : '已使用关键词检索'} · 找到 {result.items.length} 个片段</span></div>
      {result.fallback && <p className="kh-input-hint">{fallbackText[result.fallback]}</p>}
      {result.items.map(item => <article key={`${item.document.id}:${item.index}`}><div><BookOpen size={14} /><strong>{item.document.title}</strong><span>{item.anchor}</span></div><p>{item.text}</p>{item.retrieval?.includes('semantic') && <small>语义相关度 {Math.round(item.similarity * 100)}%</small>}</article>)}
      {!result.items.length && <p className="kh-input-hint">暂时没有找到依据，可以换个问法或先收录相关资料。</p>}
    </div>}
    {status?.configured && <details className="ad-rag-rebuild"><summary>重新生成全部向量</summary><p>同名模型在服务端更新后，可重新生成全部向量。会重新调用 Embedding 服务并产生用量。</p>{confirm ? <div className="kh-dialog-actions"><button type="button" className="button ghost small" disabled={Boolean(busy)} onClick={() => setConfirm(false)}>取消</button><button type="button" className="button primary small" disabled={Boolean(busy)} onClick={() => rebuild(true)}>确认重新生成</button></div> : <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => setConfirm(true)}>重新生成全部向量<RefreshCw size={13} /></button>}</details>}
  </section>;
}
