import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../server/app.mjs';
import { CoachService } from '../../server/coach.mjs';
import { MatchService } from '../../server/matches.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { question, config, settings, result } from './fixtures.mjs';

async function setup(t, { providers = {}, coachProvider, configuration = config } = {}) {
  const bank = new QuestionBank('', [question]);
  const service = new MatchService(bank, configuration, { persist: false, providers });
  const coach = new CoachService(bank, service, configuration, { provider: coachProvider });
  const app = createApp(bank, service, configuration, { coach });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { coach.shutdown(); service.shutdown(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { body, token, method = body === undefined ? 'GET' : 'POST', headers = {}, ...rest } = {}) => fetch(base + route, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...rest,
  });
  const login = async () => (await (await request('/api/login', { body: { password: configuration.sitePassword } })).json()).token;
  return { app, service, coach, request, login };
}

test('JWT owner workflow seals concurrent AI output across refresh and SSE reconnects', async t => {
  let calls = 0;
  const { request, login } = await setup(t, { providers: { llm: async (_q, _config, context) => {
    calls++; context.emit('explanation', { text: 'SEALED_EXPLANATION' });
    return { ...result('D'), explanation: 'SEALED_EXPLANATION' };
  } } });
  for (const route of ['/.env', '/.env.local', '/data/xingce/questions.jsonl', '/data/runtime/matches/test.json', '/xingce-dataset.zip']) {
    const response = await request(route); assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes('test-private-key'));
  }
  const catalog = await (await request('/api/catalog')).json();
  assert.ok(!JSON.stringify(catalog).includes('test-private-key'));
  assert.equal((await request('/api/matches', { body: settings })).status, 401);
  const token = await login();
  let response = await request('/api/matches', { token, body: settings });
  assert.equal(response.status, 201); const created = await response.json();
  const route = `/api/matches/${created.match.id}`;
  assert.equal((await request(route)).status, 401);
  assert.equal((await request(route, { token: created.token })).status, 401, 'old per-match token cannot authenticate a learner');
  const unfinished = await (await request(route, { token })).json();
  assert.equal(unfinished.current.result, null); assert.ok(!JSON.stringify(unfinished).includes('GOLD_SECRET'));
  assert.equal(unfinished.current.aiStatus, 'ready'); assert.equal(unfinished.current.explanation, '');
  assert.equal((await request(`/api/public/matches/${created.match.id}`)).status, 404);
  for (let i = 0; i < 2; i++) {
    const hiddenStream = new AbortController();
    const stream = await request(route + '/events', { token, signal: hiddenStream.signal });
    const text = new TextDecoder().decode((await stream.body.getReader().read()).value); hiddenStream.abort();
    assert.ok(text.includes('event: snapshot'));
    for (const marker of ['SEALED_EXPLANATION', 'GOLD_SECRET', 'submit_answer', 'aiChoice']) assert.ok(!text.includes(marker), marker);
  }
  assert.equal(calls, 1);
  response = await request(route + '/answer', { token, body: { choice: 'D', index: 0 } }); assert.equal(response.status, 200);
  const abort = new AbortController();
  response = await request(route + '/events', { token, signal: abort.signal });
  const chunk = new TextDecoder().decode((await response.body.getReader().read()).value); abort.abort();
  assert.ok(chunk.includes('"phase":"revealed"')); assert.ok(chunk.includes('GOLD_SECRET'));
  assert.ok(chunk.includes('SEALED_EXPLANATION')); assert.equal(calls, 1);
  const final = await (await request(route + '/finish', { token, body: {} })).json();
  assert.equal(final.status, 'finished'); assert.equal(final.scores.completed, 1);
  const publicRecord = await (await request(`/api/public/matches/${created.match.id}`)).json();
  assert.equal(publicRecord.history.length, 1); assert.equal(publicRecord.current, null);
});

