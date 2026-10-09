import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, providerCatalog } from './config.mjs';
import { HttpError } from './bank.mjs';
import { createAuth } from './auth.mjs';
import { LearningService } from './learning.mjs';
import { KnowledgeService } from './knowledge.mjs';
import { DraftService, completeDraft } from './question-drafts.mjs';
import { runKnowledge } from './knowledge-runtime.mjs';
import { AiConfigService } from './ai-config.mjs';
import { CoachService } from './coach.mjs';
import { ProviderError } from './providers.mjs';
import { defaultImagesPath } from './resources.mjs';
import { imageMime } from './object-resources.mjs';
import { questionImportRouter } from './question-import-api.mjs';
import { publicStats, publicStatsQuery } from './public-stats.mjs';

export function createApp(bank, service, config, options = {}) {
  const app = express(), auth = createAuth(config);
  const learning = options.learning || new LearningService(bank, service, config, { persist: service.persist });
  const knowledge = options.knowledge || new KnowledgeService(config, { storage: service.storage, persist: service.persist });
  const aiConfig = options.aiConfig || new AiConfigService(options.runtime ? { ...config, llm: {}, jev: {}, vision: {} } : config, { storage: service.storage, persist: service.persist });
  const drafts = options.drafts || new DraftService(config, { storage: service.storage, persist: service.persist, llmResolver: () => aiConfig.effectiveLlm() });
  const coach = options.coach || new CoachService(bank, service, config);
  service.storage?.onFailure(() => coach.shutdown());
  app.locals.learning = learning; app.locals.coach = coach; app.locals.knowledge = knowledge; app.locals.drafts = drafts; app.locals.aiConfig = aiConfig;
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.set('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return next(new HttpError(403, '请求来源无效。')); }
      const dev = ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '5173'
        && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const configured = config.publicUrl && origin.origin === new URL(config.publicUrl).origin;
      if (origin.host !== req.get('host') && !dev && !configured) return next(new HttpError(403, '不允许跨站提交。'));
    }
    next();
  });
  const runtime = options.runtime;
  const local = { service, learning, coach, knowledge, drafts, aiConfig };
  const run = (work, options) => runtime ? runtime.run(work, options) : Promise.resolve().then(() => {
    service.config = aiConfig.effectiveConfig(); coach.config = service.config;
    return work(local);
  }).then(async value => { await service.flush(); return value; });
  const buckets = new Map();
  async function limit(key, count, windowMs) {
    if (runtime) return runtime.limit(key, count, windowMs);
    const now = Date.now();
    if (buckets.size > 2000) for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id);
    const item = buckets.get(key) || { count: 0, until: now + windowMs };
    if (item.until <= now) { item.count = 0; item.until = now + windowMs; }
    buckets.set(key, item);
    if (++item.count > count) throw new HttpError(429, '操作过于频繁，请稍后再试。', 'rate_limited');
  }
  const token = req => req.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  // Authenticate administrators before buffering large imports. Learner JWTs
  // cannot access this router; normal study requests retain their small limit.
  app.use('/api/admin/question-bank', questionImportRouter(bank, config, { limit, runtime, auth }));
  // Knowledge uploads carry whole PDF/Word files as base64; parsed before the
  // small global JSON limit so ordinary study requests stay cheap.
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/kb\/libraries\/[^/]+\/documents$/.test(req.path)) {
      try { auth.requireToken(token(req)); } catch (error) { return next(error); }
      return express.json({ limit: '28mb', inflate: false })(req, res, next);
    }
    next();
  });
  app.use(express.json({ limit: '24kb' }));
  const route = (handler, { readOnly = false, match = false, cache = false } = {}) => async (req, res) => {
    const work = ctx => handler(req, ctx);
    const value = runtime && cache ? await runtime.cached(`${req.viewer?.sub || 'public'}:${req.originalUrl}`, work)
      : await run(work, { readOnly, ...(match ? { matchId: req.params.id } : {}) });
    res.json(value);
  };
  const overview = (req, learning, publicOnly = false) => {
    const ownerId = req.viewer?.sub || 'primary';
    return { ...(publicOnly ? learning.publicDashboard() : learning.dashboard(ownerId)),
      history: learning.history({ ownerId, publicOnly, page: 1, pageSize: 20 }),
      ...(publicOnly ? {} : { wrong: learning.collection({ ownerId, kind: 'wrong', page: 1, pageSize: 20,
        module: req.query.wrongModule || 'all', search: req.query.wrongSearch || '', includeMastered: req.query.wrongMastered || false }),
        bookmarks: learning.collection({ ownerId, kind: 'bookmarked', page: 1, pageSize: 20,
          module: req.query.bookmarksModule || 'all', search: req.query.bookmarksSearch || '', includeMastered: req.query.bookmarksMastered || false }) }),
    };
  };
  const owned = (req, matches) => {
    const match = matches.matches.get(req.params.id);
    if (match?.ownerId === req.viewer.sub) return match;
    if (match && !match.ownerId && req.get('X-Match-Token')) return matches.authenticate(req.params.id, req.get('X-Match-Token'));
    throw new HttpError(404, '练习不存在或无权访问。', 'match_not_found');
  };
  app.get('/api/health/live', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', async (_req, res) => {
    try { await runtime?.health(); if (service.storage) await service.storage.health();
      if (runtime?.resourceManager) await runtime.withQuestions(({ resources }) => resources.health()); else await config.questionResources?.health();
      res.json({ ok: true, auth: 'jwt', guestAccess: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.post('/api/login', async (req, res) => {
    await limit(`login:${req.ip}`, 12, 60000);
    const session = auth.login(req.body?.password, req.body?.role || 'learner');
    if (session.role === 'admin') return res.json(session);
    res.json(await run(({ learning }) => ({ ...session, profile: { ...session.profile, name: learning.profile(session.profile.id).nickname } })));
  });
  app.get('/api/catalog', async (_req, res) => {
    const catalog = (bank, configuration, version) => ({ bank: bank.catalog(), resourceVersion: version, providers: providerCatalog(configuration),
      coach: { name: '小栗', ready: Boolean(configuration.llm.key && configuration.llm.model && configuration.llm.baseUrl) } });
    res.json(runtime ? await runtime.withQuestions(({ bank, config, version }) => catalog(bank, config, version)) : catalog(bank, aiConfig.effectiveConfig(), config.resourceVersion));
  });
  app.get('/api/public/revision', async (_req, res) => res.json({ dataRevision: runtime ? await runtime.revision() : null }));
  app.get('/api/public/stats', async (req, res) => {
    await limit(`public-stats:${req.ip}`, 60, 60000);
    const query = publicStatsQuery(req.query);
    const work = ({ learning }) => publicStats(learning, query);
    const value = runtime ? await runtime.cached('public:stats:v1:' + JSON.stringify(query), work)
      : { ...await run(work, { readOnly: true }), dataRevision: null };
    res.set('X-RateLimit-Limit', '60').json(value);
  });
  app.get('/api/public/overview', route((req, { learning }) => overview(req, learning, true), { cache: true }));
  app.get('/api/public/dashboard', route((_req, { learning }) => learning.publicDashboard(), { cache: true }));
  app.get('/api/public/history', route((req, { learning }) => learning.history({ publicOnly: true, page: req.query.page || 1, pageSize: req.query.pageSize || 20 }), { cache: true }));
  app.get('/api/public/matches/:id', route((req, { learning }) => learning.record(req.params.id, { publicOnly: true }), { cache: true }));
  app.use('/api', (req, _res, next) => {
    try { req.viewer = auth.requireToken(token(req)); next(); } catch (error) { next(error); }
  });
  const requireAdmin = (req, _res, next) => {
    try { auth.requireAdmin(token(req)); next(); } catch (error) { next(error); }
  };
  const requireLearner = (req, _res, next) => req.viewer.role === 'learner' ? next() : next(new HttpError(403, '请切换到考生身份进行练习。', 'learner_required'));
  app.get('/api/session', async (req, res) => {
    if (req.viewer.role === 'admin') return res.json(auth.publicSession(req.viewer));
    res.json(await run(({ learning }) => ({ ...auth.publicSession(req.viewer), profile: { id: req.viewer.sub, name: learning.profile(req.viewer.sub).nickname } }), { readOnly: true }));
  });
  app.use('/api/admin', requireAdmin);
  app.use('/api/ai/config', requireAdmin);
  app.use('/api/learning', requireLearner);
  app.use('/api/matches', requireLearner);
  const runKb = (work, options = {}) => runtime ? runKnowledge(runtime, config, work, options) : run(work);
  const kbRoute = (handler, readOnly = false) => async (req, res) => res.json(await runKb(ctx => handler(req, ctx), { readOnly }));
  app.get('/api/admin/status', async (_req, res) => {
    const services = {};
    try { await runtime?.health(); if (service.storage) await service.storage.health(); services.database = runtime || service.storage ? 'ready' : 'local'; services.redis = runtime ? 'ready' : 'local'; }
    catch { services.database = 'unavailable'; services.redis = 'unavailable'; }
    let info;
    try { info = runtime ? await runtime.withQuestions(({ bank, version }) => ({ bank: bank.catalog(), resourceVersion: version })) : { bank: bank.catalog(), resourceVersion: config.resourceVersion || null }; services.resources = 'ready'; }
    catch { services.resources = 'unavailable'; info = { bank: null, resourceVersion: null }; }
    const knowledge = await runKb(({ knowledge }) => ({ libraries: knowledge.libraries.size, documents: knowledge.documents.size }), { readOnly: true });
    res.json({ ...info, services, knowledge, mode: 'single-learner', importer: { validation: true, publishing: Boolean(runtime?.resourceManager && config.questionImport?.accessKey && config.questionImport?.secretKey) } });
  });
  app.get('/api/learning/overview', route((req, { learning }) => overview(req, learning), { cache: true }));
  app.get('/api/learning/dashboard', route((req, { learning }) => learning.dashboard(req.viewer.sub), { cache: true }));
  app.get('/api/learning/history', route((req, { learning }) => learning.history({ ownerId: req.viewer.sub, page: req.query.page || 1, pageSize: req.query.pageSize || 20 }), { cache: true }));
  app.get('/api/learning/records/:id', route((req, { learning }) => learning.record(req.params.id, { ownerId: req.viewer.sub }), { cache: true }));
  app.get('/api/learning/questions', route((req, { learning }) => learning.collection({ ownerId: req.viewer.sub, kind: req.query.kind || 'wrong', page: req.query.page || 1, pageSize: req.query.pageSize || 20,
    module: req.query.module || 'all', search: req.query.search || '', mastered: req.query.mastered || 'all', includeMastered: req.query.includeMastered || false }), { cache: true }));
  app.get('/api/learning/questions/:id', route((req, { learning }) => learning.questionMeta(req.params.id, req.viewer.sub), { cache: true }));
  app.patch('/api/learning/questions/:id', route((req, { learning }) => learning.updateQuestion(req.params.id, req.body, req.viewer.sub)));
  app.patch('/api/learning/profile', route((req, { learning }) => learning.updateProfile(req.body, req.viewer.sub)));
  app.post('/api/learning/availability', route((req, { learning }) => learning.availability(req.body || {}, req.viewer.sub)));
  // Both fixed identities manage the same learner's library. No second learner
  // profile is created when an administrator organizes study material.
  app.get('/api/kb/libraries', kbRoute((_req, { knowledge }) => knowledge.listLibraries('mine', 'primary'), true));
  app.post('/api/kb/libraries', async (req, res) => {
    await limit(`kb:${req.viewer.sub}`, 30, 60000);
    res.status(201).json(await runKb(({ knowledge }) => knowledge.createLibrary({ ...req.body, visibility: 'private' }, 'primary')));
  });
  app.patch('/api/kb/libraries/:id', kbRoute((req, { knowledge }) => knowledge.updateLibrary(req.params.id, { ...req.body, visibility: 'private' }, 'primary')));
  app.delete('/api/kb/libraries/:id', kbRoute((req, { knowledge }) => knowledge.removeLibrary(req.params.id, 'primary')));
  app.get('/api/kb/libraries/:id', kbRoute((req, { knowledge }) => knowledge.listDocuments(req.params.id, 'primary'), true));
  app.get('/api/kb/libraries/:id/export', kbRoute((req, { knowledge }) => knowledge.exportLibrary(req.params.id, 'primary'), true));
  app.post('/api/kb/libraries/:id/documents', async (req, res) => {
    await limit(`kb:${req.viewer.sub}`, 30, 60000);
    res.status(201).json(await runKb(({ knowledge }) => knowledge.upload({ ...req.body, libraryId: req.params.id }, 'primary')));
  });
  app.get('/api/kb/libraries/:id/documents/:docId', kbRoute((req, { knowledge }) => knowledge.getDocument(req.params.id, req.params.docId, 'primary'), true));
  app.delete('/api/kb/libraries/:id/documents/:docId', kbRoute((req, { knowledge }) => knowledge.removeDocument(req.params.id, req.params.docId, 'primary')));
  app.get('/api/kb/search', kbRoute((req, { knowledge }) => knowledge.searchChunks(String(req.query.q || ''), { limit: Number(req.query.limit) || 5, ownerId: 'primary' }), true));
  app.post('/api/kb/generate', requireLearner, async (req, res) => {
    await limit('kbgen:primary', 10, 60000);
    if (!runtime) return res.json(await runKb(({ drafts, knowledge }) => drafts.generate(req.body || {}, knowledge, 'primary')));
    const prepared = await runKb(({ drafts, knowledge }) => drafts.prepare(req.body || {}, knowledge, 'primary'), { readOnly: true });
    const text = await completeDraft(prepared.llm, prepared.messages);
    res.json(await runKb(({ drafts }) => drafts.accept(prepared, text)));
  });
  app.get('/api/drafts', kbRoute((req, { drafts }) => drafts.list({ status: req.query.status || 'draft' }), true));
  app.post('/api/drafts/:id/confirm', kbRoute((req, { drafts }) => drafts.confirm(req.params.id)));
  app.delete('/api/drafts/:id', kbRoute((req, { drafts }) => drafts.remove(req.params.id)));
  app.get('/api/drafts/export', kbRoute((_req, { drafts }) => drafts.export(), true));
  app.post('/api/drafts/:id/swap', kbRoute((req, { drafts }) => drafts.markSwapped(req.params.id)));
  app.get('/api/ai/config', async (_req, res) => res.json(await runKb(({ aiConfig }) => aiConfig.masked(), { readOnly: true, configurationOnly: true })));
  app.put('/api/ai/config', async (req, res) => res.json(await runKb(({ aiConfig }) => aiConfig.update(req.body || {}), { configurationOnly: true })));
  app.post('/api/ai/config/test', async (req, res) => {
    await limit('aitest:admin', 6, 60000);
    const aiConfig = await runKb(({ aiConfig }) => aiConfig, { readOnly: true, configurationOnly: true });
    res.json(await aiConfig.test(req.body || {}));
  });
  app.post('/api/matches', async (req, res) => {
    await limit(`create:${req.viewer.sub}`, 30, 600000);
    const result = await run(({ service, learning, coach }) => {
      let input = req.body || {};
      if (!runtime && input.mode === 'llm' && service.jobs.size + coach.jobs.size >= config.maxConcurrent) throw new HttpError(429, '模型目前较忙，请稍后再试。');
      const scope = input.scope || 'all';
      const options = { ownerId: req.viewer.sub, allowedQuestionIds: learning.eligibleIds(scope, req.viewer.sub) };
      if (scope === 'smart') {
        const plan = learning.smartPlan(input, req.viewer.sub);
        input = { ...input, questionIds: plan.ids };
        options.composition = plan.composition;
      }
      return service.create({ ...input, name: learning.profile(req.viewer.sub).nickname }, options);
    });
    res.status(201).json(result);
  });
  app.get('/api/matches/:id', route((req, { service }) => service.snapshot(owned(req, service)), { readOnly: true, match: true }));
  app.get('/api/matches/:id/events', async (req, res) => {
    const snapshot = () => run(({ service }) => service.snapshot(owned(req, service)), { readOnly: true, matchId: req.params.id });
    await snapshot(); // Authorize before opening a stream or subscribing.
    openStream(res);
    let revision = -1, busy = false, again = false;
    const send = event => {
      if (req.viewer.exp * 1000 <= Date.now()) return res.end();
      if (res.writableLength > 256 * 1024) return res.destroy();
      if (!res.destroyed) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    const refresh = async () => {
      if (res.destroyed) return;
      if (busy) { again = true; return; } busy = true;
      try { do { again = false; const data = await snapshot();
        if (data.revision > revision) { revision = data.revision; send({ id: revision, type: 'snapshot', data }); }
      } while (again && !res.destroyed); } catch { res.end(); } finally { busy = false; }
    };
    const unsubscribe = runtime ? runtime.watch(req.params.id, refresh) : service.subscribe(owned(req, service), send);
    const heartbeat = setInterval(() => {
      if (req.viewer.exp * 1000 <= Date.now()) return res.end();
      if (!res.destroyed) res.write(': heartbeat\n\n');
      if (runtime) refresh();
    }, runtime ? 3000 : 15000);
    const stopOnFailure = service.storage?.onFailure(() => res.end());
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); stopOnFailure?.(); });
    await refresh(); // Subscribe first, then snapshot: a concurrent commit cannot fall in a gap.
  });
  for (const [action, method] of [['answer', 'submit'], ['retry', 'retry'], ['next', 'next'], ['finish', 'finish'], ['pause', 'pause'], ['resume', 'resume']]) {
    app.post(`/api/matches/:id/${action}`, route((req, { service, coach }) => {
      const match = owned(req, service), round = service.current(match), mode = match.settings.mode;
      const startsModel = mode !== 'practice' && (method === 'retry' && round.phase === 'error'
        || method === 'submit' && !round.parallel && round.phase === 'human'
        || method === 'next' && mode === 'llm' && round.phase === 'revealed' && match.index < match.questionIds.length - 1);
      if (!runtime && startsModel && service.jobs.size + coach.jobs.size >= config.maxConcurrent) throw new HttpError(429, '模型目前较忙，请稍后再试。');
      return ['finish', 'pause', 'resume'].includes(method) ? service[method](match) : service[method](match, req.body || {});
    }, { match: true }));
  }
  app.get('/api/matches/:id/coach', route((req, { service, coach }) => coach.snapshot(owned(req, service), Number(req.query.index)), { readOnly: true, match: true }));
  app.post('/api/matches/:id/coach', async (req, res) => {
    await limit(`coach:${req.viewer.sub}`, 20, 600000);
    const index = req.body?.index, message = req.body?.message;
    if (runtime) {
      const jobId = await runtime.enqueueCoach(req.params.id, index, message, service => owned(req, service));
      openStream(res);
      let sent = 0, busy = false;
      const poll = async () => {
        if (res.destroyed || busy) return; busy = true;
        try {
          if (req.viewer.exp * 1000 <= Date.now()) return res.end();
          const text = await runtime.coachText(jobId);
          if (text.length > sent) { res.write(`event: text\ndata: ${JSON.stringify({ text: text.slice(sent) })}\n\n`); sent = text.length; }
          const state = await runtime.jobStatus(jobId);
          if (state?.status === 'done') {
            const data = await run(({ service, coach }) => coach.snapshot(owned(req, service), index), { readOnly: true, matchId: req.params.id });
            res.write(`event: complete\ndata: ${JSON.stringify(data)}\n\n`); res.end();
          } else if (!state || ['interrupted', 'cancelled'].includes(state.status)) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: '小栗的回复中断了，已完成的聊天仍会保留，请稍后重试。' })}\n\n`); res.end();
          }
        } catch { res.end(); } finally { busy = false; }
      };
      const timer = setInterval(poll, 200), heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      res.on('close', () => { clearInterval(timer); clearInterval(heartbeat); });
      await poll(); return;
    }
    const match = owned(req, service); coach.round(match, index);
    const controller = new AbortController(); res.on('close', () => controller.abort()); openStream(res);
    const emit = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    try { await coach.reply(match, index, message, { signal: controller.signal, emit }); }
    catch (error) { if (!controller.signal.aborted) emit('error', { message: error instanceof HttpError || error instanceof ProviderError ? error.message : '小栗的连接中断了，请稍后再试。' }); }
    finally { clearInterval(heartbeat); res.end(); }
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在。')));
  if (config.questionResources) app.use('/assets/images', async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '只支持读取题图。');
    const name = 'assets/images' + req.path;
    const send = async resources => {
      const bytes = await resources.image(name), file = resources.files.get(name);
      res.set({ 'Content-Type': imageMime(name), 'Cache-Control': 'public, max-age=2592000, immutable', ETag: `"${file.sha256}"` });
      res.send(bytes);
    };
    if (runtime?.resourceManager) await runtime.withQuestions(({ resources }) => send(resources)); else await send(config.questionResources);
  });
  else app.use('/assets/images', express.static(config.imagesPath || defaultImagesPath, { immutable: true, maxAge: '30d', dotfiles: 'deny', index: false, fallthrough: false }));
  if (config.serveFrontend !== false) {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist, { index: false, dotfiles: 'deny' }));
  app.get('/', (_req, res) => {
    if (!fs.existsSync(path.join(dist, 'index.html'))) return res.status(503).send('Frontend not built. Run npm run build.');
    res.sendFile(path.join(dist, 'index.html'));
  });
  }
  app.use((_req, _res, next) => next(new HttpError(404, '页面不存在。')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
    res.status(status).json({ error: { code: error.code || 'server_error', message: status < 500 && error instanceof HttpError
      ? error.message : status === 400 ? '请求格式无效。' : status === 404 ? '文件不存在。' : status === 413 ? '提交内容过长。' : '服务暂时无法处理请求，请稍后重试。' } });
  });
  return app;
}
function openStream(res) {
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
}
