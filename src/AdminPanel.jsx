import React, { useEffect, useState } from 'react';
import { Activity, ArrowRight, BookOpen, Check, CircleCheck, CircleX, Database, Download, Eye, FileCheck2, FileText, FolderOpen, GraduationCap, History, LayoutDashboard, LoaderCircle, LogOut, RefreshCw, Settings2, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { api } from './api.js';
import { AiConfigPanel, KnowledgeBrowse } from './KnowledgeHub.jsx';
import example from '../examples/question-bank/questions.json';
import './admin.css';

const sections = [['overview', LayoutDashboard, '运行概览'], ['models', Sparkles, '模型配置'], ['knowledge', BookOpen, '资料库'], ['imports', Upload, '题库导入']];
const fromHash = () => sections.some(([id]) => id === window.location.hash.split('/')[1]) ? window.location.hash.split('/')[1] : 'overview';
const nf = new Intl.NumberFormat('zh-CN');

function Notice({ error, children }) {
  if (!children) return null;
  return <div className={`kh-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{error ? <CircleX size={16} /> : <CircleCheck size={16} />}<span>{children}</span></div>;
}

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function QuestionImport({ publishing, onBusy, onPublished }) {
  const [report, setReport] = useState(null), [bundle, setBundle] = useState(null), [busy, setBusy] = useState(''), [progress, setProgress] = useState(0), [error, setError] = useState(''), [success, setSuccess] = useState('');
  useEffect(() => {
    onBusy(Boolean(busy));
    const leave = event => { event.preventDefault(); event.returnValue = ''; };
    if (busy) window.addEventListener('beforeunload', leave);
    return () => { onBusy(false); window.removeEventListener('beforeunload', leave); };
  }, [busy, onBusy]);
  const validate = async file => {
    if (!file) return; setBusy('validate'); setError(''); setReport(null); setSuccess('');
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('标准题库 JSON 不能超过 32 MB。');
      let body; try { body = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON，请检查格式。'); }
      setReport(await api('/api/admin/question-bank/validate', { method: 'POST', body, timeoutMs: 120000 }));
    } catch (issue) { setError(issue.message); } finally { setBusy(''); }
  };
  const selectBundle = async files => {
    setError(''); setSuccess(''); setBundle(null); setProgress(0);
    if (!files.length) return;
    try {
      const map = new Map(files.map(file => [file.webkitRelativePath.split('/').slice(1).join('/'), file]));
      const manifestFile = map.get('manifest.json');
      if (!manifestFile) throw new Error('所选目录中没有 manifest.json，请选择资源包的根目录。');
      if (manifestFile.size > 4 * 1024 * 1024) throw new Error('资源清单过大。');
      const manifest = JSON.parse(await manifestFile.text());
      if (!/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) throw new Error('资源清单格式无效，请使用题库导入工具生成资源包。');
      let bytes = 0;
      for (const entry of manifest.files) {
        if (typeof entry.path !== 'string' || !map.has(entry.path)) throw new Error(`资源包缺少文件：${entry.path || '(无路径)'}`);
        if (map.get(entry.path).size !== entry.bytes) throw new Error(`文件大小与清单不符：${entry.path}`);
        bytes += entry.bytes;
      }
      if (bytes > 512 * 1024 * 1024) throw new Error('资源包总大小不能超过 512 MB。');
      setBundle({ manifest, files: map, bytes });
    } catch (issue) { setError(issue instanceof SyntaxError ? 'manifest.json 不是有效的 JSON。' : issue.message); }
  };
  const publish = async () => {
    if (!bundle || busy) return; setBusy('publish'); setError(''); setSuccess(''); setProgress(0);
    try {
      for (const [index, entry] of bundle.manifest.files.entries()) {
        await api(`/api/admin/question-bank/releases/${bundle.manifest.version}/files?path=${encodeURIComponent(entry.path)}`, { method: 'PUT', body: bundle.files.get(entry.path), raw: true, timeoutMs: 120000 });
        setProgress(index + 1);
      }
      const result = await api(`/api/admin/question-bank/releases/${bundle.manifest.version}/publish`, { method: 'POST', body: bundle.manifest, timeoutMs: 120000 });
      setSuccess(`新题库已启用，共 ${nf.format(result.questions)} 道题。正在进行的练习和历史成绩保持有效。`); setBundle(null); onPublished();
    } catch (issue) { setError(issue.message); } finally { setBusy(''); }
  };
  return <>
    <div className="lh-page-heading"><div><span className="lh-kicker">KEEP THE QUESTION BANK GROWING</span><h1>让好题，慢慢多起来。</h1><p>先校验内容，再上传资源包。只有完整通过检查的版本才会启用。</p></div></div>
    <section className="lh-panel admin-import-panel"><div className="kh-section-title"><span><FileCheck2 size={19} /></span><div><h2>1. 检查标准题库文件</h2><p>选择符合导入格式的 JSON，检查题目、答案和图片引用。</p></div></div><div className="admin-import-actions"><label className={`button ghost admin-file-button${busy ? ' disabled' : ''}`}><FileText size={16} />{busy === 'validate' ? '正在校验…' : '选择 JSON 校验'}<input type="file" accept=".json,application/json" aria-label="选择标准题库 JSON" disabled={Boolean(busy)} onChange={event => { validate(event.target.files[0]); event.target.value = ''; }} /></label><button className="text-button" onClick={() => downloadJson('questions.example.json', example)}><Download size={14} />下载格式范例</button><button className="text-button" disabled={Boolean(busy)} onClick={async () => { try { downloadJson('question-import.schema.json', await api('/api/admin/question-bank/schema')); } catch (issue) { setError(issue.message); } }}>下载 JSON Schema<ArrowRight size={14} /></button></div>{report && <Notice>格式校验通过。{report.questions != null ? `共 ${nf.format(report.questions)} 道题。` : ''}发布时还会检查实际图片文件。</Notice>}</section>
    <section className="lh-panel admin-import-panel"><div className="kh-section-title"><span><Database size={19} /></span><div><h2>2. 上传并启用资源包</h2><p>选择包含 manifest.json、questions.jsonl 与题图的完整目录。</p></div></div>
      {!publishing && <Notice error>当前环境未配置题库发布服务。需要 PostgreSQL、Redis、对象存储和独立发布凭证；格式校验仍可使用。</Notice>}
      <label className={`kh-dropzone${busy || !publishing ? ' disabled' : ''}`}><input className="kb-file-input" type="file" webkitdirectory="" multiple aria-label="选择题库资源包目录" disabled={Boolean(busy) || !publishing} onChange={event => { selectBundle([...event.target.files]); event.target.value = ''; }} /><span className="kh-drop-icon"><FolderOpen size={24} /></span><strong>{bundle ? `${nf.format(bundle.manifest.questions)} 道题 · ${bundle.manifest.images} 张图片` : '选择题库资源包目录'}</strong><span>{bundle ? `${bundle.manifest.files.length} 个文件 · ${(bundle.bytes / 1024 / 1024).toFixed(1)} MB · 点击重新选择` : '保留目录结构，系统会逐个校验文件后启用'}</span></label>
      <p className="kh-input-hint">资源包须以当前版本为基础增量合并，保留历史记录引用的原题。可用仓库的 <code>npm run questions:import</code> 生成，完整说明见 <a href="https://github.com/RC-Friends/lizhi-study/blob/main/docs/QUESTION_IMPORT.md" target="_blank" rel="noreferrer">题库导入文档</a>。</p>
      {bundle && <div className="admin-release-info"><span>待发布版本</span><code>{bundle.manifest.version}</code></div>}
      {busy === 'publish' && <div className="admin-upload-progress" role="status"><progress max={bundle.manifest.files.length + 1} value={progress} /><span>{progress < bundle.manifest.files.length ? `已上传 ${progress} / ${bundle.manifest.files.length} 个文件` : '文件已上传，正在校验并启用版本…'}</span></div>}
      <div className="kh-dialog-actions"><button className="button primary" disabled={!publishing || !bundle || Boolean(busy)} onClick={publish}>{busy === 'publish' ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}上传并启用此题库</button></div>
    </section><Notice error>{error}</Notice><Notice>{success}</Notice>
  </>;
}

export default function AdminPanel({ onLogout, onObserve }) {
  const [view, setView] = useState(fromHash), [status, setStatus] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [operation, setOperation] = useState(false);
  const refresh = async () => {
    setLoading(true); setError('');
    try { setStatus(await api('/api/admin/status')); }
    catch (issue) { setError(issue.message); } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); const pop = () => setView(fromHash()); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  const navigate = next => { if (operation) return; setView(next); window.history.replaceState(null, '', `#admin/${next}`); window.scrollTo({ top: 0, behavior: 'instant' }); };
  return <div className="learning-app"><header className="lh-header admin-header"><div><button className="lh-brand" disabled={operation} onClick={() => navigate('overview')}><span><GraduationCap size={23} /></span><div>栗知自习室<small>ONE QUESTION, ONE STEP.</small></div></button><div className="lh-header-actions"><span className="admin-identity"><ShieldCheck size={15} />超级管理员</span><button className="button ghost small" disabled={operation} onClick={() => onObserve('public')}><Eye size={15} />查看学习情况</button><button className="button ghost small" disabled={operation} onClick={onLogout}><LogOut size={15} />退出管理</button></div></div></header>
    <div className="lh-shell"><aside className="lh-sidebar admin-sidebar"><span className="lh-nav-label">打理自习室</span><nav aria-label="站点管理导航">{sections.map(([key, Icon, name]) => <button key={key} className={view === key ? 'active' : ''} aria-current={view === key ? 'page' : undefined} disabled={operation} onClick={() => navigate(key)}><Icon size={18} /><span>{name}</span></button>)}{[['public', Eye, '公开监督'], ['history', History, '学习记录'], ['skill', Sparkles, 'AI 监督']].map(([key, Icon, name]) => <button key={key} disabled={operation} onClick={() => onObserve(key)}><Icon size={18} /><span>{name}</span></button>)}</nav><div className="admin-sidebar-note"><ShieldCheck size={25} /><strong>单考生模式</strong><p>考生专注练习<br />朋友随时监督<br />管理员打理站点</p></div></aside>
      <main className="lh-main admin-main"><Notice error>{error}</Notice>{view === 'overview' && <>
        <div className="lh-page-heading"><div><span className="lh-kicker">A QUIET PLACE, WELL LOOKED AFTER</span><h1>把自习室，照顾好。</h1><p>查看服务状态、维护资料与题库，让考生安心往前走。</p></div><button className="button ghost small" disabled={loading} onClick={refresh}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新状态</button></div>
        <div className="lh-stat-grid admin-stats">{[[Database, '可用题目', status?.bank?.total, '正式题库中的单选题'], [FileText, '带图题目', status?.bank?.imageQuestions, '支持多模态练习'], [BookOpen, '资料库', status?.knowledge?.libraries, '为单考生整理的资料库'], [FolderOpen, '已收录资料', status?.knowledge?.documents, '知识库中的讲义与笔记']].map(([Icon, name, value, text]) => <section className="lh-stat" key={name}><div><span>{name}</span><Icon size={17} /></div><strong>{value == null ? '—' : nf.format(value)}</strong><p>{text}</p></section>)}</div>
        <div className="admin-overview-grid"><section className="lh-panel"><div className="lh-panel-heading"><div><span className="lh-kicker">EVERYTHING IN ITS PLACE</span><h2>服务状态</h2></div><Activity size={17} /></div>{[['database', '学习数据库', '保存成绩、记录与资料'], ['redis', '任务与协作服务', '协调后台任务和缓存'], ['resources', '题库资源', '提供题目与原始题图']].map(([key, title, text]) => <div className="admin-service" key={key}><span><Database size={18} /></span><div><strong>{title}</strong><p>{text}</p></div><span className={`kh-label${status?.services[key] === 'unavailable' ? ' warm' : ''}`}>{!status ? '读取中' : status.services[key] === 'ready' ? <><Check size={12} />正常</> : status.services[key] === 'local' ? '本地模式' : '不可用'}</span></div>)}</section>
        <section className="lh-panel"><div className="lh-panel-heading"><div><span className="lh-kicker">KEEP LEARNING SIMPLE</span><h2>常用管理</h2></div><Settings2 size={17} /></div>{[['models', Sparkles, '配置出题模型', '维护对战、陪练与出题的模型'], ['knowledge', BookOpen, '整理知识库', '收录讲义，管理备考资料'], ['imports', Upload, '导入新题目', '校验并发布一个新的题库版本']].map(([id, Icon, name, text]) => <button className="admin-shortcut" key={id} onClick={() => navigate(id)}><Icon size={19} /><span><strong>{name}</strong><small>{text}</small></span><ArrowRight size={15} /></button>)}</section></div>
        {status?.resourceVersion && <div className="admin-release-info"><span>当前题库版本</span><code>{status.resourceVersion}</code></div>}
      </>}
      {view === 'models' && <><div className="lh-page-heading"><div><span className="lh-kicker">HELP YOUR STUDY PARTNER HELP YOU</span><h1>给小栗，配好学习工具。</h1><p>首次初始化从环境配置导入；此后以这里保存的配置为准，重启不会覆盖。</p></div></div><AiConfigPanel /></>}
      {view === 'knowledge' && <KnowledgeBrowse />}
      {view === 'imports' && <QuestionImport publishing={status?.importer.publishing} onBusy={setOperation} onPublished={refresh} />}
      <footer className="lh-footer"><span>栗知自习室 · 站点管理</span><span>一个考生，一份持续积累的学习记录。</span></footer></main>
    </div></div>;
}
