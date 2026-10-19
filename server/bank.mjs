import fs from 'node:fs';
import crypto from 'node:crypto';
import { questionFingerprint } from './resources.mjs';
import { materialKey, orderMaterialQuestions } from './materials.mjs';

export const MODULES = ['政治理论', '常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
export class HttpError extends Error {
  constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
export function questionImages(question) {
  return [...new Map(question.images.filter(image => image.role !== 'analysis').map(image => [image.path, image])).values()];
}
export const localHtml = value => (value || '').replace(/(src=["'])assets\/images\//g, '$1/assets/images/');
const shuffle = array => { for (let i = array.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [array[i], array[j]] = [array[j], array[i]]; } return array; };
const validateCount = count => {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new HttpError(400, '题量须为 1—100 道整数。');
};

export class QuestionBank {
  constructor(filename, suppliedRows) {
    const rows = suppliedRows || fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    this.rows = rows.filter(q => q.question_type === 'single' && q.answer.length === 1 && !q.quality_flags.includes('answer_analysis_mismatch'));
    this.byId = new Map(this.rows.map(question => [question.id, question]));
    if (this.byId.size !== this.rows.length) throw new Error('题库存在重复题目 ID。');
    this.fingerprints = new Map(this.rows.map(q => [q.id, questionFingerprint(q)]));
    this.materialKeys = new Map(this.rows.map(q => [q.id, materialKey(q)]));
    this.materials = new Map();
    for (const q of this.rows) {
      const key = this.materialKeys.get(q.id);
      if (!this.materials.has(key)) this.materials.set(key, []);
      this.materials.get(key).push(q.id);
    }
    for (const [key, ids] of this.materials) this.materials.set(key,
      orderMaterialQuestions(ids.map(id => this.byId.get(id))).map(question => question.id));
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
  eligibleGroups(settings, { allowedQuestionIds = null } = {}) {
    const permitted = new Set(this.eligible(settings).map(q => q.id));
    const seeds = allowedQuestionIds === null ? null : new Set(allowedQuestionIds);
    // Scope selects materials through matching questions. Hard filters must
    // hold for every member; omit incompatible or oversized groups intact.
    return [...this.materials.values()].filter(ids => ids.length <= 100 && ids.every(id => permitted.has(id))
      && (!seeds || ids.some(id => seeds.has(id))));
  }
  selectGroups(groups, count) {
    validateCount(count);
    const available = groups.reduce((total, ids) => total + ids.length, 0);
    if (available < count) throw new HttpError(400, `当前条件只有 ${available} 道题可整组抽取，请减少题量或放宽筛选。`);
    // Preserve sampling/ranking priority, completing the last selected group
    // even if it crosses the target. Skip groups that exceed the hard cap.
    const picked = [];
    for (const group of groups) {
      if (picked.length + group.length > 100) continue;
      picked.push(...group);
      if (picked.length >= count) break;
    }
    return picked;
  }
  draw(settings, selection = {}) {
    const { modules, count } = settings;
    validateCount(count);
    const groups = this.eligibleGroups(settings, selection);
    if (selection.requestedQuestionIds !== undefined) {
      const ids = selection.requestedQuestionIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '指定题目须去重且为 1—100 道。');
      const permitted = new Set(groups.flat());
      if (ids.some(id => !permitted.has(id))) throw new HttpError(400, '指定题目不符合当前练习范围或筛选条件。');
      const selected = [...new Set(ids.map(id => this.materialKeys.get(id)))].flatMap(key => this.materials.get(key));
      if (selected.length > 100) throw new HttpError(400, `指定材料共有 ${selected.length} 道题，超过 100 道上限，请减少材料。`);
      return selected;
    }
    const buckets = shuffle(modules.map(module => ({ module, count: 0,
      groups: shuffle(groups.filter(ids => this.byId.get(ids[0]).module === module)) })));
    const ordered = [];
    while (buckets.some(bucket => bucket.groups.length)) {
      const bucket = buckets.filter(bucket => bucket.groups.length).sort((a, b) => a.count - b.count)[0];
      const group = bucket.groups.pop(); ordered.push(group); bucket.count += group.length;
    }
    const selected = this.selectGroups(ordered, count);
    return shuffle([...new Set(selected.map(id => this.materialKeys.get(id)))]).flatMap(key => this.materials.get(key));
  }
  publicQuestion(id) {
    const q = this.byId.get(id);
    if (!q) throw new HttpError(404, '题目不存在。');
    // Explicit allowlist: never serialize the source record into an unfinished round.
    return { id: q.id, module: q.module, submodule: q.submodule, sourceType: q.source_type,
      year: q.year, province: q.province, stemHtml: localHtml(q.stem_html), materialHtml: localHtml(q.material_html),
      materialId: this.materialKeys.get(q.id),
      options: Object.entries(q.options_html).map(([label, content]) => ({ label, html: localHtml(content) })),
      hasImages: questionImages(q).length > 0, imageCount: questionImages(q).length };
  }
  reveal(id) {
    const q = this.byId.get(id);
    return { correctAnswer: q.answer[0], analysisHtml: localHtml(q.analysis_html),
      source: { title: q.occurrences[0]?.paper_title || '', url: q.occurrences[0]?.source_url || '' } };
  }
}
