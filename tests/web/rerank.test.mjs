import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { rerankDocuments, validateRanking } from '../../server/rerank.mjs';
import { createEmbeddings, EmbeddingRetrieval } from '../../server/embeddings.mjs';
import { LocalEmbeddingStore } from '../../server/embedding-store.mjs';
import { KnowledgeService } from '../../server/knowledge.mjs';
import { AiConfigService } from '../../server/ai-config.mjs';
import { DraftService } from '../../server/question-drafts.mjs';
import { config } from './fixtures.mjs';

const embedding = { enabled: true, authRequired: false, baseUrl: 'http://vectors.example/v1', model: 'vectors', timeout: 600000, minSimilarity: 0.3 };
const rerank = { enabled: true, authRequired: false, baseUrl: 'http://ranking.example/v1', model: 'ranker', timeout: 600000, candidates: 20, minScore: 0.05 };
const vectors = async (_config, inputs) => inputs.map(text => text.includes('追及') || text.includes('赶上') ? [1, 0] : [0, 1]);
const ranking = async (_config, _query, documents) => documents.map((text, index) => ({ index, relevance_score: text.includes('速度差') ? 0.95 : 0.01 }));
async function fixture(t) {
  const knowledge = new KnowledgeService(config, { persist: false });
  const library = knowledge.createLibrary({ name: '行程笔记' }, 'primary');
  const document = knowledge.upload({ libraryId: library.id, title: '追及公式', format: 'text', content: '同向行驶赶上前车，用间隔除以速度差。' }, 'primary').document;
  knowledge.upload({ libraryId: library.id, title: '追及易错概念', format: 'text', content: '注意识别出发方向和距离，避免混淆题意。' }, 'primary');
  const privateLibrary = knowledge.createLibrary({ name: '不属于考生的资料' }, 'other');
  knowledge.upload({ libraryId: privateLibrary.id, title: '追及私密材料', format: 'text', content: '这份速度差材料不能出现在候选或上下文中。' }, 'other');
  const store = new LocalEmbeddingStore(config, knowledge, { persist: false });
  const indexer = new EmbeddingRetrieval(store, { configResolver: async () => embedding, embed: vectors });
  t.after(() => indexer.close()); await indexer.tick();
  return { knowledge, library, document, privateLibrary, store };
}

test('all four embedding/rerank combinations preserve original, permitted citations', async t => {
  const { knowledge, store, document, privateLibrary } = await fixture(t);
  for (const embeddingEnabled of [false, true]) for (const rerankEnabled of [false, true]) {
    await t.test(`embedding=${embeddingEnabled}, rerank=${rerankEnabled}`, async () => {
      let embeds = 0, ranks = 0;
      const retrieval = new EmbeddingRetrieval(store, {
        configResolver: async () => ({ ...embedding, enabled: embeddingEnabled }), rerankResolver: async () => ({ ...rerank, enabled: rerankEnabled }),
        embed: async (cfg, inputs) => { embeds++; assert.equal(cfg.timeout, 7000); return vectors(cfg, inputs); },
        rerank: async (cfg, query, documents) => { ranks++; assert.equal(cfg.timeout, 7000); assert.ok(documents.every(text => !text.includes('私密'))); return ranking(cfg, query, documents); },
      });
      try {
        const result = await retrieval.search('追及', knowledge, { ownerId: 'primary' });
        assert.equal(result.mode, embeddingEnabled ? 'hybrid' : 'keyword'); assert.equal(result.rerank.applied, rerankEnabled);
        assert.equal(embeds, Number(embeddingEnabled)); assert.equal(ranks, Number(rerankEnabled));
        assert.ok(result.items.some(item => item.document.id === document.id));
        const prepared = new DraftService(config, { persist: false }).prepare({ query: '追及', count: 1 }, knowledge, 'primary', result);
        assert.equal(prepared.retrieval.rerank.applied, rerankEnabled); assert.ok(prepared.messages[1].content.includes('速度差'));
        const empty = await retrieval.search('追及', knowledge, { ownerId: 'primary', libraryIds: [privateLibrary.id] });
        assert.equal(empty.items.length, 0); assert.equal(empty.fallback, 'empty');
        assert.equal(embeds, Number(embeddingEnabled)); assert.equal(ranks, Number(rerankEnabled));
      } finally { await retrieval.close(); }
    });
  }
});

