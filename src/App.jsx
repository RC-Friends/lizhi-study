import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import { ArrowUpRight, ArrowRight, ArrowLeft, Check, ChevronDown, ChevronRight, X, Zap,
  Cpu, UserRound, BrainCircuit, ScanLine, Sparkles, CircleHelp, Trophy, Flag, LockKeyhole,
  CircleCheck, CircleX, LoaderCircle, RotateCcw, Image as ImageIcon, Download, Plus,
  Clock3, Eye, Layers3, Radio, ShieldCheck, FileText, ExternalLink, WifiOff, Target,
  ChartNoAxesCombined, MousePointer2, ListChecks, CircleDot, ScanEye } from 'lucide-react';
import { api, savedMatch, saveMatch, savedSession, saveSession, streamMatch } from './api';
import LearningHub, { LearnerLogin } from './LearningHub';
import { CoachPanel, QuestionNotebook } from './StudyTools';
import AdminPanel from './AdminPanel.jsx';

const nf = new Intl.NumberFormat('zh-CN');
const formatPercent = value => value === null || value === undefined ? '—' : `${value}%`;
const shortModel = model => model?.replace(/^deepseek\//, '') || 'AI';
const seconds = milliseconds => `${(Math.max(0, milliseconds || 0) / 1000).toFixed(1)}s`;
const textOnly = html => { const div = document.createElement('div'); div.innerHTML = DOMPurify.sanitize(html || ''); return div.textContent || '图形题'; };

function Brand({ onClick }) {
  return <button className="brand" onClick={onClick} aria-label="返回学习中心"><span className="brand-symbol"><ScanLine size={22} strokeWidth={2.4} /></span><span>栗知自习室<span className="brand-en">ONE QUESTION, ONE STEP</span></span><span className="beta">BETA</span></button>;
}
function Rich({ html, className = '', onImage }) {
  const clean = DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true, mathMl: true }, FORBID_TAGS: ['style', 'iframe', 'svg'], FORBID_ATTR: ['style', 'srcset'] });
  return <div className={`rich-text ${className}`} onClick={event => {
    const target = event.target;
    if (target.tagName === 'IMG' && onImage) onImage(target.src);
  }} dangerouslySetInnerHTML={{ __html: clean }} />;
}
function Explanation({ text, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    // Model prose always enters as text. KaTeX alone owns this isolated subtree.
    element.textContent = text || '';
    renderMathInElement(element, { delimiters: [{ left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false }], throwOnError: false, strict: 'ignore', trust: false,
      maxExpand: 200, maxSize: 20, errorCallback: () => {} });
  }, [text]);
  return <span ref={ref} className={`math-prose ${className}`} />;
}
function Dialog({ title, children, onClose, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`dialog ${className}`} onCancel={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <div className="dialog-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>{children}
  </dialog>;
}
function Rules({ onClose }) {
  return <Dialog title="按自己的节奏，认真做每一道题" onClose={onClose}><div className="rules-list">
    <div><span>01</span><section><h3>日常练习，或与 AI 过招</h3><p>自主练习提交后立即看解析；人机对战中，每题你和多模态 LLM 同时作答。提交前，模型的说明和选择保持隐藏；AI 看不到你的选择。</p></section></div>
    <div><span>02</span><section><h3>交卷后，看模型出招</h3><p>你提交后，若 LLM 已完成就立即揭晓；否则查看解题说明的实时输出，等待工具交卷。JEV 保留提交后决策的流程。</p></section></div>
    <div><span>03</span><section><h3>比正确率，也比用时</h3><p>双方完成后展示参考答案、对错和各自用时。服务端从出题计时，到各自交卷停止；AI 用时包含请求、说明生成和工具提交。确认后才进入下一题。</p></section></div>
  </div><div className="quiet-box"><ListChecks size={18} /><p>双方正确率以<strong>同一批已揭晓的题目</strong>为分母。可以随时结束；模型失败或未完成的题不计入双方成绩。演示对战不代表模型真实能力。</p></div><button className="button primary full" onClick={onClose}>了解了，开始对决 <ArrowRight size={18} /></button></Dialog>;
}
function Header({ match, onHome, onRules, onFinish, providers, readOnly = false }) {
  return <header className="site-header"><div className="header-inner"><Brand onClick={onHome} /><nav>
    <button className={!match ? 'nav-item active' : 'nav-item'} onClick={onHome}>学习中心</button>
    <button className="nav-item" onClick={onRules}>练习规则 <ArrowUpRight size={13} /></button>
  </nav><div className="header-right">{match?.settings.demo ? <span className="status-pill demo-pill">演示对战</span> : <span className="status-pill"><i />{readOnly ? '公开学习记录' : '进度自动保存'}</span>}
    {match?.status === 'active' && <button className="button small ghost" onClick={onFinish}><Flag size={15} /> {match.settings.mode === 'practice' ? '结束练习' : '结束本场'}</button>}</div></div></header>;
}

function Lobby({ catalog, onStart, busy, error, onRules }) {
  const [mode, setMode] = useState('llm'), [demo, setDemo] = useState(false);
  const [modules, setModules] = useState(catalog.bank.modules.map(m => m.name));
  const [count, setCount] = useState(10), [source, setSource] = useState('all'), [images, setImages] = useState(catalog.providers.llm.vision ? 'mixed' : 'text');
  const [name, setName] = useState('');
  const provider = catalog.providers[mode], canUseImages = demo || provider.vision;
  useEffect(() => { if (!canUseImages) setImages('text'); }, [canUseImages]);
  const toggleModule = module => setModules(selected => selected.includes(module) ? selected.filter(m => m !== module) : [...selected, module]);
  return <main className="lobby page-width">
    <section className="hero"><div className="hero-copy"><div className="eyebrow"><span className="small-cross">+</span> HUMAN INTELLIGENCE, MEET AI.</div>
      <h1>这次，<br />谁答得<span>更准？<svg viewBox="0 0 240 16" aria-hidden="true"><path d="M3 10 C65 0 145 2 236 7" /></svg></span></h1>
      <p className="hero-description">同一张行测试卷，一位人类选手，一个 AI 对手。<br />与 LLM 同时开答，比一比谁更准、谁更快。</p>
      <div className="hero-stats"><span><strong>{nf.format(catalog.bank.total)}</strong> 道可用题目</span><span className="stat-divider" /><span><strong>6</strong> 大行测模块</span><span className="stat-divider" /><span><strong>1 v 1</strong> 独立作答</span></div>
    </div><div className="arena-art" aria-hidden="true"><div className="orbit-line one" /><div className="orbit-line two" /><div className="art-topline"><span><i /> MATCH PREVIEW</span><span>ROUND 01</span></div>
      <div className="contestant human-art"><div className="avatar-art"><UserRound size={53} strokeWidth={1.5} /></div><span className="art-label">HUMAN</span><strong>人类直觉</strong><span className="art-tag">经验 · 判断 · 灵感</span></div>
      <div className="art-vs">VS<span>THE NEXT MOVE IS YOURS</span></div>
      <div className="contestant ai-art"><div className="avatar-art"><Cpu size={53} strokeWidth={1.5} /></div><span className="art-label">ARTIFICIAL INTELLIGENCE</span><strong>模型智力</strong><span className="art-tag">理解 · 推断 · 决策</span></div>
      <div className="art-footer"><LockKeyhole size={13} /><span>同题竞技，独立提交</span><div className="mini-signal"><i /><i /><i /><i /></div></div>
    </div></section>

    <section className="setup-card"><div className="setup-title"><div><span className="section-index">01 / MATCH SETUP</span><h2>设定你的这场对决</h2></div><label className="toggle-label"><span>演示模式</span><button role="switch" aria-label="演示模式" aria-checked={demo} className={`switch ${demo ? 'on' : ''}`} onClick={() => setDemo(!demo)}><span /></button></label></div>
      <div className="opponent-grid">{['llm', 'jev'].map(id => {
        const p = catalog.providers[id], selected = mode === id, Icon = id === 'llm' ? BrainCircuit : Zap;
        return <button key={id} className={`opponent-card ${selected ? 'selected' : ''}`} onClick={() => setMode(id)} aria-pressed={selected}>
          <span className={`opponent-icon ${id}`}><Icon size={25} /></span><div className="opponent-info"><div className="opponent-name">{id === 'llm' ? '多模态 LLM' : 'JEV 决策模型'}<span className={`mini-pill ${p.ready ? 'ready' : 'pending'}`}>{p.ready ? '已接入' : '待接入'}</span></div><p>{id === 'llm' ? '看图理解 · 流式讲解 · 工具交卷' : '文本决策 · 选项概率 · 视觉辅助可选'}</p><code>{p.model}</code></div><span className="radio-circle">{selected && <span />}</span>
        </button>;
      })}</div>
      {demo && <div className="inline-notice demo-notice"><Sparkles size={17} /><span>正在体验演示流程，不调用真实模型。演示成绩不用于能力比较。</span></div>}
      {!demo && !provider.ready && <div className="inline-notice"><LockKeyhole size={17} /><span>JEV 选手尚未连接。可以开启演示模式体验，或先与多模态 LLM 对战。</span></div>}
      {mode === 'jev' && canUseImages && images !== 'text' && <div className="inline-notice"><ScanEye size={17} /><span>含图题先由视觉助手转写，再交给 JEV 决策。战报会标记“视觉辅助”。</span></div>}

      <div className="setup-divider" /><div className="field-heading"><h3>想在哪些模块交锋？</h3><button className="text-button" onClick={() => setModules(modules.length === catalog.bank.modules.length ? [] : catalog.bank.modules.map(m => m.name))}>{modules.length === catalog.bank.modules.length ? '取消全选' : '选择全部'}</button></div>
      <div className="module-chips">{catalog.bank.modules.map(module => <button key={module.name} aria-pressed={modules.includes(module.name)} onClick={() => toggleModule(module.name)} className={`module-chip ${modules.includes(module.name) ? 'selected' : ''}`}>{modules.includes(module.name) ? <Check size={15} /> : <Plus size={15} />}{module.name}<span>{nf.format(module.count)}</span></button>)}</div>
      <div className="setup-fields"><div className="field"><label>本场题量 <span>道</span></label><div className="count-selector">{[5, 10, 20, 30].map(n => <button key={n} className={count === n ? 'selected' : ''} onClick={() => setCount(n)}>{n}</button>)}<input aria-label="自定义题量" type="number" min="1" max="100" value={count} onChange={e => setCount(Number(e.target.value))} /></div></div>
        <div className="field"><label htmlFor="question-source">题目来源</label><div className="select-wrap"><select id="question-source" value={source} onChange={e => setSource(e.target.value)}><option value="all">真题 + 模拟题</option><option value="real">只做历年真题</option><option value="mock">只做模拟练习</option></select><ChevronDown size={15} /></div></div>
        <div className="field"><label htmlFor="question-images">图片题设置</label><div className="select-wrap"><select id="question-images" value={images} onChange={e => setImages(e.target.value)}><option value="text">纯文字题</option><option value="mixed" disabled={!canUseImages}>文字与图片混合</option><option value="visual" disabled={!canUseImages}>只做含图题</option></select><ChevronDown size={15} /></div></div>
        <div className="field"><label htmlFor="player-name">你的选手名 <span>选填</span></label><input id="player-name" maxLength={24} placeholder="人类选手" value={name} onChange={e => setName(e.target.value)} /></div>
      </div>
      <div className="setup-footer"><div><div className="ready-line"><CircleCheck size={17} /><span>随机组卷，同一题目，独立作答</span></div><p>参考答案在双方提交后揭晓，可随时结束并查看战报。</p></div><button className="button primary start-button" disabled={busy || !modules.length || (!provider.ready && !demo) || !Number.isInteger(count) || count < 1 || count > 100} onClick={() => onStart({ mode, demo, modules, count, source, images, name })}>{busy ? <LoaderCircle className="spin" size={19} /> : <><span>{demo ? '开始演示对战' : '开始对战'}</span><ArrowUpRight size={23} /></>}</button></div>
      {error && <p className="error-text" role="alert"><CircleX size={16} />{error}</p>}
    </section>
    <section className="how-it-works"><div><MousePointer2 size={21} /><span><strong>01. 与 LLM 同时开答</strong><small>独立选择，提交前互不干扰</small></span></div><ChevronRight size={17} /><div><Radio size={21} /><span><strong>02. 提交后揭晓</strong><small>查看模型说明与双方选择</small></span></div><ChevronRight size={17} /><div><ChartNoAxesCombined size={21} /><span><strong>03. 比准确，也比速度</strong><small>每题用时对比，整场复盘</small></span></div><button className="text-button" onClick={onRules}>完整规则 <ArrowUpRight size={15} /></button></section>
    <footer className="site-footer"><span>DUEL ARENA <span className="footer-dot">·</span> 人类与模型，各凭本事。</span><span>题库参考答案判分 · 仅用于练习与实验</span></footer>
  </main>;
}

function Scoreboard({ match }) {
  const { scores, name, model, current } = match;
  if (match.settings.mode === 'practice') return <section className="practice-scoreboard"><div><h2>{name}的自主练习</h2><p>专注解题，即交即看解析 · 进度自动保存</p></div><div><strong>{formatPercent(scores.humanAccuracy)}</strong><small>正确率</small><p>{scores.human} / {scores.completed} 题答对</p></div></section>;
  return <section className="scoreboard"><div className="score-side human-score"><span className="avatar"><UserRound size={24} /></span><div><span className="score-role">HUMAN PLAYER</span><strong>{name}</strong></div><div className="score-number"><strong>{scores.human}</strong><span>/{scores.completed} 答对</span></div></div>
    <div className="score-center"><span className="versus">VS</span><span className="live-label"><i />{current?.phase === 'revealed' ? '本题已揭晓' : '对战进行中'}</span></div>
    <div className="score-side ai-score"><div className="score-number"><strong>{scores.ai}</strong><span>/{scores.completed} 答对</span></div><div><span className="score-role">AI CHALLENGER</span><strong title={model}>{match.settings.mode === 'jev' ? 'JEV' : shortModel(model)}</strong></div><span className="avatar ai-avatar"><Cpu size={24} /></span></div>
  </section>;
}
function RoundProgress({ match }) {
  const phase = match.current.phase, step = phase === 'human' ? 0 : phase === 'revealed' ? 2 : 1;
  return <div className="round-progress"><div className="round-position"><strong>{String(match.index + 1).padStart(2, '0')}</strong><span>/ {String(match.count).padStart(2, '0')} 题</span><div className="paper-progress"><span style={{ width: `${match.scores.completed / match.count * 100}%` }} /></div></div>
    <div className="phase-steps">{(match.settings.mode === 'practice' ? ['独立作答', '提交答案', '查看解析'] : match.current.parallel ? ['同时作答', '等待交卷', '揭晓结果'] : ['你的回合', '模型作答', '揭晓结果']).map((label, index) => <React.Fragment key={label}>{index > 0 && <div className={`phase-line ${step >= index ? 'done' : ''}`} />}<span className={`phase-step ${step === index ? 'active' : ''} ${step > index ? 'done' : ''}`}><i>{step > index ? <Check size={12} /> : index + 1}</i>{label}</span></React.Fragment>)}</div></div>;
}
function useElapsed(startedAt, running, completedMs = 0) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return running ? (completedMs || 0) + Math.max(0, clock - Date.parse(startedAt || new Date().toISOString())) : completedMs || 0;
}
function TimingComparison({ round, humanLabel = '你' }) {
  const human = Math.round(round.humanMs / 100), ai = Math.round(round.aiMs / 100), incomplete = round.aiTimingIncomplete;
  return <section className="timing-comparison" aria-label="本题用时对比"><div className="timing-heading"><span><Clock3 size={15} />本题用时</span><strong>{incomplete ? 'AI 计时中断' : human === ai ? '用时相同（精确到 0.1 秒）' : `${human < ai ? humanLabel : 'AI'}快了 ${seconds(Math.abs(human - ai) * 100)}`}</strong></div>
    <div className="timing-sides"><div><UserRound size={19} /><span>{humanLabel}的用时</span><time>{seconds(round.humanMs)}</time></div><div><Cpu size={19} /><span>AI 用时</span><time>{incomplete ? '—' : seconds(round.aiMs)}</time></div></div>
    <p>{incomplete ? '服务重启导致 AI 用时记录不完整，本题不比较速度。' : `${round.parallel ? '同时开始，分别停止计时。' : '各自从开始作答到交卷计时。'}AI 用时包含请求、说明生成及工具交卷。`}{round.attempts > 1 && ` AI 累计 ${round.attempts} 次作答（含重试），不计等待重试的时间。`}</p>
  </section>;
}
function AiPanel({ match, onRetry, busy }) {
  const round = match.current, result = round.result, mode = match.settings.mode, bodyRef = useRef(null);
  useEffect(() => { const el = bodyRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight; }, [round.explanation, round.transcription]);
  const idle = round.phase === 'human', processing = round.phase === 'ai';
  const elapsed = useElapsed(round.aiAttemptStartedAt || round.aiStartedAt, processing, round.aiMs);
  const canRetry = round.canRetry ?? round.attempts < 3;
  const concealed = idle && round.parallel, sealed = concealed && round.aiStatus === 'ready';
  return <aside className={`ai-panel ${idle ? 'idle' : ''}`}><div className="ai-panel-head"><div className="ai-title"><span>{mode === 'jev' ? <Zap size={20} /> : <BrainCircuit size={21} />}</span><div><h2>{mode === 'jev' ? 'JEV 决策现场' : '小栗的解题现场'}</h2><p>{match.settings.demo ? 'DEMO · 交互演示' : shortModel(match.model)}</p></div></div><span className={`ai-status ${processing || concealed && round.aiStatus === 'running' ? 'live' : ''}`}>{processing ? <><i /> LIVE</> : sealed ? <><LockKeyhole size={12} /> 已封存</> : concealed ? round.aiStatus === 'error' ? '已中断' : <><i /> 同步作答</> : result ? <><Check size={12} /> 已交卷</> : 'STANDBY'}</span></div>
    {idle ? <div className="ai-idle"><div className="ai-orb"><div className="orb-ring" /><div className="orb-ring outer" /><Cpu size={37} strokeWidth={1.2} /><span className="orb-dot" /></div><span className="eyebrow">{concealed ? 'INDEPENDENT ANSWERS' : 'YOUR MOVE FIRST'}</span><h3>{sealed ? 'AI 已交卷，等你。' : concealed ? round.aiStatus === 'error' ? 'AI 作答暂时中断' : '你们正在同时作答。' : '先到你了。'}</h3><p>{concealed ? round.aiStatus === 'error' ? '你仍可继续作答。提交答案后，\n可以重试 AI，本题暂不计分。' : sealed ? '模型选择与解题说明已封存。\n提交你的答案后，立即揭晓。' : 'AI 已开始独立解题。\n你提交前，模型的说明与选择保持隐藏。' : '你的答案锁定后，\nAI 才会开始独立解答这道题。'}</p><div className="idle-lock"><LockKeyhole size={13} /> {concealed ? '提交前隐藏 AI 答案' : '标准答案暂未揭晓'}</div></div> : <>
      <div className="ai-stage" role="status">{processing ? <LoaderCircle size={15} className="spin" /> : round.phase === 'error' ? <CircleX size={15} /> : <CircleCheck size={15} />}<span>{round.phase === 'error' ? '作答暂时中断' : round.stage === 'explaining' && round.progress?.publicChars > 0 ? '正在流式输出公开解题说明' : round.stageLabel}</span>{processing && <time className="ai-elapsed" aria-hidden="true">{Math.floor(elapsed / 1000)}s</time>}</div>
      <div className="ai-stream-body" ref={bodyRef}>
        {mode === 'llm' && <div className="explanation-content"><div className="stream-label"><span className="tiny-spark">✦</span> 公开解题说明</div>{round.explanation ? <div className="stream-text"><Explanation text={round.explanation} />{processing && round.stage === 'explaining' && <span className="typing-cursor" />}</div> : processing && <><div className="loading-lines"><i /><i /><i /></div><div className="model-waiting"><p>{round.progress?.chunks > 0 ? `已收到模型响应，正在分析${round.question.hasImages ? '题图' : '题目'}。` : '正在等待模型响应。'}</p><span>公开解题说明生成后会实时显示。{elapsed >= 30000 && '复杂题需要更长时间，当前题尚未计分。'}</span></div></>}</div>}
        {mode === 'jev' && <><div className="jev-explainer"><Zap size={25} /><h3>用概率，给出选择。</h3><p>JEV 不生成解题文字。它直接评估题目与选项，返回结构化选择和概率。</p></div>{round.transcription && <div className="visual-transcription"><div className="stream-label"><ScanEye size={15} />视觉助手转写 <span>非 JEV 推理</span></div><p>{round.transcription}</p></div>}{processing && <div className="jev-pending"><LoaderCircle className="spin" size={19} /><span>{round.stage === 'transcribing' ? '正在读取图片信息…' : '等待 JEV 返回决策…'}</span></div>}</>}
        {result?.probabilities && <div className="probabilities"><div className="stream-label">选项概率{match.settings.demo && <span>演示数据</span>}</div>{Object.entries(result.probabilities).map(([label, value]) => <div className={`probability-row ${result.aiChoice === label ? 'chosen' : ''}`} key={label}><strong>{label}</strong><div><i style={{ width: `${value * 100}%` }} /></div><span>{(value * 100).toFixed(1)}%</span></div>)}<p className="confidence-caption">JEV 置信度 <strong>{formatPercent(Number((result.confidence * 100).toFixed(1)))}</strong></p></div>}
        {result && <div className="tool-receipt"><div><Check size={15} />{mode === 'jev' ? '结构化决策已提交' : '工具调用成功'}</div><code>submit_answer({'{'} <span>choice: &quot;{result.aiChoice}&quot;</span> {'}'})</code>{mode === 'jev' && <small>由 JEV Choice 结果接入统一判分</small>}</div>}
        {round.phase === 'error' && <div className="ai-error"><CircleX size={23} /><p>{round.error}</p><small>你的答案保持锁定；本题尚未计分。{canRetry && round.errorCode === 'output_limit' && '重试会在配置上限内增加生成额度。'}</small><button className="button light" disabled={busy || !canRetry} onClick={onRetry}><RotateCcw size={15} />{!canRetry ? '已达本题重试上限' : '重试 AI 作答'}</button></div>}
      </div>
      <div className="ai-panel-foot"><span><ShieldCheck size={14} /> 未向模型提供参考答案</span>{result ? <span>{result.aiTimingIncomplete ? '计时中断' : seconds(result.aiMs)}</span> : <span>独立作答</span>}</div>
    </>}
  </aside>;
}

