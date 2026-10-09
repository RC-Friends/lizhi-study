import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiConfigService } from '../../server/ai-config.mjs';
import { config } from './fixtures.mjs';

test('original PR flat settings migrate once into independently managed providers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ai-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configuration = { ...config, aiConfigPath: path.join(directory, 'ai-config.json') };
  fs.writeFileSync(configuration.aiConfigPath, JSON.stringify({ version: 1, value: {
    baseUrl: 'https://saved.example/v1', apiKey: 'original-pr-model-key', model: 'saved-model',
  } }));
  const migrated = new AiConfigService(configuration);
  assert.equal(migrated.effectiveLlm().key, 'original-pr-model-key');
  assert.equal(migrated.effectiveLlm().baseUrl, 'https://saved.example/v1');
  assert.equal(migrated.effectiveLlm().model, 'saved-model');
  assert.equal(migrated.effectiveConfig().jev.key, config.jev.key);
  assert.equal(migrated.stored.version, 2);
  assert.equal(migrated.masked().providers.llm.keyTail, '-key');
  migrated.update({ provider: 'llm', clearKey: true, enabled: false });
  const restarted = new AiConfigService({ ...configuration, llm: { ...config.llm, key: 'changed-environment-secret' } });
  assert.equal(restarted.effectiveLlm().key, '');
  assert.equal(restarted.effectiveLlm().baseUrl, 'https://saved.example/v1');
  assert.equal(restarted.effectiveLlm().model, 'saved-model');
});

test('legacy address edits never send bootstrap credentials to another service', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ai-address-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configuration = { ...config, aiConfigPath: path.join(directory, 'ai-config.json') };
  fs.writeFileSync(configuration.aiConfigPath, JSON.stringify({ version: 1, value: {
    baseUrl: 'https://other.example/v1', apiKey: '', model: 'other-model',
  } }));
  const migrated = new AiConfigService(configuration);
  assert.equal(migrated.ready(), false);
  assert.equal(migrated.effectiveLlm().key, '');
  assert.equal(migrated.effectiveConfig().vision.key, config.vision.key);
});