test('embedding and rerank faults independently fall back to the remaining useful stage', async t => {
  const { knowledge, store } = await fixture(t);
  const failures = {
    http: async () => new Response('{}', { status: 503 }),
    malformed: async () => new Response('{invalid'),
    invalid: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }], results: [{ index: -1, relevance_score: 0.9 }] })),
    timeout: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  for (const [fault, fetcher] of Object.entries(failures)) {
    for (const [failEmbedding, failRerank] of [[true, false], [false, true], [true, true]]) {
      await t.test(`${fault}: embedding=${failEmbedding}, rerank=${failRerank}`, async () => {
        const retrieval = new EmbeddingRetrieval(store, {
          configResolver: async () => ({ ...embedding, timeout: 40 }), rerankResolver: async () => ({ ...rerank, timeout: 40 }),
          embed: failEmbedding ? (cfg, inputs) => createEmbeddings(cfg, inputs, { fetcher }) : vectors,
          rerank: failRerank ? (cfg, query, documents) => rerankDocuments(cfg, query, documents, { fetcher }) : ranking,
        });
        // Keep the test alive while AbortSignal.timeout's unref'ed timer fires.
        const keepAlive = setInterval(() => {}, 1000), started = Date.now();
        try {
          const result = await retrieval.search('追及', knowledge, { ownerId: 'primary' });
          assert.equal(result.mode, failEmbedding ? 'keyword' : 'hybrid'); assert.equal(result.rerank.applied, !failRerank);
          assert.equal(result.fallback, failEmbedding ? 'unavailable' : null);
          assert.equal(result.rerank.fallback, failRerank ? 'unavailable' : null);
          assert.ok(result.items.some(item => item.document.title === '追及公式'));
          assert.ok(Date.now() - started < 1500); assert.ok(!JSON.stringify(result).includes('HTTP'));
        } finally { clearInterval(keepAlive); await retrieval.close(); }
      });
    }
  }
});

test('rerank adapter checks full permutations and never trusts returned document text', async t => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.end(JSON.stringify(req.url.endsWith('/embeddings') ? { data: [{ index: 0, embedding: [1, 0] }] }
      : { results: [{ index: 1, relevance_score: 0.1, document: { text: 'untrusted replacement' } }, { index: 0, relevance_score: 0.9 }] }));
  }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const cfg = { ...rerank, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'old-key-that-must-not-be-sent', timeout: 1000 };
  assert.deepEqual(await rerankDocuments(cfg, '追及', ['速度差', '氧化']), [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }]);
  await createEmbeddings(cfg, ['追及']); assert.ok(calls.every(call => call.auth === undefined)); assert.equal(calls[0].body.top_n, 2);
  assert.equal(calls[0].url, '/v1/rerank'); assert.equal(calls[0].body.model, 'ranker');
  await rerankDocuments({ ...cfg, authRequired: true, key: 'independent-rerank-test-key' }, '追及', ['速度差', '氧化']);
  assert.equal(calls[2].auth, 'Bearer independent-rerank-test-key');
  for (const results of [[], [{ index: 0, relevance_score: NaN }], [{ index: 0, relevance_score: 2 }], [{ index: 1, relevance_score: 0.9 }], [null]]) assert.throws(() => validateRanking(results, 1));
  assert.throws(() => validateRanking([{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }], 2));
  await assert.rejects(rerankDocuments({ ...cfg, authRequired: true, key: '' }, '追及', ['速度差']), /未配置/);
  await assert.rejects(rerankDocuments(cfg, '追及', ['']));
});

