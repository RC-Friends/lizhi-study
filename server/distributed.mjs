import crypto from 'node:crypto';
import pg from 'pg';
import { createClient } from 'redis';
import { MatchService } from './matches.mjs';
import { LearningService } from './learning.mjs';
import { CoachService } from './coach.mjs';
import { HttpError } from './bank.mjs';
import { SCHEMA, MATCH_UPSERT, matchValues, validateMatch, validateLearning, StorageError } from './storage.mjs';
import { runLlm, runJev, runDemo, ProviderError } from './providers.mjs';
import { bootstrapModelSettings, readModelConfig } from './ai-config.mjs';

const LOCK = 'SELECT pg_advisory_xact_lock(1937012089, 2)';
const JOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS study_jobs (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('answer','coach')), match_id text NOT NULL REFERENCES study_matches(id),
 round_index integer NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', worker text, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS study_jobs_pending ON study_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS study_state (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0);
INSERT INTO study_state(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE study_state ADD COLUMN IF NOT EXISTS resource_version text;
INSERT INTO study_schema_migrations(version) VALUES (2), (3) ON CONFLICT DO NOTHING;`;
const stamp = () => new Date().toISOString();
const studyStamp = match => JSON.stringify([match.status, match.index, match.finishedAt, match.rounds.map(round =>
  [round.phase, round.humanChoice, round.humanCorrect, round.aiCorrect, round.completedAt, round.pausedAt])]);
const dayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const AI_FIELDS = ['explanation', 'transcription', 'explanationComplete', 'requests', 'stage', 'stageLabel', 'progress', 'aiChoice', 'tool', 'model',
  'aiMs', 'aiCompletedAt', 'aiStatus', 'probabilities', 'confidence', 'visualAssisted', 'error', 'errorCode', 'aiCheckpointAt', 'aiTimingIncomplete'];

// Each operation has a fresh, transaction-scoped domain model. No process owns
// matches or learning records. The short DB lock serializes this single-learner
// site's mutations; model requests and SSE never hold it.
export class DistributedRuntime {
  static async open(bank, config, options = {}) {
    const runtime = new DistributedRuntime(bank, config, options);
    try {
      await runtime.transaction(async client => {
        const compatible = await client.query('SELECT pg_try_advisory_xact_lock(1937012089, 1) AS acquired');
        if (!compatible.rows[0].acquired) throw new StorageError('旧版单进程应用或导入程序仍在运行，请先停止它。');
        const versions = await client.query("SELECT to_regclass('study_schema_migrations') AS name");
        if (versions.rows[0].name && (await client.query('SELECT max(version) AS version FROM study_schema_migrations')).rows[0].version > 3) throw new StorageError('数据库版本高于当前应用。');
        await client.query(SCHEMA); await client.query(JOB_SCHEMA);
        await bootstrapModelSettings(client, config);
        if (runtime.resourceManager) await client.query('UPDATE study_state SET resource_version=COALESCE(resource_version,$1) WHERE id=1', [config.resourceVersion]);
      });
      runtime.resourcesReady = true;
      await Promise.all([runtime.redis.connect(), runtime.subscriber.connect()]);
      await runtime.subscriber.subscribe(runtime.channel, message => {
        for (const callback of runtime.listeners.get(message) || []) callback();
      });
      await runtime.run(() => {}); // Validate every historical question before serving.
      if (options.worker !== false) runtime.startWorker();
      return runtime;
    } catch (error) { await runtime.close(); if (error instanceof StorageError) throw error; throw new StorageError('无法启动后端，请检查 PostgreSQL、Redis 和题库版本配置。'); }
  }
  constructor(bank, config, { providers = {}, coachProvider, worker = true, resourceManager } = {}) {
    this.bank = bank; this.config = config; this.workerEnabled = worker; this.coachProvider = coachProvider;
    this.resourceManager = resourceManager;
    this.providers = { llm: runLlm, jev: runJev, demo: runDemo, ...providers };
    this.id = crypto.randomUUID(); this.closed = false; this.listeners = new Map(); this.tasks = new Map();
    this.prefix = config.redisPrefix || 'xingce:'; this.channel = this.prefix + 'changed';
    this.leaseMs = config.jobLeaseMs || 90000;
    this.cacheBank = config.resourceVersion || crypto.createHash('sha256').update(JSON.stringify([...bank.fingerprints])).digest('hex');
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 5000,
      statement_timeout: 10000, idle_in_transaction_session_timeout: 15000, application_name: 'xingce-backend' });
    this.pool.on('error', () => {});
    this.redis = createClient({ url: config.redisUrl, disableOfflineQueue: true, socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(1000, 100 + retries * 100) } });
    this.subscriber = this.redis.duplicate();
    this.redis.on('error', () => {}); this.subscriber.on('error', () => {});
  }
  async transaction(work, { readOnly = false } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      // Download outside the DB lock. Check the pointer again IN the transaction
      // to fence a concurrent activation; retry before running any domain work.
      const questions = this.resourcesReady && this.resourceManager ? await this.resourceManager.acquireCurrent(this.pool) : null;
      let client;
      try {
        client = await this.pool.connect();
        await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        if (!readOnly) await client.query(LOCK);
        if (questions && questions.version !== await this.resourceManager.currentVersion(client)) {
          await client.query('ROLLBACK'); continue;
        }
        client.questionContext = questions;
        const value = await work(client); await client.query('COMMIT'); return value;
      } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { if (client) { client.questionContext = null; client.release(); } questions?.release(); }
    }
    throw new StorageError('题库正在更新，请稍后重试。');
  }
  async withQuestions(work) {
    if (!this.resourceManager) return work({ bank: this.bank, config: await readModelConfig(this.pool, this.config), resources: this.config.questionResources, version: this.config.resourceVersion });
    const entry = await this.resourceManager.acquireCurrent(this.pool);
    try { return await work({ ...entry, config: await readModelConfig(this.pool, entry.config) }); } finally { entry.release(); }
  }
  async activateResources(version) {
    if (!this.resourceManager) throw new HttpError(503, '在线导入需要 PostgreSQL、Redis 和 SeaweedFS 资源模式。', 'activation_unavailable');
    const next = await this.resourceManager.acquire(version);
    try {
      await this.transaction(async client => {
        const current = client.questionContext;
        if (current.version === version) return;
        for (const [id, fingerprint] of current.bank.fingerprints) if (next.bank.fingerprints.get(id) !== fingerprint) throw new HttpError(409, `新题库必须保留现有题目 ${id}，请基于当前版本增量合并。`, 'question_conflict');
        await client.query('UPDATE study_state SET resource_version=$1, revision=revision+1 WHERE id=1', [version]);
      });
      await this.notify('resource-version');
      return { active: true, version, restartRequired: false };
    } finally { next.release(); }
  }
  async health() {
    if (this.closed || !this.redis.isReady || !this.subscriber.isReady) throw new StorageError();
    await Promise.all([this.pool.query('SELECT 1'), this.redis.withAbortSignal(AbortSignal.timeout(1500)).ping()]);
  }
  async limit(key, maximum, windowMs) {
    if (!this.redis.isReady) throw new StorageError('Redis 暂时不可用。');
    const id = this.prefix + 'limit:' + crypto.createHash('sha256').update(key).digest('hex');
    const count = await this.redis.withAbortSignal(AbortSignal.timeout(1500)).eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n", { keys: [id], arguments: [String(windowMs)] });
    if (count > maximum) throw new HttpError(429, '操作过于频繁，请稍后再试。', 'rate_limited');
  }
  async run(work, options = {}) {
    const changed = new Set();
    const operation = async client => {
      const bank = client.questionContext?.bank || this.bank, config = await readModelConfig(client, client.questionContext?.config || this.config);
      const jobs = options.readOnly ? [] : (await client.query("SELECT id FROM study_jobs WHERE status IN ('queued','running')")).rows;
      const pending = [], matches = new MatchService(bank, config, { persist: false, dispatch: job => pending.push(job) });
      const rows = options.matchId ? await client.query('SELECT payload FROM study_matches WHERE id=$1', [options.matchId])
        : await client.query('SELECT payload FROM study_matches ORDER BY created_at,id');
      const before = new Map();
      for (const { payload } of rows.rows) { matches.matches.set(payload.id, validateMatch(payload, bank)); if (!options.readOnly) before.set(payload.id, studyStamp(payload)); }
      // Capacity is shared by all processes, including coach jobs.
      matches.requireCapacity = () => { if (jobs.length + pending.length >= this.config.maxConcurrent) throw new HttpError(429, '模型目前较忙，请稍后再试。'); };
      matches.save = match => { changed.add(match.id); if (matches.current(match)?.aiStatus === 'running') matches.current(match).aiCheckpointAt = stamp(); };
      const learning = new LearningService(bank, matches, config, { persist: false });
      learning.memo = new Map();
      const profiles = options.matchId ? [] : (await client.query('SELECT * FROM study_profiles')).rows;
      const annotations = options.matchId ? [] : (await client.query('SELECT * FROM study_annotations')).rows;
      learning.data.profiles = Object.fromEntries(profiles.map(row => [row.owner_id, row.payload]));
      for (const row of annotations) (learning.data.questions[row.owner_id] ||= {})[row.question_id] = row.payload;
      validateLearning(learning.data, bank);
      const edits = []; learning.save = (...args) => { learning.memo.clear(); edits.push(args); };
      const coach = new CoachService(bank, matches, config);
      const value = await work({ service: matches, learning, coach, client, jobs, pending });
      if (options.readOnly && (changed.size || edits.length || pending.length)) throw new Error('Read operation attempted to mutate state');
      let studyChanged = Boolean(edits.length);
      for (const id of changed) {
        studyChanged ||= before.get(id) !== studyStamp(matches.matches.get(id));
        const match = matches.matches.get(id); await client.query(MATCH_UPSERT, matchValues(match));
        if (match.status === 'finished') await client.query("UPDATE study_jobs SET status='cancelled',finished_at=now() WHERE match_id=$1 AND kind='answer' AND status IN ('queued','running')", [id]);
      }
      for (const [kind, owner, question] of edits) {
        if (kind === 'profile') await client.query('INSERT INTO study_profiles VALUES($1,$2::jsonb) ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload', [owner, JSON.stringify(learning.data.profiles[owner])]);
        else await client.query('INSERT INTO study_annotations VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id,question_id) DO UPDATE SET payload=EXCLUDED.payload', [owner, question, JSON.stringify(learning.data.questions[owner][question])]);
      }
      for (const job of pending) await client.query('INSERT INTO study_jobs(id,kind,match_id,round_index,payload) VALUES($1,$2,$3,$4,$5::jsonb)', [job.id, job.kind, job.matchId, job.index, JSON.stringify(job.payload)]);
      if (studyChanged) await client.query('UPDATE study_state SET revision=revision+1 WHERE id=1');
      return value;
    };
    const result = options.client ? await operation(options.client) : await this.transaction(operation, options);
    // Redis is a notification channel, not the source of record. Polling repairs
    // missed publications after a committed write or a subscriber reconnect.
    await Promise.all([...changed].map(id => this.notify(id)));
    return result;
  }
  async revision(client = this.pool) {
    const row = (await client.query('SELECT revision FROM study_state WHERE id=1')).rows[0];
    return `${dayKey()}:${row.revision}`;
  }
  async cached(key, work) {
    // Read the authoritative version and its data in the SAME MVCC snapshot.
    // An old computation can only populate its old key, never overwrite new data.
    return this.transaction(async client => {
      const dataRevision = await this.revision(client);
      const cacheKey = this.prefix + 'read:v1:' + (client.questionContext?.version || this.cacheBank) + ':' + dataRevision + ':' + crypto.createHash('sha256').update(key).digest('hex');
      if (this.redis.isReady) {
        const saved = await this.redis.withAbortSignal(AbortSignal.timeout(1500)).get(cacheKey).catch(() => null);
        if (saved) { try { return JSON.parse(saved); } catch {} }
      }
      const value = await this.run(work, { readOnly: true, client });
      const response = { ...value, dataRevision };
      if (this.redis.isReady) await this.redis.withAbortSignal(AbortSignal.timeout(1500)).set(cacheKey, JSON.stringify(response), { EX: 120 }).catch(() => {});
      return response;
    }, { readOnly: true });
  }
  async notify(id) { if (this.redis.isReady) await this.redis.withAbortSignal(AbortSignal.timeout(1500)).publish(this.channel, id).catch(() => {}); }
  watch(id, callback) {
    const listeners = this.listeners.get(id) || new Set(); listeners.add(callback); this.listeners.set(id, listeners);
    return () => { listeners.delete(callback); if (!listeners.size) this.listeners.delete(id); };
  }
  async enqueueCoach(matchId, index, message, authorize) {
    return this.run(({ service, coach, pending, jobs }) => {
      const match = authorize(service, matchId), { round } = coach.validateReply(match, index, message);
      if (jobs.length >= this.config.maxConcurrent) throw new HttpError(429, '小栗正在忙，请稍后再问。');
      const id = crypto.randomUUID(); round.coachBusy = true; round.coachJobId = id; round.coachTurns = (round.coachTurns || 0) + 1;
      service.publish(match); pending.push({ id, kind: 'coach', matchId, index, payload: { message: message.trim() } });
      return id;
    }, { matchId });
  }
  async jobStatus(id) {
    const row = (await this.pool.query('SELECT status,payload FROM study_jobs WHERE id=$1', [id])).rows[0];
    return row;
  }
  async coachText(id) { return this.redis.isReady ? (await this.redis.withAbortSignal(AbortSignal.timeout(1500)).get(this.prefix + 'coach:' + id) || '') : ''; }
  startWorker() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.config.workerPollMs || 500); this.timer.unref();
    this.tick().catch(() => {});
  }
  async tick() {
    if (this.closed || this.ticking || !this.redis.isReady) return;
    this.ticking = true;
    try {
      await this.recover();
      const job = await this.transaction(async client => {
        const count = Number((await client.query("SELECT count(*) FROM study_jobs WHERE status='running'")).rows[0].count);
        if (count >= this.config.maxConcurrent) return null;
        const row = (await client.query("SELECT * FROM study_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
        if (!row) return null;
        await client.query("UPDATE study_jobs SET status='running',worker=$2,lease_until=now()+($3::int * interval '1 millisecond') WHERE id=$1", [row.id, this.id, this.leaseMs]);
        return row;
      });
      if (job && !this.closed) {
        const controller = new AbortController();
        const task = this.executeJob(job, controller).catch(() => {}).finally(() => this.tasks.delete(job.id));
        this.tasks.set(job.id, { controller, task });
      }
    } finally { this.ticking = false; }
  }
  async patchJob(job, update, terminal = false) {
    return this.run(async ({ service, client }) => {
      const row = (await client.query("SELECT status,worker,lease_until>now() AS valid FROM study_jobs WHERE id=$1", [job.id])).rows[0];
      if (row?.status !== 'running' || row.worker !== this.id || !row.valid) return false;
      const match = service.matches.get(job.match_id), round = match?.rounds[job.round_index];
      if (!round || (job.kind === 'answer' ? match.status !== 'active' || round.aiJobId !== job.id : round.coachJobId !== job.id)) return false;
      await update({ match, round, service, client });
      service.publish(match);
      if (terminal) await client.query("UPDATE study_jobs SET status='done',finished_at=now() WHERE id=$1", [job.id]);
      return true;
    }, { matchId: job.match_id });
  }
  async recover() {
    const ids = (await this.pool.query("SELECT DISTINCT match_id FROM study_jobs WHERE status='running' AND lease_until < now()")).rows;
    for (const { match_id: matchId } of ids) await this.run(async ({ service, client }) => {
      const expired = (await client.query("SELECT * FROM study_jobs WHERE match_id=$1 AND status='running' AND lease_until < now() FOR UPDATE", [matchId])).rows;
      for (const job of expired) {
        const match = service.matches.get(job.match_id), round = match?.rounds[job.round_index];
        if (round && job.kind === 'answer' && round.aiJobId === job.id && match.status === 'active') {
          round.aiStatus = 'error'; round.phase = round.humanChoice ? 'error' : 'human'; round.aiTimingIncomplete = true;
          round.errorCode = 'server_restart'; round.error = '模型任务中断，你的答案已保留；请手动重试，本题尚未计分。';
          round.aiMs = (round.aiMs || 0) + Math.max(0, Date.parse(round.aiCheckpointAt || round.aiAttemptStartedAt) - Date.parse(round.aiAttemptStartedAt));
          service.publish(match);
        } else if (round && job.kind === 'coach' && round.coachJobId === job.id) { round.coachBusy = false; service.publish(match); }
        await client.query("UPDATE study_jobs SET status='interrupted',finished_at=now() WHERE id=$1", [job.id]);
      }
    }, { matchId });
  }
  async executeJob(job, controller) {
    let pulseBusy = false;
    const heartbeat = setInterval(async () => {
      if (pulseBusy) return; pulseBusy = true;
      try {
        if (!this.redis.isReady) throw new StorageError();
        const result = await this.pool.query("UPDATE study_jobs SET lease_until=now()+($3::int * interval '1 millisecond') WHERE id=$1 AND worker=$2 AND status='running' AND lease_until>now() RETURNING id", [job.id, this.id, this.leaseMs]);
        if (!result.rowCount) controller.abort();
      } catch { controller.abort(); } finally { pulseBusy = false; }
    }, Math.max(100, Math.floor(this.leaseMs / 3)));
    try {
      const match = await this.run(({ service }) => structuredClone(service.matches.get(job.match_id)), { matchId: job.match_id, readOnly: true });
      if (!await this.patchJob(job, () => {})) return;
      await this.withQuestions(async context => {
        if (job.kind === 'answer') await this.answer(job, match, controller, context);
        else await this.coach(job, match, controller.signal, context);
      });
    } catch (error) {
      await this.patchJob(job, ({ round }) => {
        if (job.kind === 'coach') { round.coachBusy = false; return; }
        round.aiStatus = 'error'; round.phase = round.humanChoice ? 'error' : 'human'; round.aiTimingIncomplete = controller.signal.aborted;
        round.aiMs = (round.aiMs || 0) + Math.max(0, Date.now() - Date.parse(round.aiAttemptStartedAt));
        round.errorCode = error instanceof ProviderError ? error.code : 'connection_error';
        round.error = error instanceof ProviderError ? error.message : '模型任务中断，你的答案已保留；请手动重试，本题尚未计分。';
      }, true).catch(() => {});
      // Do not expose provider errors, keys or upstream response bodies in Redis.
      if (job.kind === 'coach') await this.pool.query("UPDATE study_jobs SET status='interrupted' WHERE id=$1 AND worker=$2 AND status='done'", [job.id, this.id]).catch(() => {});
    } finally { clearInterval(heartbeat); }
  }
  async answer(job, match, controller, { bank, config }) {
    const signal = controller.signal;
    const local = match.rounds[job.round_index], q = bank.byId.get(match.questionIds[job.round_index]);
    const fields = {}, started = Date.parse(local.aiAttemptStartedAt), previousMs = local.aiMs || 0;
    let chain = Promise.resolve(), dirty = false;
    const checkpoint = () => {
      if (!dirty) return chain;
      dirty = false; const captured = structuredClone(fields);
      chain = chain.then(async () => {
        signal.throwIfAborted();
        const valid = await this.patchJob(job, ({ round }) => { Object.assign(round, captured); });
        if (!valid) throw new DOMException('Cancelled', 'AbortError');
      });
      chain.catch(() => controller.abort()); return chain;
    };
    const timer = setInterval(() => checkpoint(), 150);
    const emit = (type, data) => {
      if (signal.aborted) return;
      if (type === 'phase') Object.assign(local, { stage: data.phase, stageLabel: data.label, progress: null });
      if (type === 'model_progress') local.progress = { ...data, updatedAt: stamp() };
      if (type === 'provider_request') (local.requests ||= []).push({ ...data, attempt: local.attempts });
      if (type === 'explanation_complete') { local.explanation = data.text; local.explanationComplete = true; }
      if (['explanation', 'transcription'].includes(type)) local[type] = (local[type] || '') + data.text;
      local.aiCheckpointAt = stamp();
      for (const key of AI_FIELDS) if (Object.hasOwn(local, key)) fields[key] = local[key];
      dirty = true;
    };
    try {
      signal.throwIfAborted();
      const context = { signal, emit, previousRequests: job.payload.previousRequests || [], savedExplanation: local.explanationComplete ? local.explanation : '',
        // Hidden provider continuation is intentionally neither stored nor exposed.
        // A manual retry can continue from the public explanation alone.
        savedContinuation: null, saveContinuation: () => {} };
      const result = match.settings.demo ? await this.providers.demo(q, match.settings.mode, context)
        : match.settings.mode === 'jev' ? await this.providers.jev(q, config, context) : await this.providers.llm(q, config.llm, context);
      signal.throwIfAborted();
      if (!Object.hasOwn(q.options, result.choice) || result.tool?.name !== 'submit_answer' || result.tool.arguments?.choice !== result.choice) throw new ProviderError('模型没有提交可验证的工具答案。');
      clearInterval(timer); await checkpoint();
      await this.patchJob(job, ({ round, match: current, service }) => {
        Object.assign(round, { aiChoice: result.choice, tool: result.tool, model: result.model, aiMs: previousMs + Math.max(0, Date.now() - started),
          aiCompletedAt: stamp(), aiStatus: 'ready', explanation: result.explanation ?? local.explanation,
          probabilities: result.probabilities || null, confidence: result.confidence ?? null, visualAssisted: Boolean(result.visualAssisted) });
        service.reveal(current);
      }, true);
    } finally { clearInterval(timer); await checkpoint().catch(() => {}); }
  }
  async coach(job, match, signal, { bank, config }) {
    const service = new MatchService(bank, config, { persist: false });
    const coach = new CoachService(bank, service, config, this.coachProvider ? { provider: this.coachProvider } : {});
    const round = match.rounds[job.round_index]; round.coachBusy = false; round.coachTurns--;
    let content = '', dirty = false, chain = Promise.resolve();
    const checkpoint = () => { if (!dirty) return chain; dirty = false; const text = content;
      chain = chain.then(() => this.redis.withAbortSignal(AbortSignal.timeout(1500)).set(this.prefix + 'coach:' + job.id, text, { EX: 3600 })); chain.catch(() => {}); return chain; };
    const timer = setInterval(checkpoint, 150);
    try {
      await coach.reply(match, job.round_index, job.payload.message, { signal, emit: (type, data) => { if (type === 'text') { content += data.text; dirty = true; } } });
      clearInterval(timer); await checkpoint(); signal.throwIfAborted();
      await this.patchJob(job, ({ round: target }) => { target.coachMessages = round.coachMessages; target.coachBusy = false; }, true);
    } finally { clearInterval(timer); await checkpoint().catch(() => {}); }
  }
  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    for (const { controller } of this.tasks.values()) controller.abort();
    await Promise.allSettled([...this.tasks.values()].map(task => task.task));
    for (const client of [this.subscriber, this.redis]) if (client.isOpen) client.destroy();
    await this.pool.end().catch(() => {});
    this.resourceManager?.close();
  }
}
