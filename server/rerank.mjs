import { ragRequest } from './rag-providers.mjs';

export function validateRanking(results, count) {
  if (!Array.isArray(results) || results.length !== count) throw new Error('Rerank 返回数量与候选片段不一致。');
  const seen = new Set();
  for (const item of results) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || seen.has(item.index)
      || !Number.isFinite(item.relevance_score) || item.relevance_score < 0 || item.relevance_score > 1) throw new Error('Rerank 返回序号或相关度无效。');
    seen.add(item.index);
  }
  // Returned document bodies are ignored; only original source text is trusted.
  return results.map(({ index, relevance_score }) => ({ index, relevance_score }))
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
}

export async function rerankDocuments(config, query, documents, options = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || !Array.isArray(documents) || !documents.length
    || documents.length > 100 || documents.some(text => typeof text !== 'string' || !text.trim() || text.length > 8000)) throw new Error('Rerank 输入无效。');
  const result = await ragRequest(config, 'rerank', { model: config.model, query, documents, top_n: documents.length }, options);
  return validateRanking(result.results, documents.length);
}

export function selectRanked(items, limit, maxPerDocument = 3) {
  const selected = [], counts = new Map();
  for (const item of items) {
    const count = counts.get(item.document.id) || 0; if (count >= maxPerDocument) continue;
    selected.push(item); counts.set(item.document.id, count + 1); if (selected.length === limit) break;
  }
  return selected;
}
