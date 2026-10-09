import crypto from 'node:crypto';
import { HttpError } from './bank.mjs';
import { ragProviderReady, ragRequest } from './rag-providers.mjs';
import { rerankDocuments, validateRanking, selectRanked } from './rerank.mjs';

export const embeddingReady = ragProviderReady;
// Credentials, batch size and ranking thresholds do not change vector space.
export const embeddingIndexKey = config => crypto.createHash('sha256').update(JSON.stringify([
  'knowledge-chunks-v2', config.baseUrl, config.model, config.dimensions || 0,
])).digest('hex');
export const embeddingText = (document, chunk) => `${document.title}\n${chunk.anchor}\n${chunk.text}`;

export function normalizeVector(vector, dimensions = 0) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || (dimensions && vector.length !== dimensions)
    || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Embedding 返回的向量或维度无效。');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('Embedding 返回了无效的零向量。');
  return vector.map(value => value / norm);
}

export async function createEmbeddings(config, input, { signal, fetcher = fetch } = {}) {
  if (!Array.isArray(input) || !input.length || input.length > 64 || input.some(text => typeof text !== 'string' || !text.trim() || text.length > 8000)) throw new Error('Embedding 输入无效。');
  const payload = await ragRequest({ ...config, timeout: config.timeout || 30000 }, 'embeddings',
    { model: config.model, input, encoding_format: 'float', ...(config.dimensions ? { dimensions: config.dimensions } : {}) }, { signal, fetcher });
  if (!Array.isArray(payload.data) || payload.data.length !== input.length) throw new Error('Embedding 返回数量与输入不一致。');
  const vectors = new Array(input.length); let dimensions = config.dimensions || 0;
  for (const item of payload.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || vectors[item.index]) throw new Error('Embedding 返回序号无效。');
    const vector = normalizeVector(item.embedding, dimensions); dimensions ||= vector.length; vectors[item.index] = vector;
  }
  return vectors;
}

export function fuseRankings(keyword, semantic, limit = 5, { maxPerDocument = 3 } = {}) {
  const combined = new Map();
  for (const [kind, list] of [['keyword', keyword], ['semantic', semantic]]) {
    list.forEach((item, rank) => {
      const key = `${item.document.id}:${item.index}`, found = combined.get(key) || { ...item, score: 0, retrieval: [] };
      found.score += 1 / (60 + rank + 1); found.retrieval.push(kind);
      if (kind === 'semantic') found.similarity = item.score;
      combined.set(key, found);
    });
  }
  // A generic lexical hit (e.g. “问题”) must not win a rank tie merely
  // because its document UUID sorts before a precise semantic match.
  const sorted = [...combined.values()].sort((a, b) => b.score - a.score
    || (b.similarity ?? -1) - (a.similarity ?? -1)
    || a.document.id.localeCompare(b.document.id) || a.index - b.index);
  // Keep context useful when one long document has many very similar passages.
  return selectRanked(sorted, limit, maxPerDocument).map(item => ({ ...item, score: Number(item.score.toFixed(6)) }));
}