test('missing providers, unready indexes and empty libraries skip unnecessary model calls', async t => {
  const { knowledge, store } = await fixture(t); let embeds = 0, ranks = 0;
  const retrieval = new EmbeddingRetrieval(store, { configResolver: async () => ({}), rerankResolver: async () => ({}),
    embed: async (...args) => { embeds++; return vectors(...args); }, rerank: async (...args) => { ranks++; return ranking(...args); } });
  t.after(() => retrieval.close());
  const missing = await retrieval.search('追及', knowledge, { ownerId: 'primary' });
  assert.equal(missing.mode, 'keyword'); assert.equal(missing.rerank.fallback, 'disabled'); assert.equal(embeds + ranks, 0);
  const unready = await retrieval.search('追及', knowledge, { ownerId: 'primary', config: { ...embedding, model: 'not-indexed-yet' }, rerankConfig: rerank });
  assert.equal(unready.mode, 'keyword'); assert.equal(unready.fallback, 'indexing'); assert.equal(unready.rerank.applied, true); assert.equal(embeds, 0); assert.equal(ranks, 1);
  const emptyLibrary = knowledge.createLibrary({ name: '尚未收录资料' }, 'primary');
  const empty = await retrieval.search('追及', knowledge, { ownerId: 'primary', libraryIds: [emptyLibrary.id], config: embedding, rerankConfig: rerank });
  assert.equal(empty.items.length, 0); assert.equal(empty.fallback, 'empty'); assert.equal(empty.rerank.fallback, 'empty'); assert.equal(embeds, 0); assert.equal(ranks, 1);
});

test('rank cache follows exact current candidates, model and threshold without reviving deleted sources', async t => {
  const { knowledge, library, document, store } = await fixture(t); let current = rerank, calls = 0;
  const retrieval = new EmbeddingRetrieval(store, { configResolver: async () => ({ enabled: false }), rerankResolver: async () => current,
    rerank: async (...args) => { calls++; return ranking(...args); } }); t.after(() => retrieval.close());
  assert.equal((await retrieval.search('追及', knowledge, { ownerId: 'primary' })).items[0].document.id, document.id);
  await retrieval.search('追及', knowledge, { ownerId: 'primary' }); assert.equal(calls, 1);
  current = { ...rerank, minScore: 0.99 }; assert.equal((await retrieval.search('追及', knowledge, { ownerId: 'primary' })).items.length, 0); assert.equal(calls, 1);
  current = { ...rerank, model: 'new-ranker' }; await retrieval.search('追及', knowledge, { ownerId: 'primary' }); assert.equal(calls, 2);
  knowledge.removeDocument(library.id, document.id, 'primary');
  const deleted = await retrieval.search('追及', knowledge, { ownerId: 'primary' }); assert.equal(calls, 3); assert.equal(deleted.items.length, 0);
  current = { ...current, enabled: false }; const disabled = await retrieval.search('追及', knowledge, { ownerId: 'primary' });
  assert.equal(disabled.items.length, 1); assert.equal(disabled.rerank.fallback, 'disabled'); assert.equal(calls, 3);
});

test('rerank bootstrap imports once, independently of existing models and explicit no-auth configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rerank-config-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...config, runtimePath: path.join(root, 'matches'), embedding, rerank }, first = new AiConfigService(cfg);
  assert.equal(first.effectiveConfig().embedding.authRequired, false); assert.equal(first.effectiveConfig().rerank.authRequired, false);
  const old = structuredClone(first.stored); delete old.providers.rerank; delete old.providers.embedding.authRequired;
  fs.writeFileSync(first.filename, JSON.stringify({ version: 1, value: old }));
  const upgraded = new AiConfigService({ ...cfg, embedding: { ...embedding, model: 'stale-vector' } });
  assert.equal(upgraded.effectiveConfig().embedding.model, embedding.model); assert.equal(upgraded.effectiveConfig().embedding.authRequired, true);
  assert.equal(upgraded.effectiveConfig().rerank.model, rerank.model); assert.equal(upgraded.effectiveConfig().rerank.authRequired, false);
  upgraded.update({ provider: 'rerank', enabled: false, clearKey: true, model: 'admin-ranker' });
  const restarted = new AiConfigService({ ...cfg, rerank: { ...rerank, key: 'stale-key', model: 'stale-ranker' } });
  assert.equal(restarted.effectiveConfig().rerank.model, 'admin-ranker'); assert.equal(restarted.effectiveConfig().rerank.enabled, false);
  assert.equal(restarted.effectiveConfig().rerank.key, ''); assert.equal(restarted.effectiveLlm().key, config.llm.key);
  assert.throws(() => restarted.update({ provider: 'rerank', candidates: 1000 }), { status: 400 });
});
