import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, MODULES } from './bank.mjs';
import { streamCompletion } from './providers.mjs';

const DRAFT_LIMITS = { count: 10, total: 200 };
const OPTION_KEYS = ['A', 'B', 'C', 'D'];

function buildPrompt(query, module, count, materials) {
  return [
    { role: 'system', content: '你是一名严谨的公考行测命题专家。严格依据用户提供的资料片段命题，不得使用资料之外的事实。只输出一个 JSON 数组，不要输出任何解释、Markdown 代码块或其他文字。' },
    { role: 'user', content: `资料片段：\n${materials}\n\n请依据以上资料，围绕「${query}」，命制 ${count} 道单选题${module ? `，属于「${module}」模块` : '，学科依据资料内容判断'}。每道题输出一个 JSON 对象，字段：\n- "stem"：题干字符串\n- "options"：对象，键为 A、B、C、D，值为选项字符串\n- "answer"：正确选项字母，必须存在于 options\n- "analysis"：解析字符串，须引用资料中的依据\n- "knowledgePoints"：知识点字符串数组\n- "source"：所依据资料片段的编号，如 "K1"\n只输出 JSON 数组。` },
  ];
}

function parseQuestions(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new HttpError(502, '模型没有按约定格式返回题目，请重试。', 'generation_format');
  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new HttpError(502, '模型没有按约定格式返回题目，请重试。', 'generation_format'); }
  if (!Array.isArray(parsed)) throw new HttpError(502, '模型没有按约定格式返回题目，请重试。', 'generation_format');
  return parsed;
}

function normalizeDraft(raw, sources) {
  if (!raw || typeof raw !== 'object') return null;
  const stem = typeof raw.stem === 'string' ? raw.stem.trim() : '';
  const options = {};
  for (const key of OPTION_KEYS) {
    const value = raw.options?.[key];
    if (typeof value !== 'string' || !value.trim()) return null;
    options[key] = value.trim();
  }
  const answer = typeof raw.answer === 'string' ? raw.answer.trim().toUpperCase() : '';
  const analysis = typeof raw.analysis === 'string' ? raw.analysis.trim() : '';
  const knowledgePoints = Array.isArray(raw.knowledgePoints) ? raw.knowledgePoints.filter(point => typeof point === 'string' && point.trim()).map(point => point.trim()).slice(0, 6) : [];
  if (stem.length < 8 || stem.length > 500 || !OPTION_KEYS.includes(answer) || !analysis) return null;
  const source = sources.includes(raw.source) ? raw.source : sources[0];
  return { stem, options, answer, analysis, knowledgePoints, source };
}

export function validateDraft(draft) {
  if (!draft || typeof draft.id !== 'string' || !draft.id || !['draft', 'confirmed', 'swapped'].includes(draft.status)
    || (draft.module !== null && !MODULES.includes(draft.module)) || typeof draft.stem !== 'string' || !draft.stem
    || typeof draft.answer !== 'string' || !OPTION_KEYS.includes(draft.answer)
    || typeof draft.options !== 'object' || draft.options === null
    || OPTION_KEYS.some(key => typeof draft.options[key] !== 'string' || !draft.options[key])
    || typeof draft.analysis !== 'string' || !draft.analysis
    || !Array.isArray(draft.knowledgePoints) || typeof draft.source !== 'object' || draft.source === null
    || !Number.isFinite(Date.parse(draft.createdAt))) throw new Error('AI 出题草稿结构无效。');
  return draft;
}

