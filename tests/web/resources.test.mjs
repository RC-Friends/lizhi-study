import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { packageResources, verifyResources } from '../../scripts/package-resources.mjs';
import { readLegacy } from '../../scripts/import-legacy.mjs';
import { resolveQuestionImage } from '../../server/resources.mjs';
import { multimodalContent } from '../../server/providers.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { createApp } from '../../server/app.mjs';
import { question, config, settings } from './fixtures.mjs';

test('external resource release is portable, deterministic, checked, and shared by HTTP and model images', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingce-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagesPath = path.join(root, 'source-images'); fs.mkdirSync(imagesPath);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(imagesPath, 'one.png'), bytes);
  const q = { ...question, images: [{ path: 'assets/images/one.png', role: 'stem' }], stem_html: '<img src="assets/images/one.png">' };
  const dataPath = path.join(root, 'source.jsonl'); fs.writeFileSync(dataPath, JSON.stringify(q) + '\n');
  const output = path.join(root, 'release');
  const manifest = packageResources({ dataPath, imagesPath, output });
  const duplicate = packageResources({ dataPath, imagesPath, output: path.join(root, 'identical') });
  assert.equal(manifest.version, duplicate.version); assert.equal(manifest.images, 1);
  fs.rmSync(imagesPath, { recursive: true }); fs.unlinkSync(dataPath);
  const externalImages = path.join(output, 'assets/images');
  const content = await multimodalContent(q, externalImages);
  assert.equal(content.find(item => item.type === 'image_url').image_url.url, 'data:image/png;base64,' + bytes.toString('base64'));
  const bank = new QuestionBank(path.join(output, 'questions.jsonl'));
  const configuration = { ...config, imagesPath: externalImages };
  const service = new MatchService(bank, configuration, { persist: false });
  const app = createApp(bank, service, configuration), server = app.listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { service.shutdown(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = await fetch(base + '/assets/images/one.png'); assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  for (const filename of ['/questions.jsonl', '/manifest.json', '/resources/questions.jsonl', '/assets/images/../../questions.jsonl']) assert.equal((await fetch(base + filename)).status, 404);
  assert.throws(() => resolveQuestionImage('assets/images/../../source.jsonl', externalImages), /路径/);
  fs.symlinkSync(path.join(output, 'questions.jsonl'), path.join(externalImages, 'escape.png'));
  assert.throws(() => resolveQuestionImage('assets/images/escape.png', externalImages), /越界/);
  fs.writeFileSync(path.join(externalImages, 'one.png'), 'corrupted');
  assert.throws(() => verifyResources(output), /校验失败/);
  assert.throws(() => packageResources({ dataPath, imagesPath, output }), /已存在/);
});

test('legacy import preview validates every record and never silently drops damaged or orphaned data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingce-import-'));
  try {
    const bank = new QuestionBank(null, [question]);
    const service = new MatchService(bank, { ...config, runtimePath: path.join(root, 'matches') });
    service.create({ ...settings, mode: 'practice' }, { ownerId: 'primary' });
    const snapshot = readLegacy(root, bank);
    assert.equal(snapshot.matches.length, 1); assert.equal(snapshot.matches[0].questionFingerprints[0], bank.fingerprints.get(question.id));
    assert.deepEqual(readLegacy(root, bank), snapshot);
    const filename = path.join(root, 'matches/broken.json'); fs.writeFileSync(filename, '{');
    assert.throws(() => readLegacy(root, bank)); fs.unlinkSync(filename);
    assert.throws(() => readLegacy(root, new QuestionBank(null, [])), /缺少/);
    fs.writeFileSync(path.join(root, 'learning.json'), JSON.stringify({ version: 1, profiles: {}, questions: { primary: { removed: { note: 'keep me' } } } }));
    assert.throws(() => readLegacy(root, bank), /题目不可用/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
