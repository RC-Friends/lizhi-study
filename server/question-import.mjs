import fs from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { parseFragment } from 'parse5';
import { imageSize } from 'image-size';
import { HttpError, QuestionBank } from './bank.mjs';
import { sha256, questionFingerprint } from './resources.mjs';

export const IMPORT_LIMITS = Object.freeze({ documentBytes: 64 * 1024 * 1024, bankBytes: 128 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024, files: 20000, totalBytes: 512 * 1024 * 1024 });
export const importSchema = JSON.parse(fs.readFileSync(new URL('../schema/question-import.schema.json', import.meta.url)));
const canonicalSchema = JSON.parse(fs.readFileSync(new URL('../schema/question.schema.json', import.meta.url)));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateInput = ajv.compile(importSchema), validateRecord = ajv.compile(canonicalSchema);
export class ImportError extends HttpError {
  constructor(issues, status = 422, code = 'invalid_question_import') {
    super(status, '题库校验未通过，请根据 issues 修正后重试。', code);
    this.issues = issues.slice(0, 100);
  }
}
const issue = (path, message) => ({ path, message });
function schemaIssues(validate, value, prefix = '') {
  return validate(value) ? [] : validate.errors.slice(0, 100).map(e => issue(prefix + e.instancePath, `${e.message}${e.params.missingProperty ? ': ' + e.params.missingProperty : ''}`));
}
export function importPath(value) {
  return typeof value === 'string' && value.length <= 300 && !/[\\\s\x00-\x1f:#?%]/.test(value)
    && !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..')
    && /\.(png|jpe?g|gif|webp|bmp)$/i.test(value);
}
export function importImages(document) {
  return [...document.questions.flatMap(q => q.images || []),
    ...(document.materials || []).flatMap(material => (material.images || []).map(image => ({ ...image, role: 'material' })))];
}
export function validateImport(document) {
  const errors = schemaIssues(validateInput, document);
  if (errors.length) throw new ImportError(errors);
  const ids = new Set(), images = new Set(), modules = {}, materials = new Map(), orders = new Map();
  for (const [i, material] of (document.materials || []).entries()) {
    const root = `/materials/${i}`, refs = material.images || [], paths = new Set();
    if (materials.has(material.id)) errors.push(issue(root + '/id', '材料 ID 重复。'));
    materials.set(material.id, material);
    if (!(material.text || '').trim() && !refs.length) errors.push(issue(root, '材料须包含非空文字或图片。'));
    for (const [j, image] of refs.entries()) {
      if (!importPath(image.path)) errors.push(issue(`${root}/images/${j}/path`, '材料图片须为资源目录内的相对路径。'));
      if (paths.has(image.path)) errors.push(issue(`${root}/images/${j}`, '材料图片引用重复。'));
      paths.add(image.path); images.add(image.path);
    }
  }
  for (const [i, q] of document.questions.entries()) {
    const root = `/questions/${i}`, refs = q.images || [], roles = new Set(refs.map(r => r.role));
    if (ids.has(q.id)) errors.push(issue(root + '/id', '题目 ID 重复。'));
    ids.add(q.id); modules[q.module] = (modules[q.module] || 0) + 1;
    if (q.materialId !== undefined) {
      if (!materials.has(q.materialId)) errors.push(issue(root + '/materialId', '引用的材料不存在。'));
      if (q.material !== undefined || refs.some(image => image.role === 'material')) errors.push(issue(root, '引用共用材料时，请将材料文字和材料图片统一放入 materials。'));
      if (!orders.has(q.materialId)) orders.set(q.materialId, new Set());
      const positions = orders.get(q.materialId);
      if (positions.has(q.materialOrder)) errors.push(issue(root + '/materialOrder', '同一材料的小题序号重复。'));
      positions.add(q.materialOrder);
    }
    if (!q.stem.trim() || !q.analysis.trim()) errors.push(issue(root, '题干与解析不能仅包含空白。'));
    if (!Object.hasOwn(q.options, q.answer)) errors.push(issue(root + '/answer', '答案不在选项中。'));
    const labels = Object.keys(q.options).sort();
    if (labels.join('') !== 'ABCDEF'.slice(0, labels.length)) errors.push(issue(root + '/options', '选项须从 A 开始连续排列。'));
    for (const [label, text] of Object.entries(q.options)) if (!text.trim() && !roles.has('option_' + label)) errors.push(issue(root + '/options/' + label, '空选项必须有对应选项图片。'));
    const unique = new Set();
    for (const [j, image] of refs.entries()) {
      if (!importPath(image.path)) errors.push(issue(`${root}/images/${j}/path`, '只接受资源目录内的相对图片路径，不接受网址、Base64 或路径穿越。'));
      if (image.role.startsWith('option_') && !Object.hasOwn(q.options, image.role.slice(7))) errors.push(issue(`${root}/images/${j}/role`, '图片引用了不存在的选项。'));
      const ref = image.role + ':' + image.path;
      if (unique.has(ref)) errors.push(issue(`${root}/images/${j}`, '同一位置的图片引用重复。'));
      unique.add(ref); images.add(image.path);
    }
    if (q.source?.url) {
      try { const u = new URL(q.source.url); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error(); }
      catch { errors.push(issue(root + '/source/url', '来源链接必须为不含凭证的 HTTP(S) URL。')); }
    }
    if (errors.length >= 100) break;
  }
  for (const [i, material] of (document.materials || []).entries()) {
    const positions = orders.get(material.id);
    if (!positions) errors.push(issue(`/materials/${i}`, '材料未关联任何小题。'));
    else if (positions.size > 100 || [...positions].some(position => position > positions.size)) {
      errors.push(issue(`/materials/${i}`, '每篇材料须关联 1—100 道小题，序号从 1 开始连续排列。'));
    }
  }
  if (errors.length) throw new ImportError(errors);
  return { valid: true, schemaVersion: '1.0', bankId: document.bankId, questions: document.questions.length, images: images.size, modules };
}
export function inspectImage(bytes, name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMPORT_LIMITS.imageBytes) throw new ImportError([issue(name, '图片须为 1 字节至 16 MiB。')]);
  let meta;
  try { meta = imageSize(bytes); } catch { throw new ImportError([issue(name, '无法识别图片格式和尺寸。')]); }
  const type = meta.type === 'jpeg' ? 'jpg' : meta.type, extension = name.split('.').at(-1).toLowerCase().replace(/^jpeg$/, 'jpg');
  if (!['png', 'jpg', 'gif', 'webp', 'bmp'].includes(type) || extension !== type || !meta.width || !meta.height
    || meta.width > 16000 || meta.height > 16000 || meta.width * meta.height > 40000000) throw new ImportError([issue(name, '图片格式、扩展名或尺寸不合要求（最多 4000 万像素，边长不超过 16000）。')]);
  const hash = sha256(bytes);
  return { path: `assets/images/${hash.slice(0, 2)}/${hash}.${type}`, width: meta.width, height: meta.height, sha256: hash };
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function compileImport(document, imageInfo) {
  validateImport(document);
  const materials = new Map((document.materials || []).map(material => [material.id, material]));
  return document.questions.map(q => {
    const source = q.source || {};
    const material = materials.get(q.materialId);
    const images = [...(q.images || []), ...(material?.images || []).map(image => ({ ...image, role: 'material' }))].map(image => {
      const meta = imageInfo.get(image.path);
      if (!meta) throw new ImportError([issue(image.path, '缺少本地图片。')]);
      return { path: meta.path, role: image.role, kind: image.kind || 'image', width: meta.width, height: meta.height };
    });
    const text = (value = '', role) => value + images.filter(i => i.role === role).map(i => `\n[图片: ${i.path}]`).join('');
    const html = (value = '', role) => (value ? `<p>${escape(value).replaceAll('\n', '<br>')}</p>` : '')
      + images.filter(i => i.role === role).map(i => `<img src="${i.path}" alt="题目图片">`).join('');
    const year = source.year ?? null, province = source.province || '';
    return {
      id: 'xc_' + sha256(document.bankId + ':' + q.id).slice(0, 24), schema_version: '1.0', module: q.module,
      submodule: q.submodule || '', source_type: source.type || '模拟题', question_type: 'single', answer: [q.answer],
      images, has_image: images.length > 0,
      material_id: material ? 'mat_' + sha256(document.bankId + ':material:' + material.id).slice(0, 24) : null,
      classification_basis: 'source_category', year, province,
      years: year === null ? [] : [year], provinces: province ? [province] : [], difficulty: null, accuracy: null,
      source_reviewed: null, answer_verification: 'source_only', charts: [],
      occurrences: [{ dataset: document.bankId, source_id: q.id, source_url: source.url || '', raw_path: 'question-import/1.0',
        paper_title: source.title || document.bankId, province, year,
        ...(material ? { question_number: q.materialOrder } : {}) }],
      stem: text(q.stem, 'stem'), stem_html: html(q.stem, 'stem'),
      material: text(material ? material.text : q.material, 'material'), material_html: html(material ? material.text : q.material, 'material'),
      analysis: text(q.analysis, 'analysis'), analysis_html: html(q.analysis, 'analysis'),
      tags: [...new Set([...(q.tags || []).filter(t => t !== 'has_image'), ...(images.length ? ['has_image'] : [])])],
      quality_flags: [], knowledge_points: q.knowledgePoints || [],
      options: Object.fromEntries(Object.keys(q.options).sort().map(k => [k, text(q.options[k], 'option_' + k)])),
      options_html: Object.fromEntries(Object.keys(q.options).sort().map(k => [k, html(q.options[k], 'option_' + k)])),
    };
  });
}
export function parseQuestionLines(bytes) {
  if (bytes.length > IMPORT_LIMITS.bankBytes) throw new ImportError([issue('', '题库不能超过 128 MiB。')]);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ImportError([issue('', '题库必须为 UTF-8。')]); }
  const rows = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { throw new ImportError([issue(`/lines/${i + 1}`, '这一行不是合法 JSON。')]); }
  }
  return rows;
}
export function validateCanonical(rows, { activeBank, activeFingerprints = activeBank?.fingerprints } = {}) {
  const errors = [], ids = new Set(), refs = new Map(), materials = new Map();
  if (!Array.isArray(rows) || !rows.length || rows.length > 50000) throw new ImportError([issue('', '资源包必须包含 1—50000 道题。')]);
  for (const [i, q] of rows.entries()) {
    const root = `/questions/${i}`, shape = schemaIssues(validateRecord, q, root);
    if (shape.length) { errors.push(...shape); if (errors.length >= 100) break; continue; }
    if (ids.has(q.id)) errors.push(issue(root + '/id', '题目 ID 重复。'));
    ids.add(q.id);
    if (!q.stem.trim() || !q.analysis.trim() || q.answer.some(k => !Object.hasOwn(q.options, k))
      || q.question_type === 'single' && q.answer.length !== 1 || Object.keys(q.options).sort().join() !== Object.keys(q.options_html).sort().join()) errors.push(issue(root, '题干、解析、选项或答案不一致。'));
    if (q.has_image !== Boolean(q.images.length) || q.tags.includes('has_image') !== q.has_image) errors.push(issue(root + '/images', '图片标记不一致。'));
    // Check explicit imported groups again after merging with an existing bank.
    // Legacy canonical records retain their original validation behavior.
    const position = q.occurrences.find(o => o.raw_path === 'question-import/1.0' && Number.isInteger(o.question_number))?.question_number;
    if (q.material_id && position !== undefined) {
      if (!materials.has(q.material_id)) materials.set(q.material_id, { text: q.material, html: q.material_html, positions: new Set() });
      const material = materials.get(q.material_id);
      if (material.text !== q.material || material.html !== q.material_html) errors.push(issue(root + '/material_id', '同一材料 ID 对应内容不一致，修订材料请使用新的材料 ID。'));
      if (material.positions.has(position)) errors.push(issue(root + '/occurrences', '同一材料的小题序号重复。'));
      material.positions.add(position);
    }
    const expected = new Set(q.images.map(image => image.role + ':' + image.path)), actual = new Set();
    for (const image of q.images) {
      const previous = refs.get(image.path);
      if (previous && (previous.width !== image.width || previous.height !== image.height)) errors.push(issue(root + '/images', '相同图片路径的尺寸不一致。'));
      refs.set(image.path, image);
    }
    for (const [role, html] of [...['stem', 'material', 'analysis'].map(r => [r, q[r + '_html']]), ...Object.entries(q.options_html).map(([k, v]) => ['option_' + k, v])]) {
      const stack = [parseFragment(html)];
      while (stack.length) {
        const node = stack.pop();
        if (['script', 'iframe', 'object', 'embed', 'link', 'style', 'base', 'meta', 'svg', 'template', 'audio', 'video', 'form'].includes(node.tagName)) errors.push(issue(root + '/' + role, 'HTML 包含不允许的元素。'));
        for (const attr of node.attrs || []) if (/^on/i.test(attr.name) || ['srcset', 'style', 'href', 'xlink:href'].includes(attr.name) || attr.name === 'src' && node.tagName !== 'img') errors.push(issue(root + '/' + role, 'HTML 包含不允许的属性。'));
        if (node.tagName === 'img') actual.add(role + ':' + (node.attrs.find(a => a.name === 'src')?.value || ''));
        stack.push(...(node.childNodes || []));
      }
    }
    if (expected.size !== actual.size || [...actual].some(ref => !expected.has(ref))) errors.push(issue(root + '/images', 'HTML 图片引用与 images 索引不一致。'));
    if (errors.length >= 100) break;
  }
  for (const [id, material] of materials) {
    if (material.positions.size > 100 || [...material.positions].some(position => position < 1 || position > material.positions.size)) {
      errors.push(issue('/questions', `材料 ${id} 须包含 1—100 道序号从 1 开始连续排列的小题。`));
    }
  }
  if (!errors.length && activeFingerprints) {
    const next = new Map(rows.map(q => [q.id, q]));
    for (const [id, fingerprint] of activeFingerprints) if (!next.has(id) || questionFingerprint(next.get(id)) !== fingerprint) {
      errors.push(issue('/questions', `新版本必须保留当前题目及内容：${id}。请基于现有资源包增量合并；修订题目使用新 ID。`));
      if (errors.length >= 100) break;
    }
  }
  if (errors.length) throw new ImportError(errors);
  const catalog = new QuestionBank(null, rows).catalog();
  if (!catalog.total) throw new ImportError([issue('/questions', '资源包没有可用的单选题。')]);
  return { valid: true, questions: rows.length, usableQuestions: catalog.total, images: refs.size, refs, catalog };
}