export class DraftService {
  constructor(config, { storage = null, persist = true, complete = null, llmResolver = null, clock = Date.now } = {}) {
    this.config = config; this.storage = storage; this.persist = persist;
    this.llmResolver = llmResolver || (() => this.config.llm);
    this.complete = complete || completeDraft;
    this.clock = clock;
    this.filename = config.draftsPath || path.join(path.dirname(config.runtimePath), 'drafts.json');
    this.drafts = new Map();
    if (storage) {
      for (const draft of storage.kbDrafts || []) this.drafts.set(draft.id, validateDraft(draft));
    } else if (persist && fs.existsSync(this.filename)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.drafts)) throw new Error('Invalid draft state');
        for (const draft of saved.drafts) this.drafts.set(draft.id, validateDraft(draft));
      } catch { throw new Error('草稿文件无法读取；为避免覆盖原记录，请先检查 drafts.json。'); }
    }
  }
  save() {
    if (!this.persist || this.storage) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify({ version: 1, drafts: [...this.drafts.values()] }), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  ready() {
    const llm = this.llmResolver() || {};
    return Boolean(llm.key && llm.baseUrl && llm.model);
  }
  list({ status = 'draft' } = {}) {
    if (!['draft', 'confirmed', 'all'].includes(status)) throw new HttpError(400, '草稿状态无效。');
    const items = [...this.drafts.values()].filter(draft => status === 'all' || draft.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : 1));
    return { items, total: items.length };
  }
  async generate(input = {}, knowledge = null, ownerId = null) {
    const prepared = this.prepare(input, knowledge, ownerId);
    return this.accept(prepared, await this.complete(prepared.llm, prepared.messages));
  }
  validateInput(input = {}) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > 100) throw new HttpError(400, '请输入 1—100 字的出题主题或知识点。');
    const module = input.module || null;
    if (module && !MODULES.includes(module)) throw new HttpError(400, '出题模块无效。');
    const count = input.count ?? 3;
    if (!Number.isInteger(count) || count < 1 || count > DRAFT_LIMITS.count) throw new HttpError(400, `一次生成 1—${DRAFT_LIMITS.count} 道。`);
    if (!this.ready()) throw new HttpError(409, '尚未配置模型服务，请联系管理员在管理面板中配置出题模型。', 'llm_not_configured');
    return { query, module, count };
  }
  prepare(input = {}, knowledge = null, ownerId = null, retrieved = null) {
    const { query, module, count } = this.validateInput(input);
    if (!knowledge) throw new HttpError(400, '知识库服务不可用。');
    const sources = retrieved?.items || knowledge.searchChunks(query, { limit: 5, ownerId });
    if (!sources.length) throw new HttpError(400, '知识库里没有找到与该主题相关的片段，请先上传相关资料或换个关键词。');
    const keys = sources.map((_, index) => `K${index + 1}`);
    const materials = sources.map((chunk, index) => `[K${index + 1}] 《${chunk.document.title}》· ${chunk.anchor}\n${chunk.text}`).join('\n\n');
    const llm = { ...this.llmResolver(), maxTokens: Math.max(this.llmResolver()?.maxTokens || 0, 4096) };
    return { llm, messages: buildPrompt(query, module, count, materials), count, module, sources, keys, retrieval: retrieved ? { mode: retrieved.mode, fallback: retrieved.fallback, rerank: retrieved.rerank } : { mode: 'keyword', fallback: 'disabled' } };
  }
  accept({ count, module, sources, keys, retrieval }, text) {
    const parsed = parseQuestions(text);
    const createdAt = new Date(this.clock()).toISOString();
    const created = [];
    for (const raw of parsed.slice(0, count)) {
      const draft = normalizeDraft(raw, keys);
      if (!draft) continue;
      const origin = sources[keys.indexOf(draft.source)];
      const record = validateDraft({ id: crypto.randomUUID(), status: 'draft', module, ...draft,
        source: { title: origin.document.title, anchor: origin.anchor }, createdAt });
      this.drafts.set(record.id, record); created.push(record);
    }
    if (!created.length) throw new HttpError(502, '模型返回的题目均未通过校验，请重试或更换资料。', 'generation_invalid');
    // Direct practice has no draft-inbox UI. Keep a bounded recent history
    // instead of permanently blocking generation after 200 questions.
    const keep = new Set(created.map(draft => draft.id));
    const oldest = this.list({ status: 'all' }).items.filter(draft => !keep.has(draft.id)).reverse();
    while (this.drafts.size > DRAFT_LIMITS.total && oldest.length) {
      const draft = oldest.shift(); this.drafts.delete(draft.id); this.storage?.deleteKbDraft(draft.id);
    }
    if (this.storage) for (const record of created) this.storage.saveKbDraft(record);
    else this.save();
    return { drafts: created, retrieval, sources: sources.map(({ document, anchor, score, similarity }) => ({ title: document.title, anchor, score, ...(similarity !== undefined ? { similarity } : {}) })) };
  }
  markSwapped(id) {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== 'draft') throw new HttpError(404, '题目不存在或已处理。', 'draft_not_found');
    draft.status = 'swapped';
    if (this.storage) this.storage.saveKbDraft(draft); else this.save();
    return { swapped: draft.id };
  }
  confirm(id) {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== 'draft') throw new HttpError(404, '草稿不存在或已处理。', 'draft_not_found');
    draft.status = 'confirmed';
    if (this.storage) this.storage.saveKbDraft(draft); else this.save();
    return draft;
  }
  remove(id) {
    const draft = this.drafts.get(id);
    if (!draft) throw new HttpError(404, '草稿不存在。', 'draft_not_found');
    this.drafts.delete(id);
    if (this.storage) this.storage.deleteKbDraft(id); else this.save();
    return { removed: id };
  }
  // Confirmed drafts become a standard question-import document, so publishing
  // into the live bank reuses the existing reviewed import pipeline.
  export() {
    const confirmed = [...this.drafts.values()].filter(draft => draft.status === 'confirmed');
    return {
      schemaVersion: '1.0', bankId: 'kb-drafts',
      questions: confirmed.map(draft => ({
        id: `kb_${draft.id.replace(/-/g, '').slice(0, 16)}`, module: draft.module, stem: draft.stem,
        options: draft.options, answer: draft.answer, analysis: draft.analysis,
        knowledgePoints: draft.knowledgePoints, source: { type: '模拟题', title: `知识库生成 · ${draft.source.title}` },
      })),
    };
  }
}

export async function completeDraft(llm, messages) {
  let text = '';
  await streamCompletion(llm, { messages, max_tokens: llm.maxTokens || 4096, temperature: 0.6 }, {
    signal: AbortSignal.timeout(llm.timeout || 120000), onText: delta => { text += delta; },
  });
  return text;
}
