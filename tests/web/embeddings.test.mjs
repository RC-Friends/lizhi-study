import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createEmbeddings, normalizeVector, EmbeddingRetrieval, embeddingIndexKey, fuseRankings } from '../../server/embeddings.mjs';
import { LocalEmbeddingStore } from '../../server/embedding-store.mjs';
import { KnowledgeService, chunkDocument, KB_LIMITS } from '../../server/knowledge.mjs';
import { AiConfigService } from '../../server/ai-config.mjs';
import { DraftService } from '../../server/question-drafts.mjs';
import { config } from './fixtures.mjs';

const model = { enabled: true, baseUrl: 'http://embedding.example/v1', key: 'separate-embedding-test-key', model: 'test-vectors', dimensions: 0, batchSize: 2, timeout: 1000, minSimilarity: 0.3 };
const vectorFor = text => text.includes('追及') || text.includes('赶上') ? [1, 0, 0] : [0, 1, 0];
function fixture() {
  const knowledge = new KnowledgeService(config, { persist: false });
  const mine = knowledge.createLibrary({ name: '公式笔记' }, 'primary');
  const other = knowledge.createLibrary({ name: '别人的笔记' }, 'someone-else');
  const document = knowledge.upload({ libraryId: mine.id, title: '车辆笔记', format: 'text', content: '同向行驶的两车，赶上的时刻用初始间隔除以快慢差。' }, 'primary').document;
  knowledge.upload({ libraryId: mine.id, title: '化学笔记', format: 'text', content: '金属生锈是一种缓慢氧化现象。' }, 'primary');
  knowledge.upload({ libraryId: other.id, title: '私密车辆材料', format: 'text', content: '赶上需要使用速度差，这份材料禁止越权读取。' }, 'someone-else');
  return { knowledge, mine, other, document };
}

test('embedding adapter validates, normalizes and reorders real HTTP responses', async t => {
  const bodies = [], headers = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    bodies.push(JSON.parse(body)); headers.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 4, 0] }, { index: 0, embedding: [3, 0, 0] }] }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await createEmbeddings({ ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, dimensions: 3 }, ['追及', '化学']);
  assert.deepEqual(result, [[1, 0, 0], [0, 1, 0]]); assert.equal(headers[0], `Bearer ${model.key}`);
  assert.equal(bodies[0].dimensions, 3); assert.equal(bodies[0].encoding_format, 'float');
  assert.throws(() => normalizeVector([0, 0])); assert.throws(() => normalizeVector([1, NaN])); assert.throws(() => normalizeVector([1, 0], 3));
  await assert.rejects(createEmbeddings(model, ['a', 'b'], { fetcher: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] })) }), /序号/);
});

test('hybrid RAG finds synonyms, respects private libraries and caches only query vectors', async t => {
  const { knowledge, mine, document } = fixture(), calls = []; let current = model;
  const store = new LocalEmbeddingStore(config, knowledge, { persist: false });
  const retrieval = new EmbeddingRetrieval(store, { configResolver: async () => current, embed: async (_config, inputs) => { calls.push(inputs); return inputs.map(vectorFor); } });
  t.after(() => retrieval.close());
  await retrieval.tick(); await retrieval.tick();
  assert.deepEqual(knowledge.searchChunks('追及问题', { ownerId: 'primary' }), []);
  const semantic = await retrieval.search('追及问题', knowledge, { ownerId: 'primary' });
  assert.equal(semantic.mode, 'hybrid'); assert.equal(semantic.items[0].document.id, document.id); assert.equal(semantic.items.length, 1);
  assert.ok(semantic.items[0].retrieval.includes('semantic')); assert.equal(semantic.items[0].similarity, 1);
  const before = calls.length; await retrieval.search('追及问题', knowledge, { ownerId: 'primary' }); assert.equal(calls.length, before);
  const drafts = new DraftService(config, { persist: false });
  const prepared = drafts.prepare({ query: '追及问题', count: 1 }, knowledge, 'primary', semantic);
  assert.ok(prepared.messages[1].content.includes('初始间隔除以快慢差')); assert.equal(prepared.retrieval.mode, 'hybrid');
  current = { ...model, model: 'changed-vector-model' };
  const changed = await retrieval.search('追及问题', knowledge, { ownerId: 'primary' });
  assert.equal(changed.fallback, 'indexing'); assert.equal(changed.items.length, 0);
  current = model; knowledge.removeDocument(mine.id, document.id, 'primary');
  assert.equal((await retrieval.search('追及问题', knowledge, { ownerId: 'primary' })).items.length, 0);
});

