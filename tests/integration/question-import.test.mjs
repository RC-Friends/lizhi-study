import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { prepareQuestionImport } from '../../scripts/import-questions.mjs';
import { uploadResources } from '../../scripts/upload-resources.mjs';
import { loadQuestionResources } from '../../server/resource-loader.mjs';
import { LiveResources, configuredResourceVersion } from '../../server/live-resources.mjs';
import { DistributedRuntime } from '../../server/distributed.mjs';
import { MatchService } from '../../server/matches.mjs';
import { createApp } from '../../server/app.mjs';
import { config } from '../web/fixtures.mjs';

for (const key of ['TEST_DATABASE_URL', 'TEST_REDIS_URL', 'TEST_S3_ENDPOINT']) if (!process.env[key] || !['127.0.0.1', 'localhost'].includes(new URL(process.env[key]).hostname)) throw new Error('Use isolated loopback TEST_* services.');
test('standard imports activate immediately across replicas and survive restarts without changing old records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-live-import-')); t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.cpSync('examples/question-bank', path.join(root, 'input'), { recursive: true });
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'input/questions.json'))), first = path.join(root, 'first.json');
  fs.writeFileSync(first, JSON.stringify({ ...doc, questions: [doc.questions[0]] }));
  const original = prepareQuestionImport({ input: first, output: path.join(root, 'base') });
  const next = prepareQuestionImport({ input: path.join(root, 'input/questions.json'), base: path.join(root, 'base'), output: path.join(root, 'next') });
  const reader = { endpoint: process.env.TEST_S3_ENDPOINT, bucket: process.env.TEST_S3_BUCKET, accessKey: process.env.TEST_S3_READER_KEY,
    secretKey: process.env.TEST_S3_READER_SECRET, prefix: 'live-import-' + crypto.randomUUID() };
  const publisher = { ...reader, accessKey: process.env.TEST_S3_PUBLISHER_KEY, secretKey: process.env.TEST_S3_PUBLISHER_SECRET };
  await uploadResources(path.join(root, 'base'), publisher);
  const configuration = { ...config, llm: { ...config.llm }, databaseUrl: process.env.TEST_DATABASE_URL, redisUrl: process.env.TEST_REDIS_URL,
    redisPrefix: 'import-test:' + crypto.randomUUID() + ':', resourceDriver: 's3', storageDriver: 'postgres', s3: reader, resourceVersion: original.version,
    questionImport: { token: 'operator-test-' + crypto.randomUUID(), accessKey: publisher.accessKey, secretKey: publisher.secretKey } };
  const nodes = [];
  const make = async () => {
    const settings = { ...configuration, llm: { ...configuration.llm }, resourceVersion: await configuredResourceVersion(configuration) };
    const { bank, resources } = await loadQuestionResources(settings), resourceManager = new LiveResources(settings, bank, resources);
    const runtime = await DistributedRuntime.open(bank, settings, { worker: false, resourceManager });
    const service = new MatchService(bank, settings, { persist: false }), app = createApp(bank, service, settings, { runtime });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const node = { base: 'http://127.0.0.1:' + server.address().port, runtime, server, app, service, settings }; nodes.push(node); return node;
  };
  t.after(async () => { for (const node of nodes) { node.server.closeAllConnections(); await new Promise(r => node.server.close(r)); node.app.locals.coach.shutdown(); node.service.shutdown(); await node.runtime.close(); } });
  const a = await make(), b = await make();
  const call = async (node, url, { body, token, method = body === undefined ? 'GET' : 'POST', binary = false } = {}) => {
    const response = await fetch(node.base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const admin = configuration.questionImport.token, learner = (await call(a, '/api/login', { body: { password: config.sitePassword } })).value.token;
  const match = (await call(a, '/api/matches', { token: learner, body: { mode: 'practice', modules: ['数量关系'], count: 1, source: 'mock', images: 'text' } })).value.match;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'next/manifest.json')));
  const target = '/api/admin/question-bank/releases/' + next.version;
  await t.test('partial uploads remain unavailable, separate admin authentication and file hashes are enforced', async () => {
    assert.equal((await call(a, '/api/admin/question-bank/schema', { token: learner })).status, 401);
    const file = manifest.files[0], bytes = fs.readFileSync(path.join(root, 'next', file.path));
    assert.equal((await call(a, `${target}/files?path=${encodeURIComponent(file.path)}`, { method: 'PUT', token: admin, body: bytes, binary: true })).status, 201);
    assert.equal((await call(b, target + '/publish', { token: admin, body: manifest })).status, 503);
    assert.equal((await call(b, target, { token: admin })).status, 404);
    assert.equal((await call(b, '/api/catalog')).value.bank.total, 1);
    const image = manifest.files[1];
    assert.equal((await call(a, `${target}/files?path=${encodeURIComponent(image.path)}`, { method: 'PUT', token: admin, body: Buffer.from('not an image'), binary: true })).status, 422);
  });
  await t.test('one replica publishes; a transaction racing activation retries with the committed resource version', async () => {
    for (const file of manifest.files) {
      const response = await call(b, `${target}/files?path=${encodeURIComponent(file.path)}`, { method: 'PUT', token: admin, body: fs.readFileSync(path.join(root, 'next', file.path)), binary: true });
      assert.ok([200, 201].includes(response.status));
    }
    let release, entered; const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    const acquire = a.runtime.resourceManager.acquireCurrent.bind(a.runtime.resourceManager); let once = true;
    a.runtime.resourceManager.acquireCurrent = async client => { const result = await acquire(client); if (once) { once = false; entered(); await gate; } return result; };
    const racing = a.runtime.run(({ service }) => service.bank.catalog().total, { readOnly: true }); await ready;
    try {
      const published = await call(b, target + '/publish', { token: admin, body: manifest });
      assert.equal(published.status, 201, JSON.stringify(published.value)); assert.equal(published.value.active, true); assert.equal(published.value.restartRequired, false);
    } finally { release(); }
    assert.equal(await racing, 3);
    for (const node of [a, b]) {
      const catalog = await call(node, '/api/catalog'); assert.equal(catalog.value.bank.total, 3); assert.equal(catalog.value.resourceVersion, next.version);
      assert.equal((await fetch(node.base + '/' + manifest.files[1].path)).status, 200);
      assert.equal((await call(node, '/api/health')).status, 200);
    }
    assert.equal((await call(a, target + '/publish', { token: admin, body: manifest })).status, 200);
  });
  await t.test('existing questions, scores and login remain valid; stale env cannot revert an import after restart', async () => {
    const answered = await call(b, `/api/matches/${match.id}/answer`, { token: learner, body: { index: 0, choice: 'D' } });
    assert.equal(answered.status, 200); assert.equal(answered.value.scores.human, 1);
    const c = await make(); assert.equal(c.settings.resourceVersion, next.version);
    assert.equal((await call(c, `/api/matches/${match.id}`, { token: learner })).value.scores.human, 1);
    assert.equal((await call(c, '/api/catalog')).value.bank.total, 3);
    await assert.rejects(c.runtime.activateResources(original.version), e => e.status === 409);
    assert.equal((await call(c, '/api/catalog')).value.bank.total, 3);
  });
});
