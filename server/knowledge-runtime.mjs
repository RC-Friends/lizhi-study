import { KnowledgeService } from './knowledge.mjs';
import { AiConfigService } from './ai-config.mjs';
import { DraftService } from './question-drafts.mjs';
import { PostgresStore } from './storage.mjs';

// Knowledge/configuration writes use their own short transaction and never
// acquire the learner's match lock. Inference runs outside this transaction.
export async function runKnowledge(runtime, config, work, { readOnly = false, configurationOnly = false, retrievalOnly = false } = {}) {
  const client = await runtime.pool.connect(), writes = [];
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    if (!readOnly) await client.query('SELECT pg_advisory_xact_lock(1937012089, 8)');
    const storage = { enqueue: operation => writes.push(operation) };
    for (const name of ['saveKbLibrary', 'deleteKbLibrary', 'saveKbDocument', 'deleteKbDocument', 'saveKbDraft', 'deleteKbDraft', 'saveAiConfig']) {
      storage[name] = PostgresStore.prototype[name].bind(storage);
    }
    storage.aiConfig = (await client.query("SELECT id,payload FROM study_ai_config WHERE id='platform'")).rows.map(row => ({ id: row.id, value: row.payload }));
    if (!configurationOnly) {
      storage.kbLibraries = (await client.query('SELECT payload FROM study_kb_libraries')).rows.map(row => row.payload);
      // Retrieval does not need image base64 payloads or the draft inbox.
      storage.kb = (await client.query(`SELECT payload FROM study_kb_documents${retrievalOnly ? " WHERE payload->>'format'<>'image'" : ''}`)).rows.map(row => row.payload);
      if (!retrievalOnly) storage.kbDrafts = (await client.query('SELECT payload FROM study_kb_drafts ORDER BY created_at,id')).rows.map(row => row.payload);
    }
    const aiConfig = new AiConfigService(config, { storage });
    const knowledge = new KnowledgeService(config, { storage });
    const drafts = new DraftService(config, { storage, llmResolver: () => aiConfig.effectiveLlm() });
    const result = await work({ knowledge, drafts, aiConfig });
    if (readOnly && writes.length) throw new Error('Knowledge read attempted to mutate state');
    for (const operation of writes) await operation(client);
    // Existing learner dashboards poll this revision before refreshing their
    // provider catalog. A saved model must not leave stale readiness controls.
    if (configurationOnly && writes.length) await client.query('UPDATE study_state SET revision=revision+1 WHERE id=1');
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
