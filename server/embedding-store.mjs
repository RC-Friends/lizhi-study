import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { embeddingText } from './embeddings.mjs';

export const EMBEDDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS study_kb_embedding_indexes (
  index_key text PRIMARY KEY, generation text NOT NULL
);
CREATE TABLE IF NOT EXISTS study_kb_embeddings (
  index_key text NOT NULL, document_id text NOT NULL REFERENCES study_kb_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK(chunk_index>=0), text_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','ready','failed')),
  embedding double precision[], worker text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz, error text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(index_key,document_id,chunk_index),
  CHECK(embedding IS NULL OR cardinality(embedding) BETWEEN 1 AND 8192)
);
CREATE INDEX IF NOT EXISTS study_kb_embeddings_work ON study_kb_embeddings(index_key,status,retry_at);
CREATE INDEX IF NOT EXISTS study_kb_embeddings_document ON study_kb_embeddings(document_id);
`;
const pgInput = "(d.payload->>'title') || E'\\n' || ((d.payload->'chunks'->e.chunk_index)->>'anchor') || E'\\n' || ((d.payload->'chunks'->e.chunk_index)->>'text')";
const matchesText = `e.text_hash=md5(${pgInput})`;
const access = "(l.owner_id=$2 OR l.payload->>'visibility'='public') AND ($3::text[] IS NULL OR d.library_id=ANY($3::text[]))";

export class PostgresEmbeddingStore {
  constructor(pool) { this.pool = pool; }
  async sync(key, { force = false, retry = false } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(1937012089,9)');
      await client.query('INSERT INTO study_kb_embedding_indexes(index_key,generation) VALUES($1,$2) ON CONFLICT(index_key) DO NOTHING', [key, crypto.randomUUID()]);
      if (force) await client.query('UPDATE study_kb_embedding_indexes SET generation=$2 WHERE index_key=$1', [key, crypto.randomUUID()]);
      await client.query(`INSERT INTO study_kb_embeddings(index_key,document_id,chunk_index,text_hash)
      SELECT $1,d.id,(c.ordinality-1)::int,md5((d.payload->>'title') || E'\\n' || (c.value->>'anchor') || E'\\n' || (c.value->>'text'))
      FROM study_kb_documents d CROSS JOIN LATERAL jsonb_array_elements(d.payload->'chunks') WITH ORDINALITY c(value,ordinality)
      WHERE d.payload->>'format'<>'image'
      ON CONFLICT(index_key,document_id,chunk_index) DO UPDATE SET text_hash=EXCLUDED.text_hash,status='queued',embedding=NULL,
        worker=NULL,lease_until=NULL,attempts=0,retry_at=NULL,error=NULL,updated_at=now()
      WHERE study_kb_embeddings.text_hash<>EXCLUDED.text_hash OR $2::boolean`, [key, force]);
      if (retry) await client.query("UPDATE study_kb_embeddings SET status='queued',attempts=0,retry_at=NULL,error=NULL WHERE index_key=$1 AND status='failed'", [key]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async claim(key, count, worker, leaseMs) {
    const result = await this.pool.query(`WITH picked AS (
      SELECT e.document_id,e.chunk_index FROM study_kb_embeddings e JOIN study_kb_documents d ON d.id=e.document_id
      WHERE e.index_key=$1 AND ${matchesText} AND ((e.status='queued') OR (e.status='working' AND e.lease_until<now())
        OR (e.status='failed' AND e.attempts<3 AND e.retry_at<=now()))
      ORDER BY e.document_id,e.chunk_index FOR UPDATE OF e SKIP LOCKED LIMIT $2
    ), claimed AS (
      UPDATE study_kb_embeddings e SET status='working',worker=$3,lease_until=now()+($4::int*interval '1 millisecond'),attempts=e.attempts+1,updated_at=now()
      FROM picked p WHERE e.index_key=$1 AND e.document_id=p.document_id AND e.chunk_index=p.chunk_index
      RETURNING e.*
    ) SELECT e.document_id,e.chunk_index,e.text_hash,${pgInput} AS text
      FROM claimed e JOIN study_kb_documents d ON d.id=e.document_id`, [key, count, worker, leaseMs]);
    return result.rows;
  }
  async complete(key, rows, vectors, worker) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(1937012089,9)');
      const dimensions = (await client.query("SELECT cardinality(embedding) AS dimensions FROM study_kb_embeddings WHERE index_key=$1 AND status='ready' LIMIT 1", [key])).rows[0]?.dimensions;
      if (dimensions && dimensions !== vectors[0].length) throw new Error('向量维度变动，请重建索引。');
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        await client.query(`UPDATE study_kb_embeddings e SET status='ready',embedding=$6::double precision[],worker=NULL,lease_until=NULL,error=NULL,retry_at=NULL,updated_at=now()
          FROM study_kb_documents d WHERE e.index_key=$1 AND e.document_id=$2 AND e.chunk_index=$3 AND e.text_hash=$4
            AND e.worker=$5 AND e.status='working' AND e.lease_until>now() AND d.id=e.document_id AND ${matchesText}`,
        [key, row.document_id, row.chunk_index, row.text_hash, worker, vectors[i]]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async fail(key, rows, worker, error) {
    await this.pool.query(`UPDATE study_kb_embeddings SET status='failed',error=$4,worker=NULL,lease_until=NULL,
      retry_at=now()+(LEAST(300,POWER(2,attempts)*15)::int*interval '1 second'),updated_at=now()
      WHERE index_key=$1 AND worker=$2 AND status='working' AND document_id=ANY($3::text[])`, [key, worker, rows.map(row => row.document_id), error]);
  }
  async status(key, { ownerId = 'primary', libraryIds = null } = {}) {
    const values = [key, ownerId, libraryIds];
    const generation = (await this.pool.query('SELECT generation FROM study_kb_embedding_indexes WHERE index_key=$1', [key])).rows[0]?.generation || 'initial';
    const total = (await this.pool.query(`SELECT COALESCE(sum(jsonb_array_length(d.payload->'chunks')),0)::int AS total
      FROM study_kb_documents d JOIN study_kb_libraries l ON l.id=d.library_id WHERE ${access.replaceAll('$2', '$1').replaceAll('$3', '$2')}`, [ownerId, libraryIds])).rows[0].total;
    const counts = (await this.pool.query(`SELECT e.status,count(*)::int AS count FROM study_kb_embeddings e
      JOIN study_kb_documents d ON d.id=e.document_id JOIN study_kb_libraries l ON l.id=d.library_id
      WHERE e.index_key=$1 AND ${matchesText} AND ${access} GROUP BY e.status`, values)).rows;
    const result = { generation, total, ready: 0, queued: 0, working: 0, failed: 0 };
    for (const row of counts) result[row.status] = row.count;
    result.queued += Math.max(0, total - result.ready - result.queued - result.working - result.failed);
    return result;
  }
  async search(key, vector, { ownerId, libraryIds, limit, minSimilarity, generation }) {
    const result = await this.pool.query(`SELECT d.library_id,d.id,d.payload->>'title' AS title,e.chunk_index,
      d.payload->'chunks'->e.chunk_index AS chunk,s.score
      FROM study_kb_embeddings e JOIN study_kb_documents d ON d.id=e.document_id JOIN study_kb_libraries l ON l.id=d.library_id
      CROSS JOIN LATERAL (SELECT sum(v.document_value*v.query_value) AS score FROM unnest(e.embedding,$4::double precision[]) v(document_value,query_value)) s
      WHERE e.index_key=$1 AND e.status='ready' AND cardinality(e.embedding)=cardinality($4::double precision[])
        AND ${matchesText} AND ${access} AND s.score >= $5
        AND ($7::text IS NULL OR COALESCE((SELECT generation FROM study_kb_embedding_indexes WHERE index_key=$1),'initial')=$7)
      ORDER BY s.score DESC,d.id,e.chunk_index LIMIT $6`, [key, ownerId, libraryIds, vector, minSimilarity, limit, generation || null]);
    return result.rows.map(row => ({ libraryId: row.library_id, document: { id: row.id, title: row.title },
      index: row.chunk_index, anchor: row.chunk.anchor, text: row.chunk.text, score: Math.min(1, row.score) }));
  }
}

// Development compatibility only. Production vectors and leases live in PostgreSQL.
export class LocalEmbeddingStore {
  constructor(config, knowledge, { persist = true, clock = Date.now } = {}) {
    this.knowledge = knowledge; this.persist = persist; this.clock = clock; this.rows = new Map(); this.generations = new Map();
    this.filename = path.join(path.dirname(config.runtimePath), 'kb-embeddings.json');
    if (persist && fs.existsSync(this.filename)) {
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.rows)) throw new Error('知识库向量文件无法读取。');
      for (const row of saved.rows) this.rows.set(row.id, row);
      this.generations = new Map(Object.entries(saved.generations || {}));
    }
  }
  save() {
    if (!this.persist) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify({ version: 1, rows: [...this.rows.values()], generations: Object.fromEntries(this.generations) }), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  entries() {
    return [...this.knowledge.documents.values()].flatMap(document => document.chunks.map(chunk => ({
      document, chunk, document_id: document.id, chunk_index: chunk.index,
      text: embeddingText(document, chunk), text_hash: crypto.createHash('md5').update(embeddingText(document, chunk)).digest('hex'),
    })));
  }
  async sync(key, { force = false, retry = false } = {}) {
    if (force || !this.generations.has(key)) this.generations.set(key, crypto.randomUUID());
    const entries = this.entries(), valid = new Set(entries.map(entry => `${entry.document_id}:${entry.chunk_index}`));
    for (const [id, row] of this.rows) if (!valid.has(`${row.document_id}:${row.chunk_index}`)) this.rows.delete(id);
    for (const entry of entries) {
      const id = `${key}:${entry.document_id}:${entry.chunk_index}`, old = this.rows.get(id);
      if (!old || force || old.text_hash !== entry.text_hash || (retry && old.status === 'failed')) this.rows.set(id, {
        id, key, document_id: entry.document_id, chunk_index: entry.chunk_index, text_hash: entry.text_hash, status: 'queued', attempts: 0,
      });
    }
    this.save();
  }
  async claim(key, count, worker, leaseMs) {
    const entries = new Map(this.entries().map(entry => [`${entry.document_id}:${entry.chunk_index}`, entry])), selected = [];
    for (const row of this.rows.values()) {
      if (row.key !== key || !['queued', 'working', 'failed'].includes(row.status)) continue;
      if (row.status === 'working' && row.lease_until > this.clock()) continue;
      if (row.status === 'failed' && (row.attempts >= 3 || row.retry_at > this.clock())) continue;
      const entry = entries.get(`${row.document_id}:${row.chunk_index}`); if (!entry || entry.text_hash !== row.text_hash) continue;
      Object.assign(row, { status: 'working', worker, lease_until: this.clock() + leaseMs, attempts: row.attempts + 1 });
      selected.push({ ...row, text: entry.text }); if (selected.length === count) break;
    }
    if (selected.length) this.save(); return selected;
  }
  async complete(key, rows, vectors, worker) {
    const dimensions = [...this.rows.values()].find(row => row.key === key && row.status === 'ready')?.embedding.length;
    if (dimensions && dimensions !== vectors[0].length) throw new Error('向量维度变动，请重建索引。');
    const entries = new Map(this.entries().map(entry => [`${entry.document_id}:${entry.chunk_index}`, entry]));
    rows.forEach((claim, i) => {
      const row = this.rows.get(claim.id), entry = entries.get(`${claim.document_id}:${claim.chunk_index}`);
      if (row?.worker === worker && row.status === 'working' && row.lease_until > this.clock() && row.text_hash === entry?.text_hash) Object.assign(row, { status: 'ready', embedding: vectors[i], worker: null, error: null });
    }); this.save();
  }
  async fail(key, rows, worker, error) {
    for (const claim of rows) { const row = this.rows.get(claim.id); if (row?.worker === worker && row.status === 'working') Object.assign(row, { status: 'failed', error, worker: null, retry_at: this.clock() + 30000 }); }
    this.save();
  }
  async status(key, { ownerId = 'primary', libraryIds = null } = {}) {
    const allowed = this.knowledge.accessibleLibraryIds(ownerId).filter(id => !libraryIds || libraryIds.includes(id));
    const entries = this.entries().filter(entry => allowed.includes(entry.document.libraryId));
    const result = { generation: this.generations.get(key) || 'initial', total: entries.length, ready: 0, queued: 0, working: 0, failed: 0 };
    for (const entry of entries) {
      const row = this.rows.get(`${key}:${entry.document_id}:${entry.chunk_index}`);
      result[row?.text_hash === entry.text_hash ? row.status : 'queued']++;
    }
    return result;
  }
  async search(key, vector, { ownerId, libraryIds, limit, minSimilarity, generation }) {
    if (generation && generation !== (this.generations.get(key) || 'initial')) return [];
    const allowed = this.knowledge.accessibleLibraryIds(ownerId).filter(id => !libraryIds || libraryIds.includes(id));
    return this.entries().filter(entry => allowed.includes(entry.document.libraryId)).flatMap(entry => {
      const row = this.rows.get(`${key}:${entry.document_id}:${entry.chunk_index}`);
      if (row?.status !== 'ready' || row.text_hash !== entry.text_hash || row.embedding.length !== vector.length) return [];
      const score = Math.min(1, row.embedding.reduce((sum, value, i) => sum + value * vector[i], 0));
      return score < minSimilarity ? [] : [{ libraryId: entry.document.libraryId, document: { id: entry.document.id, title: entry.document.title },
        index: entry.chunk.index, anchor: entry.chunk.anchor, text: entry.chunk.text, score }];
    }).sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id) || a.index - b.index).slice(0, limit);
  }
}
