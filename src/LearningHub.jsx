import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ArrowRight, ArrowUpRight, BookOpen, Bookmark, CalendarDays, Check, ChevronDown, ChevronRight, CircleCheck, CircleHelp, CircleX, Clock3, Eye, FileText, Flame, GraduationCap, History, Image as ImageIcon, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Target, Trash2, Trophy, X, Zap } from 'lucide-react';
import { api } from './api.js';
import './learning.css';

const nf = new Intl.NumberFormat('zh-CN');
const pct = value => value == null ? '—' : `${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%`;
const when = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未开始';
const duration = ms => !ms ? '0 分钟' : ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`;
const plain = html => { const element = document.createElement('div'); element.innerHTML = DOMPurify.sanitize(html || ''); return element.textContent || ''; };
const clean = html => DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true, mathMl: true }, FORBID_TAGS: ['style', 'iframe', 'svg'], FORBID_ATTR: ['style', 'srcset'] });
const modeName = item => item.mode === 'practice' || item.settings?.mode === 'practice' ? '自主练习' : item.mode === 'jev' || item.settings?.mode === 'jev' ? 'JEV 对战' : 'AI 对战';
const labels = { overview: '学习概览', practice: '开始练习', wrong: '错题本', bookmarks: '收藏夹', knowledge: '知识库', drafts: 'AI 出题', history: '学习记录', public: '公开监督', settings: '学习设置' };

export function Chestnut({ size = 64, cheerful = true, className = '' }) {
  return <svg className={`chestnut ${className}`} width={size} height={size} viewBox="0 0 80 80" role="img" aria-label="陪练小栗"><path d="M40 10c-4 10-27 17-27 38 0 18 11 25 27 25s27-7 27-25C67 27 45 20 40 10Z" fill="#ac704e" /><path d="M14 50c2 15 10 22 26 22s24-7 26-22c-12-8-40-8-52 0Z" fill="#f1d5a5" /><path d="M40 14c1-8 10-11 16-6-4 7-10 9-16 6Z" fill="#8caa64" /><path d="M40 15c-1-5-5-8-8-9" fill="none" stroke="#607744" strokeWidth="3" strokeLinecap="round" /><ellipse cx="29" cy="47" rx="2.6" ry="3.1" fill="#3e392b" /><ellipse cx="51" cy="47" rx="2.6" ry="3.1" fill="#3e392b" /><ellipse cx="23" cy="54" rx="5" ry="3" fill="#df9f80" opacity=".8" /><ellipse cx="57" cy="54" rx="5" ry="3" fill="#df9f80" opacity=".8" /><path d={cheerful ? 'M35 54q5 7 10 0' : 'M36 57q4-3 8 0'} fill="none" stroke="#6a4937" strokeWidth="2.2" strokeLinecap="round" /><path d="M24 29q4-6 10-8" fill="none" stroke="#c9926c" strokeWidth="4" strokeLinecap="round" /></svg>;
}

export function LearnerLogin({ onLogin, onClose, busy, error, expired = false }) {
  const [password, setPassword] = useState('');
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog className="lh-login" ref={ref} onCancel={event => { if (busy) event.preventDefault(); else onClose?.(); }} onClick={event => { if (event.target === ref.current && !busy) onClose?.(); }}>
    <button className="icon-button lh-login-close" aria-label="关闭登录" onClick={onClose} disabled={busy}><X size={20} /></button>
    <Chestnut size={76} /><span className="lh-kicker">WELCOME BACK</span><h1>{expired ? '回来继续，重新登录一下' : '考生就位，小栗陪你。'}</h1><p>{expired ? '登录已过期，学习记录都还在。输入口令就能接着做题。' : '输入朋友给你的学习口令，开启今天的练习。'}</p>
    <form onSubmit={event => { event.preventDefault(); if (password.trim() && !busy) onLogin(password); }}>
      <label htmlFor="learner-password">学习口令</label><div className="lh-password"><LockKeyhole size={17} /><input autoFocus id="learner-password" type="password" autoComplete="current-password" placeholder="请输入口令" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required /></div>
      {error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
      <button className="button primary full" type="submit" disabled={busy || !password.trim()}>{busy ? <><LoaderCircle size={18} className="spin" />正在登录</> : <>进入我的学习中心<ArrowRight size={18} /></>}</button>
    </form><div className="lh-login-note"><ShieldCheck size={14} /> 在这台设备保持登录，可随时退出</div><button className="text-button" onClick={onClose} disabled={busy}>先以游客身份看看学习记录 <ArrowRight size={13} /></button>
  </dialog>;
}

function Empty({ icon: Icon = BookOpen, title, text, action, onAction }) {
  return <div className="lh-empty"><span><Icon size={29} strokeWidth={1.5} /></span><h3>{title}</h3><p>{text}</p>{action && <button className="button ghost small" onClick={onAction}>{action}<ArrowRight size={15} /></button>}</div>;
}
function PanelHeading({ kicker, title, children }) { return <div className="lh-panel-heading"><div>{kicker && <span className="lh-kicker">{kicker}</span>}<h2>{title}</h2></div>{children}</div>; }

function Activity({ activity = [] }) {
  return <section className="lh-panel lh-week"><PanelHeading kicker="SMALL STEPS, EVERY DAY" title="最近 7 天的学习足迹" /><div className="lh-activity">{activity.length ? activity.slice(-7).map(day => {
    const count = day.count ?? day.completed ?? day.answered ?? 0;
    return <div className={`lh-activity-day ${count ? 'has-work' : ''}`} key={day.date} title={`${day.date} · 完成 ${count} 题`}><span>{new Date(`${day.date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' }).replace('周', '')}</span><div style={{ '--activity-fill': `${Math.min(100, count * 4)}%` }}><strong>{count || '·'}</strong></div><small>{day.date?.slice(5).replace('-', '/')}</small></div>;
  }) : <p className="lh-soft-text">完成第一题后，这里就会留下你的学习足迹。</p>}</div><p className="lh-footnote">每一道独立完成的题，都算今天向前走的一小步。</p></section>;
}

function ModuleOverview({ modules = [], onPractice, loggedIn }) {
  return <section className="lh-panel"><PanelHeading kicker="FIND YOUR NEXT FOCUS" title="各模块表现" />{modules.length ? <div className="lh-modules">{modules.map(module => {
    const name = module.name || module.module, count = module.completed ?? module.count ?? module.answered ?? module.total ?? 0;
    const accuracy = module.accuracy ?? (count ? Math.round((module.correct || 0) / count * 100) : null);
    return <div className="lh-module-row" key={name}><div><strong>{name}</strong><span>{count ? `${count} 题 · 正确率 ${pct(accuracy)}` : '尚未练习'}</span></div><div className="lh-module-track"><span style={{ width: `${Math.min(100, Math.max(0, accuracy || 0))}%` }} /></div>{loggedIn && <button className="icon-button" aria-label={`练习${name}`} onClick={() => onPractice(name)}><ArrowUpRight size={17} /></button>}</div>;
  })}</div> : <Empty title="还没有模块成绩" text="完成练习后，一起找出擅长的模块和需要加强的地方。" />}</section>;
}

