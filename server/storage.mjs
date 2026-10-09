import pg from 'pg';
import { validateKnowledge, validateLibrary } from './knowledge.mjs';
import { validateDraft } from './question-drafts.mjs';

export class StorageError extends Error {
  constructor(message = '数据库暂时不可用，请稍后重试。', code = 'storage_unavailable') {
    super(message); this.name = 'StorageError'; this.status = 503; this.code = code;
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS study_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS study_matches (
  id text PRIMARY KEY, owner_id text, status text NOT NULL CHECK (status IN ('active', 'finished')),
  revision integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload->>'id' = id)
);
CREATE INDEX IF NOT EXISTS study_matches_owner_created ON study_matches(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS study_matches_status ON study_matches(status);
CREATE TABLE IF NOT EXISTS study_profiles (owner_id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS study_annotations (
  owner_id text NOT NULL, question_id text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (owner_id, question_id)
);
CREATE TABLE IF NOT EXISTS study_imports (
  fingerprint text PRIMARY KEY, counts jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS study_kb_libraries (
  id text PRIMARY KEY, owner_id text NOT NULL, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS study_kb_documents (
  id text PRIMARY KEY, library_id text, sha256 text NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS study_kb_documents_sha ON study_kb_documents(sha256);
CREATE INDEX IF NOT EXISTS study_kb_documents_library ON study_kb_documents(library_id);
ALTER TABLE study_kb_documents ADD COLUMN IF NOT EXISTS library_id text;
CREATE TABLE IF NOT EXISTS study_ai_config (
  id text PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS study_kb_drafts (
  id text PRIMARY KEY, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL
);
INSERT INTO study_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
`;
export const MATCH_UPSERT = `INSERT INTO study_matches(id, owner_id, status, revision, created_at, payload)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id, status=EXCLUDED.status,
    revision=EXCLUDED.revision, payload=EXCLUDED.payload, updated_at=now()
  WHERE study_matches.revision <= EXCLUDED.revision RETURNING id`;
export const matchValues = match => [match.id, match.ownerId || null, match.status, match.revision, match.createdAt, JSON.stringify(match)];

export function validateMatch(match, bank) {
  if (!match || typeof match.id !== 'string' || !match.id || typeof match.tokenHash !== 'string'
      || !Array.isArray(match.questionIds) || !match.questionIds.length || new Set(match.questionIds).size !== match.questionIds.length
      || !Array.isArray(match.rounds) || !match.rounds.length || match.rounds.length > match.questionIds.length
      || !Number.isInteger(match.index) || match.index < 0 || match.index >= match.rounds.length
      || !Number.isInteger(match.revision) || match.revision < 0 || !Number.isFinite(Date.parse(match.createdAt))
      || !['active', 'finished'].includes(match.status) || !['practice', 'llm', 'jev'].includes(match.settings?.mode)) {
    throw new Error('答题记录结构无效，已停止加载，未删除原记录。');
  }
  for (const [index, id] of match.questionIds.entries()) {
    if (!bank.byId.has(id)) throw new Error(`资源包缺少历史记录引用的题目：${id}`);
    if (match.questionFingerprints && match.questionFingerprints[index] !== bank.fingerprints.get(id)) {
      throw new Error(`题目内容与历史记录不一致：${id}；请保留原题或使用新的题目 ID。`);
    }
  }
  return match;
}

export function validateLearning(data, bank) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (data?.version !== 1 || !object(data.profiles) || !object(data.questions)) throw new Error('学习档案结构无效。');
  for (const profile of Object.values(data.profiles)) if (!object(profile)) throw new Error('考生资料结构无效。');
  for (const annotations of Object.values(data.questions)) {
    if (!object(annotations)) throw new Error('笔记结构无效。');
    for (const [id, annotation] of Object.entries(annotations)) {
      if (!bank.byId.has(id) || !object(annotation)) throw new Error(`笔记引用的题目不可用：${id}`);
    }
  }
  return data;
}

// The match engine and SSE subscriptions currently live in one process. Keep one
// writer per database until that engine is distributed; a second app fails closed.
// Use a dedicated connection: PostgreSQL session locks cannot use transaction pooling.
export class PostgresStore {
  static async open(connectionString, bank) {
    if (!connectionString) throw new StorageError('PostgreSQL 模式需要 DATABASE_URL。', 'database_not_configured');
    const store = new PostgresStore(connectionString);
    try {
      await store.client.connect();
      const lock = await store.client.query('SELECT pg_try_advisory_lock(1937012089, 1) AS acquired');
      if (!lock.rows[0].acquired) throw new StorageError('该数据库已有应用或迁移程序运行；当前版本只允许一个应用副本。', 'database_in_use');
      await store.client.query('BEGIN');
      try {
        const exists = await store.client.query("SELECT to_regclass('study_schema_migrations') AS name");
        if (exists.rows[0].name) {
          const version = await store.client.query('SELECT max(version) AS version FROM study_schema_migrations');
          if (version.rows[0].version > 1) throw new StorageError('数据库版本高于此应用支持的版本。', 'schema_too_new');
        }
        await store.client.query(SCHEMA);
        await store.client.query('COMMIT');
      } catch (error) { await store.client.query('ROLLBACK').catch(() => {}); throw error; }
      store.loadedMatches = (await store.client.query('SELECT payload FROM study_matches ORDER BY created_at, id')).rows.map(row => validateMatch(row.payload, bank));
      const profiles = (await store.client.query('SELECT owner_id, payload FROM study_profiles')).rows;
      const annotations = (await store.client.query('SELECT owner_id, question_id, payload FROM study_annotations')).rows;
      store.learning = { version: 1, profiles: Object.fromEntries(profiles.map(row => [row.owner_id, row.payload])), questions: {} };
      for (const row of annotations) (store.learning.questions[row.owner_id] ||= {})[row.question_id] = row.payload;
      validateLearning(store.learning, bank);
      store.kbLibraries = (await store.client.query('SELECT payload FROM study_kb_libraries ORDER BY payload->>\'createdAt\', id')).rows.map(row => validateLibrary(row.payload));
      store.kb = (await store.client.query('SELECT payload FROM study_kb_documents ORDER BY uploaded_at, id')).rows.map(row => validateKnowledge(row.payload));
      store.aiConfig = (await store.client.query("SELECT id,payload FROM study_ai_config WHERE id='platform'")).rows.map(row => ({ id: row.id, value: row.payload }));
      store.kbDrafts = (await store.client.query('SELECT payload FROM study_kb_drafts ORDER BY created_at, id')).rows.map(row => validateDraft(row.payload));
      return store;
    } catch (error) {
      await store.close();
      if (error instanceof StorageError || /题目|记录|笔记|档案|资料/.test(error.message)) throw error;
      throw new StorageError('无法初始化数据库，请检查连接配置与数据库状态。', 'database_connect_failed');
    }
  }
  constructor(connectionString) {
    this.client = new pg.Client({ connectionString, application_name: 'xingce-study',
      connectionTimeoutMillis: 10000, query_timeout: 15000, statement_timeout: 10000,
      keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    this.tail = Promise.resolve(); this.failure = null; this.closed = false;
    this.failureListeners = new Set();
    this.client.on('error', () => this.fail());
    this.client.on('end', () => { if (!this.closed) this.fail(); });
  }
  onFailure(listener) { this.failureListeners.add(listener); return () => this.failureListeners.delete(listener); }
  fail() {
    if (this.failure || this.closed) return;
    this.failure = new StorageError();
    for (const listener of this.failureListeners) listener(this.failure);
  }
  assertHealthy() { if (this.failure || this.closed) throw this.failure || new StorageError(); }
  enqueue(work) {
    this.assertHealthy();
    // Capture values before enqueueing. Never serialize a mutable match later.
    this.tail = this.tail.then(async () => { this.assertHealthy(); await work(this.client); }).catch(() => this.fail());
  }
  async flush() {
    let pending;
    do { pending = this.tail; await pending; this.assertHealthy(); } while (pending !== this.tail);
  }
  async health() {
    await this.flush();
    try { await this.client.query('SELECT 1'); } catch { this.fail(); }
    this.assertHealthy();
  }
  saveMatch(match) {
    const values = matchValues(match);
    this.enqueue(async client => {
      const result = await client.query(MATCH_UPSERT, values);
      if (result.rowCount !== 1) throw new Error('Stale match revision');
    });
  }
  saveProfile(ownerId, profile) {
    const payload = JSON.stringify(profile);
    this.enqueue(client => client.query(`INSERT INTO study_profiles(owner_id, payload) VALUES ($1, $2::jsonb)
      ON CONFLICT (owner_id) DO UPDATE SET payload=EXCLUDED.payload`, [ownerId, payload]));
  }
  saveAnnotation(ownerId, questionId, annotation) {
    const payload = JSON.stringify(annotation);
    this.enqueue(client => client.query(`INSERT INTO study_annotations(owner_id, question_id, payload) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (owner_id, question_id) DO UPDATE SET payload=EXCLUDED.payload`, [ownerId, questionId, payload]));
  }
  saveKbLibrary(library) {
    this.enqueue(client => client.query(`INSERT INTO study_kb_libraries(id, owner_id, payload) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload`, [library.id, library.ownerId, JSON.stringify(library)]));
  }
  deleteKbLibrary(id) {
    this.enqueue(client => client.query('DELETE FROM study_kb_libraries WHERE id=$1', [id]));
  }
  saveKbDocument(document) {
    this.enqueue(client => client.query(`INSERT INTO study_kb_documents(id, library_id, sha256, uploaded_at, payload) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (id) DO UPDATE SET library_id=EXCLUDED.library_id, payload=EXCLUDED.payload`,
      [document.id, document.libraryId, document.sha256, document.uploadedAt, JSON.stringify(document)]));
  }
  deleteKbDocument(id) {
    this.enqueue(client => client.query('DELETE FROM study_kb_documents WHERE id=$1', [id]));
  }
  saveAiConfig(entry) {
    this.enqueue(client => client.query(`INSERT INTO study_ai_config(id, payload) VALUES ('platform', $1::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload`, [JSON.stringify(entry.value)]));
  }
  saveKbDraft(draft) {
    this.enqueue(client => client.query(`INSERT INTO study_kb_drafts(id, status, created_at, payload) VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload`, [draft.id, draft.status, draft.createdAt, JSON.stringify(draft)]));
  }
  deleteKbDraft(id) {
    this.enqueue(client => client.query('DELETE FROM study_kb_drafts WHERE id=$1', [id]));
  }
  async importLegacy({ fingerprint, matches, learning }) {
    await this.flush();
    const existing = await this.client.query('SELECT counts FROM study_imports WHERE fingerprint=$1', [fingerprint]);
    if (existing.rowCount) return { ...existing.rows[0].counts, alreadyImported: true };
    const occupied = await this.client.query(`SELECT EXISTS(SELECT 1 FROM study_matches) OR EXISTS(SELECT 1 FROM study_profiles)
      OR EXISTS(SELECT 1 FROM study_annotations) OR EXISTS(SELECT 1 FROM study_imports) AS occupied`);
    if (occupied.rows[0].occupied) throw new Error('目标数据库已有数据，拒绝覆盖或混合导入。请使用新的空数据库。');
    const counts = { matches: matches.length, profiles: Object.keys(learning.profiles).length,
      annotations: Object.values(learning.questions).reduce((n, rows) => n + Object.keys(rows).length, 0) };
    await this.client.query('BEGIN');
    try {
      for (const match of matches) await this.client.query(MATCH_UPSERT, matchValues(match));
      for (const [id, profile] of Object.entries(learning.profiles)) await this.client.query('INSERT INTO study_profiles VALUES ($1, $2::jsonb)', [id, JSON.stringify(profile)]);
      for (const [id, rows] of Object.entries(learning.questions)) for (const [questionId, annotation] of Object.entries(rows)) {
        await this.client.query('INSERT INTO study_annotations VALUES ($1, $2, $3::jsonb)', [id, questionId, JSON.stringify(annotation)]);
      }
      await this.client.query('INSERT INTO study_imports(fingerprint, counts) VALUES ($1, $2::jsonb)', [fingerprint, JSON.stringify(counts)]);
      await this.client.query('COMMIT');
      return { ...counts, alreadyImported: false };
    } catch { await this.client.query('ROLLBACK').catch(() => {}); throw new StorageError('导入未确认完成，未提交的事务已回滚；请使用相同备份重试核验。'); }
  }
  async close() {
    if (this.closed) return;
    await this.tail;
    this.closed = true;
    await this.client.end().catch(() => {});
  }
}

export async function openStorage(config, bank) {
  if (config.storageDriver === 'files') return null;
  if (config.storageDriver !== 'postgres') throw new Error('STORAGE_DRIVER 必须为 postgres 或 files。');
  return PostgresStore.open(config.databaseUrl, bank);
}
