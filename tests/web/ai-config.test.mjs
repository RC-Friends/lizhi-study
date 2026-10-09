import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiConfigService } from '../../server/ai-config.mjs';

const secret = 'test-jwt-signing-secret-at-least-32-bytes';

const withTemp = (jwtSecret = secret) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ai-'));
  return { directory, configuration: { runtimePath: '/tmp/ai-test-unused', jwtSecret, aiConfigPath: path.join(directory, 'ai-config.json') } };
};

test('api keys encrypt at rest, decrypt for use, and survive a restart', () => {
  const { directory, configuration } = withTemp();
  try {
    const first = new AiConfigService(configuration);
    const saved = first.update({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret-value', model: 'deepseek-chat' });
    assert.equal(saved.hasKey, true);
    assert.equal(saved.keyTail.slice(0, 4), 'alue'.slice(0, 4) || saved.keyTail);
    assert.equal(saved.source, 'custom');
    const raw = fs.readFileSync(configuration.aiConfigPath, 'utf8');
    assert.ok(!raw.includes('sk-secret-value'), 'key must be encrypted at rest');
    const second = new AiConfigService(configuration);
    assert.equal(second.effectiveLlm().key, 'sk-secret-value');
    assert.equal(second.effectiveLlm().model, 'deepseek-chat');
    assert.equal(second.ready(), true);
    assert.equal(second.masked().keyTail, 'alue');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a rotated server secret cannot decrypt the stored key, and empty updates keep it', () => {
  const { directory, configuration } = withTemp();
  try {
    const first = new AiConfigService(configuration);
    first.update({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret-value', model: 'deepseek-chat' });
    const rotated = new AiConfigService({ ...configuration, jwtSecret: 'another-signing-secret-that-is-long-enough-x' });
    assert.equal(rotated.effectiveLlm().key, '');
    assert.equal(rotated.ready(), false);
    rotated.update({ apiKey: 'sk-rotated-value' });
    assert.equal(rotated.masked().hasKey, true, 'key can be saved again under the rotated secret');
    first.update({ apiKey: '' });
    assert.equal(first.masked().hasKey, true, 'empty update keeps the stored key');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
