import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, CircleCheck, CircleX, Eye, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import RagSettings from './RagSettings.jsx';

const providers = {
  llm: { name: '通用 LLM', description: '用于人机对战、小栗陪练与知识库出题。开启图片能力后，可直接作答带图题。' },
  jev: { name: 'JEV 决策模型', description: '用于 JEV 模式的结构化决策。带图题可交由视觉助手先转写。' },
  vision: { name: 'JEV 视觉助手', description: '将题图转写成文字，供 JEV 决策模型使用。这里的配置与通用 LLM 独立维护。' },
  embedding: { name: 'Embedding 检索', description: '理解资料和问题的语义，与关键词检索一起为知识库出题寻找依据。请使用提供向量接口的模型。' },
};
const numbers = { timeout: ['请求超时（毫秒）', 1000, 600000], maxTokens: ['解题输出上限', 64, 131072], toolMaxTokens: ['选项提交输出上限', 64, 131072],
  imageTimeout: ['带图题超时（毫秒）', 1000, 600000], imageMaxTokens: ['带图题解题输出上限', 64, 131072], imageToolMaxTokens: ['带图题选项输出上限', 64, 131072], maxRetryTokens: ['手动重试输出上限', 64, 131072],
  batchSize: ['每批资料段数', 1, 64], dimensions: ['向量维度（0 为模型默认）', 0, 8192], minSimilarity: ['最低语义相关度', -1, 1, 'any'] };

