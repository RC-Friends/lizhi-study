import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, CircleCheck, CircleHelp, CircleX, Download, Eye, FileText, FolderOpen, Image as ImageIcon, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { api } from './api.js';
import './knowledge.css';

const formatNames = { markdown: 'Markdown', text: '纯文本', pdf: 'PDF', docx: 'Word', image: '图片' };
const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const date = value => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

function Notice({ children, error = false, action, onAction }) {
  if (!children) return null;
  const Icon = error ? CircleX : CircleCheck;
  return <div className={`kh-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><Icon size={16} /><span>{children}</span>{action && <button type="button" className="text-button" onClick={onAction}>{action}<RefreshCw size={13} /></button>}</div>;
}

function Empty({ title, children, action, onAction, icon: Icon = FolderOpen }) {
  return <div className="lh-empty kh-empty"><span><Icon size={27} /></span><h3>{title}</h3><p>{children}</p>{action && <button className="button ghost small" onClick={onAction}><Plus size={15} />{action}</button>}</div>;
}

function Dialog({ title, kicker, children, onClose, busy = false, wide = false }) {
  const ref = useRef(null), id = useId();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog className={`dialog kh-dialog${wide ? ' wide' : ''}`} ref={ref} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { const rect = ref.current.getBoundingClientRect(); if (!busy && event.target === ref.current && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    <div className="kh-dialog-heading"><div><span className="lh-kicker">{kicker}</span><h2 id={id}>{title}</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={19} /></button></div>
    {children}
  </dialog>;
}

function LibraryDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', description: '', visibility: 'private' }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const library = await api('/api/kb/libraries', { method: 'POST', body: form }); onCreated(library); }
    catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  return <Dialog title="新建资料库" kicker="A PLACE FOR YOUR NOTES" onClose={onClose} busy={busy}>
    <p className="kh-dialog-copy">给同一科目的讲义和笔记，留一个专属的位置。</p>
    <form onSubmit={submit} className="kh-form">
      <div className="field"><label htmlFor="kb-lib-name">资料库名称</label><input autoFocus id="kb-lib-name" maxLength={40} placeholder="例如：数量关系 · 备考笔记" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required disabled={busy} /></div>
      <div className="field"><label htmlFor="kb-lib-desc">简介 <span>选填</span></label><textarea id="kb-lib-desc" rows={3} maxLength={200} placeholder="收录的内容，或给未来自己的提醒" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} disabled={busy} /></div>
      <Notice error>{error}</Notice><div className="kh-dialog-actions"><button type="button" className="button ghost" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !form.name.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建资料库</button></div>
    </form>
  </Dialog>;
}

function UploadDialog({ library, onClose, onUploaded }) {
  const [mode, setMode] = useState('file'), [format, setFormat] = useState('markdown'), [title, setTitle] = useState(''), [content, setContent] = useState(''), [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [error, setError] = useState('');
  const readId = useRef(0);
  useEffect(() => () => { readId.current += 1; }, []);
  const pick = async chosen => {
    if (!chosen || busy) return;
    const id = ++readId.current;
    const extension = chosen.name.split('.').pop().toLowerCase();
    const type = ({ md: 'markdown', markdown: 'markdown', txt: 'text', pdf: 'pdf', docx: 'docx', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image' })[extension];
    setError('');
    if (!type) { setError('请选择 Markdown、TXT、PDF、Word 或 PNG / JPEG / WebP 图片。'); return; }
    const limit = ['pdf', 'docx'].includes(type) ? 20 * 1024 * 1024 : type === 'image' ? 6 * 1024 * 1024 : 512 * 1024;
    if (chosen.size > limit) { setError(`${formatNames[type]} 文件不能超过 ${fileSize(limit)}。`); return; }
    setReading(true);
    try {
      let body;
      if (['markdown', 'text'].includes(type)) body = { content: await chosen.text() };
      else {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('文件读取失败，请重新选择。')); reader.readAsDataURL(chosen); });
        body = type === 'image' ? { image: data } : { fileBase64: data.split(',')[1] };
      }
      if (id !== readId.current) return;
      setFile({ name: chosen.name, size: chosen.size, format: type, body });
      setTitle(current => current.trim() || chosen.name.replace(/\.[^.]+$/, ''));
    } catch (issue) { if (id === readId.current) setError(issue.message); }
    finally { if (id === readId.current) setReading(false); }
  };
  const submit = async event => {
    event.preventDefault(); if (busy || reading) return; setBusy(true); setError('');
    try {
      const body = mode === 'file' ? { title: title.trim(), format: file.format, ...file.body } : { title: title.trim(), format, content };
      const result = await api(`/api/kb/libraries/${library.id}/documents`, { method: 'POST', body });
      onUploaded(result.duplicate ? '这份资料已经收录，已保留原文档。' : '资料收录成功。');
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const ready = title.trim() && (mode === 'file' ? file : content.trim());
  return <Dialog title="收录新资料" kicker="ADD TO YOUR LIBRARY" onClose={onClose} busy={busy || reading}>
    <p className="kh-dialog-copy">保存到 <strong>{library.name}</strong></p>
    <div className="kh-segment" role="group" aria-label="导入方式">{[['file', Upload, '上传文件'], ['text', FileText, '粘贴文字']].map(([value, Icon, label]) => <button key={value} type="button" aria-pressed={mode === value} disabled={busy || reading} onClick={() => { setMode(value); setError(''); }}><Icon size={15} />{label}</button>)}</div>
    <form className="kh-form" onSubmit={submit}>
      {mode === 'file' ? <>
        <label className={`kh-dropzone${dragging ? ' dragging' : ''}${file ? ' has-file' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy && !reading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy && !reading) pick(event.dataTransfer.files[0]); }}>
          <input className="kb-file-input" type="file" aria-label="选择资料文件" accept=".md,.markdown,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp" disabled={busy || reading} onChange={event => { pick(event.target.files[0]); event.target.value = ''; }} />
          <span className="kh-drop-icon">{reading ? <LoaderCircle size={24} className="spin" /> : file ? <FileText size={24} /> : <Upload size={24} />}</span>
          <strong>{reading ? '正在读取文件…' : file ? file.name : '选择文件，或拖到这里'}</strong>
          <span>{file ? `${formatNames[file.format]} · ${fileSize(file.size)} · 点击重新选择` : 'Markdown、TXT、PDF、Word 或图片'}</span>
        </label>
        {file?.format === 'image' && <img className="kh-upload-preview" src={file.body.image} alt="待收录的资料预览" />}
        <p className="kh-input-hint">{file?.format === 'image' ? '图片可保存到资料库，暂不支持文字识别和出题。' : '文字版 PDF / Word ≤ 20 MB，文本 ≤ 512 KB，图片 ≤ 6 MB。扫描版 PDF 暂不支持。'}</p>
      </> : <div className="field"><div className="kh-field-label"><label htmlFor="kb-content">资料内容</label><select aria-label="文字格式" value={format} onChange={event => setFormat(event.target.value)} disabled={busy}><option value="markdown">Markdown</option><option value="text">纯文本</option></select></div><textarea id="kb-content" rows={7} placeholder="粘贴讲义、教材章节或复习笔记…" value={content} onChange={event => setContent(event.target.value)} required disabled={busy} /><small>最多 512 KB；Markdown 标题会保留为章节名称。</small></div>}
      <div className="field"><label htmlFor="kb-title">资料标题</label><input id="kb-title" maxLength={100} placeholder="给这份资料起个容易找到的名字" value={title} onChange={event => setTitle(event.target.value)} required disabled={busy} /></div>
      <Notice error>{error}</Notice><div className="kh-dialog-actions"><button type="button" className="button ghost" disabled={busy || reading} onClick={onClose}>取消</button><button className="button primary" disabled={busy || reading || !ready}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{busy ? '正在收录' : '收进知识库'}</button></div>
    </form>
  </Dialog>;
}

