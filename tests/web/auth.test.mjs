import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../../server/auth.mjs';
import { environmentFromFiles } from '../../server/config.mjs';

const configuration = { sitePassword: 'study-password-for-test', jwtSecret: 'random-test-secret-not-for-production-123456',
  jwtTtlSeconds: 30 * 86400, profileName: '测试同学' };
const startingTime = Date.UTC(2026, 9, 3, 10);
function resign(token, update, headerUpdate = {}) {
  const [head, body] = token.split('.');
  const header = { ...JSON.parse(Buffer.from(head, 'base64url')), ...headerUpdate };
  const claims = { ...JSON.parse(Buffer.from(body, 'base64url')), ...update };
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${crypto.createHmac('sha256', configuration.jwtSecret).update(input).digest('base64url')}`;
}

test('learner JWT survives a service restart and expires exactly at the deadline', () => {
  let clock = startingTime;
  const first = createAuth(configuration, { now: () => clock });
  const logged = first.login(configuration.sitePassword);
  assert.equal(logged.role, 'learner'); assert.equal(logged.authenticated, true);
  assert.equal(logged.profile.id, 'primary'); assert.equal(logged.profile.name, '测试同学');
  assert.ok(!JSON.stringify(logged).includes(configuration.sitePassword));
  const restored = createAuth(configuration, { now: () => clock });
  assert.equal(restored.verify(logged.token).sub, 'primary');
  clock += configuration.jwtTtlSeconds * 1000 - 1;
  assert.ok(restored.verify(logged.token));
  clock += 1;
  assert.equal(restored.verify(logged.token), null);
  assert.throws(() => restored.requireToken(logged.token), { status: 401, code: 'login_required' });
});

test('wrong passwords, tampering, wrong claims and unexpected algorithms are rejected', () => {
  const auth = createAuth(configuration, { now: () => startingTime });
  for (const password of ['', 'wrong-password', undefined, null, 123, 'a'.repeat(513)]) {
    assert.throws(() => auth.login(password), { status: 401, code: 'invalid_password' });
  }
  const { token } = auth.login(configuration.sitePassword);
  const seconds = Math.floor(startingTime / 1000);
  for (const claims of [
    { iss: 'other' }, { aud: 'other' }, { sub: 'other' }, { role: 'visitor' },
    { exp: seconds }, { exp: '99999999999' }, { exp: seconds + configuration.jwtTtlSeconds + 1 },
    { iat: seconds + 31 }, { iat: '0' }, { nbf: seconds + 1 }, { nbf: '0' },
    { ver: 'forged' }, { ver: null }, { jti: '' },
  ]) assert.equal(auth.verify(resign(token, claims)), null, JSON.stringify(claims));
  for (const header of [{ alg: 'none' }, { alg: 'RS256' }, { typ: 'other' }, { jku: 'https://evil.example/key' }, { crit: [] }]) {
    assert.equal(auth.verify(resign(token, {}, header)), null);
  }
  const [head, body, signature] = token.split('.');
  for (const invalid of [null, '', 'a.b.c', `${head}.${body}.`, `${head}.${body}.${signature}a`,
    `${head}.${body}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`, `${head}=.${body}.${signature}`,
    `${head}.${body}.${signature}.extra`, 'a'.repeat(4097)]) assert.equal(auth.verify(invalid), null);
});

test('rotating either secret invalidates all old tokens and no empty password bypass exists', () => {
  const auth = createAuth(configuration, { now: () => startingTime });
  const { token } = auth.login(configuration.sitePassword);
  const passwordRotated = createAuth({ ...configuration, sitePassword: 'new-study-password' }, { now: () => startingTime });
  assert.equal(passwordRotated.verify(token), null);
  assert.ok(passwordRotated.verify(passwordRotated.login('new-study-password').token));
  const secretRotated = createAuth({ ...configuration, jwtSecret: 'new-independent-secret-for-test-123456789' }, { now: () => startingTime });
  assert.equal(secretRotated.verify(token), null);
  for (const changed of [{ sitePassword: '' }, { sitePassword: 'short' }, { jwtSecret: '' }, { jwtSecret: 'short' },
    { jwtTtlSeconds: 0 }, { jwtTtlSeconds: 91 * 86400 }, { jwtTtlSeconds: NaN }]) {
    assert.throws(() => createAuth({ ...configuration, ...changed }));
  }
  assert.deepEqual(auth.publicSession(null), { authenticated: false, role: 'visitor', profile: { id: 'primary', name: '测试同学' } });
});

test('.env account settings win over legacy empty values while runtime environment takes precedence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duel-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env.local'), 'SITE_PASSWORD=\nLLM_MODEL=legacy-model\nLLM_API_KEY=legacy-key\n');
  fs.writeFileSync(path.join(root, '.env'), 'SITE_PASSWORD=new-password\nJWT_SECRET=new-secret\n');
  const clean = environmentFromFiles(root, {});
  assert.equal(clean.SITE_PASSWORD, 'new-password'); assert.equal(clean.LLM_MODEL, 'legacy-model');
  assert.equal(clean.LLM_API_KEY, 'legacy-key');
  const injected = environmentFromFiles(root, { SITE_PASSWORD: 'runtime-password', LLM_API_KEY: 'runtime-key' });
  assert.equal(injected.SITE_PASSWORD, 'runtime-password'); assert.equal(injected.LLM_API_KEY, 'runtime-key');
  // An explicitly empty runtime secret must fail startup instead of silently
  // falling back to a stale disk credential.
  assert.equal(environmentFromFiles(root, { SITE_PASSWORD: '' }).SITE_PASSWORD, '');
  fs.unlinkSync(path.join(root, '.env')); fs.unlinkSync(path.join(root, '.env.local'));
  assert.deepEqual(environmentFromFiles(root, { PORT: '3210' }), { PORT: '3210' });
});