test('visitors may supervise results but cannot write, recover private notes, or access coaching', async t => {
  const { request, login, service } = await setup(t, { coachProvider: async (_config, _payload, hooks) => {
    hooks.onText('PRIVATE_COACH_REPLY'); return { content: 'PRIVATE_COACH_REPLY' };
  } });
  const token = await login(), created = await (await request('/api/matches', { token, body: { ...settings, mode: 'practice' } })).json();
  const id = created.match.id, route = `/api/matches/${id}`;
  assert.equal((await request(route + '/pause', { body: {} })).status, 401);
  const paused = await (await request(route + '/pause', { token, body: {} })).json();
  assert.equal(paused.current.paused, true);
  assert.equal((await request(route + '/answer', { token, body: { index: 0, choice: 'A' } })).status, 409);
  const resumed = await (await request(route + '/resume', { token, body: {} })).json();
  assert.equal(resumed.current.paused, false);
  assert.equal((await request(route + '/coach?index=0', { token })).status, 409);
  assert.equal((await request(route + '/answer', { token, body: { index: 0, choice: 'A' } })).status, 200);
  assert.equal((await request(`/api/learning/questions/${question.id}`, { token, method: 'PATCH', body: { note: 'PRIVATE_NOTE', bookmarked: true } })).status, 200);
  let response = await request(route + '/coach', { token, body: { index: 0, message: '为什么错了？' } });
  const stream = await response.text(); assert.ok(stream.includes('event: complete')); assert.ok(stream.includes('PRIVATE_COACH_REPLY'));
  for (const endpoint of ['/api/public/dashboard', '/api/public/stats', '/api/public/history', `/api/public/matches/${id}`]) {
    response = await request(endpoint); assert.equal(response.status, 200);
    const body = await response.text();
    for (const secret of ['PRIVATE_NOTE', 'PRIVATE_COACH_REPLY', 'tokenHash', 'coachMessages']) assert.ok(!body.includes(secret), `${endpoint}: ${secret}`);
  }
  for (const endpoint of ['/api/learning/dashboard', `/api/learning/questions/${question.id}`, route + '/coach?index=0']) assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(`/api/learning/questions/${question.id}`, { method: 'PATCH', body: { bookmarked: false } })).status, 401);
  assert.equal((await request(route + '/answer', { body: { index: 0, choice: 'D' } })).status, 401);
  const newDeviceToken = await login();
  assert.equal((await request(route, { token: newDeviceToken })).status, 200, 'account can resume without local match token');
  assert.equal((await (await request('/api/learning/dashboard', { token })).json()).summary.answered, 1);
  assert.equal((await (await request('/api/learning/questions?kind=wrong', { token })).json()).total, 1);
  assert.equal((await (await request('/api/learning/questions?kind=wrong&search=PRIVATE_NOTE&pageSize=1', { token })).json()).total, 1);
  const outside = service.create({ ...settings, mode: 'practice' }, { ownerId: 'someone-else' });
  assert.equal((await request(`/api/matches/${outside.match.id}`, { token })).status, 404);
});

test('guest stats are anonymous, read-only, validated and rate limited without model calls', async t => {
  let calls = 0;
  const { request } = await setup(t, { providers: { llm: () => { calls++; return result(); } } });
  const response = await request('/api/public/stats');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json(); assert.equal(data.summary.answered, 0); assert.equal(data.summary.accuracy, null);
  assert.equal(data.schemaVersion, '1.0'); assert.equal(data.dataRevision, null); assert.equal(data.activity.length, 7);
  assert.equal((await request('/api/public/stats?module=unknown')).status, 400);
  assert.equal((await request('/api/public/stats?from=2026-02-30')).status, 400);
  assert.equal((await request('/api/public/stats?unused=1')).status, 400);
  assert.equal((await request('/api/public/stats', { body: {} })).status, 401);
  for (let index = 0; index < 56; index++) assert.equal((await request('/api/public/stats')).status, 200);
  assert.equal((await request('/api/public/stats')).status, 429); assert.equal(calls, 0);
});