function DocumentDialog({ document, onClose }) {
  const [count, setCount] = useState(10);
  return <Dialog title={document.title} kicker="YOUR STUDY MATERIAL" wide onClose={onClose}><p className="kh-dialog-copy">{formatNames[document.format]} · 按原资料章节整理</p><div className="kh-document-content">{document.chunks.slice(0, count).map(chunk => <section key={chunk.index}><span className="lh-kicker">{String(chunk.index + 1).padStart(2, '0')}</span><h3>{chunk.anchor}</h3><p>{chunk.text}</p></section>)}</div>{document.chunks.length > count && <button className="button ghost kh-load-more" onClick={() => setCount(count + 10)}>继续阅读<ChevronDown size={15} /></button>}</Dialog>;
}

export function KnowledgeBrowse() {
  const scope = 'mine';
  const [libraries, setLibraries] = useState(null), [detail, setDetail] = useState(null), [preview, setPreview] = useState(null), [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null), [removing, setRemoving] = useState(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [saved, setSaved] = useState(''), [error, setError] = useState('');
  const request = useRef(0);
  const load = async (target = scope) => {
    const id = ++request.current; setLoading(true); setError('');
    try { const result = await api(`/api/kb/libraries?scope=${target}`); if (id === request.current) setLibraries(result); }
    catch (issue) { if (id === request.current) setError(issue.message); }
    finally { if (id === request.current) setLoading(false); }
  };
  useEffect(() => { setLibraries(null); setQuery(''); load(scope); return () => { request.current += 1; }; }, [scope]);
  const open = async (id, clearNotice = true) => {
    if (clearNotice) setSaved(''); setError(''); setBusy(true);
    try { setDetail(await api(`/api/kb/libraries/${id}`)); setQuery(''); }
    catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const download = async library => {
    setBusy(true); setError('');
    try {
      const data = await api(`/api/kb/libraries/${library.id}/export`), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${library.name}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api(removing.kind === 'library' ? `/api/kb/libraries/${removing.id}` : `/api/kb/libraries/${detail.library.id}/documents/${removing.id}`, { method: 'DELETE' });
      setRemoving(null); setSaved('已删除。'); if (detail) await open(detail.library.id, false); else await load();
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const docs = detail?.items || [], items = (libraries?.items || []).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="kh-page">
    {detail && <button className="text-button kh-back" onClick={() => { setDetail(null); setSaved(''); setQuery(''); load(); }}><ArrowLeft size={14} />全部资料库</button>}
    <div className="lh-page-heading"><div><span className="lh-kicker">{detail ? 'YOUR STUDY LIBRARY' : 'A LITTLE KNOWLEDGE, EVERY DAY'}</span><h1>{detail ? detail.library.name : '把知识，慢慢积累起来。'}</h1><p>{detail ? detail.library.description || '讲义、笔记和练习的依据，都收在这里。' : '收好讲义和笔记，让每一份资料都成为下一次进步的起点。'}</p></div>{detail ? detail.library.mine && <button className="button primary small" disabled={busy} onClick={() => setDialog('upload')}><Upload size={16} />收录资料</button> : <button className="button primary small" onClick={() => setDialog('create')}><Plus size={16} />新建资料库</button>}</div>
    {!removing && <Notice error action={!detail ? '重试' : undefined} onAction={() => load()}>{error}</Notice>}<Notice>{saved}</Notice>
    {detail ? <section className="lh-panel kh-library-detail">
      <div className="kh-library-toolbar"><div><span>{docs.length} 份资料</span></div><button className="text-button" disabled={busy} onClick={() => download(detail.library)}><Download size={14} />下载资料库</button></div>
      {docs.length ? <div className="kh-document-list">{docs.map(item => <article className="kh-document" key={item.id}>
        <span className={`kh-file-icon${item.format === 'image' ? ' warm' : ''}`}>{item.format === 'image' ? <ImageIcon size={21} /> : <FileText size={21} />}</span>
        <div className="kh-document-info"><h2>{item.title}</h2><p>{item.preview}</p><div className="kh-meta"><span>{formatNames[item.format]}</span><span>{fileSize(item.size)}</span><span>{date(item.uploadedAt)}收录</span>{item.format === 'image' && <span className="kh-label warm">暂不参与出题</span>}</div></div>
        <div className="kh-document-actions">{item.format !== 'image' && <button className="button ghost small" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setPreview(await api(`/api/kb/libraries/${detail.library.id}/documents/${item.id}`)); } catch (issue) { setError(issue.message); } finally { setBusy(false); } }}><Eye size={14} />查看内容</button>}{detail.library.mine && <button className="icon-button kh-delete" aria-label={`删除资料 ${item.title}`} disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'document', id: item.id, title: item.title }); }}><Trash2 size={16} /></button>}</div>
      </article>)}</div> : <Empty title="第一份资料，就从这里开始" action={detail.library.mine ? '收录资料' : undefined} onAction={() => setDialog('upload')}>上传讲义或粘贴笔记，日后复习和出题都方便。</Empty>}
    </section> : <section className="lh-panel kh-library-list" aria-busy={loading}>
      <div className="kh-library-controls"><h2 className="kh-list-title"><BookOpen size={17} />我的资料库</h2><label className="lh-search kh-search"><Search size={16} /><input aria-label="搜索资料库" placeholder="搜索资料库" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {loading ? <div className="kh-loading" role="status"><LoaderCircle className="spin" size={20} />正在整理你的书架…</div> : libraries && (items.length ? <div className="kh-library-grid">{items.map(library => <article className="kh-library-card" key={library.id}>
        <div className="kh-card-top"><span className="kh-folder-icon"><BookOpen size={23} /></span><span className="kh-meta">{library.documentCount} 份资料</span></div>
        <h2>{library.name}</h2><p>{library.description || '收好每一份资料，慢慢填满自己的知识库。'}</p>
        <div className="kh-card-bottom"><button className="text-button" disabled={busy} onClick={() => open(library.id)}>打开资料库<ArrowRight size={14} /></button><details className="kh-menu"><summary aria-label={`${library.name}的更多操作`}><MoreHorizontal size={19} /></summary><div onClick={event => { event.currentTarget.parentElement.open = false; }}><button disabled={busy} onClick={() => download(library)}><Download size={14} />下载资料库</button>{library.mine && <><button className="kh-delete" disabled={busy} onClick={() => { setError(''); setRemoving({ kind: 'library', id: library.id, title: library.name }); }}><Trash2 size={14} />删除资料库</button></>}</div></details></div>
      </article>)}</div> : <Empty icon={query ? Search : FolderOpen} title={query ? '没有找到这份资料库' : scope === 'mine' ? '给你的知识，安一个家' : '暂时还没有共享资料库'} action={!query && scope === 'mine' ? '新建资料库' : undefined} onAction={() => setDialog('create')}>{query ? '换一个关键词试试。' : scope === 'mine' ? '先建一个资料库，再把常用的讲义和笔记收进来。' : '其他考生公开的资料库，会出现在这里。'}</Empty>)}
      {!loading && libraries && <div className="kh-list-foot"><span>共 {items.length} 个资料库</span><span><BookOpen size={13} />温故而知新</span></div>}
    </section>}
    {dialog === 'create' && <LibraryDialog onClose={() => setDialog(null)} onCreated={() => { setDialog(null); setSaved('资料库创建好了，可以开始收录资料。'); load(); }} />}
    {dialog === 'upload' && detail && <UploadDialog library={detail.library} onClose={() => setDialog(null)} onUploaded={message => { setDialog(null); setSaved(message); open(detail.library.id, false); }} />}
    {preview && <DocumentDialog document={preview} onClose={() => setPreview(null)} />}
    {removing && <Dialog title={`删除${removing.kind === 'library' ? '资料库' : '资料'}`} kicker="REMOVE MATERIAL" onClose={() => { setRemoving(null); setError(''); }} busy={busy}><p className="kh-dialog-copy">确定删除「{removing.title}」吗？{removing.kind === 'library' ? '其中的资料也会一起删除。' : ''}</p><Notice error>{error}</Notice><div className="kh-dialog-actions"><button className="button ghost" disabled={busy} onClick={() => setRemoving(null)}>保留</button><button className="button primary" disabled={busy} onClick={remove}>{busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}确认删除</button></div></Dialog>}
  </div>;
}

