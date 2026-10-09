import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './bank.mjs';
import { streamCompletion } from './providers.mjs';

// Runtime-updatable AI provider settings. Environment variables remain the
// bootstrap default; values saved here override them until cleared, so the
// knowledge pipeline can be wired up without touching server config files.
// API keys are stored AES-256-GCM encrypted; the encryption key is derived
// from the server's JWT secret, so no extra deployment input is required.
export function validateAiConfig(config) {
  if (!config || typeof config !== 'object'
    || typeof config.baseUrl !== 'string' || typeof config.apiKey !== 'string' || typeof config.model !== 'string') throw new Error('AI 配置结构无效。');
  return config;
}

const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  custom: { baseUrl: '', model: '' },
};

export class AiConfigService {
  constructor(config, { storage = null, persist = true, clock = Date.now } = {}) {
    this.config = config; this.storage = storage; this.persist = persist; this.clock = clock;
    this.filename = config.aiConfigPath || path.join(path.dirname(config.runtimePath), 'ai-config.json');
    this.encryptionKey = config.jwtSecret ? crypto.createHash('sha256').update(`ai-config:${config.jwtSecret}`).digest() : null;
    this.stored = { baseUrl: '', apiKey: '', model: '' };
    if (storage) {
      const saved = (storage.aiConfig || []).find(entry => entry.id === 'platform');
      if (saved) this.stored = validateAiConfig(saved).value;
    } else if (persist && fs.existsSync(this.filename)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (saved.version !== 1 || typeof saved.value !== 'object') throw new Error('Invalid ai config state');
        this.stored = validateAiConfig({ ...this.stored, ...saved.value });
      } catch { throw new Error('AI 配置文件无法读取；为避免覆盖原配置，请先检查 ai-config.json。'); }
    }
  }
  // Stored values win when present; environment variables stay the fallback.
  effectiveLlm() {
    const base = this.config.llm || {};
    return { ...base,
      baseUrl: this.stored.baseUrl || base.baseUrl || '',
      key: this.decrypt(this.stored.apiKey) || base.key || '',
      model: this.stored.model || base.model || '' };
  }
  ready() {
    const llm = this.effectiveLlm();
    return Boolean(llm.baseUrl && llm.key && llm.model);
  }
  encrypt(plain) {
    if (!this.encryptionKey) throw new HttpError(400, '服务器缺少签名密钥，无法安全保存 API Key。', 'encryption_unavailable');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  }
  decrypt(payload) {
    if (!payload || !this.encryptionKey) return '';
    try {
      const [iv, tag, data] = payload.split('.').map(part => Buffer.from(part, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch { return ''; }
  }
  masked() {
    const llm = this.effectiveLlm();
    const key = llm.key || '';
    return { baseUrl: llm.baseUrl || '', model: llm.model || '', keyTail: key.slice(-4),
      hasKey: Boolean(key), source: this.stored.apiKey || this.stored.baseUrl || this.stored.model ? 'custom' : 'env',
      presets: PRESETS };
  }
  update(patch = {}) {
    if (typeof patch.baseUrl !== 'undefined') {
      if (typeof patch.baseUrl !== 'string' || (patch.baseUrl && !/^https?:\/\//.test(patch.baseUrl))) throw new HttpError(400, 'Base URL 须为 http(s) 地址。');
      this.stored.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof patch.model !== 'undefined') {
      if (typeof patch.model !== 'string' || (patch.model && patch.model.length > 100)) throw new HttpError(400, '模型名无效。');
      this.stored.model = patch.model.trim();
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey && !patch.apiKey.includes('…')) this.stored.apiKey = this.encrypt(patch.apiKey.trim());
    if (!this.stored.baseUrl && !this.stored.apiKey && !this.stored.model) this.stored = { baseUrl: '', apiKey: '', model: '' };
    this.save();
    return this.masked();
  }
  save() {
    if (!this.persist) return;
    if (this.storage) { this.storage.saveAiConfig({ id: 'platform', value: this.stored }); return; }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify({ version: 1, value: this.stored }), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  async test(input = {}) {
    const baseUrl = (input.baseUrl || this.effectiveLlm().baseUrl || '').replace(/\/+$/, '');
    const apiKey = input.apiKey && !input.apiKey.includes('…') ? input.apiKey : this.effectiveLlm().apiKey;
    const model = input.model || this.effectiveLlm().model || 'gpt-4o-mini';
    if (!baseUrl || !apiKey) throw new HttpError(400, '请先填写 Base URL 与 API Key。');
    const started = Date.now();
    try {
      let text = '';
      await streamCompletion({ baseUrl, apiKey, model, timeout: 20000 }, {
        messages: [{ role: 'user', content: '回复"连接成功"四个字。' }], max_tokens: 16, temperature: 0,
      }, { onText: delta => { text += delta; } });
      return { ok: true, latencyMs: Date.now() - started, reply: text.trim().slice(0, 40) || '(空回复)' };
    } catch (issue) {
      throw new HttpError(502, `连接失败：${issue.message || '请检查地址、密钥与模型名。'}`, 'ai_test_failed');
    }
  }
}