/** Model requests run outside database transactions; stores fence leased writes. */
export class EmbeddingRetrieval {
  constructor(store, { configResolver, rerankResolver = async () => ({}), embed = createEmbeddings, rerank = rerankDocuments, redis = null, prefix = 'xingce:' } = {}) {
    this.store = store; this.configResolver = configResolver; this.embed = embed; this.redis = redis; this.prefix = prefix;
    this.rerankResolver = rerankResolver; this.rerank = rerank;
    this.id = crypto.randomUUID(); this.cache = new Map(); this.pending = new Map(); this.closed = false; this.lastSync = 0;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 1000); this.timer.unref();
    this.tick().catch(() => {});
  }
  async tick() {
    if (this.closed || this.task) return this.task;
    this.task = this.work();
    try { await this.task; } finally { this.task = null; }
  }
  async work() {
    const config = await this.configResolver(); if (!embeddingReady(config)) return;
    const key = embeddingIndexKey(config);
    if (Date.now() - this.lastSync > 15000 || key !== this.syncedKey) {
      await this.store.sync(key); this.lastSync = Date.now(); this.syncedKey = key;
    }
    const lease = (config.timeout || 30000) + 30000;
    const rows = await this.store.claim(key, config.batchSize || 16, this.id, lease);
    if (!rows.length || this.closed) return;
    this.controller = new AbortController();
    try {
      const vectors = await this.embed(config, rows.map(row => row.text), { signal: this.controller.signal });
      // Already-issued requests can finish into their own versioned index.
      // Searches read only the current version; a rebuild fences old leases.
      if (this.closed) return;
      await this.store.complete(key, rows, vectors, this.id);
    } catch {
      // Store a fixed message only: upstream responses can contain credentials.
      await this.store.fail(key, rows, this.id, '向量生成失败，请检查模型连接后重试。').catch(() => {});
    } finally { this.controller = null; }
  }
  async refresh({ force = false } = {}) {
    const config = await this.configResolver();
    if (!embeddingReady(config)) throw new HttpError(409, '请先保存并启用 Embedding 模型配置。', 'embedding_not_configured');
    await this.store.sync(embeddingIndexKey(config), { force, retry: true }); this.lastSync = Date.now();
    this.tick().catch(() => {}); return this.status();
  }
  async status() {
    const config = await this.configResolver(), ready = embeddingReady(config);
    const rerank = await this.rerankResolver();
    return { configured: ready, model: config.model || '', rerank: { configured: ragProviderReady(rerank), model: rerank.model || '' }, ...(await this.store.status(embeddingIndexKey(config))) };
  }
  async queryVector(config, query, generation = 'initial') {
    const key = this.prefix + 'embedding:query:' + embeddingIndexKey(config) + ':' + generation + ':' + crypto.createHash('sha256').update(query).digest('hex');
    const saved = this.cache.get(key); if (saved?.until > Date.now()) return saved.vector;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = (async () => {
      if (this.redis?.isReady) {
        try { const cached = await this.redis.withAbortSignal(AbortSignal.timeout(1000)).get(key); if (cached) return normalizeVector(JSON.parse(cached), config.dimensions); } catch { /* cache is optional */ }
      }
      const [vector] = await this.embed({ ...config, timeout: Math.min(config.timeout || 30000, 7000) }, [query]);
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { vector, until: Date.now() + 300000 });
      if (this.redis?.isReady) await this.redis.withAbortSignal(AbortSignal.timeout(1000)).set(key, JSON.stringify(vector), { EX: 300 }).catch(() => {});
      return vector;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  async ranked(config, query, candidates) {
    const documents = candidates.map(item => `${item.document.title}\n${item.anchor}\n${item.text}`);
    const key = this.prefix + 'rerank:query:' + crypto.createHash('sha256').update(JSON.stringify([config.baseUrl, config.model, query, documents])).digest('hex');
    const saved = this.cache.get(key); if (saved?.until > Date.now()) return saved.ranking;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      if (this.redis?.isReady) {
        try { const cached = await this.redis.withAbortSignal(AbortSignal.timeout(1000)).get(key); if (cached) return validateRanking(JSON.parse(cached), candidates.length); } catch { /* optional cache */ }
      }
      const ranking = validateRanking(await this.rerank({ ...config, timeout: Math.min(config.timeout || 15000, 7000) }, query, documents), candidates.length);
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { ranking, until: Date.now() + 120000 });
      if (this.redis?.isReady) await this.redis.withAbortSignal(AbortSignal.timeout(1000)).set(key, JSON.stringify(ranking), { EX: 120 }).catch(() => {});
      return ranking;
    })();
    this.pending.set(key, task); try { return await task; } finally { this.pending.delete(key); }
  }
  async search(query, knowledge, { ownerId, libraryIds = null, limit = 5, config, rerankConfig } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 100) throw new HttpError(400, '请输入 1—100 字的检索问题。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new HttpError(400, '检索数量须为 1—20。');
    const allowed = knowledge.accessibleLibraryIds(ownerId).filter(id => !libraryIds || libraryIds.includes(id));
    const ranker = rerankConfig || await this.rerankResolver(), reranking = ragProviderReady(ranker);
    const candidateLimit = reranking ? ranker.candidates || 20 : 20;
    const keyword = knowledge.searchChunks(query, { ownerId, libraryIds: allowed, limit: candidateLimit });
    const settings = config || await this.configResolver();
    let candidates = keyword, mode = 'keyword', fallback = 'disabled';
    if (!allowed.length) fallback = 'empty';
    else if (embeddingReady(settings)) {
      try {
        const counts = await this.store.status(embeddingIndexKey(settings), { ownerId, libraryIds: allowed });
        if (!counts.total) fallback = 'empty';
        else if (!counts.ready) fallback = 'indexing';
        else {
          const vector = await this.queryVector(settings, query.trim(), counts.generation);
          const semantic = await this.store.search(embeddingIndexKey(settings), vector, { ownerId, libraryIds: allowed, limit: candidateLimit, minSimilarity: settings.minSimilarity ?? 0.3, generation: counts.generation });
          candidates = fuseRankings(keyword, semantic, candidateLimit, { maxPerDocument: reranking ? Infinity : 3 });
          mode = 'hybrid'; fallback = counts.ready < counts.total ? 'indexing' : null;
        }
      } catch { fallback = 'unavailable'; }
    }
    const result = { items: selectRanked(candidates, limit), mode, fallback, rerank: { applied: false, fallback: reranking ? 'empty' : 'disabled' } };
    if (reranking && candidates.length) {
      try {
        const ranking = await this.ranked(ranker, query.trim(), candidates);
        const reordered = ranking.filter(item => item.relevance_score >= (ranker.minScore ?? 0.05))
          .map(item => ({ ...candidates[item.index], rerankScore: item.relevance_score }));
        return { ...result, items: selectRanked(reordered, limit), rerank: { applied: true, model: ranker.model, fallback: null } };
      } catch { result.rerank = { applied: false, fallback: 'unavailable' }; }
    }
    return result;
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.task?.catch(() => {}); }
}
