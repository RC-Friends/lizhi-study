import test from 'node:test';
import assert from 'node:assert/strict';
import { api, savedSession, saveSession, streamCoach, streamMatch } from '../../src/api.js';

function browser(t) {
  const originals = Object.fromEntries(['window', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const data = new Map(), events = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } });
  window.addEventListener('learner-session-expired', event => events.push(event.detail));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return events;
}
const unauthorized = () => Response.json({ error: { message: '登录已过期', code: 'login_required' } }, { status: 401 });

for (const [name, request] of [
  ['JSON request', () => api('/api/admin/status')],
  ['match stream', () => streamMatch({ id: 'test-match' }, new AbortController().signal, () => {})],
  ['coach stream', () => streamCoach('test-match', 0, 'test', new AbortController().signal, () => {})],
]) {
  test(`${name}: an old JWT's delayed 401 preserves a newer login`, async t => {
    const events = browser(t); saveSession({ token: 'old-jwt', role: 'learner' });
    let finish, sent;
    globalThis.fetch = async (_url, options) => { sent = options; await new Promise(resolve => { finish = resolve; }); return unauthorized(); };
    const pending = request();
    saveSession({ token: 'new-jwt', role: 'admin' }); finish();
    await assert.rejects(pending, { status: 401 });
    assert.equal(sent.headers.Authorization, 'Bearer old-jwt');
    assert.equal(sent.cache, 'no-store');
    assert.deepEqual(savedSession(), { token: 'new-jwt', role: 'admin' });
    assert.deepEqual(events, []);
  });
}

test('a current JWT failure requests expiration of that exact session', async t => {
  const events = browser(t); saveSession({ token: 'current-jwt', role: 'admin' });
  globalThis.fetch = async () => unauthorized();
  await assert.rejects(api('/api/session'), { status: 401 });
  assert.deepEqual(events, [{ token: 'current-jwt' }]);
});

test('a rejected password never expires an existing session', async t => {
  const events = browser(t); saveSession({ token: 'valid-jwt', role: 'admin' });
  globalThis.fetch = async () => unauthorized();
  await assert.rejects(api('/api/login', { method: 'POST', body: { password: 'test-invalid-password' } }), { status: 401 });
  assert.equal(savedSession().token, 'valid-jwt');
  assert.deepEqual(events, []);
});

test('a permission denial keeps authentication valid', async t => {
  const events = browser(t); saveSession({ token: 'learner-jwt', role: 'learner' });
  globalThis.fetch = async () => Response.json({ error: { message: '需要管理员权限' } }, { status: 403 });
  await assert.rejects(api('/api/admin/status'), { status: 403 });
  assert.equal(savedSession().token, 'learner-jwt');
  assert.deepEqual(events, []);
});