test('failed or disabled embeddings preserve keyword retrieval and do not reuse another model index', async t => {
  const { knowledge } = fixture(), store = new LocalEmbeddingStore(config, knowledge, { persist: false });
  let failing = false, current = model;
  const retrieval = new EmbeddingRetrieval(store, { configResolver: async () => current, embed: async (_config, inputs) => { if (failing) throw new Error('secret upstream detail'); return inputs.map(vectorFor); } });
  t.after(() => retrieval.close()); await retrieval.tick(); await retrieval.tick(); failing = true;
  const result = await retrieval.search('生锈', knowledge, { ownerId: 'primary' });
  assert.equal(result.mode, 'keyword'); assert.equal(result.fallback, 'unavailable'); assert.equal(result.items[0].document.title, '化学笔记');
  current = { ...model, enabled: false }; assert.equal((await retrieval.search('生锈', knowledge, { ownerId: 'primary' })).fallback, 'disabled');
  assert.notEqual(embeddingIndexKey(model), embeddingIndexKey({ ...model, dimensions: 3 }));
  assert.equal(embeddingIndexKey(model), embeddingIndexKey({ ...model, key: 'rotated-key', batchSize: 8, minSimilarity: 0.8 }));
});

test('expired embedding leases cannot overwrite the new worker and vectors persist across restart', async t => {
  const { knowledge } = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); let now = 1000;
  const cfg = { ...config, runtimePath: path.join(root, 'matches') }, store = new LocalEmbeddingStore(cfg, knowledge, { clock: () => now });
  const key = embeddingIndexKey(model); await store.sync(key);
  const first = await store.claim(key, 1, 'old-worker', 100); now += 200;
  const second = await store.claim(key, 1, 'new-worker', 100);
  await store.complete(key, first, [[0, 1, 0]], 'old-worker'); assert.equal((await store.status(key)).ready, 0);
  await store.complete(key, second, [[1, 0, 0]], 'new-worker'); assert.equal((await store.status(key)).ready, 1);
  const restarted = new LocalEmbeddingStore(cfg, knowledge); assert.equal((await restarted.status(key)).ready, 1);
  await restarted.sync(key, { force: true }); assert.equal((await restarted.status(key)).ready, 0);
});

test('embedding bootstrap imports once and upgrades only the new provider without overwriting existing model settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-config-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...config, runtimePath: path.join(root, 'matches'), embedding: model };
  const first = new AiConfigService(cfg); assert.equal(first.effectiveConfig().embedding.key, model.key);
  first.update({ provider: 'embedding', model: 'managed-by-admin', clearKey: true });
  const restarted = new AiConfigService({ ...cfg, embedding: { ...model, key: 'stale-environment-key' } });
  assert.equal(restarted.effectiveConfig().embedding.model, 'managed-by-admin'); assert.equal(restarted.effectiveConfig().embedding.key, '');
  const old = structuredClone(first.stored); delete old.providers.embedding;
  fs.writeFileSync(first.filename, JSON.stringify({ version: 1, value: old }));
  const upgraded = new AiConfigService({ ...cfg, llm: { key: 'must-not-import-existing-llm-key' } });
  assert.equal(upgraded.effectiveConfig().embedding.key, model.key);
  assert.equal(upgraded.effectiveLlm().key, config.llm.key);
  assert.equal(new AiConfigService({ ...cfg, embedding: { ...model, key: 'must-not-reimport-embedding-key' } }).effectiveConfig().embedding.key, model.key);
});

test('an in-flight batch finishes into its original version while a changed model starts with an empty index', async t => {
  const { knowledge } = fixture(), store = new LocalEmbeddingStore(config, knowledge, { persist: false });
  let current = model, release;
  const gate = new Promise(resolve => { release = resolve; });
  const retrieval = new EmbeddingRetrieval(store, { configResolver: async () => current, embed: async (_config, inputs) => { await gate; return inputs.map(vectorFor); } });
  t.after(() => retrieval.close());
  const task = retrieval.tick();
  while ((await store.status(embeddingIndexKey(model))).working === 0) await new Promise(resolve => setImmediate(resolve));
  current = { ...model, model: 'new-semantic-space' }; release(); await task;
  assert.equal((await store.status(embeddingIndexKey(model))).ready, 2);
  assert.equal((await store.status(embeddingIndexKey(current))).ready, 0);
  assert.equal((await retrieval.search('追及问题', knowledge, { ownerId: 'primary' })).fallback, 'indexing');
});

test('hard chunk bounds apply to unpunctuated text and RRF merges both sources deterministically', () => {
  const content = '无标点讲义内容'.repeat(400), chunks = chunkDocument('text', content);
  assert.equal(chunks.map(chunk => chunk.text).join(''), content); assert.ok(chunks.every(chunk => chunk.text.length <= KB_LIMITS.chunkChars));
  const a = { document: { id: 'a' }, index: 0, score: 2 }, b = { document: { id: 'b' }, index: 0, score: 0.95 };
  const result = fuseRankings([a, b], [b, a]); assert.equal(result.length, 2); assert.deepEqual(result[0].retrieval, ['keyword', 'semantic']);
  assert.equal(fuseRankings([a], [b])[0].document.id, 'b');
});
