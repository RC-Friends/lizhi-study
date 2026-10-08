import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import { PostgresStore } from '../../server/storage.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { LearningService } from '../../server/learning.mjs';
import { createApp } from '../../server/app.mjs';
import { readLegacy } from '../../scripts/import-legacy.mjs';
import { question, config, settings, result } from '../web/fixtures.mjs';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.startsWith('/xingce_test')) throw new Error('Set TEST_DATABASE_URL to an isolated xingce_test* database. Never use production.');
const bank = new QuestionBank(null, [question]);
const admin = new pg.Client({ connectionString: connection }); await admin.connect();
const reset = () => admin.query('DROP TABLE IF EXISTS study_imports, study_annotations, study_profiles, study_matches, study_schema_migrations');

test('PostgreSQL persistence, migration and failure behavior', async t => {
  t.after(async () => { await reset(); await admin.end(); });
  await t.test('HTTP successes survive restart, private notes stay private, and a second writer is rejected', async () => {
    await reset();
    let storage = await PostgresStore.open(connection, bank);
    let service = new MatchService(bank, config, { storage });
    const app = createApp(bank, service, config), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    let token;
    const request = async (route, body, method = 'POST') => {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
    };
    try {
      token = (await request('/api/login', { password: config.sitePassword })).token;
      const created = await request('/api/matches', { ...settings, mode: 'practice' });
      const id = created.match.id;
      await request(`/api/matches/${id}/answer`, { choice: 'D', index: 0 });
      await request('/api/learning/questions/' + question.id, { note: 'PRIVATE_SQL_NOTE', bookmarked: true }, 'PATCH');
      await request('/api/learning/profile', { nickname: '数据库同学', dailyGoal: 42 }, 'PATCH');
      await request(`/api/matches/${id}/finish`, {});
      const committed = (await admin.query('SELECT payload FROM study_matches WHERE id=$1', [id])).rows[0].payload;
      assert.equal(committed.status, 'finished'); assert.equal(committed.rounds[0].humanChoice, 'D');
      assert.equal((await admin.query('SELECT payload FROM study_annotations')).rows[0].payload.note, 'PRIVATE_SQL_NOTE');
      assert.ok(!JSON.stringify(await request('/api/public/dashboard', undefined, 'GET')).includes('PRIVATE_SQL_NOTE'));
      await assert.rejects(PostgresStore.open(connection, bank), error => error.code === 'database_in_use');
      service.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await storage.close();
      storage = await PostgresStore.open(connection, bank); service = new MatchService(bank, config, { storage });
      const learning = new LearningService(bank, service, config);
      assert.equal(service.matches.get(id).rounds[0].humanChoice, 'D');
      assert.equal(learning.profile().dailyGoal, 42); assert.equal(learning.questionMeta(question.id).note, 'PRIVATE_SQL_NOTE');
      assert.equal(learning.publicDashboard().summary.answered, 1);
      await storage.close();
      await assert.rejects(PostgresStore.open(connection, new QuestionBank(null, [{ ...question, answer: ['A'] }])), /不一致/);
      await assert.rejects(PostgresStore.open(connection, new QuestionBank(null, [])), /缺少/);
    } finally { service.shutdown(); server.closeAllConnections(); server.close(); await storage.close(); }
  });
  await t.test('legacy import is atomic, repeatable, lossless, and refuses to overwrite another dataset', async () => {
    await reset();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingce-pg-import-'));
    const configuration = { ...config, runtimePath: path.join(root, 'matches') };
    const old = new MatchService(bank, configuration);
    const created = old.create({ ...settings, mode: 'practice' }, { ownerId: 'primary' });
    const match = old.matches.get(created.match.id); old.submit(match, { choice: 'A', index: 0 }); old.pause(match);
    const learning = new LearningService(bank, old, configuration);
    learning.updateQuestion(question.id, { note: 'migration note', bookmarked: true });
    learning.updateProfile({ dailyGoal: 25 });
    const snapshot = readLegacy(root, bank), storage = await PostgresStore.open(connection, bank);
    try {
      const broken = structuredClone(snapshot); broken.matches.push({ ...broken.matches[0], id: 'invalid', createdAt: 'not-a-date' });
      await assert.rejects(storage.importLegacy(broken), /回滚/);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM study_matches')).rows[0].n, 0);
      assert.equal((await storage.importLegacy(snapshot)).matches, 1);
      assert.equal((await storage.importLegacy(snapshot)).alreadyImported, true);
      const payload = (await admin.query('SELECT payload FROM study_matches')).rows[0].payload;
      assert.deepEqual(payload, snapshot.matches[0]);
      assert.equal((await admin.query('SELECT payload FROM study_annotations')).rows[0].payload.note, 'migration note');
      await assert.rejects(storage.importLegacy({ ...snapshot, fingerprint: 'different-source' }), /已有数据/);
      assert.equal(readLegacy(root, bank).fingerprint, snapshot.fingerprint, 'source JSON remains untouched');
    } finally { await storage.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await t.test('model calls wait for their durable reservation and interrupted rounds require explicit retry', async () => {
    await reset(); let calls = 0;
    let storage = await PostgresStore.open(connection, bank);
    let service = new MatchService(bank, config, { storage, providers: { llm: async (_q, _config, context) => {
      calls++;
      const saved = (await admin.query('SELECT payload FROM study_matches')).rows[0].payload;
      assert.equal(saved.rounds[0].attempts, 1); assert.equal(saved.rounds[0].aiStatus, 'running');
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    } } });
    try {
      const created = service.create(settings, { ownerId: 'primary' });
      const match = service.matches.get(created.match.id);
      service.submit(match, { choice: 'D', index: 0 }); await service.flush();
      for (let i = 0; calls === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls, 1); service.shutdown();
      await Promise.allSettled([...service.jobs.values()].map(job => job.task)); await service.flush(); await storage.close();
      storage = await PostgresStore.open(connection, bank);
      service = new MatchService(bank, config, { storage, providers: { llm: async () => { calls++; return result('D'); } } });
      const recovered = service.matches.get(created.match.id); await service.flush();
      assert.equal(calls, 1); assert.equal(service.current(recovered).humanChoice, 'D'); assert.equal(service.current(recovered).phase, 'error');
      service.retry(recovered, { index: 0 }); await service.jobs.get(recovered.id).task; await service.flush();
      assert.equal(calls, 2); assert.equal(service.snapshot(recovered).scores.humanAccuracy, 100);
    } finally { service.shutdown(); await storage.close(); }
  });
  await t.test('lost database connection rejects writes and health without claiming a saved answer', async () => {
    await reset(); const storage = await PostgresStore.open(connection, bank);
    const service = new MatchService(bank, config, { storage });
    const app = createApp(bank, service, config), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.sitePassword }) })).json();
      const pid = (await storage.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      for (let i = 0; !storage.failure && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(storage.failure);
      const response = await fetch(base + '/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ ...settings, mode: 'practice' }) });
      assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(new URL(connection).password));
      assert.equal((await fetch(base + '/api/health')).status, 503); assert.equal(service.matches.size, 0);
    } finally { service.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await storage.close(); }
  });
  await t.test('a commit failure never returns success or starts a billable model request', async () => {
    await reset(); const storage = await PostgresStore.open(connection, bank); let calls = 0;
    const service = new MatchService(bank, config, { storage, providers: { llm: async () => { calls++; return result('D'); } } });
    const app = createApp(bank, service, config), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.sitePassword }) })).json();
      await storage.client.query('SET default_transaction_read_only = on');
      const response = await fetch(base + '/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify(settings) });
      assert.equal(response.status, 503); assert.equal(calls, 0);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM study_matches')).rows[0].n, 0);
      assert.ok(storage.failure);
    } finally { service.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await storage.close(); }
  });
});