test('JWT session persists through requests; invalid tokens and cross-site writes are rejected', async t => {
  const { request, login } = await setup(t);
  assert.equal((await request('/api/catalog')).status, 200);
  assert.equal((await request('/api/public/dashboard')).status, 200);
  assert.equal((await request('/api/login', { body: { password: 'bad' } })).status, 401);
  const token = await login();
  const session = await (await request('/api/session', { token })).json();
  assert.equal(session.authenticated, true); assert.equal(session.profile.id, 'primary');
  assert.equal((await request('/api/session', { token: token + 'tampered' })).status, 401);
  assert.equal((await request('/api/session?token=' + token)).status, 401);
  assert.equal((await request('/api/matches', { token, headers: { Origin: 'https://unrelated.example' }, body: { ...settings, mode: 'practice' } })).status, 403);
  const legacy = await request('/api/login', { body: { password: config.sitePassword } });
  assert.equal(legacy.headers.get('set-cookie'), null, 'login uses JWT, not a parallel cookie session');
});

test('coach stream errors redact private provider details and preserve the submitted answer', async t => {
  const { request, login } = await setup(t, { coachProvider: async () => { throw new Error('PRIVATE_UPSTREAM_KEY_AND_PROMPT'); } });
  const token = await login(), created = await (await request('/api/matches', { token, body: { ...settings, mode: 'practice' } })).json();
  const route = `/api/matches/${created.match.id}`;
  await request(route + '/answer', { token, body: { choice: 'D', index: 0 } });
  const response = await request(route + '/coach', { token, body: { index: 0, message: '再解释一下' } });
  const stream = await response.text(); assert.ok(stream.includes('event: error')); assert.ok(!stream.includes('PRIVATE_UPSTREAM'));
  const saved = await (await request(route + '/coach?index=0', { token })).json();
  assert.equal(saved.messages.length, 0); assert.equal(saved.busy, false); assert.equal(saved.remaining, 7);
  const match = await (await request(route, { token })).json(); assert.equal(match.current.result.humanCorrect, true);
});

test('all real model entry points share coaching capacity without blocking last-question acknowledgement', async t => {
  const { request, login, coach, service } = await setup(t, { configuration: { ...config, maxConcurrent: 1 }, providers: { llm: async () => result('D'), jev: async () => result('D') } });
  const token = await login();
  const llm = await (await request('/api/matches', { token, body: settings })).json();
  await request(`/api/matches/${llm.match.id}/answer`, { token, body: { choice: 'D', index: 0 } });
  const jev = await (await request('/api/matches', { token, body: { ...settings, mode: 'jev' } })).json();
  coach.jobs.set('a-live-coach-request', new AbortController());
  assert.equal((await request(`/api/matches/${jev.match.id}/answer`, { token, body: { choice: 'D', index: 0 } })).status, 429);
  assert.equal(service.matches.get(jev.match.id).rounds[0].humanChoice, undefined, 'busy response does not lock the human answer');
  assert.equal((await request(`/api/matches/${llm.match.id}/next`, { token, body: { index: 0 } })).status, 200, 'finishing requires no additional model slot');
});
test('smart scope plans a deterministic weak-first paper through the API', async t => {
  const { request, login } = await setup(t, {});
  const token = await login();
  const first = await (await request('/api/matches', { token, body: { ...settings, mode: 'practice' } })).json();
  await request(`/api/matches/${first.match.id}/answer`, { token, body: { choice: 'A', index: 0 } });
  await request(`/api/matches/${first.match.id}/finish`, { token, body: {} });
  const response = await request('/api/matches', { token, body: { ...settings, mode: 'practice', scope: 'smart', count: 1 } });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.match.settings.scope, 'smart');
  assert.deepEqual(created.match.settings.composition, { review: 1, weak: 0, extend: 0 });
  assert.equal(created.match.current.question.id, question.id);
});