function MatchList({ matches = [], onReview, onResume, publicView = false, compact = false, busy, page, onLoadMore }) {
  const [filter, setFilter] = useState('all'), [limit, setLimit] = useState(12);
  const filtered = matches.filter(match => filter === 'all' || (filter === 'practice' ? modeName(match) === '自主练习' : filter === 'active' ? match.status === 'active' : modeName(match) !== '自主练习'));
  const visible = compact ? filtered.slice(0, 4) : filtered.slice(0, page ? filtered.length : limit);
  return <>{!compact && <div className="lh-filter-tabs" role="group" aria-label="筛选学习记录">{[['all', '全部记录'], ['practice', '自主练习'], ['duel', '人机对战'], ...(!publicView ? [['active', '未完成']] : [])].map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? 'selected' : ''} onClick={() => { setFilter(key); setLimit(12); }}>{label}</button>)}</div>}
    {visible.length ? <div className="lh-match-list">{visible.map(match => {
      const scores = match.scores || {}, completed = scores.completed ?? match.completed ?? match.answered ?? 0;
      const correct = scores.human ?? match.correct ?? 0, accuracy = scores.humanAccuracy ?? match.accuracy ?? (completed ? Math.round(correct / completed * 100) : null);
      const total = match.count ?? match.total ?? match.settings?.count ?? 0, active = match.status === 'active';
      return <article className="lh-match-item" key={match.id}><span className={`lh-match-icon ${modeName(match) === '自主练习' ? '' : 'duel'}`}>{modeName(match) === '自主练习' ? <BookOpen size={19} /> : <Zap size={19} />}</span><div className="lh-match-info"><div><h3>{match.title || modeName(match)}</h3>{match.demo || match.settings?.demo ? <span className="lh-label warm">演示</span> : null}{active && <span className="lh-label">进行中</span>}</div><p>{when(match.createdAt)}<span> · </span>{match.modules?.join('、') || match.settings?.modules?.join('、') || '行测练习'}</p></div><div className="lh-match-score"><strong>{pct(accuracy)}</strong><span>{completed} / {total} 题已完成</span></div><button className="button ghost small" disabled={busy} onClick={() => active && !publicView ? onResume?.(match.id) : onReview?.(match.id)}>{active && !publicView ? '继续做题' : '查看记录'}<ChevronRight size={14} /></button></article>;
    })}</div> : <Empty icon={History} title={filter === 'all' ? '第一份学习记录，等你来写' : '这个分类暂时没有记录'} text={publicView ? '考生完成题目后，真实的进度与成绩会展示在这里。' : '选择几个感兴趣的模块，先从 5 道题开始也很好。'} />}
    {!compact && page?.hasMore && <div className="lh-pagination"><p>已加载 {matches.length} / {page.total} 条记录，分类筛选当前已加载的记录。</p><button className="button ghost small" disabled={page.loading} onClick={onLoadMore}>{page.loading ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={15} />}加载更多记录</button></div>}
    {!compact && !page && filtered.length > limit && <button className="button ghost small lh-load-more" onClick={() => setLimit(value => value + 12)}>再看 12 条记录<ChevronDown size={15} /></button>}
  </>;
}