export function AiPractice({ companion, onNavigate }) {
  const [topic, setTopic] = useState(''), [count, setCount] = useState(5), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [session, setSession] = useState(null), [choice, setChoice] = useState(null), [revealed, setRevealed] = useState(false);
  const heading = useRef(null);
  const generate = async (query, number) => (await api('/api/kb/generate', { method: 'POST', body: { query, count: number }, timeoutMs: 180000 })).drafts;
  const start = async event => {
    event?.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const questions = await generate(topic.trim(), count); setSession({ query: topic.trim(), questions, index: 0, answers: {}, swapped: 0 }); setChoice(null); setRevealed(false); }
    catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  useEffect(() => { if (session) heading.current?.focus({ preventScroll: true }); }, [session?.index]);
  const submit = () => {
    if (!choice || revealed || busy) return;
    setSession(current => ({ ...current, answers: { ...current.answers, [current.questions[current.index].id]: choice } })); setRevealed(true);
  };
  const next = () => { if (busy) return; setChoice(null); setRevealed(false); setSession(current => ({ ...current, index: current.index + 1 })); heading.current?.scrollIntoView({ block: 'start' }); };
  const swap = async () => {
    if (busy) return; const old = session.questions[session.index]; setBusy(true); setError('');
    try {
      const fresh = await generate(session.query, 1);
      await api(`/api/drafts/${old.id}/swap`, { method: 'POST', body: {} });
      setSession(current => ({ ...current, questions: current.questions.map(question => question.id === old.id ? fresh[0] : question), swapped: current.swapped + 1 }));
      setChoice(null); setRevealed(false);
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  if (!session) return <div className="kh-page">
    <div className="lh-page-heading"><div><span className="lh-kicker">FROM YOUR NOTES TO YOUR NEXT STEP</span><h1>让资料，变成下一道题。</h1><p>告诉小栗想练什么，从你的知识库里找依据，出一组刚刚好的练习。</p></div></div>
    <div className="kh-practice-layout"><form className="lh-panel kh-form kh-generator" onSubmit={start}>
      <div className="kh-section-title"><span><Sparkles size={18} /></span><div><h2>今天想巩固什么？</h2><p>写下一个知识点，或一份资料里的具体章节。</p></div></div>
      <div className="field"><div className="kh-field-label"><label htmlFor="ai-topic">练习主题</label><span>{topic.length} / 100</span></div><textarea id="ai-topic" rows={4} maxLength={100} placeholder="例如：根据我的数量关系笔记，练一练相遇与追及问题" value={topic} onChange={event => setTopic(event.target.value)} required disabled={busy} /></div>
      <fieldset className="kh-fieldset"><legend>一次练多少</legend><div className="kh-count-options">{[[3, '热身一下'], [5, '刚刚好'], [10, '认真巩固']].map(([value, label]) => <label key={value} className={count === value ? 'selected' : ''}><input type="radio" name="question-count" value={value} checked={count === value} onChange={() => setCount(value)} disabled={busy} /><strong>{value}<span> 道</span></strong><small>{label}</small>{count === value && <CircleCheck size={15} />}</label>)}</div></fieldset>
      <Notice error>{error}</Notice>
      <div className="kh-generator-bottom"><span><BookOpen size={15} />取材于你可访问的资料库</span><button className="button primary" disabled={busy || !topic.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{busy ? '正在准备题目' : '生成练习'}{!busy && <ArrowRight size={16} />}</button></div>
      <p className="kh-input-hint">AI 生成内容供巩固参考；本次练习暂不计入学习记录。</p>
    </form><aside className="kh-practice-aside"><section className="lh-companion kh-companion"><div>{companion}<span><strong>小栗的出题小贴士</strong><small>一点准备，练习更有方向</small></span></div><p>先把想复习的资料收进知识库，再写下具体的主题。我会围绕资料出题，陪你把知识再过一遍。</p><button type="button" className="text-button" onClick={() => onNavigate('knowledge')}>去整理知识库<ArrowRight size={14} /></button></section><div className="kh-practice-steps"><div><span>01</span><p><strong>选个主题</strong><small>从一个具体的知识点开始</small></p></div><div><span>02</span><p><strong>认真作答</strong><small>提交后再看答案和解析</small></p></div><div><span>03</span><p><strong>回顾与巩固</strong><small>题目不合适，可以换一道</small></p></div></div></aside></div>
  </div>;
  const current = session.questions[session.index], finished = session.index >= session.questions.length;
  const correct = session.questions.filter(question => session.answers[question.id] === question.answer).length;
  if (finished) return <div className="kh-page"><div className="lh-page-heading"><div><span className="lh-kicker">ONE MORE STEP FORWARD</span><h1 ref={heading} tabIndex={-1}>这一组练完啦！</h1><p>再回看一下答案，把刚才的收获记牢。</p></div><button className="button ghost small" disabled={busy} onClick={() => setSession(null)}><ArrowLeft size={14} />换个主题</button></div>
    <section className="lh-panel kh-practice-result"><span className="kh-result-icon"><CircleCheck size={28} /></span><div><h2>{session.query}</h2><p>答对 {correct} / {session.questions.length} 题{session.swapped > 0 ? ` · 换过 ${session.swapped} 题` : ''}</p><small>本次 AI 练习暂不计入学习记录。</small></div><strong>{Math.round(correct / session.questions.length * 100)}<span>%</span><small>本组正确率</small></strong><button className="button primary" disabled={busy} onClick={start}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}再练一组</button></section><Notice error>{error}</Notice>
    <section className="lh-panel kh-result-review"><div className="kh-section-title"><BookOpen size={18} /><h2>逐题回顾</h2></div>{session.questions.map((question, index) => <details className="kh-review-item" key={question.id}><summary><span className="kh-question-number">{String(index + 1).padStart(2, '0')}</span><span>{question.stem}</span><span className={`kh-verdict${session.answers[question.id] === question.answer ? '' : ' wrong'}`}>{session.answers[question.id] === question.answer ? <CircleCheck size={15} /> : <CircleX size={15} />}{session.answers[question.id] === question.answer ? '答对' : '答错'}</span><ChevronDown size={16} /></summary><div className="kh-review-body"><div className="kh-review-choices">{Object.entries(question.options).map(([label, text]) => <p key={label} className={label === question.answer ? 'correct' : ''}><strong>{label}</strong><span>{text}</span>{label === question.answer && <Check size={14} />}</p>)}</div><p>你的答案：{session.answers[question.id]} · 参考答案：{question.answer}</p><div className="kh-explanation"><h3>解析</h3><p>{question.analysis}</p></div></div></details>)}</section>
  </div>;
  return <div className="kh-page kh-practice-page"><div className="lh-page-heading"><div><span className="lh-kicker">A LITTLE MORE CONFIDENT</span><h1 ref={heading} tabIndex={-1}>{session.query}</h1><p>按自己的节奏来，每认真完成一道，就多巩固一点。</p></div><span className="kh-label"><Sparkles size={13} />AI 专项练习</span></div>
    <div className="kh-practice-progress"><span><strong>{String(session.index + 1).padStart(2, '0')}</strong> / {String(session.questions.length).padStart(2, '0')}</span><progress aria-label="练习进度" max={session.questions.length} value={session.index + (revealed ? 1 : 0)} /><small>已完成 {session.index + (revealed ? 1 : 0)} 道</small></div>
    <article className="lh-panel kh-question-card" aria-busy={busy}><div className="kh-question-meta"><span>单项选择</span>{current.knowledgePoints.map(point => <span className="kh-label" key={point}>{point}</span>)}</div><h2>{current.stem}</h2>
      <div className="kh-answer-options" role="group" aria-label="答案选项">{Object.entries(current.options).map(([label, text]) => <button key={label} aria-pressed={choice === label} className={`kh-answer-option${choice === label ? ' selected' : ''}${revealed && label === current.answer ? ' correct' : ''}${revealed && choice === label && label !== current.answer ? ' wrong' : ''}`} disabled={revealed || busy} onClick={() => setChoice(label)}><strong>{label}</strong><span>{text}</span>{revealed && label === current.answer ? <CircleCheck size={18} /> : revealed && choice === label ? <CircleX size={18} /> : choice === label ? <Check size={18} /> : null}</button>)}</div>
      <div className="kh-question-actions"><button className="text-button" disabled={busy} onClick={swap}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{busy ? '正在换题' : '换一道题'}</button>{revealed ? <button className="button primary" disabled={busy} onClick={next}>{session.index + 1 >= session.questions.length ? '查看结果' : '下一题'}<ArrowRight size={16} /></button> : <button className="button primary" disabled={!choice || busy} onClick={submit}>提交答案<ArrowRight size={16} /></button>}</div>
      <Notice error>{error}</Notice>{revealed && <div className="kh-answer-reveal" role="status"><div className={`kh-verdict${choice === current.answer ? '' : ' wrong'}`}>{choice === current.answer ? <CircleCheck size={19} /> : <CircleX size={19} />}<strong>{choice === current.answer ? '答对了，继续保持。' : '没关系，再把解法过一遍。'}</strong><span>参考答案 {current.answer}</span></div><div className="kh-explanation"><h3>答案解析</h3><p>{current.analysis}</p></div>{current.source?.title && <div className="kh-source"><BookOpen size={13} />依据：{current.source.title}{current.source.anchor ? ` · ${current.source.anchor}` : ''}</div>}</div>}
    </article><p className="kh-practice-foot"><CircleHelp size={14} />AI 生成内容供巩固参考，本次练习暂不计入学习记录。</p>
  </div>;
}

export { default as AiConfigPanel } from './ModelSettings.jsx';
