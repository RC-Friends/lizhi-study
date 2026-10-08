import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Check, FilePenLine, LoaderCircle, MessageCircle, Send, ShieldCheck, Sparkles } from 'lucide-react';
import renderMathInElement from 'katex/contrib/auto-render';
import { api, streamCoach } from './api';
import { Chestnut } from './LearningHub';
import './study-tools.css';

function Prose({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.textContent = text || '';
    renderMathInElement(ref.current, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }], throwOnError: false, strict: 'ignore', trust: false, maxExpand: 200, maxSize: 20, errorCallback: () => {} });
  }, [text]);
  return <div className="buddy-prose math-prose" ref={ref} />;
}
export function QuestionNotebook({ questionId, revealed, onChanged }) {
  const [meta, setMeta] = useState(null), [note, setNote] = useState(''), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const draftKey = `xingce-study.note.${questionId}`;
  useEffect(() => {
    const controller = new AbortController(); setMeta(null); setError(''); setSaved(false); setOpen(false);
    api(`/api/learning/questions/${questionId}`, { signal: controller.signal }).then(data => {
      setMeta(data); let draft; try { draft = localStorage.getItem(draftKey); } catch {}
      setNote(draft ?? data.note); if (draft !== null && draft !== undefined && draft !== data.note) setOpen(true);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [questionId, revealed]);
  async function update(patch) {
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api(`/api/learning/questions/${questionId}`, { method: 'PATCH', body: patch });
      setMeta(current => ({ ...current, ...result }));
      if (patch.note !== undefined) { setSaved(true); try { localStorage.removeItem(draftKey); } catch {} }
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="question-notebook"><div className="notebook-actions"><button className={`text-button ${meta?.bookmarked ? 'is-saved' : ''}`} disabled={!meta || busy} onClick={() => update({ bookmarked: !meta.bookmarked })}>{meta?.bookmarked ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}{meta?.bookmarked ? '已收藏' : '收藏这道题'}</button><button className="text-button" disabled={!meta} onClick={() => setOpen(!open)} aria-expanded={open}><FilePenLine size={16} />我的笔记{meta?.note && <i className="note-dot" />}</button>{revealed && meta?.attempts > 0 && !meta.mastered && <button className="text-button" disabled={busy} onClick={() => update({ mastered: true })}><Check size={15} />我已掌握</button>}</div>
    {open && <div className="note-editor"><label htmlFor={`note-${questionId}`}>记下错因、方法或容易漏看的条件</label><textarea id={`note-${questionId}`} value={note} maxLength={4000} rows={4} onChange={e => { setNote(e.target.value); setSaved(false); try { localStorage.setItem(draftKey, e.target.value); } catch {} }} placeholder="例如：这里问的是“不正确”，审题时先圈出来。" /><div><small>{note.length}/4000 · 仅自己可见{note !== meta?.note && ' · 草稿已留在当前浏览器'}</small><button className="button small" disabled={busy || note === meta?.note} onClick={() => update({ note })}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saved ? '已保存' : '保存笔记'}</button></div></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}

export function CoachPanel({ matchId, index, revealed, correct, demo, compact = false }) {
  const [chat, setChat] = useState(null), [input, setInput] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState(''), [asking, setAsking] = useState('');
  const request = useRef(null), body = useRef(null);
  useEffect(() => {
    setChat(null); setError(''); setDraft(''); setAsking(''); setInput(''); setBusy(false);
    if (!revealed) return;
    const controller = new AbortController();
    api(`/api/matches/${matchId}/coach?index=${index}`, { signal: controller.signal }).then(setChat).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [matchId, index, revealed]);
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [draft, chat]);
  async function send(message) {
    if (busy || !message.trim() || !chat?.ready || chat.remaining <= 0) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setDraft(''); setAsking(message); setInput('');
    try {
      await streamCoach(matchId, index, message, controller.signal, (type, data) => {
        if (type === 'text') setDraft(current => current + data.text);
        if (type === 'complete') { setChat(data); setDraft(''); setAsking(''); }
      });
    } catch (e) { if (!controller.signal.aborted) {
      setError(e.message); setInput(message);
      try { setChat(await api(`/api/matches/${matchId}/coach?index=${index}`, { signal: controller.signal })); } catch { /* Keep the original, actionable error. */ }
    } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <aside className={`coach-panel ${compact ? 'compact' : ''}`}><div className="coach-heading"><Chestnut size={46} /><div><h3>小栗陪你复盘 <span>AI 陪练</span></h3><p>{revealed ? correct ? '答对啦，也把方法留在脑袋里～' : '错题是路标，咱们把卡住的地方弄明白。' : '先独立做一遍，交卷后我们一起拆解。'}</p></div></div>
    {!revealed ? <div className="coach-welcome"><Sparkles size={21} /><p>不用和别人比进度。<br />认真弄懂这一题，就又往前走了一小步。</p><small>交卷后可以提问、聊思路，或记下自己的解法。</small></div> : <>
      {demo && <div className="coach-demo">演示陪练 · 不调用真实模型</div>}
      <div className="coach-messages" ref={body} aria-live="polite">{chat?.messages.map((message, i) => <div key={i} className={`coach-message ${message.role}`}><span>{message.role === 'user' ? '你' : '小栗'}</span><Prose text={message.content} /></div>)}{asking && <div className="coach-message user"><span>你</span><Prose text={asking} /></div>}{(draft || busy) && <div className="coach-message assistant"><span>小栗</span>{draft ? <Prose text={draft} /> : <p className="coach-typing"><LoaderCircle size={14} className="spin" />在整理好懂的讲解…</p>}</div>}</div>
      {!chat?.messages.length && !asking && <p className="coach-invitation">哪里还没想明白？可以直接问我。</p>}
      <div className="coach-prompts">{['用简单的话讲讲这题', '其他选项为什么不对？', '帮我总结一个避坑口诀'].map(text => <button disabled={busy || !chat?.ready || chat?.remaining <= 0 || chat?.busy} key={text} onClick={() => send(text)}>{text}</button>)}</div>
      <form className="coach-input" onSubmit={e => { e.preventDefault(); send(input); }}><label className="sr-only" htmlFor={`coach-${matchId}-${index}`}>问小栗</label><textarea id={`coach-${matchId}-${index}`} maxLength={800} rows={2} value={input} disabled={busy || !chat?.ready || chat?.remaining <= 0 || chat?.busy} onChange={e => setInput(e.target.value)} placeholder={chat?.ready === false ? '模型尚未接入，先看看参考解析吧' : '我不明白……（最多 800 字）'} /><button type="submit" className="button primary" disabled={busy || !input.trim() || !chat?.ready || chat?.remaining <= 0 || chat?.busy} aria-label="发送给小栗">{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></form>
      <div className="coach-foot"><ShieldCheck size={12} />聊天仅自己可见 · 不影响已判成绩{chat && <span>还可聊 {chat.remaining} 轮</span>}</div>
      {chat?.busy && !busy && <p className="coach-recovery">刚才的回复仍在生成。稍后重新打开本题即可查看已保存的回复。</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </>}
  </aside>;
}
