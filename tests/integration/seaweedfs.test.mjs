import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ObjectResources } from '../../server/object-resources.mjs';
import { packageResources } from '../../scripts/package-resources.mjs';
import { uploadResources } from '../../scripts/upload-resources.mjs';
import { loadQuestionResources } from '../../server/resource-loader.mjs';
import { multimodalContent, runJev } from '../../server/providers.mjs';
import { MatchService } from '../../server/matches.mjs';
import { createApp } from '../../server/app.mjs';
import { question, config, streamingResponse } from '../web/fixtures.mjs';

const endpoint = process.env.TEST_S3_ENDPOINT;
if (!endpoint || !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)) throw new Error('Use a loopback TEST_S3_ENDPOINT for an isolated SeaweedFS test container.');
const settings = { endpoint, bucket: process.env.TEST_S3_BUCKET, accessKey: process.env.TEST_S3_READER_KEY, secretKey: process.env.TEST_S3_READER_SECRET,
  prefix: 'integration-' + crypto.randomUUID() };
const writer = { ...settings, accessKey: process.env.TEST_S3_PUBLISHER_KEY, secretKey: process.env.TEST_S3_PUBLISHER_SECRET };

test('private SeaweedFS resource releases', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingce-seaweed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagesPath = path.join(root, 'images'); fs.mkdirSync(imagesPath);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(imagesPath, 'fixture.png'), image);
  const q = { ...question, stem_html: '<img src="assets/images/fixture.png">', images: [{ role: 'stem', path: 'assets/images/fixture.png' }] };
  const dataPath = path.join(root, 'questions.jsonl'); fs.writeFileSync(dataPath, JSON.stringify(q) + '\n');
  const source = path.join(root, 'bundle'), manifest = packageResources({ dataPath, imagesPath, output: source });
  const reader = new ObjectResources(settings, manifest.version), publisher = new ObjectResources(writer, manifest.version);
  t.after(() => { reader.close(); publisher.close(); });

  await t.test('partial uploads are unavailable until the verified manifest is published', async () => {
    const file = manifest.files[0];
    await publisher.publishFile(file, fs.readFileSync(path.join(source, file.path)));
    await assert.rejects(reader.load(), /无法加载/);
    const result = await uploadResources(source, writer);
    assert.equal(result.uploaded, 1); assert.equal(result.reused, 1); assert.equal(result.verified, true);
    assert.equal((await reader.load())[0].id, q.id);
    const repeated = await uploadResources(source, writer);
    assert.equal(repeated.uploaded, 0); assert.equal(repeated.reused, 2);
  });
  await t.test('anonymous users cannot read the answer bank and runtime credentials cannot upload', async () => {
    const response = await fetch(`${endpoint}/${settings.bucket}/${reader.prefix}questions.jsonl`);
    assert.equal(response.status, 403);
    await assert.rejects(reader.send(PutObjectCommand, { Key: reader.prefix + 'forbidden.txt', Body: 'forbidden' }), error => error.$metadata?.httpStatusCode === 403);
  });
  await t.test('the app and all model image paths work without any local question files', async () => {
    const configuration = { ...config, llm: { ...config.llm }, resourceDriver: 's3', s3: settings, resourceVersion: manifest.version,
      dataPath: '/nonexistent/questions.jsonl', imagesPath: '/nonexistent/images' };
    const { bank, resources } = await loadQuestionResources(configuration);
    const service = new MatchService(bank, configuration, { persist: false }), app = createApp(bank, service, configuration);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(base + '/api/health')).status, 200);
      const response = await fetch(base + '/assets/images/fixture.png');
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
      for (const route of ['/manifest.json', '/questions.jsonl', '/resources/questions.jsonl', '/assets/images/unknown.png']) assert.equal((await fetch(base + route)).status, 404);
      const content = await multimodalContent(q, configuration.imagesPath, resources);
      assert.equal(content.find(part => part.type === 'image_url').image_url.url, 'data:image/png;base64,' + image.toString('base64'));
      let calls = 0;
      const result = await runJev(q, configuration, { signal: AbortSignal.timeout(30000), emit: () => {}, fetcher: async (_url, request) => {
        calls++; const body = JSON.parse(request.body);
        if (calls === 1) { assert.ok(body.messages[1].content.some(part => part.image_url)); return streamingResponse([{ choices: [{ delta: { content: '图片转写测试。' }, finish_reason: 'stop' }] }, '[DONE]']); }
        assert.ok(!JSON.stringify(body).includes('base64'));
        return Response.json({ model: 'jev-test', answers: { answer: { type: 'choice', choice: 'D', probabilities: { A: .1, B: .1, C: .1, D: .7 }, confidence: .8 } } });
      } });
      assert.equal(result.choice, 'D'); assert.equal(calls, 2);
    } finally { service.shutdown(); resources.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await t.test('corrupt objects fail checksum validation and re-upload never silently overwrites them', async () => {
    await publisher.send(PutObjectCommand, { Key: publisher.prefix + 'assets/images/fixture.png', Body: Buffer.alloc(image.length) });
    await assert.rejects(reader.image('assets/images/fixture.png'), /不可用/);
    await assert.rejects(uploadResources(source, writer), /不同内容/);
  });
});
