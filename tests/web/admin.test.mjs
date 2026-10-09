import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createAuth } from '../../server/auth.mjs';
import { AiConfigService } from '../../server/ai-config.mjs';
import { createApp } from '../../server/app.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { KnowledgeService } from '../../server/knowledge.mjs';
import { DraftService } from '../../server/question-drafts.mjs';
import { config, question } from './fixtures.mjs';

const settings = { ...config, adminPassword: 'independent-test-admin-password', serveFrontend: false };

test('fixed administrator identity is distinct, optional and independently revocable', () => {
  const auth = createAuth(settings), learner = auth.login(settings.sitePassword), admin = auth.login(settings.adminPassword, 'admin');
  assert.equal(admin.role, 'admin'); assert.equal(admin.profile.id, 'superadmin');
  assert.equal(auth.requireAdmin(admin.token).role, 'admin');
  assert.throws(() => auth.requireAdmin(learner.token), { status: 403 });
  assert.throws(() => auth.login(settings.sitePassword, 'admin'), { status: 401 });
  assert.throws(() => auth.login(settings.adminPassword), { status: 401 });
  assert.throws(() => createAuth(config).login(settings.adminPassword, 'admin'), { status: 403 });
  const rotated = createAuth({ ...settings, adminPassword: 'rotated-administrator-password' });
  assert.equal(rotated.verify(admin.token), null); assert.ok(rotated.verify(learner.token));
  const learnerRotated = createAuth({ ...settings, sitePassword: 'rotated-learner-password' });
  assert.ok(learnerRotated.verify(admin.token)); assert.equal(learnerRotated.verify(learner.token), null);
  assert.throws(() => createAuth({ ...settings, adminPassword: settings.sitePassword }));
  assert.equal(createAuth(config).verify(admin.token), null);
});

test('administrator gates protect model configuration and imports without creating another learner', async t => {
  const bank = new QuestionBank('', [question]), matches = new MatchService(bank, settings, { persist: false });
  const app = createApp(bank, matches, settings), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); matches.shutdown(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, token, body, method = 'POST') => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const admin = (await request('/api/login', null, { password: settings.adminPassword, role: 'admin' })).body;
  const learner = (await request('/api/login', null, { password: settings.sitePassword })).body;
  for (const url of ['/api/admin/status', '/api/ai/config', '/api/admin/rag/status']) {
    assert.equal((await request(url)).status, 401); assert.equal((await request(url, learner.token)).status, 403); assert.equal((await request(url, admin.token)).status, 200);
  }
  assert.equal((await request('/api/admin/question-bank/schema', learner.token)).status, 401);
  assert.equal((await request('/api/admin/question-bank/schema', admin.token)).status, 200);
  assert.equal((await request('/api/ai/config', learner.token, { model: 'bad' }, 'PUT')).status, 403);
  assert.equal((await request('/api/learning/overview', admin.token)).status, 403);
  assert.equal((await request('/api/session', admin.token)).body.profile.id, 'superadmin');
  const library = await request('/api/kb/libraries', admin.token, { name: '考生的讲义', visibility: 'public' });
  assert.equal(library.status, 201); assert.equal(library.body.ownerId, 'primary'); assert.equal(library.body.visibility, 'private');
  const visible = (await request('/api/kb/libraries', learner.token)).body.items;
  assert.equal(visible[0].id, library.body.id); assert.equal(visible[0].mine, true);
  assert.equal((await request(`/api/kb/libraries/${library.body.id}`, learner.token)).body.library.mine, true);
  const saved = await request('/api/ai/config', admin.token, { provider: 'llm', model: 'admin-configured-model' }, 'PUT');
  assert.equal(saved.status, 200); assert.ok(!JSON.stringify(saved.body).includes(settings.llm.key));
  assert.equal((await request('/api/catalog')).body.providers.llm.model, 'admin-configured-model');
  assert.equal(app.locals.learning.data.profiles.superadmin, undefined);
});

test('bootstrap happens once; empty keys and disabled models never fall back to environment secrets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-bootstrap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...settings, runtimePath: path.join(root, 'matches') };
  const first = new AiConfigService(cfg);
  assert.equal(first.effectiveLlm().key, cfg.llm.key);
  first.update({ provider: 'llm', model: 'saved-in-panel', clearKey: true });
  first.update({ provider: 'jev', enabled: false });
  const restarted = new AiConfigService({ ...cfg, llm: { key: 'changed-environment-key', baseUrl: 'https://changed.example/v1', model: 'changed-environment-model' } });
  assert.equal(restarted.effectiveLlm().model, 'saved-in-panel'); assert.equal(restarted.effectiveLlm().key, '');
  assert.equal(restarted.effectiveConfig().jev.key, '');
  const revision = restarted.masked().revision;
  restarted.update({ provider: 'llm', revision, model: 'newer-model' });
  assert.throws(() => restarted.update({ provider: 'llm', revision, model: 'stale-model' }), { status: 409 });
  const locked = new AiConfigService(settings, { persist: false });
  assert.throws(() => locked.update({ provider: 'llm', baseUrl: 'https://different.example/v1' }), { status: 400, code: 'provider_key_required' });
  locked.update({ baseUrl: 'https://different.example/v1', apiKey: 'new-provider-test-key' });
  assert.equal(locked.effectiveLlm().key, 'new-provider-test-key');
  assert.throws(() => locked.update({ maxTokens: -1 }), { status: 400 });
  assert.throws(() => locked.update({ baseUrl: 'https://user:secret@example.org/v1', apiKey: 'unused' }), { status: 400 });
});

test('real streaming adapter uses the configured key for connection tests and question generation', async t => {
  const requests = [], payload = [{ stem: '相遇问题中两人相距一百二十千米多久相遇？', options: { A: '2小时', B: '3小时', C: '4小时', D: '5小时' }, answer: 'A', analysis: '路程除以速度和，120÷60=2。', knowledgePoints: ['相遇'], source: 'K1' }];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ key: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const models = new AiConfigService({ ...settings, llm: {} }, { persist: false });
  models.update({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'actual-test-provider-key', model: 'test-model' });
  assert.equal(models.ready(), true); assert.equal((await models.test()).ok, true);
  const knowledge = new KnowledgeService(settings, { persist: false }), library = knowledge.createLibrary({ name: '行程讲义' }, 'primary');
  knowledge.upload({ libraryId: library.id, title: '相遇问题', format: 'text', content: '相遇问题的时间等于路程除以速度和，120千米除以60千米每小时等于2小时。' }, 'primary');
  const drafts = new DraftService(settings, { persist: false, llmResolver: () => models.effectiveLlm() });
  assert.equal((await drafts.generate({ query: '相遇问题', count: 1 }, knowledge, 'primary')).drafts.length, 1);
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.key === 'Bearer actual-test-provider-key'));
});