function Arena({ match, onAction, busy, error, onImage, connection, onChanged }) {
  const [selected, setSelected] = useState(null);
  const round = match.current, question = round.question, result = round.result, practice = match.settings.mode === 'practice';
  const imageOptions = question.options.length === 4 && question.options.every(option => /<img\b/i.test(option.html));
  const humanElapsed = useElapsed(round.humanTimerStartedAt || round.startedAt, round.phase === 'human' && !round.paused, round.phase === 'human' ? round.humanElapsedMs || 0 : round.humanMs);
  useEffect(() => { setSelected(round.humanChoice || null); }, [match.index, round.humanChoice]);
  useEffect(() => {
    const onKey = event => {
      const active = document.activeElement;
      if (document.querySelector('dialog[open]') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName) || (active?.tagName === 'BUTTON' && !active.classList.contains('answer-option')) || busy || event.ctrlKey || event.metaKey || event.altKey) return;
      if (round.phase === 'human' && !round.paused) {
        const label = /^[1-4]$/.test(event.key) ? 'ABCD'[Number(event.key) - 1] : event.key.toUpperCase();
        if (question.options.some(option => option.label === label)) { event.preventDefault(); setSelected(label); }
        if (event.key === 'Enter' && selected) { event.preventDefault(); onAction('answer', { choice: selected, index: match.index }); }
      } else if (round.phase === 'revealed' && event.key === 'Enter') { event.preventDefault(); onAction('next', { index: match.index }); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [selected, round.phase, round.paused, match.index, busy, question, onAction]);
  return <main className="match-page page-width"><div className="match-topline"><span className="eyebrow">THE ACCURACY CHALLENGE</span><span>{match.settings.demo ? '演示试卷' : practice ? '自主练习卷' : '随机挑战卷'} <span className="muted">/</span> {match.settings.modules.length} 个模块{connection === 'reconnecting' && <span className="reconnecting"><WifiOff size={14} /> 正在恢复连接</span>}</span></div>
    <Scoreboard match={match} /><RoundProgress match={match} />
    <div className="duel-grid"><section className="question-card"><div className="question-meta"><div><span className="module-badge">{question.module}</span><span className="question-type">单项选择</span>{question.hasImages && <span className="image-badge"><ImageIcon size={13} />含图</span>}</div><span className="source-caption">{question.year} · {question.province} · {question.sourceType}</span></div>
        <div className="human-timer"><span><Clock3 size={15} />你的用时 <time>{seconds(humanElapsed)}</time></span><small>{round.paused ? '已暂停 · 计时停止' : round.phase !== 'human' ? '已交卷 · 计时停止' : round.parallel ? '与 AI 同时开始 · 独立作答' : '独立作答中'}</small></div>
        {question.materialHtml && <details className="material-panel" open><summary><FileText size={16} /><span>阅读材料</span><ChevronDown size={16} /></summary><Rich html={question.materialHtml} onImage={onImage} /></details>}
        <Rich html={question.stemHtml} className="question-stem" onImage={onImage} />
        {question.hasImages && <div className="image-hint"><ScanEye size={13} />{imageOptions ? '点选项选答案 · 点放大按钮查看题图' : '点击题干或材料中的图片可放大查看'}</div>}
        <div className={`answer-options ${imageOptions ? 'image-options' : ''}`} role="group" aria-label="选择你的答案">{question.options.map(option => {
          const chosen = selected === option.label, correct = result?.correctAnswer === option.label, wrong = result && chosen && !correct;
          return <div key={option.label} className={`answer-option-wrap ${/<img\b/i.test(option.html) ? 'has-option-image' : ''}`}><button className={`answer-option ${chosen ? 'selected' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`} onClick={() => { if (round.phase === 'human' && !round.paused) setSelected(option.label); }} aria-pressed={chosen} aria-disabled={round.phase !== 'human' || round.paused}>
            <span className="option-letter">{correct ? <Check size={19} /> : wrong ? <X size={19} /> : option.label}</span><Rich html={option.html} /><span className="option-markers">{round.phase !== 'human' && round.humanChoice === option.label && <small className="human-marker">你</small>}{result?.aiChoice === option.label && <small className="ai-marker">AI</small>}{round.phase === 'human' && chosen && <CircleCheck size={18} />}</span>
          </button>{/<img\b/i.test(option.html) && <button className="option-zoom" aria-label={`放大选项 ${option.label} 题图`} title="放大题图" onClick={event => { const img = event.currentTarget.parentElement.querySelector('.answer-option img'); if (img) onImage(img.src); }}><ScanEye size={16} /></button>}</div>;
        })}</div>
        {round.paused ? <div className="human-submit"><span>进度已保存。准备好后继续这一题。</span><button className="button primary" disabled={busy} onClick={() => onAction('resume')}>继续作答 <ArrowRight size={18} /></button></div> : round.phase === 'human' ? <div className="human-submit"><div><span><LockKeyhole size={14} />提交后锁定答案</span><small>可用 A—D 选择，Enter 提交</small></div><button className="button primary" disabled={!selected || busy} onClick={() => onAction('answer', { choice: selected, index: match.index })}>{busy ? <LoaderCircle className="spin" size={17} /> : <>{practice ? '提交答案，看解析' : round.parallel ? '提交答案，查看 AI' : '锁定答案，轮到 AI'} <ArrowRight size={18} /></>}</button></div>
          : !result && <div className="locked-answer"><LockKeyhole size={17} /><span>你已选择 <strong>{round.humanChoice}</strong>，等待 AI 独立交卷。</span></div>}
        {result && <div className="round-reveal"><div className="reveal-answer"><div><span>参考答案</span><strong>{result.correctAnswer}</strong></div><div className="verdicts"><span className={result.humanCorrect ? 'is-correct' : 'is-wrong'}>{result.humanCorrect ? <CircleCheck size={17} /> : <CircleX size={17} />}你答{result.humanCorrect ? '对' : '错'}了</span>{!practice && <span className={result.aiCorrect ? 'is-correct' : 'is-wrong'}>{result.aiCorrect ? <CircleCheck size={17} /> : <CircleX size={17} />}AI 答{result.aiCorrect ? '对' : '错'}了</span>}</div></div>
          <>{practice ? <p className="practice-timing"><Clock3 size={16} />本题用时 <strong>{seconds(result.humanMs)}</strong></p> : <TimingComparison round={result} />}</>
          <div className="next-round-bar"><div><span className="round-done"><CircleCheck size={18} /> 第 {match.index + 1} 题已完成</span><p>{result.visualAssisted ? '本题使用了视觉转写辅助 · ' : ''}{practice ? '答案和用时已保存，错题自动归档。' : '双方答案与用时已记录。'}<span>下方可查看参考解析。</span></p></div><button className="button primary" disabled={busy} onClick={() => onAction('next', { index: match.index })}>{busy ? <LoaderCircle className="spin" size={18} /> : <>{match.index + 1 === match.count ? practice ? '完成练习，查看报告' : '完成对战，查看战报' : '确认，下一题'}<ArrowRight size={18} /></>}</button></div>
          <details className="answer-analysis" open><summary>看看参考解析 <ChevronDown size={16} /></summary><Rich html={result.analysisHtml} onImage={onImage} />{result.source?.url && <a href={result.source.url} target="_blank" rel="noreferrer" className="source-link">题目来源：{result.source.title}<ExternalLink size={12} /></a>}</details>
        </div>}
      <QuestionNotebook key={question.id} questionId={question.id} revealed={Boolean(result)} onChanged={onChanged} />
        <details className="round-answer-map"><summary>答题进度 · 已完成 {match.scores.completed} / {match.count} 题</summary><div>{Array.from({ length: match.count }, (_, index) => { const previous = match.history.find(item => item.index === index); return <span key={index} className={`${index === match.index ? 'current' : ''} ${previous ? previous.humanCorrect ? 'correct' : 'wrong' : ''}`} title={previous ? `第 ${index + 1} 题：${previous.humanCorrect ? '答对' : '答错'}` : `第 ${index + 1} 题`}>{index + 1}</span>; })}</div><p>绿色答对 · 棕色答错 · 完成后可在报告逐题复盘</p></details>
      </section><div className="duel-side">{!practice && <AiPanel match={match} onRetry={() => onAction('retry', { index: match.index })} busy={busy} />}{(practice || result) && <CoachPanel key={`${match.id}:${match.index}`} matchId={match.id} index={match.index} revealed={Boolean(result)} correct={result?.humanCorrect} demo={match.settings.demo} />}</div></div>
    {error && <div className="page-error" role="alert"><CircleX size={17} />{error}</div>}
    <div className="match-bottom-note"><ShieldCheck size={14} />{practice ? '返回学习中心可保留进度并暂停计时。学习成绩公开，笔记与聊天仅自己可见。' : '双方正确率仅统计已揭晓题目。离开页面后本题继续计时，AI 独立作答。'}{match.settings.demo && '本场为演示，成绩不代表真实模型表现。'}</div>
  </main>;
}

function AccuracyChart({ history, practice = false, humanLabel = '你' }) {
  const width = 620, height = 185, left = 37, right = 12, top = 17, bottom = 30;
  const cumulative = key => { let hits = 0; return history.map((round, i) => { hits += round[key] ? 1 : 0; return hits / (i + 1) * 100; }); };
  const x = i => left + (width - left - right) * (history.length <= 1 ? .5 : i / (history.length - 1));
  const y = value => top + (height - top - bottom) * (1 - value / 100);
  const values = practice ? [cumulative('humanCorrect')] : [cumulative('humanCorrect'), cumulative('aiCorrect')];
  return <div className="accuracy-chart"><div className="chart-heading"><h3>正确率走势</h3><div><span className="legend human-legend">{humanLabel}</span>{!practice && <span className="legend ai-legend">AI</span>}</div></div>{history.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="人类与模型逐题累计正确率走势">{[0, 50, 100].map(v => <g key={v}><line x1={left} x2={width - right} y1={y(v)} y2={y(v)} className="chart-grid" /><text x={left - 9} y={y(v) + 4} textAnchor="end">{v}%</text></g>)}{values.map((series, index) => <g key={index} className={index ? 'ai-line' : 'human-line'}><polyline points={series.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />{series.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={history.length > 30 ? 2 : 3.5}><title>第 {i + 1} 题累计：{v.toFixed(1)}%</title></circle>)}</g>)}<text x={left} y={height - 5}>第 1 题</text><text x={width - right} y={height - 5} textAnchor="end">第 {history.length} 题</text></svg> : <div className="empty-chart">完成双方作答后，这里会出现正确率走势。</div>}</div>;
}

function ReviewTools({ match, round, onChanged }) {
  const [open, setOpen] = useState(false);
  return <div className="review-private-tools"><button className="text-button" onClick={() => setOpen(!open)} aria-expanded={open}><FileText size={15} />{open ? '收起笔记与陪练' : '笔记与小栗陪练'}</button>{open && <><QuestionNotebook questionId={round.question.id} revealed onChanged={onChanged} /><CoachPanel matchId={match.id} index={round.index} revealed correct={round.humanCorrect} demo={match.settings.demo} compact /></>}</div>;
}
function Report({ match, onRestart, onImage, readOnly = false, onChanged }) {
  const { scores, history, settings } = match, diff = scores.human - scores.ai, practice = settings.mode === 'practice', humanLabel = readOnly ? '考生' : '你';
  const title = readOnly ? `${match.name}的${practice ? '练习报告' : '人机对战记录'}` : practice ? scores.completed ? `又完成了 ${scores.completed} 道，认真练过就算数。` : '今天先到这里，下次继续。' : !scores.completed ? '随时回来，再战一场。' : diff > 0 ? '这局，人类领先。' : diff < 0 ? '这局，AI 略胜一筹。' : '势均力敌，下一局见。';
  const modules = settings.modules.map(module => ({ module, rounds: history.filter(r => r.question.module === module) })).filter(item => item.rounds.length);
  function download() {
    const data = { createdAt: match.createdAt, finishedAt: match.finishedAt, name: match.name, model: match.model, settings, scores, history };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `人机对决-${match.createdAt.slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className={`report-page page-width ${practice ? 'practice-report' : ''}`}><div className="report-intro"><div><span className="eyebrow"><Flag size={14} /> {settings.demo ? 'DEMO MATCH REPORT' : 'MATCH REPORT'}</span><h1>{title}</h1><p>{match.endReason === 'in_progress' ? '练习进行中，以下为已揭晓记录' : match.endReason === 'completed' ? '整张试卷已完成' : '本场已主动结束'} · {scores.completed} / {match.count} 题已完成{scores.unscoredSubmissions > 0 && ` · ${scores.unscoredSubmissions} 题未揭晓，不计分`}</p></div><div className="report-actions"><button className="button ghost" onClick={download}><Download size={17} />保存报告</button><button className="button primary" onClick={onRestart}>返回学习中心 <ArrowUpRight size={19} /></button></div></div>
    {settings.demo && <div className="inline-notice demo-notice"><Sparkles size={17} />本场为交互演示，没有调用真实模型；以下成绩不代表模型能力。</div>}
    {readOnly && <p className="reading-note"><Eye size={15} /> 公开学习记录 · 仅包含已揭晓的题目与成绩。</p>}
    {practice ? <section className="practice-result-card"><div><span>本次正确率</span><strong>{formatPercent(scores.humanAccuracy)}</strong></div><div><span>答对 / 已完成</span><strong>{scores.human} / {scores.completed}</strong></div><div><span>做题用时</span><strong>{seconds(history.reduce((total, round) => total + round.humanMs, 0))}</strong></div></section> : <section className="final-score-card"><div className={`final-contestant ${diff > 0 ? 'winner' : ''}`}><div className="final-name"><span className="avatar"><UserRound size={26} /></span><div><small>HUMAN PLAYER</small><h2>{match.name}</h2></div>{diff > 0 && <span className="winner-badge"><Trophy size={13} />本场领先</span>}</div><div className="final-percent">{scores.humanAccuracy === null ? '—' : scores.humanAccuracy}<span>{scores.humanAccuracy === null ? '' : '%'}</span></div><p><strong>{scores.human}</strong> / {scores.completed} 题答对 <span>正确率</span></p></div>
      <div className="final-vs"><span>VS</span><strong>{scores.completed ? `${Math.abs((scores.humanAccuracy || 0) - (scores.aiAccuracy || 0)).toFixed(1)}` : '—'}</strong><small>个百分点差距</small></div>
      <div className={`final-contestant ai-final ${diff < 0 ? 'winner' : ''}`}><div className="final-name"><span className="avatar ai-avatar"><Cpu size={26} /></span><div><small>AI CHALLENGER</small><h2>{settings.mode === 'jev' ? 'JEV' : '多模态 LLM'}</h2></div>{diff < 0 && <span className="winner-badge"><Trophy size={13} />本场领先</span>}</div><div className="final-percent">{scores.aiAccuracy === null ? '—' : scores.aiAccuracy}<span>{scores.aiAccuracy === null ? '' : '%'}</span></div><p><strong>{scores.ai}</strong> / {scores.completed} 题答对 <span>{shortModel(match.model)}</span></p></div></section>}
    {!practice && <div className="result-facts"><span><CircleCheck size={17} /> 双方都对 <strong>{scores.bothCorrect}</strong></span><span><UserRound size={17} /> 只有你对 <strong>{scores.humanOnly}</strong></span><span><Cpu size={17} /> 只有 AI 对 <strong>{scores.aiOnly}</strong></span><span><CircleX size={17} /> 双方都错 <strong>{scores.bothWrong}</strong></span></div>}
    <div className="report-grid"><AccuracyChart history={history} practice={practice} humanLabel={humanLabel} /><section className="module-results"><h3>各模块表现</h3>{modules.length ? modules.map(({ module, rounds }) => <div className="module-result" key={module}><div><span>{module}</span><small>{rounds.length} 题</small></div><div className="module-bars">{(practice ? ['humanCorrect'] : ['humanCorrect', 'aiCorrect']).map((key, i) => { const correct = rounds.filter(r => r[key]).length; return <div key={key} className={i ? 'ai-bar' : 'human-bar'}><span>{i ? 'AI' : humanLabel}</span><div><i style={{ width: `${correct / rounds.length * 100}%` }} /></div><strong>{correct}/{rounds.length}</strong></div>; })}</div></div>) : <p className="muted">本场尚无已揭晓题目。</p>}</section></div>
    <section className="review-section"><div className="review-heading"><div><span className="section-index">ROUND BY ROUND</span><h2>逐题复盘</h2></div><span className="muted">展开题目，看看胜负在哪里</span></div>{!history.length && <div className="empty-review"><FileText size={32} /><p>还没有可以复盘的题目。</p><button className="text-button" onClick={onRestart}>回到大厅，开始一局 <ArrowRight size={15} /></button></div>}
      {history.map((round, index) => <details className="review-item" key={index}><summary><span className="review-number">{String(index + 1).padStart(2, '0')}</span><div className="review-question"><span>{round.question.module}{round.visualAssisted && <small>视觉辅助</small>}</span><p>{textOnly(round.question.stemHtml).slice(0, 85)}</p></div><div className="review-verdict"><span className={round.humanCorrect ? 'is-correct' : 'is-wrong'}>{humanLabel} {round.humanChoice} {round.humanCorrect ? <Check size={14} /> : <X size={14} />}</span>{!practice && <span className={round.aiCorrect ? 'is-correct' : 'is-wrong'}>AI {round.aiChoice} {round.aiCorrect ? <Check size={14} /> : <X size={14} />}</span>}</div><ChevronDown size={17} /></summary><div className="review-expanded">{round.question.materialHtml && <Rich html={round.question.materialHtml} className="review-material" onImage={onImage} />}<Rich html={round.question.stemHtml} onImage={onImage} /><div className="review-options">{round.question.options.map(o => <div key={o.label}><strong>{o.label}.</strong><Rich html={o.html} onImage={onImage} /></div>)}</div><p className="review-gold">参考答案：<strong>{round.correctAnswer}</strong></p><>{practice ? <p className="practice-timing"><Clock3 size={15} />本题用时 {seconds(round.humanMs)}</p> : <TimingComparison round={round} humanLabel={humanLabel} />}</><Rich html={round.analysisHtml} onImage={onImage} />{!readOnly && <ReviewTools match={match} round={round} onChanged={onChanged} />}{round.explanation && <details className="review-explanation"><summary>查看 AI 公开解题说明 <ChevronDown size={14} /></summary><div className="review-ai-prose"><Explanation text={round.explanation} /></div></details>}</div></details>)}
    </section><p className="report-footnote">{practice ? '成绩只统计已交卷的题目；错题已自动放进错题本。一步一步来，小栗陪你积累。' : '同题、同分母，按题库参考答案判分。模型失败与未完成题不按答错计算。本场成绩仅代表这张试卷。'}</p></main>;
}

export default function App() {
  const [catalog, setCatalog] = useState(null), [learner, setLearner] = useState(null), [hub, setHub] = useState(null);
  const [match, setMatch] = useState(null), [credentials, setCredentials] = useState(null), [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(true), [hubLoading, setHubLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false), [expired, setExpired] = useState(false), [rulesOpen, setRulesOpen] = useState(false), [finishOpen, setFinishOpen] = useState(false), [image, setImage] = useState(null);
  const [connection, setConnection] = useState('connected');
  const [loginRole, setLoginRole] = useState('learner');
  const hubRequest = useRef(0), filters = useRef({ wrong: {}, bookmarks: {} }), collectionRequests = useRef({}), pendingMatch = useRef(null);
  const pages = useRef({ history: 1, wrong: 1, bookmarks: 1 }), hubRevision = useRef(null);
  const liveMatch = useRef(match); liveMatch.current = match;
  const applySnapshot = snapshot => setMatch(current => current?.id === snapshot.id && snapshot.revision >= current.revision ? snapshot : current);
  function pageMeta(response) { return { total: response.total, hasMore: response.page < response.pages, loading: false }; }
  function listUrl(kind, account, page = 1) {
    const query = new URLSearchParams({ page, pageSize: 20 });
    if (kind === 'history') return `/api/${account ? 'learning' : 'public'}/history?${query}`;
    query.set('kind', kind === 'bookmarks' ? 'bookmarked' : 'wrong');
    for (const [key, value] of Object.entries(filters.current[kind] || {})) if (value !== '' && value !== undefined) query.set(key, String(value));
    return `/api/learning/questions?${query}`;
  }
  async function refreshHub(account = learner, quiet = false) {
    if (account?.role === 'admin') { setHubLoading(false); return; }
    const request = ++hubRequest.current;
    const filterKey = JSON.stringify(filters.current);
    for (const kind of ['history', 'wrong', 'bookmarks']) collectionRequests.current[kind] = (collectionRequests.current[kind] || 0) + 1;
    if (!quiet) setHubLoading(true);
    try {
      const query = new URLSearchParams();
      for (const kind of ['wrong', 'bookmarks']) {
        const selected = filters.current[kind] || {};
        if (selected.module) query.set(`${kind}Module`, selected.module);
        if (selected.search) query.set(`${kind}Search`, selected.search);
        if (selected.includeMastered) query.set(`${kind}Mastered`, String(selected.includeMastered));
      }
      // All panels share one database snapshot and one committed revision.
      const [overview, nextCatalog] = await Promise.all([api(`/api/${account ? 'learning' : 'public'}/overview?${query}`), api('/api/catalog')]);
      const { history, wrong, bookmarks, ...dashboard } = overview;
      if (request !== hubRequest.current || filterKey !== JSON.stringify(filters.current)) return;
      setCatalog(nextCatalog);
      hubRevision.current = dashboard.dataRevision || null;
      pages.current = { history: 1, wrong: 1, bookmarks: 1 };
      setHub({ ...dashboard, history: history.items, wrong: wrong?.items || [], bookmarks: bookmarks?.items || [], pages: {
        history: pageMeta(history), ...(wrong ? { wrong: pageMeta(wrong), bookmarks: pageMeta(bookmarks) } : {}),
      } });
    } catch (e) { if (request === hubRequest.current) setError(e.message); }
    finally { if (request === hubRequest.current) setHubLoading(false); }
  }
  async function loadCollection(kind, append = false, nextFilters) {
    if (nextFilters) filters.current[kind] = nextFilters;
    const epoch = hubRequest.current;
    const request = (collectionRequests.current[kind] || 0) + 1; collectionRequests.current[kind] = request;
    const page = append ? pages.current[kind] + 1 : 1;
    setHub(current => current ? { ...current, pages: { ...current.pages, [kind]: { ...current.pages?.[kind], loading: true } } } : current);
    try {
      const response = await api(listUrl(kind, learner, page));
      if (collectionRequests.current[kind] !== request || epoch !== hubRequest.current) return;
      pages.current[kind] = page;
      setHub(current => ({ ...current, [kind]: append ? [...current[kind], ...response.items] : response.items, pages: { ...current.pages, [kind]: pageMeta(response) } }));
    } catch (e) { if (collectionRequests.current[kind] !== request || epoch !== hubRequest.current) return; setError(e.message); setHub(current => current ? { ...current, pages: { ...current.pages, [kind]: { ...current.pages?.[kind], loading: false } } } : current); }
  }
  async function openRecord(id, account = learner, push = true) {
    setBusy(true); setError('');
    try {
      const record = await api(`/api/${account ? 'learning/records' : 'public/matches'}/${encodeURIComponent(id)}`);
      setCredentials(null); setReadOnly(!account); setMatch(record);
      if (push) window.history.pushState(null, '', `#record/${record.id}`);
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function resume(id, account = learner, push = true) {
    if (!account) { pendingMatch.current = id; setLoginOpen(true); return; }
    setBusy(true); setError('');
    try {
      const saved = savedMatch(), creds = { id, ...(saved?.id === id && saved.token ? { token: saved.token } : {}) };
      let current = await api(`/api/matches/${id}`, { token: creds.token });
      if (current.status === 'active' && current.settings.mode === 'practice' && current.current?.paused) current = await api(`/api/matches/${id}/resume`, { method: 'POST', token: creds.token, body: {} });
      saveMatch(current.status === 'active' ? creds : null); setCredentials(creds); setMatch(current); setReadOnly(false);
      if (push) window.history.pushState(null, '', `#match/${id}`);
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) { setError(e.message); if (e.status === 404) saveMatch(null); }
    finally { setBusy(false); }
  }
  async function boot() {
    setLoading(true); setError('');
    try {
      setCatalog(await api('/api/catalog'));
      let account = null;
      if (savedSession()?.token) {
        try { account = await api('/api/session'); setLearner(account); }
        catch (e) { if (e.status === 401) { saveSession(null); setExpired(true); } else throw e; }
      }
      await refreshHub(account);
      if (account?.role === 'admin') return;
      if (window.location.hash.startsWith('#admin')) { setLoginRole('admin'); setLoginOpen(true); }
      const route = window.location.hash.match(/^#(record|match)\/([a-f0-9-]+)$/);
      if (route?.[1] === 'record') await openRecord(route[2], account, false);
      else if (route?.[1] === 'match') await resume(route[2], account, false);
      else if (!window.location.hash && account && savedMatch()?.id) await resume(savedMatch().id, account, false);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { boot(); }, []);
  useEffect(() => {
    const expire = () => {
      setLoginRole(savedSession()?.role === 'admin' ? 'admin' : 'learner');
      pendingMatch.current = match?.status === 'active' ? match.id : null;
      saveSession(null); setLearner(null); setCredentials(null); setMatch(null); setHub(null); setExpired(true); setLoginOpen(true); setBusy(false);
      refreshHub(null);
    };
    window.addEventListener('learner-session-expired', expire);
    return () => window.removeEventListener('learner-session-expired', expire);
  }, [match?.id]);
  useEffect(() => {
    const pop = async () => {
      if (learner?.role === 'admin') return;
      const route = window.location.hash.match(/^#(record|match)\/([a-f0-9-]+)$/);
      const outgoing = liveMatch.current;
      if (outgoing?.status === 'active' && outgoing.settings.mode === 'practice' && route?.[2] !== outgoing.id) {
        try { await api(`/api/matches/${outgoing.id}/pause`, { method: 'POST', body: {} }); }
        catch (e) { setError(e.message); }
      }
      if (route?.[1] === 'record') openRecord(route[2]);
      else if (route?.[1] === 'match') resume(route[2]);
      else { saveMatch(null); setMatch(null); setCredentials(null); refreshHub(); }
    };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [learner]);
  useEffect(() => {
    if (match || loading || learner?.role === 'admin') return;
    let stopped = false, polling = false;
    const refresh = async (force = false) => {
      if (document.hidden || polling || stopped) return;
      polling = true;
      try {
        const { dataRevision } = await api('/api/public/revision');
        if (!stopped && (force || !dataRevision || dataRevision !== hubRevision.current)) await refreshHub(learner, true);
      } catch { /* Keep the last confirmed data; explicit refresh reports errors. */ }
      finally { polling = false; }
    };
    const focus = () => refresh(true);
    const timer = setInterval(refresh, 3000); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [Boolean(match), loading, learner]);
  useEffect(() => {
    if (!credentials || !learner || match?.status !== 'active') return;
    const controller = new AbortController(); let retryTimer;
    const connect = async () => {
      try {
        await streamMatch(credentials, controller.signal, (type, data) => {
          setConnection('connected');
          if (type === 'snapshot') applySnapshot(data);
          else if (['explanation', 'transcription', 'model_progress'].includes(type)) setMatch(current => {
            if (!current || current.id !== credentials.id || current.index !== data.index || data.revision <= current.revision || !current.current) return current;
            return { ...current, revision: data.revision, current: { ...current.current,
              ...(type === 'model_progress' ? { progress: data.progress } : { [type]: (current.current[type] || '') + data.text }) } };
          });
        });
      } catch (e) { if (!controller.signal.aborted && e.status !== 401) { setConnection('reconnecting'); retryTimer = setTimeout(connect, 1800); } }
    };
    connect(); return () => { controller.abort(); clearTimeout(retryTimer); };
  }, [credentials?.id, match?.status, Boolean(learner)]);
  async function login(password) {
    setBusy(true); setError('');
    try {
      const session = await api('/api/login', { method: 'POST', body: { password, role: loginRole } });
      saveSession(session); setLearner(session); setLoginOpen(false); setExpired(false); await refreshHub(session);
      if (session.role === 'admin') { pendingMatch.current = null; setMatch(null); setCredentials(null); window.history.replaceState(null, '', '#admin'); return; }
      if (pendingMatch.current) { const id = pendingMatch.current; pendingMatch.current = null; await resume(id, session); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function home() {
    if (match?.status === 'active' && match.settings.mode === 'practice') {
      try { await api(`/api/matches/${match.id}/pause`, { method: 'POST', body: {} }); } catch (e) { setError(e.message); return; }
    }
    saveMatch(null); setMatch(null); setCredentials(null); setError(''); setReadOnly(false);
    window.history.pushState(null, '', window.location.pathname); window.scrollTo({ top: 0, behavior: 'instant' }); await refreshHub();
  }
  async function logout() {
    if (match?.status === 'active' && match.settings.mode === 'practice') await api(`/api/matches/${match.id}/pause`, { method: 'POST', body: {} }).catch(() => {});
    saveSession(null); saveMatch(null); setLearner(null); setMatch(null); setCredentials(null); setHub(null); setError('');
    window.history.replaceState(null, '', window.location.pathname); await refreshHub(null);
  }
  async function start(settings) {
    setBusy(true); setError('');
    try {
      const result = await api('/api/matches', { method: 'POST', body: settings });
      const creds = { id: result.match.id }; saveMatch(creds); setCredentials(creds); setMatch(result.match); setReadOnly(false);
      window.history.pushState(null, '', `#match/${result.match.id}`); window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function action(endpoint, body = {}) {
    if (busy || !credentials) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/matches/${credentials.id}/${endpoint}`, { method: 'POST', token: credentials.token, body }); applySnapshot(result);
      if (result.status === 'finished') saveMatch(null);
      if (endpoint === 'next' || endpoint === 'finish') window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function annotate(id, patch) {
    setBusy(true); setError('');
    try { await api(`/api/learning/questions/${id}`, { method: 'PATCH', body: patch }); await refreshHub(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <>{loading ? <div className="app-loading"><LoaderCircle size={30} className="spin" /><h2>小栗在整理自习室</h2><p>正在载入学习记录…</p></div> : !catalog ? <div className="app-loading"><WifiOff size={30} /><h2>暂时无法连接自习室</h2><p>{error}</p><button className="button primary" onClick={boot}>重新连接</button></div> : learner?.role === 'admin' ? <AdminPanel onLogout={logout} /> : !match ?
    <LearningHub key={learner ? 'learner' : 'guest'} learner={learner} data={hub || {}} catalog={catalog} loading={hubLoading} busy={busy} error={error}
      onLogin={() => { setError(''); setLoginRole('learner'); setLoginOpen(true); }} onAdminLogin={() => { setError(''); setLoginRole('admin'); setLoginOpen(true); }} onLogout={logout} onStart={start} onResume={resume} onReview={openRecord} onImage={setImage}
      onBookmark={(id, bookmarked) => annotate(id, { bookmarked })} onMaster={(id, mastered) => annotate(id, { mastered })}
      onRefresh={() => { setError(''); refreshHub(); }} onLoadMore={kind => loadCollection(kind, true)} onNotebookFilter={(kind, nextFilters) => loadCollection(kind, false, nextFilters)}
      onAvailability={settings => api('/api/learning/availability', { method: 'POST', body: settings })}
      onSaveProfile={async patch => { setBusy(true); try { const profile = await api('/api/learning/profile', { method: 'PATCH', body: patch }); await refreshHub(); return profile; } finally { setBusy(false); } }} />
    : <><Header match={match} onHome={home} onRules={() => setRulesOpen(true)} onFinish={() => setFinishOpen(true)} providers={catalog.providers} readOnly={readOnly} />
      {match.status === 'finished' ? <Report match={match} onRestart={home} onImage={setImage} readOnly={readOnly} /> : <Arena match={match} onAction={action} busy={busy} error={error} onImage={setImage} connection={connection} />}</>}
    {loginOpen && <LearnerLogin key={loginRole} role={loginRole} onLogin={login} onClose={() => { setLoginOpen(false); setError(''); }} busy={busy} error={error} expired={expired} />}
    {rulesOpen && <Rules onClose={() => setRulesOpen(false)} />}
    {finishOpen && <Dialog title={match?.settings.mode === 'practice' ? '结束这次练习？' : '结束这场对决？'} onClose={() => setFinishOpen(false)}><p className="dialog-copy">已完成的 <strong>{match?.scores.completed || 0}</strong> 道题会生成练习报告。{match?.current?.phase !== 'revealed' && '当前未揭晓的题目不计入成绩。'}如果只是暂时离开，可以直接返回学习中心保留进度。</p><div className="dialog-actions"><button className="button ghost" onClick={() => setFinishOpen(false)}>继续练习</button><button className="button primary" disabled={busy} onClick={async () => { await action('finish'); setFinishOpen(false); }}>结束并查看报告 <ArrowRight size={17} /></button></div></Dialog>}
    {image && <Dialog title="题图预览" onClose={() => setImage(null)} className="image-dialog"><div className="zoom-image"><img src={image} alt="放大的题目图片" /></div><p className="image-caption">原始题图 · 可横向滚动查看细节</p></Dialog>}
  </>;
}
