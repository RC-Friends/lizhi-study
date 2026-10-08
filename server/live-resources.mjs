import pg from 'pg';
import { QuestionBank, HttpError } from './bank.mjs';
import { ObjectResources } from './object-resources.mjs';

// The database pointer is authoritative after the first activation. The env
// version only bootstraps a new database, so restarting cannot undo an import.
export async function configuredResourceVersion(config) {
  if (config.storageDriver !== 'postgres' || config.resourceDriver !== 's3') return config.resourceVersion;
  const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    await client.connect();
    const exists = await client.query("SELECT to_regclass('study_state') AS name");
    if (!exists.rows[0].name) return config.resourceVersion;
    return (await client.query("SELECT to_jsonb(s)->>'resource_version' AS version FROM study_state s WHERE id=1")).rows[0]?.version || config.resourceVersion;
  } finally { await client.end().catch(() => {}); }
}

export class LiveResources {
  constructor(config, bank, resources) {
    this.config = config; this.entries = new Map(); this.loading = new Map(); this.closed = false;
    this.entries.set(config.resourceVersion, this.entry(config.resourceVersion, bank, resources));
  }
  entry(version, bank, resources) {
    return { version, bank, resources, uses: 0, touched: Date.now(), config: { ...this.config, resourceVersion: version,
      questionResources: resources, llm: { ...this.config.llm, questionResources: resources } } };
  }
  async currentVersion(client) { return (await client.query('SELECT resource_version FROM study_state WHERE id=1')).rows[0]?.resource_version || this.config.resourceVersion; }
  async acquireCurrent(client) { return this.acquire(await this.currentVersion(client)); }
  async acquire(version) {
    if (this.closed) throw new HttpError(503, '题库服务正在关闭。');
    if (!this.entries.has(version)) {
      if (!this.loading.has(version)) this.loading.set(version, (async () => {
        const resources = new ObjectResources(this.config.s3, version);
        try { const bank = new QuestionBank(null, await resources.load()); this.entries.set(version, this.entry(version, bank, resources)); }
        catch (error) { resources.close(); throw error; }
        finally { this.loading.delete(version); }
      })());
      await this.loading.get(version);
    }
    const entry = this.entries.get(version); entry.uses++; entry.touched = Date.now(); let released = false;
    return { ...entry, release: () => { if (released) return; released = true; entry.uses--; entry.touched = Date.now(); this.prune(); } };
  }
  prune() {
    // Existing model calls pin their original resource snapshot until finished.
    const idle = [...this.entries.values()].filter(entry => !entry.uses).sort((a, b) => b.touched - a.touched);
    for (const entry of idle.slice(1)) if (entry.touched < Date.now() - 1000) { this.entries.delete(entry.version); entry.resources.close(); }
  }
  close() { this.closed = true; for (const entry of this.entries.values()) entry.resources.close(); this.entries.clear(); }
}
