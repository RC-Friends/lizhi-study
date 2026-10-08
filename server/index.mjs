import { loadConfig } from './config.mjs';
import { MatchService } from './matches.mjs';
import { createApp } from './app.mjs';
import { DistributedRuntime } from './distributed.mjs';
import { loadQuestionResources } from './resource-loader.mjs';

const config = loadConfig();
if (config.storageDriver === 'postgres' && (!config.databaseUrl || !config.redisUrl)) throw new Error('无状态后端需要 DATABASE_URL 和 REDIS_URL。');
if (process.env.NODE_ENV === 'production' && config.storageDriver !== 'postgres') throw new Error('生产环境需要 PostgreSQL 和 Redis。');
const { bank, resources } = await loadQuestionResources(config);
const runtime = config.storageDriver === 'postgres' ? await DistributedRuntime.open(bank, config) : null;
const service = new MatchService(bank, config, { persist: !runtime });
const app = createApp(bank, service, config, { runtime });
const server = app.listen(config.port, config.host, error => {
  if (error) { console.error('后端端口监听失败。'); process.exitCode = 1; runtime?.close(); resources?.close(); return; }
  console.log(`Backend ready on port ${config.port}; ${bank.rows.length} questions; ${runtime ? 'PostgreSQL + Redis' : 'local development files'}`);
});
server.requestTimeout = 150000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  server.close(); service.shutdown(); app.locals.coach.shutdown();
  const deadline = setTimeout(() => process.exit(1), 20000); deadline.unref();
  try { await runtime?.close(); await service.flush(); resources?.close(); process.exit(0); }
  catch { resources?.close(); process.exit(1); }
});
