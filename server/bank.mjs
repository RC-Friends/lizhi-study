import fs from 'node:fs';
import crypto from 'node:crypto';
import { questionFingerprint } from './resources.mjs';

export const MODULES = ['政治理论', '常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
export class HttpError extends Error {
  constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
export function questionImages(question) {
  return [...new Map(question.images.filter(image => image.role !== 'analysis').map(image => [image.path, image])).values()];
}
export const localHtml = value => (value || '').replace(/(src=["'])assets\/images\//g, '$1/assets/images/');

export class QuestionBank {
  constructor(filename, suppliedRows) {
    const rows = suppliedRows || fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    this.rows = rows.filter(q => q.question_type === 'single' && q.answer.length === 1 && !q.quality_flags.includes('answer_analysis_mismatch'));
    this.byId = new Map(this.rows.map(question => [question.id, question]));
    if (this.byId.size !== this.rows.length) throw new Error('题库存在重复题目 ID。');
    this.fingerprints = new Map(this.rows.map(q => [q.id, questionFingerprint(q)]));
  }
  catalog() {
    return {
      total: this.rows.length,
      modules: MODULES.map(name => ({ name, count: this.rows.filter(q => q.module === name).length })),
      imageQuestions: this.rows.filter(q => questionImages(q).length > 0).length,
      sources: { real: this.rows.filter(q => q.source_type === '真题').length, mock: this.rows.filter(q => q.source_type === '模拟题').length },
    };
  }
  eligible(settings, { allowedQuestionIds = null } = {}) {
    const { modules, source, images } = settings;
    if (!Array.isArray(modules) || !modules.length || modules.some(m => !MODULES.includes(m)) || new Set(modules).size !== modules.length) throw new HttpError(400, '请至少选择一个有效模块。');
    if (!['all', 'real', 'mock'].includes(source) || !['text', 'mixed', 'visual'].includes(images)) throw new HttpError(400, '组卷条件无效。');
    const allowed = allowedQuestionIds === null ? null : new Set(allowedQuestionIds);
    return this.rows.filter(q => (!allowed || allowed.has(q.id)) && modules.includes(q.module)
      && (source === 'all' || q.source_type === (source === 'real' ? '真题' : '模拟题'))
      && (images === 'mixed' || (questionImages(q).length > 0) === (images === 'visual')));
  }
  draw(settings, selection = {}) {
    const { modules, count } = settings;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new HttpError(400, '题量须为 1—100 道整数。');
    const eligible = this.eligible(settings, selection);
    if (selection.requestedQuestionIds !== undefined) {
      const ids = selection.requestedQuestionIds;
      if (!Array.isArray(ids) || ids.length !== count || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '指定题目须去重且与题量一致。');
      const permitted = new Set(eligible.map(q => q.id));
      if (ids.some(id => !permitted.has(id))) throw new HttpError(400, '指定题目不符合当前练习范围或筛选条件。');
      return [...ids];
    }
    if (eligible.length < count) throw new HttpError(400, `当前条件只有 ${eligible.length} 道题，请减少题量或放宽筛选。`);
    // Randomize within each module, then rotate modules for a balanced paper.
    const shuffle = array => { for (let i = array.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [array[i], array[j]] = [array[j], array[i]]; } return array; };
    const buckets = shuffle(modules.map(module => shuffle(eligible.filter(q => q.module === module))));
    const selected = [];
    while (selected.length < count) {
      for (const bucket of buckets) { if (bucket.length && selected.length < count) selected.push(bucket.pop().id); }
    }
    return shuffle(selected);
  }
  publicQuestion(id) {
    const q = this.byId.get(id);
    if (!q) throw new HttpError(404, '题目不存在。');
    // Explicit allowlist: never serialize the source record into an unfinished round.
    return { id: q.id, module: q.module, submodule: q.submodule, sourceType: q.source_type,
      year: q.year, province: q.province, stemHtml: localHtml(q.stem_html), materialHtml: localHtml(q.material_html),
      options: Object.entries(q.options_html).map(([label, content]) => ({ label, html: localHtml(content) })),
      hasImages: questionImages(q).length > 0, imageCount: questionImages(q).length };
  }
  reveal(id) {
    const q = this.byId.get(id);
    return { correctAnswer: q.answer[0], analysisHtml: localHtml(q.analysis_html),
      source: { title: q.occurrences[0]?.paper_title || '', url: q.occurrences[0]?.source_url || '' } };
  }
}
