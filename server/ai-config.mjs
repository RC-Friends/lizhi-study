import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './bank.mjs';
import { streamCompletion } from './providers.mjs';

const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  custom: { baseUrl: '', model: '' },
};
export const MODEL_DEFAULTS = {
  llm: { baseUrl: '', apiKey: '', model: '', enabled: true, vision: false, timeout: 180000, maxTokens: 8192, toolMaxTokens: 2048,
    reasoningEffort: '', thinking: '', imageMaxTokens: 32768, imageToolMaxTokens: 8192, imageTimeout: 300000, maxRetryTokens: 65536 },
  jev: { baseUrl: 'https://api.typesafe.ai/v1', apiKey: '', model: 'jev-latest', enabled: true, timeout: 45000 },
  vision: { baseUrl: '', apiKey: '', model: '', enabled: false, timeout: 180000, maxTokens: 8192, reasoningEffort: '', thinking: '' },
};
const own = (object, key) => Object.hasOwn(object, key);
function validUrl(value) {
  if (!value) return true;
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; } catch { return false; }
}
function validateProvider(provider, value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, '模型配置结构无效。');
  for (const [key, fallback] of Object.entries(MODEL_DEFAULTS[provider])) {
    if (typeof value[key] !== typeof fallback) throw new HttpError(400, `模型参数 ${key} 的类型无效。`);
    if (typeof fallback === 'number' && (!Number.isSafeInteger(value[key]) || value[key] < (key.toLowerCase().includes('timeout') ? 1000 : 64) || value[key] > (key.toLowerCase().includes('timeout') ? 600000 : 131072))) throw new HttpError(400, `模型参数 ${key} 超出允许范围。`);
  }
  if (!validUrl(value.baseUrl) || value.baseUrl.length > 2048) throw new HttpError(400, '服务地址须为不含账号、查询参数或片段的 http(s) 地址。');
  if (value.apiKey.length > 4096 || value.model.length > 100) throw new HttpError(400, '密钥或模型名称过长。');
  if (own(value, 'thinking') && !['', 'enabled', 'disabled'].includes(value.thinking)) throw new HttpError(400, '思考模式无效。');
  if (own(value, 'reasoningEffort') && !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoningEffort)) throw new HttpError(400, '推理强度无效。');
  return value;
}
export function validateAiConfig(value) {
  if (value?.version !== 2 || !value.providers || typeof value.revision !== 'string') throw new Error('模型配置结构无效。');
  for (const provider of Object.keys(MODEL_DEFAULTS)) validateProvider(provider, value.providers[provider]);
  return value;
}