export default function ModelSettings() {
  const [selected, setSelected] = useState('llm'), [data, setData] = useState(null), [forms, setForms] = useState({}), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState(''), [showKey, setShowKey] = useState(false);
  const receive = result => { setData(result); setForms(Object.fromEntries(Object.entries(result.providers).map(([key, config]) => [key, { ...config, apiKey: '', clearKey: false, preset: 'custom' }]))); };
  const load = async () => { setLoading(true); setError(''); try { receive(await api('/api/ai/config')); } catch (issue) { setError(issue.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const form = forms[selected], masked = data?.providers[selected];
  const change = patch => { setForms(current => ({ ...current, [selected]: { ...current[selected], ...patch } })); setError(''); setMessage(''); };
  const action = async (event, testing = false) => {
    event?.preventDefault(); if (busy) return; setBusy(testing ? 'test' : 'save'); setError(''); setMessage('');
    try {
      const { hasKey, keyTail, preset, ...settings } = form;
      const result = await api(testing ? '/api/ai/config/test' : '/api/ai/config', { method: testing ? 'POST' : 'PUT', body: { ...settings, apiKey: form.apiKey || undefined, provider: selected, revision: data.revision }, timeoutMs: 30000 });
      if (testing) setMessage(`连接成功 · ${result.latencyMs} ms · ${result.reply}`);
      else { receive(result); setShowKey(false); setMessage('已保存。新请求使用此配置，正在运行的模型请求继续完成。'); }
    } catch (issue) { setError(issue.message); } finally { setBusy(''); }
  };
  return <section className="lh-panel kh-model-panel">
    <div className="kh-segment ad-model-tabs" role="group" aria-label="模型类型">{Object.entries(providers).map(([id, provider]) => <button key={id} type="button" aria-pressed={selected === id} disabled={Boolean(busy)} onClick={() => { setSelected(id); setError(''); setMessage(''); setShowKey(false); }}>{provider.name}</button>)}</div>
    <div className="kh-model-heading"><div><span className="lh-kicker">YOUR AI STUDY PARTNER</span><h2>{providers[selected].name}</h2></div>{masked && <span className={`kh-label${masked.enabled && masked.hasKey ? '' : ' warm'}`}><span className="kh-status-dot" />{!masked.enabled ? '已停用' : masked.hasKey ? '已配置密钥' : '待配置'}</span>}</div><p className="kh-model-description">{providers[selected].description}</p>
    {loading ? <div className="kh-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取配置…</div> : !data ? <div className="kh-notice error" role="alert"><CircleX size={16} /><span>{error}</span><button className="text-button" onClick={load}>重新加载<RefreshCw size={13} /></button></div> : <form className="kh-form" onSubmit={event => action(event)}>
      <div className="ad-model-switches"><label><input type="checkbox" checked={form.enabled} disabled={Boolean(busy)} onChange={event => change({ enabled: event.target.checked })} />启用此模型</label>{selected === 'llm' && <label><input type="checkbox" checked={form.vision} disabled={Boolean(busy)} onChange={event => change({ vision: event.target.checked })} />支持图片输入</label>}</div>
      {['llm', 'vision'].includes(selected) && <div className="field"><label htmlFor="ai-preset">服务预设</label><select id="ai-preset" value={form.preset} disabled={Boolean(busy)} onChange={event => { const value = event.target.value, preset = data.presets[value]; change({ preset: value, ...(value !== 'custom' ? { baseUrl: preset.baseUrl, model: preset.model } : {}) }); }}><option value="custom">自定义 · OpenAI 兼容服务</option><option value="deepseek">DeepSeek</option><option value="qwen">通义千问</option><option value="moonshot">Moonshot</option></select></div>}
      <div className="field"><label htmlFor="ai-baseurl">服务地址 <span>Base URL</span></label><input id="ai-baseurl" type="url" autoComplete="off" spellCheck="false" placeholder="https://api.example.com/v1" value={form.baseUrl} onChange={event => change({ baseUrl: event.target.value, preset: 'custom' })} disabled={Boolean(busy)} /></div>
      <div className="kh-model-fields"><div className="field"><label htmlFor="ai-key">API Key</label><div className="kh-key-input"><input id="ai-key" type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck="false" placeholder={masked.hasKey ? `已保存 ····${masked.keyTail}` : '输入 API Key'} value={form.apiKey} onChange={event => change({ apiKey: event.target.value, clearKey: false })} disabled={Boolean(busy)} /><button type="button" className="icon-button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}><Eye size={16} /></button></div><small>留空保留现有密钥。更换服务地址时需填写新密钥。</small>{masked.hasKey && <label className="ad-clear-key"><input type="checkbox" checked={form.clearKey} onChange={event => change({ clearKey: event.target.checked, apiKey: '' })} disabled={Boolean(busy)} />保存时清除现有密钥</label>}</div>
      <div className="field"><label htmlFor="ai-model">模型名称</label><input id="ai-model" autoComplete="off" spellCheck="false" placeholder={selected === 'jev' ? 'jev-latest' : selected === 'embedding' ? '服务商提供的向量模型标识' : '例如：deepseek-chat'} value={form.model} onChange={event => change({ model: event.target.value })} disabled={Boolean(busy)} /><small>填写服务商提供的模型标识。</small></div></div>
      <details className="ad-model-advanced"><summary>高级参数<ChevronDown size={15} /></summary><p>{selected === 'embedding' ? '维度填 0 时不发送 dimensions 参数。只有服务商支持时才设置自定义维度；相关度阈值可按试查结果调整。' : '沿用初始化时的设置即可；按模型服务商要求调整输出额度和超时。'}</p><div className="kh-model-fields">{Object.entries(numbers).filter(([key]) => Object.hasOwn(form, key)).map(([key, [label, min, max, step = 1]]) => <div className="field" key={key}><label htmlFor={`model-${key}`}>{label}</label><input id={`model-${key}`} type="number" min={min} max={max} step={step} value={form[key]} disabled={Boolean(busy)} onChange={event => change({ [key]: event.target.value === '' ? '' : Number(event.target.value) })} required /></div>)}
      {Object.hasOwn(form, 'thinking') && <div className="field"><label htmlFor="model-thinking">思考模式</label><select id="model-thinking" value={form.thinking} onChange={event => change({ thinking: event.target.value })} disabled={Boolean(busy)}><option value="">服务商默认</option><option value="enabled">开启</option><option value="disabled">关闭</option></select></div>}
      {Object.hasOwn(form, 'reasoningEffort') && <div className="field"><label htmlFor="model-reasoning">推理强度</label><select id="model-reasoning" value={form.reasoningEffort} onChange={event => change({ reasoningEffort: event.target.value })} disabled={Boolean(busy)}>{[['', '服务商默认'], ['none', '无'], ['minimal', '最少'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']].map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></div>}</div></details>
      {error && <div className="kh-notice error" role="alert"><CircleX size={16} /><span>{error}</span><button type="button" className="text-button" onClick={load} disabled={Boolean(busy)}>重新加载</button></div>}{message && <div className="kh-notice" role="status"><CircleCheck size={16} /><span>{message}</span></div>}
      <div className="kh-model-actions"><span><ShieldCheck size={14} />配置保存在数据库</span><div><button type="button" className="button ghost" disabled={Boolean(busy) || !form.baseUrl || !form.model || (!form.apiKey && (!masked.hasKey || form.clearKey))} onClick={() => action(null, true)}>{busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}测试连接</button><button className="button primary" disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存模型配置</button></div></div>
      <p className="kh-input-hint">保存后立即用于新请求。环境变量仅用于首次初始化，重启不会覆盖这里的修改。</p>
    </form>}
    {selected === 'embedding' && data && <RagSettings revision={data.revision} />}
  </section>;
}
