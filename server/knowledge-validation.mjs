import { MODULES } from './bank.mjs';
const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const FORMATS = ['markdown', 'text', 'image', 'pdf', 'docx'];
const VISIBILITIES = ['private', 'public'];

export function validateLibrary(library) {
  if (!library || typeof library.id !== 'string' || !library.id || typeof library.ownerId !== 'string' || !library.ownerId
    || typeof library.name !== 'string' || !library.name || typeof library.description !== 'string'
    || !VISIBILITIES.includes(library.visibility) || !Number.isFinite(Date.parse(library.createdAt))) throw new Error('资料库结构无效。');
  return library;
}

export function validateKnowledge(document) {
  if (!document || typeof document.id !== 'string' || !document.id || typeof document.libraryId !== 'string' || !document.libraryId
    || typeof document.sha256 !== 'string' || !FORMATS.includes(document.format) || typeof document.title !== 'string' || !document.title
    || !Number.isFinite(document.size) || !Number.isFinite(Date.parse(document.uploadedAt))
    || !Array.isArray(document.chunks)) throw new Error('知识库文档结构无效。');
  if (document.format === 'image') {
    if (document.transcribed !== false || !document.image || typeof document.image.mime !== 'string'
      || typeof document.image.data !== 'string' || !document.image.data) throw new Error('图片资料结构无效。');
    return document;
  }
  if (!document.chunks.length) throw new Error('知识库切片结构无效。');
  for (const [index, chunk] of document.chunks.entries()) {
    if (chunk.index !== index || typeof chunk.anchor !== 'string' || typeof chunk.text !== 'string' || !chunk.text) throw new Error('知识库切片结构无效。');
  }
  return document;
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