// Called only when no durable model configuration exists (or once when upgrading
// the PR's old flat record). Runtime reads never merge environment defaults.
export function initialModelSettings(config, legacy = null) {
  const providers = {};
  for (const [name, defaults] of Object.entries(MODEL_DEFAULTS)) {
    const source = config[name] || {};
    providers[name] = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, key === 'apiKey' ? source.key || '' : source[key] ?? fallback]));
  }
  if (legacy) {
    for (const key of ['baseUrl', 'apiKey', 'model']) if (legacy[key]) providers.llm[key] = legacy[key];
    if (legacy.baseUrl && legacy.baseUrl !== config.llm?.baseUrl && !legacy.apiKey) providers.llm.apiKey = '';
  }
  return validateAiConfig({ version: 2, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(), providers });
}
export async function bootstrapModelSettings(client, config) {
  const row = (await client.query("SELECT payload FROM study_ai_config WHERE id='platform'")).rows[0];
  if (row?.payload?.version === 2) { validateAiConfig(row.payload); return; }
  const value = initialModelSettings(config, row?.payload);
  await client.query("INSERT INTO study_ai_config(id,payload) VALUES('platform',$1::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [JSON.stringify(value)]);
}
export function applyModelSettings(config, value) {
  validateAiConfig(value);
  const next = { ...config };
  for (const [name, settings] of Object.entries(value.providers)) {
    const { apiKey, enabled, ...parameters } = settings;
    // Preserve resource handles and paths, never any environment model values.
    next[name] = { ...parameters, enabled, key: enabled ? apiKey : '', imagesPath: config[name]?.imagesPath || config.imagesPath,
      ...(config[name]?.questionResources ? { questionResources: config[name].questionResources } : {}) };
  }
  return next;
}
export async function readModelConfig(client, config) {
  const row = (await client.query("SELECT payload FROM study_ai_config WHERE id='platform'")).rows[0];
  if (!row) throw new Error('模型配置未初始化。');
  return applyModelSettings(config, row.payload);
}

export class AiConfigService {
  constructor(config, { storage = null, persist = true } = {}) {
    this.config = config; this.storage = storage; this.persist = persist;
    this.filename = config.aiConfigPath || path.join(path.dirname(config.runtimePath), 'ai-config.json');
    let saved;
    if (storage) saved = (storage.aiConfig || []).find(entry => entry.id === 'platform')?.value;
    else if (persist && fs.existsSync(this.filename)) {
      try { const file = JSON.parse(fs.readFileSync(this.filename, 'utf8')); if (file.version !== 1 || !file.value) throw new Error(); saved = file.value; }
      catch { throw new Error('AI 配置文件无法读取；为避免覆盖原配置，请先检查 ai-config.json。'); }
    }
    this.stored = saved?.version === 2 ? validateAiConfig(saved) : initialModelSettings(config, saved);
    if (persist && !storage && saved?.version !== 2) this.save();
  }
  effectiveConfig() { return applyModelSettings(this.config, this.stored); }
  effectiveLlm() { return this.effectiveConfig().llm; }
  ready() { const llm = this.effectiveLlm(); return Boolean(llm.baseUrl && llm.key && llm.model); }
  masked() {
    const providers = Object.fromEntries(Object.entries(this.stored.providers).map(([name, value]) => {
      const { apiKey, ...visible } = value;
      return [name, { ...visible, hasKey: Boolean(apiKey), keyTail: apiKey.slice(-4) }];
    }));
    return { providers, revision: this.stored.revision, updatedAt: this.stored.updatedAt, presets: PRESETS };
  }
  patched(input = {}) {
    if (own(input, 'apiKey') && input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new HttpError(400, 'API Key 必须为字符串。');
    const provider = input.provider || 'llm';
    if (!own(MODEL_DEFAULTS, provider)) throw new HttpError(400, '模型类型无效。');
    if (input.revision && input.revision !== this.stored.revision) throw new HttpError(409, '配置已在其他页面修改，请重新加载后再保存。', 'config_conflict');
    const current = this.stored.providers[provider], next = { ...current };
    for (const key of Object.keys(MODEL_DEFAULTS[provider])) {
      if (key === 'apiKey' || !own(input, key)) continue;
      next[key] = typeof input[key] === 'string' ? input[key].trim() : input[key];
    }
    if (typeof next.baseUrl === 'string') next.baseUrl = next.baseUrl.replace(/\/+$/, '');
    if (typeof input.apiKey === 'string' && input.apiKey.trim() && !input.apiKey.includes('…')) next.apiKey = input.apiKey.trim();
    if (input.clearKey === true) next.apiKey = '';
    if (next.baseUrl !== current.baseUrl && current.apiKey && !input.apiKey?.trim() && !input.clearKey) throw new HttpError(400, '更换服务地址时，请同时填写新服务的 API Key，或选择清除旧密钥。', 'provider_key_required');
    validateProvider(provider, next);
    return { provider, next };
  }
  update(input = {}) {
    const { provider, next } = this.patched(input);
    this.stored = { version: 2, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(), providers: { ...this.stored.providers, [provider]: next } };
    this.save(); return this.masked();
  }
  save() {
    if (this.storage) { this.storage.saveAiConfig({ id: 'platform', value: this.stored }); return; }
    if (!this.persist) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify({ version: 1, value: this.stored }), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  async test(input = {}) {
    const { provider, next } = this.patched(input);
    if (!next.baseUrl || !next.apiKey || !next.model) throw new HttpError(400, '请先填写服务地址、API Key 与模型名称。');
    const started = Date.now();
    try {
      if (provider === 'jev') {
        const response = await fetch(`${next.baseUrl}/systemone`, { method: 'POST', headers: { Authorization: `Bearer ${next.apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20000), body: JSON.stringify({ model: next.model, state: { prompt: '选择 A 以确认连接。' }, questions: { answer: { type: 'choice', instructions: '选择 A。', criteria: { A: '连接成功', B: '其他' } } } }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`连接失败（HTTP ${response.status}）。`); }
        await response.body?.cancel(); return { ok: true, latencyMs: Date.now() - started, reply: 'JEV 接口已响应' };
      }
      let text = '';
      await streamCompletion({ ...next, key: next.apiKey, timeout: 20000 }, { messages: [{ role: 'user', content: '回复“连接成功”四个字。' }], max_tokens: 32, temperature: 0 },
        { signal: AbortSignal.timeout(20000), onText: delta => { text += delta; } });
      return { ok: true, latencyMs: Date.now() - started, reply: text.trim().slice(0, 60) || '接口已响应' };
    } catch { throw new HttpError(502, '连接测试失败，请检查服务地址、密钥和模型名称。', 'ai_test_failed'); }
  }
}
