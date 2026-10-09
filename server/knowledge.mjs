import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './bank.mjs';

import { KB_LIMITS, chunkDocument, tokenize, extractDocumentText } from './kb-text.mjs';
import { validateLibrary, validateKnowledge } from './knowledge-validation.mjs';
export { KB_LIMITS, parseBlocks, chunkDocument, tokenize, extractDocumentText } from './kb-text.mjs';
export { validateLibrary, validateKnowledge } from './knowledge-validation.mjs';

const FORMATS = ['markdown', 'text', 'image', 'pdf', 'docx'];
const VISIBILITIES = ['private', 'public'];
const own = (object, key) => Object.hasOwn(object, key);

export class KnowledgeService {
  constructor(config, { storage = null, persist = true, clock = Date.now } = {}) {
    this.storage = storage; this.persist = persist; this.clock = clock;
    this.filename = config.knowledgePath || path.join(path.dirname(config.runtimePath), 'kb.json');
    this.libraries = new Map(); this.documents = new Map(); this.byHash = new Map();
    if (storage) {
      for (const library of storage.kbLibraries || []) this.libraries.set(library.id, validateLibrary(library));
      for (const document of storage.kb || []) this.remember(validateKnowledge(document));
    } else if (persist && fs.existsSync(this.filename)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.libraries) || !Array.isArray(saved.documents)) throw new Error('Invalid knowledge state');
        for (const library of saved.libraries) this.libraries.set(library.id, validateLibrary(library));
        for (const document of saved.documents) this.remember(validateKnowledge(document));
      } catch { throw new Error('知识库文件无法读取；为避免覆盖原文档，请先检查 kb.json。'); }
    }
  }
  remember(document) {
    this.documents.set(document.id, document);
    this.byHash.set(`${document.libraryId}:${document.sha256}`, document.id);
    return document;
  }
  save() {
    if (!this.persist || this.storage) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify({ version: 1, libraries: [...this.libraries.values()], documents: [...this.documents.values()] }), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  canRead(library, ownerId) { return library.visibility === 'public' || library.ownerId === ownerId; }
  canWrite(library, ownerId) { return library.ownerId === ownerId; }
  requireLibrary(id, ownerId, write = false) {
    const library = this.libraries.get(id);
    if (!library || (write ? !this.canWrite(library, ownerId) : !this.canRead(library, ownerId))) {
      throw new HttpError(404, '资料库不存在或没有访问权限。', 'library_not_found');
    }
    return library;
  }
  accessibleLibraryIds(ownerId) {
    return [...this.libraries.values()].filter(library => this.canRead(library, ownerId)).map(library => library.id);
  }
  libraryBrief(library) {
    const count = [...this.documents.values()].filter(document => document.libraryId === library.id).length;
    return { ...library, documentCount: count };
  }
  listLibraries(scope = 'mine', ownerId) {
    if (!['mine', 'shared'].includes(scope)) throw new HttpError(400, '资料库范围无效。');
    const items = [...this.libraries.values()]
      .filter(library => scope === 'mine' ? library.ownerId === ownerId : library.visibility === 'public')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : 1))
      .map(library => ({ ...this.libraryBrief(library), mine: library.ownerId === ownerId }));
    return { items, total: items.length };
  }
  createLibrary(input = {}, ownerId) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const visibility = input.visibility || 'private';
    if (!name || name.length > KB_LIMITS.libraryName) throw new HttpError(400, `资料库名称须为 1—${KB_LIMITS.libraryName} 字。`);
    if (description.length > KB_LIMITS.description) throw new HttpError(400, `简介最多 ${KB_LIMITS.description} 字。`);
    if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, '可见性设置无效。');
    if ([...this.libraries.values()].filter(library => library.ownerId === ownerId).length >= KB_LIMITS.libraries) {
      throw new HttpError(400, `最多创建 ${KB_LIMITS.libraries} 个资料库，请先清理不需要的库。`);
    }
    const library = validateLibrary({ id: crypto.randomUUID(), ownerId, name, description,
      visibility, createdAt: new Date(this.clock()).toISOString() });
    this.libraries.set(library.id, library); this.save();
    if (this.storage) this.storage.saveKbLibrary(library);
    return this.libraryBrief(library);
  }
  updateLibrary(id, patch = {}, ownerId) {
    const library = this.requireLibrary(id, ownerId, true);
    if (own(patch, 'name')) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name || name.length > KB_LIMITS.libraryName) throw new HttpError(400, `资料库名称须为 1—${KB_LIMITS.libraryName} 字。`);
      library.name = name;
    }
    if (own(patch, 'description')) {
      const description = typeof patch.description === 'string' ? patch.description.trim() : '';
      if (description.length > KB_LIMITS.description) throw new HttpError(400, `简介最多 ${KB_LIMITS.description} 字。`);
      library.description = description;
    }
    if (own(patch, 'visibility')) {
      if (!VISIBILITIES.includes(patch.visibility)) throw new HttpError(400, '可见性设置无效。');
      library.visibility = patch.visibility;
    }
    this.save();
    if (this.storage) this.storage.saveKbLibrary(library);
    return this.libraryBrief(library);
  }
  removeLibrary(id, ownerId) {
    const library = this.requireLibrary(id, ownerId, true);
    const removed = [];
    for (const document of [...this.documents.values()].filter(document => document.libraryId === id)) {
      this.documents.delete(document.id); this.byHash.delete(`${id}:${document.sha256}`);
      removed.push(document.id);
      if (this.storage) this.storage.deleteKbDocument(document.id);
    }
    this.libraries.delete(id);
    if (this.storage) this.storage.deleteKbLibrary(id); else this.save();
    return { removed: id, documents: removed.length };
  }
  listDocuments(libraryId, ownerId) {
    const library = this.requireLibrary(libraryId, ownerId);
    const items = [...this.documents.values()].filter(document => document.libraryId === libraryId)
      .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt) || (a.id < b.id ? -1 : 1))
      .map(({ chunks, ...brief }) => ({ ...brief, chunkCount: chunks.length,
        preview: brief.format === 'image' ? '图片资料 · 待 AI 转写后参与出题' : chunks[0].text.slice(0, 80) }));
    return { library: { ...this.libraryBrief(library), mine: library.ownerId === ownerId }, items, total: items.length };
  }
  getDocument(libraryId, docId, ownerId) {
    this.requireLibrary(libraryId, ownerId);
    const document = this.documents.get(docId);
    if (!document || document.libraryId !== libraryId) throw new HttpError(404, '文档不存在。', 'kb_not_found');
    return document;
  }
  upload(input = {}, ownerId) {
    const libraryId = input.libraryId;
    if (typeof libraryId !== 'string' || !libraryId) throw new HttpError(400, '请先选择要收录到的资料库。');
    this.requireLibrary(libraryId, ownerId, true);
    const count = [...this.documents.values()].filter(document => document.libraryId === libraryId).length;
    if (count >= KB_LIMITS.documentsPerLibrary) throw new HttpError(400, `单个资料库最多 ${KB_LIMITS.documentsPerLibrary} 份文档，请先清理。`);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > KB_LIMITS.title) throw new HttpError(400, `标题须为 1—${KB_LIMITS.title} 字。`);
    if (!FORMATS.includes(input.format)) throw new HttpError(400, '文档格式仅支持 markdown、text 或 image。');
    if (input.format === 'image') return this.uploadImage(libraryId, title, input.image, ownerId);
    if (input.format === 'pdf' || input.format === 'docx') return this.uploadBinary(libraryId, title, input.format, input.fileBase64, ownerId);
    if (typeof input.content !== 'string' || !input.content.trim()) throw new HttpError(400, '文档内容不能为空。');
    const size = Buffer.byteLength(input.content, 'utf8');
    if (size > KB_LIMITS.documentBytes) throw new HttpError(400, `文档不能超过 ${Math.round(KB_LIMITS.documentBytes / 1024)} KiB。`);
    const sha256 = crypto.createHash('sha256').update(input.content, 'utf8').digest('hex');
    const existing = this.byHash.get(`${libraryId}:${sha256}`);
    if (existing) return { document: this.documents.get(existing), duplicate: true };
    const chunks = chunkDocument(input.format, input.content);
    if (!chunks.length) throw new HttpError(400, '没有可提取的文本内容。');
    const document = validateKnowledge({ id: crypto.randomUUID(), libraryId, sha256, title, format: input.format, size,
      chunks, uploadedAt: new Date(this.clock()).toISOString() });
    this.remember(document); this.save();
    if (this.storage) this.storage.saveKbDocument(document);
    return { document, duplicate: false };
  }
  async uploadBinary(libraryId, title, format, fileBase64, ownerId) {
    const match = typeof fileBase64 === 'string' ? fileBase64.match(/^[A-Za-z0-9+/=]+$/) : null;
    if (!match) throw new HttpError(400, '文件数据无效，请重新选择文件。');
    const size = Buffer.byteLength(fileBase64, 'base64');
    if (size > KB_LIMITS.fileBytes) throw new HttpError(400, `文件不能超过 ${Math.round(KB_LIMITS.fileBytes / 1024 / 1024)} MiB。`);
    const sha256 = crypto.createHash('sha256').update(fileBase64, 'base64').digest('hex');
    const existing = this.byHash.get(`${libraryId}:${sha256}`);
    if (existing) return { document: this.documents.get(existing), duplicate: true };
    const text = await extractDocumentText(format, fileBase64);
    if (!text.trim()) throw new HttpError(400, '这份文件里没有可提取的文字（可能是扫描版或空文档），暂无法参与出题。');
    const chunks = chunkDocument('text', text);
    const document = validateKnowledge({ id: crypto.randomUUID(), libraryId, sha256, title, format, size,
      chunks, uploadedAt: new Date(this.clock()).toISOString() });
    this.remember(document); this.save();
    if (this.storage) this.storage.saveKbDocument(document);
    return { document, duplicate: false };
  }
  uploadImage(libraryId, title, dataUrl, ownerId) {
    const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!match) throw new HttpError(400, '图片资料须为 PNG、JPEG 或 WebP 的 data URL。');
    const [, mime, data] = match;
    const size = Buffer.byteLength(data, 'base64');
    if (size > KB_LIMITS.imageBytes) throw new HttpError(400, `图片不能超过 ${Math.round(KB_LIMITS.imageBytes / 1024 / 1024)} MiB。`);
    const sha256 = crypto.createHash('sha256').update(data, 'base64').digest('hex');
    const existing = this.byHash.get(`${libraryId}:${sha256}`);
    if (existing) return { document: this.documents.get(existing), duplicate: true };
    // Photo of handwritten or printed material: stored now, transcribed into
    // text chunks by the vision model in the generation pipeline.
    const document = validateKnowledge({ id: crypto.randomUUID(), libraryId, sha256, title, format: 'image', size,
      chunks: [], transcribed: false, image: { mime, data }, uploadedAt: new Date(this.clock()).toISOString() });
    this.remember(document); this.save();
    if (this.storage) this.storage.saveKbDocument(document);
    return { document, duplicate: false };
  }
  removeDocument(libraryId, docId, ownerId) {
    this.requireLibrary(libraryId, ownerId, true);
    const document = this.documents.get(docId);
    if (!document || document.libraryId !== libraryId) throw new HttpError(404, '文档不存在。', 'kb_not_found');
    this.documents.delete(docId); this.byHash.delete(`${libraryId}:${document.sha256}`);
    this.save();
    if (this.storage) this.storage.deleteKbDocument(docId);
    return { removed: docId };
  }
  searchChunks(query, { limit = 5, ownerId = null, libraryIds = null } = {}) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) throw new HttpError(400, '请输入要出题的主题或知识点。');
    const allowed = libraryIds || (ownerId ? this.accessibleLibraryIds(ownerId) : null);
    const entries = [];
    for (const document of this.documents.values()) {
      if (document.format === 'image') continue;
      if (allowed && !allowed.includes(document.libraryId)) continue;
      for (const chunk of document.chunks) entries.push({ document, chunk });
    }
    if (!entries.length) return [];
    const df = new Map();
    const countsList = entries.map(entry => {
      const counts = new Map();
      for (const token of tokenize(`${entry.document.title} ${entry.chunk.anchor} ${entry.chunk.text}`)) counts.set(token, (counts.get(token) || 0) + 1);
      for (const token of counts.keys()) df.set(token, (df.get(token) || 0) + 1);
      return counts;
    });
    const averageLength = entries.reduce((sum, entry) => sum + entry.chunk.text.length, 0) / entries.length || 1;
    const k1 = 1.5, b = 0.75, total = entries.length;
    return entries.map((entry, index) => {
        const counts = countsList[index];
        let score = 0;
        for (const token of queryTokens) {
          const frequency = counts.get(token) || 0;
          if (!frequency) continue;
          const idf = Math.log(1 + (total - df.get(token) + 0.5) / (df.get(token) + 0.5));
          score += idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * entry.chunk.text.length / averageLength));
        }
        return { libraryId: entry.document.libraryId, document: { id: entry.document.id, title: entry.document.title }, index: entry.chunk.index,
          anchor: entry.chunk.anchor, text: entry.chunk.text, score: Number(score.toFixed(4)) };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit);
  }
  // Download payload for a library: full documents and chunks, so a learner can
  // take a shared library offline or re-upload it into their own space.
  exportLibrary(id, ownerId) {
    const library = this.requireLibrary(id, ownerId);
    const documents = [...this.documents.values()].filter(document => document.libraryId === id)
      .sort((a, b) => Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt))
      .map(({ image, ...rest }) => rest);
    return { exportVersion: 1, exportedAt: new Date(this.clock()).toISOString(),
      library: { name: library.name, description: library.description }, documents };
  }
}