export function PracticeSetup({ catalog, profile = {}, busy, error, onStart, onAvailability, initial = {} }) {
  const allModules = catalog?.bank?.modules || [];
  const [mode, setMode] = useState(initial.mode || 'practice'), [demo, setDemo] = useState(false);
  const [modules, setModules] = useState(initial.modules || allModules.map(module => module.name));
  const [count, setCount] = useState(initial.count || 10), [source, setSource] = useState('all'), [images, setImages] = useState('mixed'), [scope, setScope] = useState(initial.scope || 'all');
  const [availability, setAvailability] = useState(null), [checking, setChecking] = useState(false), [availabilityError, setAvailabilityError] = useState(''), [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const availabilityRef = useRef(onAvailability); availabilityRef.current = onAvailability;
  const provider = catalog?.providers?.[mode], canImages = mode === 'practice' || demo || provider?.vision;
  useEffect(() => { if (!canImages) setImages('text'); }, [canImages]);
  useEffect(() => {
    if (!availabilityRef.current || !modules.length) { setAvailability(null); setChecking(false); return; }
    let active = true; setChecking(true); setAvailability(null); setAvailabilityError('');
    const timer = setTimeout(async () => { try { const next = await availabilityRef.current({ mode, modules, source, images, scope }); if (active) setAvailability(next); } catch { if (active) setAvailabilityError('暂时无法预览题量，可直接尝试组卷。'); } finally { if (active) setChecking(false); } }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [mode, modules.join('|'), source, images, scope, availabilityAttempt, catalog?.resourceVersion]);
  const toggleModule = name => setModules(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const valid = modules.length > 0 && Number.isInteger(count) && count >= 1 && count <= 100 && (mode === 'practice' || demo || provider?.ready) && !checking && (availability == null || count <= availability.count);
  return <div className="lh-practice"><div className="lh-page-heading"><div><span className="lh-kicker">MAKE TODAY COUNT</span><h1>今天，练一点什么？</h1><p>按自己的节奏组一张卷子。每次提交后看解析，随时离开，下次接着做。</p></div><Chestnut size={74} /></div>
    <section className="lh-panel lh-setup"><PanelHeading title="选择练习方式" /><div className="lh-mode-grid">{[['practice', BookOpen, '自主练习', '专心做题，即交即看解析'], ['llm', Sparkles, '与小栗对战', '同时作答，比正确率与用时'], ['jev', Zap, 'JEV 决策模型', '提交后，看看模型如何选择']].map(([id, Icon, title, text]) => <button key={id} className={`lh-mode-card ${mode === id ? 'selected' : ''}`} onClick={() => setMode(id)} aria-pressed={mode === id}><span><Icon size={22} />{mode === id && <CircleCheck size={16} />}</span><strong>{title}</strong><p>{text}</p>{id !== 'practice' && <small>{catalog?.providers?.[id]?.ready ? '已连接' : '待接入，可体验演示'}</small>}</button>)}</div>
      {mode !== 'practice' && <div className="lh-demo-row"><p>{mode === 'llm' ? '小栗会独立解题；你提交前，它会把答案悄悄藏好。' : 'JEV 会在你提交后独立决策。'}{mode === 'jev' && canImages && images !== 'text' ? ' 含图题使用视觉助手转写。' : ''}</p><label className="toggle-label"><span>演示模式</span><button type="button" role="switch" className={`switch ${demo ? 'on' : ''}`} aria-label="演示模式" aria-checked={demo} onClick={() => setDemo(!demo)}><span /></button></label></div>}
      {mode !== 'practice' && demo && <div className="inline-notice demo-notice"><CircleHelp size={16} />演示只体验流程，不调用真实模型，也不计入学习统计。</div>}
      <div className="lh-setup-section"><div className="field-heading"><h3>选择模块</h3><button className="text-button" onClick={() => setModules(modules.length === allModules.length ? [] : allModules.map(module => module.name))}>{modules.length === allModules.length ? '取消全选' : '选择全部'}</button></div><div className="module-chips">{allModules.map(module => <button key={module.name} className={`module-chip ${modules.includes(module.name) ? 'selected' : ''}`} aria-pressed={modules.includes(module.name)} onClick={() => toggleModule(module.name)}>{modules.includes(module.name) ? <Check size={15} /> : <Plus size={15} />}{module.name}<span>{nf.format(module.count)}</span></button>)}</div>{!modules.length && <p className="lh-field-hint">至少选一个模块，就可以开始组卷。</p>}</div>
      <div className="lh-setup-fields"><div className="field lh-count-field"><label htmlFor="study-count">本次题量 <span>1—100 道</span></label><div className="count-selector">{[5, 10, 20, 30].map(value => <button key={value} className={count === value ? 'selected' : ''} onClick={() => setCount(value)}>{value}</button>)}<input id="study-count" aria-label="自定义题量" min="1" max="100" type="number" value={count} onChange={event => setCount(event.target.value === '' ? '' : Number(event.target.value))} /></div></div><div className="field"><label htmlFor="study-pool">从哪里出题</label><select id="study-pool" value={scope} onChange={event => setScope(event.target.value)}><option value="all">全部题库</option><option value="smart">智能组卷（按弱项）</option><option value="unseen">只做未练过的题</option><option value="wrong">从错题本重练</option><option value="bookmarked">从收藏夹重练</option></select></div><div className="field"><label htmlFor="study-source">题目来源</label><select id="study-source" value={source} onChange={event => setSource(event.target.value)}><option value="all">真题 + 模拟题</option><option value="real">历年真题</option><option value="mock">模拟题</option></select></div><div className="field"><label htmlFor="study-images">图文类型</label><select id="study-images" value={images} onChange={event => setImages(event.target.value)}><option value="mixed" disabled={!canImages}>文字与图片混合</option><option value="text">纯文字题</option><option value="visual" disabled={!canImages}>只做图片题</option></select></div></div>
      <div className={`lh-availability ${availability && availability.count < count ? 'insufficient' : ''}`} role="status">{checking ? <><LoaderCircle size={14} className="spin" />正在统计符合条件的题目…</> : availability ? <><BookOpen size={14} /><span>当前条件可出 <strong>{nf.format(availability.count)}</strong> 道题{availability.count < count ? '，请减少题量或放宽筛选。' : '，每张试卷内不重复。'}</span>{availability.count > 0 && availability.count < count && <button className="text-button" onClick={() => setCount(Math.min(100, availability.count))}>改为 {Math.min(100, availability.count)} 题</button>}</> : availabilityError ? <><span>{availabilityError}</span><button className="text-button" onClick={() => setAvailabilityAttempt(value => value + 1)}>重试统计</button></> : null}</div>
      <div className="lh-setup-bottom"><div><strong>{modules.length ? `${modules.length} 个模块 · ${count || 0} 道题` : '还没有选择模块'}</strong><p>{scope === 'smart' ? '优先重做错题、补练弱项模块，再搭配新题；同一份卷子内尽量覆盖不同知识点。' : scope === 'unseen' ? '避开已经做过的题，多见一点新题型。' : scope === 'wrong' ? '重做错题，看看这次是否真的掌握。' : scope === 'bookmarked' ? '从你收藏的好题里，抽一份专属练习。' : '随机抽题，模块均衡；提交答案后自动保存进度。'}</p></div><button className="button primary" disabled={busy || !valid} onClick={() => onStart({ mode, demo: mode !== 'practice' && demo, modules, count, source, images, scope, name: profile.nickname || '' })}>{busy ? <><LoaderCircle className="spin" size={18} />正在组卷</> : <>{mode === 'practice' ? '开始练习' : demo ? '开始演示对战' : '开始对战'}<ArrowRight size={19} /></>}</button></div>{error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
    </section><div className="lh-small-tip"><ShieldCheck size={16} /><span>参考答案来自题库，可能存在瑕疵。遇到疑问可以收藏、记笔记，再一起核对。</span></div>
  </div>;
}

function Notebook({ type, items = [], catalog, onStart, onBookmark, onMaster, busy, page, onLoadMore, onFilter, onImage }) {
  const [module, setModule] = useState('all'), [search, setSearch] = useState(''), [showMastered, setShowMastered] = useState(false), [limit, setLimit] = useState(10);
  const wrong = type === 'wrong';
  const onFilterRef = useRef(onFilter); onFilterRef.current = onFilter;
  useEffect(() => { if (!onFilterRef.current) return; const timer = setTimeout(() => onFilterRef.current({ module: module === 'all' ? '' : module, search: search.trim(), includeMastered: showMastered }), 300); return () => clearTimeout(timer); }, [module, search, showMastered]);
  const filtered = onFilter ? items : items.filter(item => { const question = item.question || item; return (module === 'all' || question.module === module) && (!wrong || showMastered || !item.mastered) && (!search.trim() || plain(question.stemHtml).includes(search.trim()) || question.module?.includes(search.trim())); });
  const retry = questionIds => onStart({ mode: 'practice', demo: false, modules: module === 'all' ? (catalog?.bank?.modules || []).map(item => item.name) : [module], count: Math.min(questionIds.length, 20), source: 'all', images: 'mixed', scope: 'all', questionIds: questionIds.slice(0, 20) });
  return <><div className="lh-page-heading"><div><span className="lh-kicker">{wrong ? 'MAKE MISTAKES USEFUL' : 'KEEP THE GOOD QUESTIONS'}</span><h1>{wrong ? '错过的题，再认识一次。' : '好题，值得再看一遍。'}</h1><p>{wrong ? '错题自动归档。重练、看解析、标记掌握，把薄弱处一点点补上。' : '做题时点亮收藏，这里就是你的专属题库。'}</p></div><button className="button primary" disabled={busy || !filtered.length} onClick={() => retry(filtered.map(item => item.question?.id || item.questionId || item.id))}><RefreshCw size={17} />{filtered.length > 20 ? '重练前 20 题' : `重练这 ${filtered.length} 题`}</button></div>
    <section className="lh-panel"><div className="lh-notebook-filters"><div className="lh-search"><Search size={17} /><input aria-label="搜索题目" maxLength={100} placeholder="搜索题目或笔记关键词" value={search} onChange={event => { setSearch(event.target.value); setLimit(10); }} /></div><select aria-label="筛选题目模块" value={module} onChange={event => { setModule(event.target.value); setLimit(10); }}><option value="all">全部模块</option>{catalog?.bank?.modules?.map(item => <option key={item.name}>{item.name}</option>)}</select>{wrong && <label className="lh-checkbox"><input type="checkbox" checked={showMastered} onChange={event => setShowMastered(event.target.checked)} />包括已掌握</label>}</div>
      <div className="lh-list-count">{page?.total != null ? `共 ${page.total} 道 · 已加载 ${items.length} 道` : `共 ${filtered.length} 道${wrong ? '错题' : '收藏题'}`}{page?.hasMore && !onFilter && ' · 筛选仅针对已加载题目'}</div>
      {filtered.length ? <div className="lh-notebook">{filtered.slice(0, page ? filtered.length : limit).map(item => {
        const question = item.question || item, id = question.id || item.questionId, reveal = item.reveal || item;
        return <article className="lh-notebook-item" key={id}><div className="lh-question-meta"><span>{question.module}</span>{question.submodule && <span>{question.submodule}</span>}{question.hasImages && <span><ImageIcon size={13} />图片题</span>}{item.mastered && <span className="lh-mastered"><Check size={13} />已掌握</span>}<time>{when(item.lastAnsweredAt || item.lastAttemptAt || item.updatedAt || item.createdAt)}</time></div><details><summary><span>{plain(question.stemHtml) || '图片题：展开查看完整题目'}</span><ChevronDown size={17} /></summary><div className="lh-question-detail" onClick={event => { if (event.target.tagName === 'IMG') onImage?.(event.target.src); }}><div className="rich-text" dangerouslySetInnerHTML={{ __html: clean(question.materialHtml) }} /><div className="rich-text" dangerouslySetInnerHTML={{ __html: clean(question.stemHtml) }} /><div className="lh-review-options">{question.options?.map(option => <div className={option.label === reveal.correctAnswer ? 'correct' : ''} key={option.label}><strong>{option.label}</strong><div className="rich-text" dangerouslySetInnerHTML={{ __html: clean(option.html) }} /></div>)}</div>{reveal.correctAnswer && <div className="lh-review-answer"><strong>参考答案 {reveal.correctAnswer}</strong>{item.lastChoice && <span>上次选择 {item.lastChoice}</span>}<div className="rich-text" dangerouslySetInnerHTML={{ __html: clean(reveal.analysisHtml) }} /></div>}{item.note && <div className="lh-note"><strong>我的笔记</strong><p>{item.note}</p></div>}</div></details><div className="lh-notebook-actions"><span>{wrong && (item.wrongCount || item.attempts - (item.correct || 0)) ? `累计答错 ${item.wrongCount || item.attempts - (item.correct || 0)} 次` : item.attempts ? `练习过 ${item.attempts} 次` : '随时回来复习'}</span><button className="text-button" disabled={busy} onClick={() => retry([id])}><RefreshCw size={14} />重做此题</button>{wrong ? <button className="text-button" disabled={busy} onClick={() => onMaster?.(id, !item.mastered)}><CircleCheck size={14} />{item.mastered ? '还需巩固' : '标记掌握'}</button> : <button className="text-button" disabled={busy} onClick={() => onBookmark?.(id, false)}><Bookmark size={14} />取消收藏</button>}</div></article>;
      })}</div> : <Empty icon={wrong ? BookOpen : Bookmark} title={search || module !== 'all' ? '没有找到符合条件的题目' : wrong ? '错题本现在很清爽' : '收藏夹，等你的第一道好题'} text={search || module !== 'all' ? '试试其他关键词，或切回全部模块。' : wrong ? '每次正式练习的错题都会自动保存。别怕做错，复盘才是进步的起点。' : '在做题页面点击“收藏题目”，随时回来复习。'} />}
      {page?.hasMore && <div className="lh-pagination"><p>还有更多题目可以复习。</p><button className="button ghost small" disabled={page.loading} onClick={onLoadMore}>{page.loading ? <LoaderCircle size={15} className="spin" /> : <ChevronDown size={15} />}加载更多题目</button></div>}
      {!page && filtered.length > limit && <button className="button ghost small lh-load-more" onClick={() => setLimit(value => value + 10)}>再看 10 道题<ChevronDown size={15} /></button>}
    </section></>;
}

const KB_MODULES = ['政治理论', '常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

function KbUploadDialog({ library, onClose, onUploaded }) {
  const ref = useRef(null);
  const [format, setFormat] = useState('markdown'), [title, setTitle] = useState(''), [content, setContent] = useState(''), [imageData, setImageData] = useState(''), [fileBase64, setFileBase64] = useState('');
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  const pickFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      if (file.size > 20 * 1024 * 1024) { setError('PDF 不能超过 20 MiB。'); return; }
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      setFormat('pdf'); setFileBase64(dataUrl.split(',')[1] || ''); setImageData(''); setContent('');
      setTitle(title.trim() || file.name.replace(/\.[^.]+$/, ''));
      return;
    }
    if (/\.docx$/i.test(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      if (file.size > 20 * 1024 * 1024) { setError('Word 文件不能超过 20 MiB。'); return; }
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
      setFormat('docx'); setFileBase64(dataUrl.split(',')[1] || ''); setImageData(''); setContent('');
      setTitle(title.trim() || file.name.replace(/\.[^.]+$/, ''));
      return;
    }
    if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)) {
      if (file.size > 6 * 1024 * 1024) { setError('图片不能超过 6 MiB，换张小一点的试试？'); return; }
      try {
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取文件失败')); reader.readAsDataURL(file); });
        setFormat('image'); setImageData(dataUrl); setContent('');
        setTitle(title.trim() || file.name.replace(/\.[^.]+$/, ''));
      } catch { setError('文件读取失败，再试一次？'); }
      return;
    }
    if (file.size > 512 * 1024) { setError('文本文件不能超过 512 KiB。'); return; }
    try {
      const text = await file.text();
      setFormat(/\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'text');
      setImageData(''); setFileBase64(''); setContent(text);
      setTitle(title.trim() || file.name.replace(/\.[^.]+$/, ''));
    } catch { setError('文件读取失败，再试一次？'); }
  };
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved('');
    try {
      const body = format === 'image' ? { title: title.trim(), format: 'image', image: imageData }
        : format === 'pdf' || format === 'docx' ? { title: title.trim(), format, fileBase64 }
        : { title: title.trim(), format, content };
      const result = await api(`/api/kb/libraries/${library.id}/documents`, { method: 'POST', body });
      const message = result.duplicate ? '这份资料已经在库里啦，直接复用了原文档。' : format === 'image' ? '收好啦！等 AI 转写成文字就能参与出题。' : `收好啦！小栗把它切成了 ${result.document.chunks.length} 个片段。`;
      onUploaded(message);
      onClose();
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const ready = title.trim() && (format === 'image' ? imageData : format === 'pdf' || format === 'docx' ? fileBase64 : content.trim());
  return <dialog className="lh-login lh-kb-dialog" ref={ref} onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <button className="icon-button lh-login-close" aria-label="关闭" onClick={onClose} disabled={busy}><X size={20} /></button>
    <span className="lh-kicker">ADD MATERIALS</span>
    <h1>给《{library.name}》添点新资料</h1>
    <p>选个文件或直接粘贴，小栗会帮你切好片段，AI 出题就有据可依啦。</p>
    <form onSubmit={submit}>
      <div className="field"><label htmlFor="kb-format">资料类型</label><select id="kb-format" value={format} onChange={event => { setFormat(event.target.value); if (event.target.value === 'image') setContent(''); else { setImageData(''); setFileBase64(''); } }}><option value="markdown">Markdown 讲义</option><option value="text">纯文本资料</option><option value="pdf">PDF 文档</option><option value="docx">Word 文档</option><option value="image">手写 / 拍照资料</option></select><small>{format === 'image' ? '拍下手写笔记或纸质资料，AI 会先转写成文字。' : format === 'pdf' ? '支持文字版 PDF，≤ 20 MiB；扫描版暂无法提取文字。' : format === 'docx' ? '支持 .docx 文件，≤ 20 MiB。' : 'Markdown 的标题会作为片段的小节锚点。'}</small></div>
      <div className="field"><label htmlFor="kb-title">资料标题</label><input id="kb-title" maxLength={100} placeholder="给这份资料起个名字吧" value={title} onChange={event => setTitle(event.target.value)} required /></div>
      <div className="field"><label>从本地导入</label><div className="kb-file-row"><label className="button ghost small kb-file-button">选择文件<input className="kb-file-input" type="file" accept=".md,.markdown,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp" onChange={pickFile} /></label><span className="kb-file-name">{format === 'image' ? (imageData ? '图片已就绪，可以直接收录～' : 'PNG / JPEG / WebP，≤ 6 MiB') : format === 'pdf' ? (fileBase64 ? 'PDF 已就绪，可以直接收录～' : '文字版 PDF，≤ 20 MiB') : format === 'docx' ? (fileBase64 ? 'Word 已就绪，可以直接收录～' : '.docx，≤ 20 MiB') : '.md / .txt，≤ 512 KiB'}</span></div></div>
      {format !== 'image' && <div className="field"><label htmlFor="kb-content">内容 <span>≤ 512 KiB</span></label><textarea id="kb-content" rows={8} placeholder="粘贴讲义、教材章节、复习资料或笔记文字……也可以直接从上方选择文件" value={content} onChange={event => setContent(event.target.value)} required /></div>}
      <button className="button primary full" type="submit" disabled={busy || !ready}>{busy ? <><LoaderCircle size={18} className="spin" />正在收录</> : <><Plus size={17} />收进知识库</>}</button>
      {saved && <p className="lh-saved" role="status"><CircleCheck size={15} />{saved}</p>}
      {error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
    </form>
  </dialog>;
}

function KnowledgeBrowse() {
  const [scope, setScope] = useState('mine'), [libraries, setLibraries] = useState(null), [detail, setDetail] = useState(null), [preview, setPreview] = useState(null), [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false), [form, setForm] = useState({ name: '', description: '', visibility: 'private' });
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [error, setError] = useState('');
  const load = async (target = scope) => {
    try { setLibraries(await api(`/api/kb/libraries?scope=${target}`)); } catch (issue) { setError(issue.message); }
  };
  useEffect(() => { setDetail(null); setPreview(null); load(scope); }, [scope]);
  const openLibrary = async id => {
    setError(''); setPreview(null); setSaved('');
    try { setDetail(await api(`/api/kb/libraries/${id}`)); } catch (issue) { setError(issue.message); }
  };
  const removeDoc = async docId => {
    setBusy(true); try { await api(`/api/kb/libraries/${detail.library.id}/documents/${docId}`, { method: 'DELETE' }); if (preview?.id === docId) setPreview(null); setDetail(await api(`/api/kb/libraries/${detail.library.id}`)); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const removeLibrary = async id => {
    setBusy(true); try { await api(`/api/kb/libraries/${id}`, { method: 'DELETE' }); setDetail(null); await load(); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const toggleVisibility = async library => {
    setBusy(true); try { await api(`/api/kb/libraries/${library.id}`, { method: 'PATCH', body: { visibility: library.visibility === 'public' ? 'private' : 'public' } }); await load(); if (detail?.library?.id === library.id) await openLibrary(library.id); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const download = async library => {
    setError(''); try { downloadJson(`${library.name}.json`, await api(`/api/kb/libraries/${library.id}/export`)); } catch (issue) { setError(issue.message); }
  };
  const create = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/kb/libraries', { method: 'POST', body: form }); setCreating(false); setForm({ name: '', description: '', visibility: 'private' }); await load(); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const items = libraries?.items || [], docItems = detail?.items || [];
  return <><div className="lh-page-heading"><div><span className="lh-kicker">KNOWLEDGE BASE</span><h1>知识库</h1><p>把讲义、教材、手写笔记都搬进来。公开的库，朋友还能直接下载～</p></div>{!detail && !creating && <button className="button primary small" onClick={() => setCreating(true)}><Plus size={15} />新建资料库</button>}</div>
    {creating && <form className="lh-panel lh-profile-form lh-kb-form" onSubmit={create}>
      <div className="field"><label htmlFor="kb-lib-name">资料库名称</label><input id="kb-lib-name" maxLength={40} placeholder="例如：数量关系讲义库" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required /><small>一个库放一类资料，AI 出题时取材更准。</small></div>
      <div className="field"><label htmlFor="kb-lib-desc">简介 <span>选填</span></label><input id="kb-lib-desc" maxLength={200} placeholder="这个库收录了什么" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
      <div className="field"><label htmlFor="kb-lib-vis">可见性</label><select id="kb-lib-vis" value={form.visibility} onChange={event => setForm({ ...form, visibility: event.target.value })}><option value="private">私有 · 只给自己看</option><option value="public">公开 · 朋友可以下载</option></select></div>
      <div className="lh-profile-save"><button className="button primary" type="submit" disabled={busy || !form.name.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}创建资料库</button><button className="button ghost" type="button" onClick={() => setCreating(false)}>先不建了</button></div>
    </form>}
    {detail ? <>
      <section className="lh-panel">
        <PanelHeading kicker={`${detail.library.visibility === 'public' ? 'PUBLIC' : 'PRIVATE'} LIBRARY`} title={detail.library.name}>
          <div className="lh-kb-head-actions"><button className="button primary small" onClick={() => setUploading(true)}><Plus size={15} />收录资料</button><button className="text-button" onClick={() => { setDetail(null); setPreview(null); }}><ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />返回列表</button></div>
        </PanelHeading>
        {detail.library.description && <p className="lh-kb-lib-desc">{detail.library.description}</p>}
        {saved && <p className="lh-saved" role="status"><CircleCheck size={15} />{saved}</p>}
        {docItems.length ? <div className="lh-kb-docs">{docItems.map(item => <article className="lh-kb-doc" key={item.id}>
          <div className="lh-kb-doc-head"><strong>{item.title}</strong><span>{item.format === 'markdown' ? 'Markdown' : item.format === 'image' ? '图片资料' : item.format === 'pdf' ? 'PDF 文档' : item.format === 'docx' ? 'Word 文档' : '纯文本'}</span>{item.format === 'image' ? <span className="lh-label warm">待 AI 转写</span> : <span>{item.chunkCount} 片段</span>}<span>{nf.format(item.size)} 字节</span><time>{when(item.uploadedAt)}</time></div>
          <p>{item.preview}……</p>
          <div className="lh-notebook-actions">{item.format !== 'image' && <button className="text-button" onClick={async () => { try { setPreview(await api(`/api/kb/libraries/${detail.library.id}/documents/${item.id}`)); } catch (issue) { setError(issue.message); } }}><Eye size={14} />查看切片</button>}<button className="text-button" disabled={busy} onClick={() => removeDoc(item.id)}><Trash2 size={14} />删除</button></div>
        </article>)}</div> : <Empty icon={FileText} title="这个库还空着呢～" text="点右上角「收录资料」，把第一份讲义或笔记请进来。" />}
        {preview && <div className="lh-kb-chunks"><h3>《{preview.title}》的 {preview.chunks.length} 个片段</h3>{preview.chunks.slice(0, 20).map(chunk => <div className="lh-kb-chunk" key={chunk.index}><small>#{chunk.index + 1} · {chunk.anchor}</small><p>{chunk.text}</p></div>)}{preview.chunks.length > 20 && <p className="lh-kb-more">其余 {preview.chunks.length - 20} 个片段省略未展示。</p>}</div>}
      </section>
    </> : <section className="lh-panel">
      <div className="kb-tabs">{[['mine', '我的资料库'], ['shared', '共享资料库']].map(([value, label]) => <button key={value} className={scope === value ? 'active' : ''} onClick={() => setScope(value)}>{label}</button>)}</div>
      {items.length ? <div className="kb-cards">{items.map(library => <article className="kb-card" key={library.id}>
        <div className="kb-card-head"><strong>{library.name}</strong><span className={library.visibility === 'public' ? 'kb-badge public' : 'kb-badge'}>{library.visibility === 'public' ? '公开' : '私有'}</span></div>
        <p>{library.description || '还没写简介，先空着啦。'}</p>
        <div className="kb-card-meta"><span>{library.documentCount} 份文档</span></div>
        <div className="kb-card-actions"><button className="button ghost small" onClick={() => openLibrary(library.id)}>打开</button><button className="text-button" disabled={busy} onClick={() => download(library)}>下载</button>{library.mine && <button className="text-button" disabled={busy} onClick={() => toggleVisibility(library)}>{library.visibility === 'public' ? '设为私有' : '公开分享'}</button>}{library.mine && <button className="text-button" disabled={busy} onClick={() => removeLibrary(library.id)}><Trash2 size={13} />删除</button>}</div>
      </article>)}</div> : <Empty icon={FileText} title={scope === 'mine' ? '还没有资料库' : '还没有可下载的共享库'} text={scope === 'mine' ? '先建一个库，给讲义和笔记安个家。' : '把库设为公开后，这里就会出现可以下载的资料库。'} onAction={scope === 'mine' ? () => setCreating(true) : undefined} action={scope === 'mine' ? '新建资料库' : undefined} />}
    </section>}
    {uploading && detail && <KbUploadDialog library={detail.library} onClose={() => setUploading(false)} onUploaded={message => { setSaved(message); openLibrary(detail.library.id); }} />}
    {error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}</>;
}

function AiPractice() {
  const [description, setDescription] = useState(''), [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [errorCode, setErrorCode] = useState('');
  const [session, setSession] = useState(null), [choice, setChoice] = useState(null), [revealed, setRevealed] = useState(false);
  const generate = async (query, n) => (await api('/api/kb/generate', { method: 'POST', body: { query, count: n } })).drafts;
  const start = async event => {
    event.preventDefault(); setBusy(true); setError(''); setErrorCode('');
    try {
      const questions = await generate(description.trim(), Number(count));
      setSession({ query: description.trim(), questions, index: 0, answers: {}, swapped: 0 });
      setChoice(null); setRevealed(false);
    } catch (issue) { setError(issue.message); setErrorCode(issue.code || ''); } finally { setBusy(false); }
  };
  const answer = label => {
    if (revealed || !session) return;
    const current = session.questions[session.index];
    setChoice(label); setRevealed(true);
    setSession(session => ({ ...session, answers: { ...session.answers, [current.id]: label } }));
  };
  const next = () => { setChoice(null); setRevealed(false); setSession(session => ({ ...session, index: session.index + 1 })); };
  const swap = async () => {
    const current = session.questions[session.index];
    setBusy(true); setError('');
    try {
      const fresh = await generate(session.query, 1);
      api(`/api/drafts/${current.id}/swap`, { method: 'POST', body: {} }).catch(() => {});
      setSession(session => ({ ...session, questions: session.questions.map((question, index) => index === session.index ? fresh[0] : question), swapped: session.swapped + 1 }));
      setChoice(null); setRevealed(false);
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  if (!session) return <><div className="lh-page-heading"><div><span className="lh-kicker">AI QUESTIONS FROM YOUR LIBRARY</span><h1>说一句想练什么，小栗去知识库里找资料。</h1><p>不限考公还是考研：用一句话描述想练的主题，小栗先检索知识库里最相关的片段（RAG），再照着片段出题、立刻开始作答。觉得题目不好？做题时随时「换一题」。</p></div></div>
    <form className="lh-panel lh-profile-form lh-kb-form" onSubmit={start}>
      <div className="field"><label htmlFor="ai-topic">你想练点什么？</label><textarea id="ai-topic" rows={3} maxLength={100} placeholder="例如：我想写点行程问题的题目／根据这份考研单词表出几道词义辨析" value={description} onChange={event => setDescription(event.target.value)} required /><small>出题严格基于知识库片段，所以先把资料收录进来，主题写得越具体越准。</small></div>
      <div className="field"><label>题量</label><div className="kb-formats" role="radiogroup" aria-label="题量">{[3, 5, 10].map(value => <button key={value} type="button" className={`kb-format-chip ${Number(count) === value ? 'selected' : ''}`} aria-pressed={Number(count) === value} onClick={() => setCount(value)}>{value} 道</button>)}</div></div>
      <div className="lh-profile-save"><button className="button primary" type="submit" disabled={busy || !description.trim()}>{busy ? <><LoaderCircle className="spin" size={17} />正在检索并命题</> : <><Sparkles size={17} />生成题目，马上开始</>}</button></div>
      {errorCode === 'llm_not_configured' ? <p className="lh-error" role="alert"><CircleX size={16} />{error} 到「学习设置 → AI 模型设置」里配好就能出题。</p> : error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
    </form></>;
  const current = session.questions[session.index];
  const finished = session.index >= session.questions.length;
  const correctCount = session.questions.filter(question => session.answers[question.id] === question.answer).length;
  if (finished) return <><div className="lh-page-heading"><div><span className="lh-kicker">PRACTICE COMPLETE</span><h1>这一组练完啦！</h1><p>主题「{session.query}」· 答对 {correctCount} / {session.questions.length} 题 · 换过 {session.swapped} 题</p></div></div>
    <section className="lh-panel"><div className="lh-kb-docs">{session.questions.map((question, index) => <article className="kb-draft" key={question.id}>
      <div className="lh-kb-doc-head"><span className="kb-badge">第 {index + 1} 题</span>{question.knowledgePoints.map(point => <span className="kb-badge soft" key={point}>{point}</span>)}{session.answers[question.id] === question.answer ? <span className="kb-badge public">答对</span> : <span className="kb-badge warm">答错或跳过</span>}</div>
      <p className="kb-draft-stem">{question.stem}</p>
      <div className="lh-review-options">{Object.entries(question.options).map(([label, text]) => <div key={label} className={label === question.answer ? 'correct' : ''}><strong>{label}</strong><span>{text}</span></div>)}</div>
      <p className="kb-draft-analysis"><strong>解析</strong>{question.analysis}</p>
    </article>)}</div>
      <div className="lh-profile-save" style={{ marginTop: 10 }}><button className="button primary" onClick={start} disabled={busy || !description.trim()}>再来一组（同主题）</button><button className="button ghost" onClick={() => setSession(null)}>换个主题</button></div>
    </section></>;
  return <><div className="lh-page-heading"><div><span className="lh-kicker">AI PRACTICE · {session.index + 1}/{session.questions.length}</span><h1>主题「{session.query}」</h1><p>点击选项即可作答；答完自动公布答案与解析。觉得题目不合适，随时换一题。</p></div></div>
    <section className="lh-panel">
      {current.knowledgePoints.length > 0 && <div className="kb-card-meta" style={{ marginBottom: 6 }}>{current.knowledgePoints.map(point => <span className="kb-badge soft" key={point} style={{ marginRight: 6 }}>{point}</span>)}</div>}
      <p className="kb-draft-stem">{current.stem}</p>
      <div className="kb-options">{Object.entries(current.options).map(([label, text]) => <button key={label} type="button" disabled={revealed}
        className={`kb-option ${revealed && label === current.answer ? 'correct' : ''} ${revealed && choice === label && label !== current.answer ? 'wrong' : ''}`}
        onClick={() => answer(label)}><strong>{label}</strong><span>{text}</span></button>)}</div>
      {revealed && <div className="lh-kb-chunk"><small>{choice === current.answer ? '答对啦，继续保持！' : `正确答案是 ${current.answer}。`}</small><p><strong>解析：</strong>{current.analysis}</p></div>}
      <div className="lh-notebook-actions" style={{ marginTop: 10 }}>
        <button className="text-button" disabled={busy} onClick={swap}><RefreshCw size={14} />此题不好，换一题</button>
        <button className="button primary small" disabled={!revealed} onClick={next}>{session.index + 1 >= session.questions.length ? '看结果' : '下一题'}<ArrowRight size={14} /></button>
      </div>
      {busy && <p role="status" style={{ fontSize: 12, color: '#8a9678' }}><LoaderCircle size={14} className="spin" style={{ verticalAlign: '-2px' }} /> 小栗正在换题……</p>}
      {error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
    </section></>;
}

function AiConfigPanel() {
  const [masked, setMasked] = useState(null), [form, setForm] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(''), [testLine, setTestLine] = useState(''), [error, setError] = useState('');
  useEffect(() => { (async () => {
    try {
      const info = await api('/api/ai/config');
      setMasked(info); setForm({ baseUrl: info.baseUrl || '', apiKey: '', model: info.model || '' });
    } catch (issue) { setError(issue.message); }
  })(); }, []);
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(''); setTestLine('');
    try { setMasked(await api('/api/ai/config', { method: 'PUT', body: { baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model } })); setForm(state => ({ ...state, apiKey: '' })); setSaved('已保存，立即生效'); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError(''); setTestLine(''); setSaved('');
    try { const result = await api('/api/ai/config/test', { method: 'POST', body: { baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, model: form.model } }); setTestLine(`连接成功，${result.latencyMs} ms，模型回复：${result.reply}`); } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const presets = masked?.presets || {};
  return <section className="lh-panel"><PanelHeading kicker="AI MODEL" title="AI 模型设置" />
    <p className="lh-kb-lib-desc">配好一次，知识库出题、陪练复盘就用这套模型。密钥保存在服务器，不会回显明文。</p>
    <form className="lh-profile-form lh-kb-form" onSubmit={save}>
      <div className="field"><label htmlFor="ai-preset">快速预设</label><select id="ai-preset" value={form.preset || 'custom'} onChange={event => { const preset = presets[event.target.value]; setForm(state => ({ ...state, preset: event.target.value, baseUrl: preset?.baseUrl || state.baseUrl, model: preset?.model || state.model })); }}><option value="custom">自定义（OpenAI 兼容）</option>{Object.entries(presets).filter(([key]) => key !== 'custom').map(([key, preset]) => <option key={key} value={key}>{key}</option>)}</select><small>选预设自动填地址和模型名，再填你自己的 API Key。</small></div>
      <div className="field"><label htmlFor="ai-baseurl">Base URL</label><input id="ai-baseurl" placeholder="https://api.deepseek.com/v1" value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} required /><small>OpenAI 兼容接口地址，留空则使用服务器环境变量里的默认模型。</small></div>
      <div className="field"><label htmlFor="ai-key">API Key</label><input id="ai-key" type="password" placeholder={masked?.hasKey ? `已保存（尾号 ${masked.keyTail}），留空表示不修改` : 'sk-…'} value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} /><small>{masked?.source === 'custom' ? '当前使用界面保存的密钥。' : '当前使用服务器环境变量中的密钥（如有）。'}</small></div>
      <div className="field"><label htmlFor="ai-model">模型名称</label><input id="ai-model" placeholder="deepseek-chat / qwen-plus / …" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></div>
      <div className="lh-profile-save"><button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存设置</button><button className="button ghost" type="button" disabled={busy || !form.baseUrl} onClick={test}>测试连接</button>{saved && <span role="status"><CircleCheck size={16} />{saved}</span>}</div>
      {testLine && <p className="lh-saved" role="status"><CircleCheck size={15} />{testLine}</p>}
      {error && <p className="lh-error" role="alert"><CircleX size={16} />{error}</p>}
    </form></section>;
}

function ProfileSettings({ profile, onSave, busy }) {
  const [nickname, setNickname] = useState(profile.nickname || ''), [dailyGoal, setDailyGoal] = useState(profile.dailyGoal || 20), [examDate, setExamDate] = useState(profile.examDate || ''), [saved, setSaved] = useState(false), [error, setError] = useState('');
  return <><div className="lh-page-heading"><div><span className="lh-kicker">YOUR OWN PACE</span><h1>把节奏，调成适合自己的。</h1><p>一个做得到的小目标，比一个遥远的大目标更有力量。</p></div></div><form className="lh-panel lh-profile-form" onSubmit={async event => { event.preventDefault(); setSaved(false); setError(''); try { await onSave({ nickname: nickname.trim(), dailyGoal: Number(dailyGoal), examDate: examDate || '' }); setSaved(true); } catch (error) { setError(error.message); } }}><div className="field"><label htmlFor="profile-name">公开昵称</label><input id="profile-name" maxLength={24} placeholder="给自己取个选手名" value={nickname} onChange={event => { setNickname(event.target.value); setSaved(false); }} required /><small>你的学习记录会以这个名字展示给来监督的朋友。</small></div><div className="field"><label htmlFor="profile-goal">每日目标 <span>道题</span></label><input id="profile-goal" type="number" min="1" max="500" value={dailyGoal} onChange={event => { setDailyGoal(event.target.value); setSaved(false); }} required /><small>建议从一个容易坚持的题量开始，之后随时调整。</small></div><div className="field"><label htmlFor="profile-exam">考试日期 <span>选填</span></label><input id="profile-exam" type="date" value={examDate} onChange={event => { setExamDate(event.target.value); setSaved(false); }} /><small>填好后，学习概览会显示距离考试还有多少天。</small></div><div className="lh-profile-save"><button className="button primary" type="submit" disabled={busy || !nickname.trim()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存设置</button>{saved && <span role="status"><CircleCheck size={16} />已保存，按自己的节奏来</span>}</div>{error && <p className="lh-error" role="alert">{error}</p>}</form></>;
}

export default function LearningHub({ learner, data = {}, catalog, loading = false, busy = false, error, onLogin, onLogout, onStart, onResume, onReview, onBookmark, onMaster, onSaveProfile, onRefresh, onImage, onLoadMore, onNotebookFilter, onAvailability, initialView = 'overview' }) {
  const loggedIn = Boolean(learner), [view, setView] = useState(loggedIn ? initialView : 'public'), [setupInitial, setSetupInitial] = useState({}), [setupKey, setSetupKey] = useState(0), [cheer, setCheer] = useState(0), [showAllActive, setShowAllActive] = useState(false);
  const profile = data.profile || learner?.profile || learner || {}, stats = data.summary || data.stats || {};
  const nickname = profile.nickname || '备考同学', history = data.history || data.recent || data.matches || [], active = data.active || history.filter(match => match.status === 'active');
  const today = stats.todayAnswered ?? stats.today?.completed ?? stats.today?.count ?? stats.todayCount ?? stats.todayCompleted ?? 0, total = stats.answered ?? stats.completed ?? stats.totalAnswered ?? stats.total ?? 0;
  const accuracy = stats.accuracy ?? stats.humanAccuracy ?? null, streak = stats.streak ?? stats.streakDays ?? 0, goal = profile.dailyGoal || 20, percent = Math.min(100, Math.round(today / goal * 100));
  const wrong = data.wrong || data.wrongQuestions || [], bookmarks = data.bookmarks || data.bookmarked || [];
  const [now] = useState(() => Date.now()), examDays = stats.daysToExam ?? (profile.examDate ? Math.ceil((new Date(`${profile.examDate}T00:00:00+08:00`).getTime() - now) / 86400000) : null);
  const publicView = !loggedIn || view === 'public';
  const navigate = next => { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const practice = initial => { setSetupInitial(initial || {}); setSetupKey(key => key + 1); navigate('practice'); };
  useEffect(() => { if (!loggedIn) setView('public'); else setView(initialView); }, [loggedIn, initialView]);
  const menu = loggedIn ? [['overview', LayoutDashboard], ['practice', Play], ['wrong', BookOpen], ['bookmarks', Bookmark], ['knowledge', FileText], ['drafts', Sparkles], ['history', History], ['public', Eye]] : [['public', Eye], ['history', History]];
  const cheers = [today >= goal ? '今天的目标完成啦！给自己一个小小的鼓掌，想再练几题，我还在。' : `不用一下子变得很厉害。我们先把今天的 ${goal} 道题，认真做完。`, '遇到不会的题也没关系。收藏起来，写下一点发现，下次你会更有把握。', '我是小栗，你的陪练搭子。答题时我也会认真想，交卷以后再和你聊解法。'];
  return <div className="learning-app"><header className="lh-header"><div><button className="lh-brand" onClick={() => navigate(loggedIn ? 'overview' : 'public')}><span><GraduationCap size={23} /></span><div>栗知自习室<small>ONE QUESTION, ONE STEP.</small></div></button><div className="lh-header-actions"><span className="lh-public-label"><Eye size={14} />{loggedIn ? '学习记录对朋友公开' : '游客监督 · 无需登录'}</span>{loggedIn ? <><button className="lh-user" onClick={() => navigate('settings')} aria-label="打开学习设置"><span>{nickname.slice(0, 1)}</span><strong>{nickname}</strong><Settings2 size={15} /></button><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={onLogout}><LogOut size={17} /></button></> : <button className="button primary small" onClick={onLogin}><LockKeyhole size={14} />考生登录</button>}</div></div></header>
    <div className="lh-shell"><aside className="lh-sidebar"><span className="lh-nav-label">{loggedIn ? '我的自习室' : '一起见证进步'}</span><nav aria-label="学习中心导航">{menu.map(([key, Icon]) => <button key={key} className={view === key ? 'active' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => key === 'practice' ? practice() : navigate(key)}><Icon size={18} /><span>{labels[key]}</span>{key === 'wrong' && (data.counts?.wrong ?? wrong.filter(item => !item.mastered).length) > 0 && <small>{data.counts?.wrong ?? wrong.filter(item => !item.mastered).length}</small>}{key === 'bookmarks' && (data.counts?.bookmarked ?? bookmarks.length) > 0 && <small>{data.counts?.bookmarked ?? bookmarks.length}</small>}</button>)}</nav><div className="lh-sidebar-bottom"><Chestnut size={48} /><p>把题一道道做完，<br />把日子一点点过好。</p><span>小栗一直在这里</span></div>{loggedIn && <button className={`lh-settings-link ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={16} />学习设置</button>}</aside>
      <main className="lh-main" id="learning-main">{error && view !== 'practice' && <div className="lh-error lh-error-banner" role="alert"><CircleX size={17} /><span>{error}</span>{onRefresh && <button className="text-button" onClick={onRefresh}>重试</button>}</div>}{loading && <div className="lh-loading" role="status"><LoaderCircle size={17} className="spin" />正在更新学习记录…</div>}
        {(view === 'overview' || view === 'public') && <><section className={`lh-welcome ${publicView ? 'public' : ''}`}><div className="lh-welcome-copy"><span className="lh-kicker">{publicView ? 'A LITTLE SUPPORT GOES A LONG WAY' : 'A FRESH START, EVERY DAY'}</span><h1>{publicView ? `${nickname}的备考日常` : `你好，${nickname}。`}<br /><span>{publicView ? '每一步进步，都有人见证。' : '今天也一起，往前一点。'}</span></h1><p>{publicView ? '这里公开展示真实的学习进度与做题记录。来看看最近的努力，也给认真备考的朋友一点支持。' : '不必和昨天的自己较劲。专注眼前这道题，小栗陪你慢慢积累。'}</p><div className="lh-welcome-actions">{publicView ? <span className="lh-open-note"><ShieldCheck size={15} />只读监督页 · 无需登录</span> : <button className="button primary" onClick={() => practice({ count: 10 })}>开始今日练习<ArrowRight size={18} /></button>}{examDays != null && examDays >= 0 && <span className="lh-exam"><CalendarDays size={15} />{examDays === 0 ? '今天考试，加油！' : <>距考试 <strong>{examDays}</strong> 天</>}</span>}</div></div><div className="lh-goal-card"><div className="lh-goal-ring" style={{ '--goal': `${percent}%` }}><div><Target size={18} /><strong>{today}<span> / {goal}</span></strong><small>今日完成</small></div></div><p>{today >= goal ? '今日目标达成，真棒！' : `再做 ${Math.max(0, goal - today)} 题，点亮今天`}</p></div></section>
          <div className="lh-stat-grid">{[[BookOpen, '累计完成', nf.format(total), '题，都是练过的积累'], [Target, '总正确率', pct(accuracy), '正式练习与对战的实际成绩'], [Flame, '连续学习', `${streak} 天`, '学习节奏，慢慢养成'], [Clock3, '累计做题用时', duration(stats.totalStudyMs ?? stats.totalMs ?? stats.studyMs ?? stats.totalHumanMs), '只统计已提交题目的用时']].map(([Icon, title, value, subtitle]) => <section className="lh-stat" key={title}><div><span>{title}</span><Icon size={17} /></div><strong>{value}</strong><p>{subtitle}</p></section>)}</div>
          {!publicView && active.length > 0 && <section className="lh-resume-list" aria-label="未完成的练习">{active.length > 1 && <div className="lh-resume-heading"><strong>还有 {active.length} 场练习，随时可以接着做</strong><span>已保存每一场的进度</span></div>}{(showAllActive ? active : active.slice(0, 3)).map((item, index) => <div className="lh-resume" key={item.id}><span><Play size={21} /></span><div><strong>{active.length === 1 ? '上次的练习，还在等你' : modeName(item)}{(item.demo || item.settings?.demo) && <span className="lh-label warm">演示</span>}</strong><p>{active.length === 1 ? `${modeName(item)} · ` : ''}{when(item.createdAt)} · 已完成 {item.scores?.completed ?? item.completed ?? 0} / {item.count ?? 0} 题</p></div><button className="button primary small" onClick={() => onResume(item.id)} disabled={busy} aria-label={active.length > 1 ? `继续第 ${index + 1} 场${modeName(item)}` : undefined}>继续做题<ArrowRight size={15} /></button></div>)}{active.length > 3 && <button className="text-button lh-resume-expand" aria-expanded={showAllActive} onClick={() => setShowAllActive(value => !value)}>{showAllActive ? '收起更多练习' : `还有 ${active.length - 3} 场未完成，展开全部`}<ChevronDown size={15} /></button>}</section>}
          <div className="lh-dashboard-grid"><Activity activity={data.activity || stats.activity || []} /><section className="lh-companion"><div><Chestnut size={68} /><span><strong>小栗的今日碎碎念</strong><small>你的行测陪练搭子</small></span></div><p>{cheers[cheer % cheers.length]}</p><button className="text-button" onClick={() => setCheer(value => value + 1)}><Sparkles size={14} />再听一句</button></section></div>
          {!publicView && <div className="lh-quick-grid">{[['错题回炉', '把上次卡住的地方，再想明白一点', BookOpen, () => navigate('wrong')], ['只练新题', '避开已做题，打开新的练习范围', Plus, () => practice({ scope: 'unseen', count: 10 })], ['与小栗过招', '同一道题，比比谁更准、谁更快', Trophy, () => practice({ mode: 'llm', count: 5 })]].map(([title, text, Icon, action]) => <button key={title} className="lh-quick" onClick={action}><Icon size={21} /><span><strong>{title}</strong><small>{text}</small></span><ArrowUpRight size={17} /></button>)}</div>}
          <div className="lh-dashboard-bottom"><ModuleOverview modules={data.modules || stats.modules || []} loggedIn={!publicView} onPractice={name => practice({ modules: [name], count: 10 })} /><section className="lh-panel"><PanelHeading kicker="YOUR EFFORT, RECORDED" title="最近的学习记录"><button className="text-button" onClick={() => navigate('history')}>全部记录<ArrowUpRight size={14} /></button></PanelHeading><MatchList matches={history} compact publicView={publicView} onReview={onReview} onResume={onResume} busy={busy} /></section></div>
        </>}
        {view === 'practice' && loggedIn && <PracticeSetup key={setupKey} initial={setupInitial} catalog={catalog} profile={profile} busy={busy} error={error} onStart={onStart} onAvailability={onAvailability} />}
        {view === 'knowledge' && loggedIn && <KnowledgeBrowse />}
        {view === 'drafts' && loggedIn && <AiPractice />}
        {(view === 'wrong' || view === 'bookmarks') && loggedIn && <Notebook key={view} type={view} items={view === 'wrong' ? wrong : bookmarks} catalog={catalog} onStart={onStart} onBookmark={onBookmark} onMaster={onMaster} busy={busy} page={data.pages?.[view]} onLoadMore={() => onLoadMore?.(view)} onFilter={onNotebookFilter ? filters => onNotebookFilter(view, filters) : undefined} onImage={onImage} />}
        {view === 'history' && <><div className="lh-page-heading"><div><span className="lh-kicker">EVERY EFFORT COUNTS</span><h1>{loggedIn ? '你的努力，有迹可循。' : `${nickname}的学习记录`}</h1><p>{loggedIn ? '从一次练习到下一次，回看答案、复盘错题，也看见自己的进步。' : '看看每次练习的真实成绩。游客可以查看已提交的题目与作答结果。'}</p></div>{onRefresh && <button className="button ghost small" onClick={onRefresh} disabled={loading}><RefreshCw size={15} />刷新记录</button>}</div><section className="lh-panel"><MatchList matches={history} onReview={onReview} onResume={onResume} publicView={!loggedIn} busy={busy} page={data.pages?.history} onLoadMore={() => onLoadMore?.('history')} /></section></>}
        {view === 'settings' && loggedIn && <><ProfileSettings profile={profile} onSave={onSaveProfile} busy={busy} /><AiConfigPanel /></>}
        <footer className="lh-footer"><span>栗知自习室 <span>·</span> 每一道题，都算数。</span><span>题库参考答案判分 · 演示不计入学习统计</span></footer>
      </main>
    </div>
  </div>;
}
