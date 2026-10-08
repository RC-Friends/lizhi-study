import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Download, Eye, LoaderCircle, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { loadSkillFiles, observerPrompt, saveDownload, siteOrigin, skillUrl, skillZip } from './observer-skill.mjs';
import './observer-skill.css';

const questions = ['看看最近 7 天练得怎么样，和前 7 天比较一下。', '分析最近的薄弱模块，给一个明天能完成的小计划。', '看看最近的人机对战，谁答得更准、谁用时更短？'];
const accuracy = value => value == null ? '暂无数据' : `${value}%`;

export default function ObserverSkill() {
  const origin = siteOrigin(window.location.origin), promptRef = useRef(null);
  const [question, setQuestion] = useState(questions[0]), [files, setFiles] = useState(null), [attempt, setAttempt] = useState(0);
  const [fileError, setFileError] = useState(''), [copyStatus, setCopyStatus] = useState('');
  const [stats, setStats] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const prompt = observerPrompt(origin, question);
  useEffect(() => {
    const controller = new AbortController(); setFiles(null); setFileError('');
    loadSkillFiles(origin, controller.signal).then(setFiles).catch(error => { if (!controller.signal.aborted) setFileError(error.message); });
    return () => controller.abort();
  }, [origin, attempt]);
  async function copy() {
    try { await navigator.clipboard.writeText(prompt); setCopyStatus('已复制，发给支持联网的 AI 就好。'); }
    catch { promptRef.current?.focus(); promptRef.current?.select(); setCopyStatus('已选中文字，请长按或按 Ctrl/Cmd+C 复制。'); }
  }
  async function preview() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/public/stats', { credentials: 'omit', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(response.status === 429 ? '查询有点频繁，稍等一分钟再试。' : '暂时无法读取公开数据，请稍后重试。');
      const next = await response.json();
      if (next.schemaVersion !== '1.0') throw new Error('统计服务暂不可用，请稍后重试。');
      setStats(next);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="observer-skill">
    <div className="lh-page-heading"><div><span className="lh-kicker">A SECOND PAIR OF EYES</span><h1>让 AI 看看最近的努力。</h1><p>把公开的学习记录交给你常用的 AI，一起找出进步和下一步。</p></div><Sparkles size={32} aria-hidden="true" /></div>
    <div className="observer-badges"><span><Eye size={15} />游客只读</span><span><ShieldCheck size={15} />无需学习口令</span><span>不消耗站内模型额度</span></div>
    <section className="lh-panel observer-share" aria-labelledby="observer-title">
      <span className="lh-kicker">把这段话交给 AI</span><h2 id="observer-title">想请它帮你看看什么？</h2>
      <div className="observer-questions" role="group" aria-label="选择查询话题">{questions.map((text, i) => <button key={text} className={question === text ? 'selected' : ''} aria-pressed={question === text} onClick={() => { setQuestion(text); setCopyStatus(''); }}>{['最近练得怎么样', '找到薄弱模块', '看看人机对战'][i]}</button>)}</div>
      <label className="observer-label" htmlFor="observer-question">也可以换成你想问的问题</label><input id="observer-question" value={question} maxLength={500} onChange={event => { setQuestion(event.target.value); setCopyStatus(''); }} />
      <label className="observer-label" htmlFor="observer-prompt">已为当前站点生成指令</label><textarea id="observer-prompt" ref={promptRef} readOnly value={prompt} rows={7} spellCheck={false} />
      <div className="observer-actions"><button className="button primary" onClick={copy}>{copyStatus.startsWith('已复制') ? <Check size={17} /> : <Copy size={17} />}复制给 AI</button><span role="status">{copyStatus || '适用于能访问网页的 AI；也可直接复制文字。'}</span></div>
    </section>
    <section className="lh-panel observer-download" aria-labelledby="observer-download-title"><div><span className="lh-kicker">常用的话，保存成技能</span><h2 id="observer-download-title">栗知学习观察员</h2><p>下载技能包，解压后按你的 AI 客户端说明安装。里面已有当前站点地址和查询说明，不包含做题记录或登录信息。</p></div>
      <div className="observer-site"><span>绑定站点</span><code>{origin}</code></div>
      <div className="observer-actions"><button className="button ghost" disabled={!files} onClick={() => saveDownload(skillZip(files), 'lizhi-study-observer.zip')}><Download size={17} />下载技能包</button><button className="button ghost" disabled={!files} onClick={() => saveDownload(new Blob([files[0].text], { type: 'text/markdown;charset=utf-8' }), 'SKILL.md')}>下载 SKILL.md</button><a className="text-button" href={skillUrl(origin)} target="_blank" rel="noreferrer">查看技能原文<ArrowUpRight size={15} /></a></div>
      {!files && !fileError && <p className="observer-note" role="status"><LoaderCircle size={14} className="spin" />正在准备技能文件…</p>}
      {fileError && <div className="lh-error" role="alert">{fileError}<button className="text-button" onClick={() => setAttempt(value => value + 1)}>重新加载</button></div>}
      <p className="observer-note">地址随当前浏览器页面生成。在公网网址打开这里，下载的技能就使用公网 HTTPS 地址。</p>
    </section>
    <section className="lh-panel observer-preview" aria-labelledby="observer-preview-title"><div className="lh-panel-heading"><div><h2 id="observer-preview-title">先看看 AI 能读到什么</h2><p>只查询公开统计，不调用模型。</p></div><button className="button ghost small" disabled={busy} onClick={preview}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{stats ? '刷新公开数据' : '试查公开数据'}</button></div>
      {error && <p className="lh-error" role="alert">{error}{stats && ' 下方保留上次查询结果。'}</p>}
      {stats ? <div className="observer-result" aria-live="polite"><p>{stats.profile.nickname} · {stats.range.from} 至 {stats.range.to}（北京时间）</p><div className="observer-metrics"><div><span>完成题次</span><strong>{stats.summary.answered}</strong></div><div><span>答对题次</span><strong>{stats.summary.correct}</strong></div><div><span>正确率</span><strong>{accuracy(stats.summary.accuracy)}</strong></div></div><p className="observer-note">查询快照：{new Date(stats.asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间） · 仅计已揭晓的正式作答</p></div> : <p className="observer-note">可查看近期题量、正确率、模块表现、人机对战和公开学习记录。私人笔记、聊天及尚未揭晓的题目不公开。</p>}
    </section>
  </div>;
}
