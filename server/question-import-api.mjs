import express from 'express';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { HttpError } from './bank.mjs';
import { ObjectResources, validateManifest, ResourceError } from './object-resources.mjs';
import { sha256 } from './resources.mjs';
import { importSchema, IMPORT_LIMITS, ImportError, inspectImage } from './question-import.mjs';

const safePath = name => name === 'questions.jsonl' || /^assets\/images\/[a-f0-9]{2}\/[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)$/.test(name);
function validateVersion(version) { if (!/^[a-f0-9]{64}$/.test(version)) throw new HttpError(400, '资源版本必须为完整 SHA-256。', 'invalid_version'); }
const missing = e => e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey';
function backgroundValidation(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./question-import-worker.mjs', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new HttpError(503, '校验超时，请减少题库大小后重试。', 'validation_timeout')); }, 90000);
    const clean = () => clearTimeout(timer);
    worker.once('message', message => { clean(); message.error ? reject(new ImportError(message.error.issues, message.error.status, message.error.code)) : resolve(message.result); });
    worker.once('error', () => { clean(); reject(new HttpError(503, '题库校验资源不足，请稍后重试。', 'validation_unavailable')); });
    worker.once('exit', code => { clean(); if (code !== 0) reject(new HttpError(503, '题库校验中断。', 'validation_unavailable')); });
  });
}
export function questionImportRouter(bank, config, { limit, runtime }) {
  const router = express.Router(), settings = config.questionImport || {}, secret = settings.token || '';
  if (secret && (Buffer.byteLength(secret) < 32 || secret === config.sitePassword || secret === config.jwtSecret)) throw new Error('QUESTION_IMPORT_TOKEN 需要独立的至少 32 字节随机值，不能复用登录口令或 JWT 密钥。');
  let active = 0;
  router.use(async (req, res, next) => {
    if (!secret) throw new HttpError(404, '题库管理接口未启用。', 'import_disabled');
    const candidate = req.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1] || '';
    if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), crypto.createHash('sha256').update(secret).digest())) {
      await limit(`import-login:${req.ip}`, 12, 60000);
      throw new HttpError(401, '需要独立的题库管理令牌。', 'import_unauthorized');
    }
    await limit('question-import:requests', 10000, 60000);
    if (active >= 2) throw new HttpError(429, '同时最多处理两个导入请求，请稍后重试。', 'import_busy');
    active++; let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    res.once('close', release); res.once('finish', release);
    next();
  });
  const writer = (req, _res, next) => {
    validateVersion(req.params.version);
    if (!settings.accessKey || !settings.secretKey || !config.s3?.endpoint) throw new HttpError(503, '尚未配置独立的 S3 发布凭证；校验接口仍可用。', 'import_writer_unavailable');
    next();
  };
  async function store(version, work) {
    const resources = new ObjectResources({ ...config.s3, accessKey: settings.accessKey, secretKey: settings.secretKey }, version);
    try { return await work(resources); }
    finally { resources.close(); }
  }
  const json = express.json({ limit: IMPORT_LIMITS.documentBytes, inflate: false });
  router.get('/schema', (_req, res) => res.json(importSchema));
  router.post('/validate', json, async (req, res) => {
    await limit('question-import:validation', 30, 60000);
    res.json({ ...await backgroundValidation({ operation: 'document', document: req.body }), imageFilesChecked: false });
  });
  router.put('/releases/:version/files', writer, (req, _res, next) => {
    const name = req.query.path;
    if (typeof name !== 'string' || !safePath(name)) throw new HttpError(400, '文件路径必须为 questions.jsonl 或带内容摘要的题图路径。', 'invalid_resource_path');
    if (!req.is(['application/octet-stream', 'application/x-ndjson'])) throw new HttpError(415, '上传文件使用 application/octet-stream。', 'unsupported_media_type');
    express.raw({ type: () => true, inflate: false, limit: name === 'questions.jsonl' ? IMPORT_LIMITS.bankBytes : IMPORT_LIMITS.imageBytes })(req, _res, next);
  }, async (req, res) => {
    const name = req.query.path, bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, '文件不能为空。', 'empty_resource');
    if (name === 'questions.jsonl') await backgroundValidation({ operation: 'bank', bytes });
    else if (inspectImage(bytes, name).path !== name) throw new ImportError([{ path: name, message: '图片路径中的摘要与内容不符。' }]);
    const file = { path: name, bytes: bytes.length, sha256: sha256(bytes) };
    const uploaded = await store(req.params.version, resources => resources.publishFile(file, bytes));
    res.status(uploaded ? 201 : 200).json({ version: req.params.version, ...file, reused: !uploaded });
  });
  router.post('/releases/:version/publish', writer, express.json({ limit: '4mb', inflate: false }), async (req, res) => {
    if (!runtime?.resourceManager) throw new HttpError(503, '在线导入需要 PostgreSQL、Redis 和 SeaweedFS。', 'activation_unavailable');
    await limit('question-import:publish', 20, 60000);
    let manifest;
    try { manifest = validateManifest(req.body, req.params.version); }
    catch { throw new ImportError([{ path: '/manifest', message: '资源清单或 SHA-256 版本无效。' }]); }
    if (manifest.files.length > IMPORT_LIMITS.files || manifest.files.some(f => !safePath(f.path))
      || manifest.files.reduce((n, f) => n + f.bytes, 0) > IMPORT_LIMITS.totalBytes) throw new ImportError([{ path: '/files', message: '资源包最多 20000 个文件、总共 512 MiB，图片须用内容摘要命名。' }]);
    const result = await store(req.params.version, async resources => {
      resources.files = new Map(manifest.files.map(file => [file.path, file]));
      const report = await backgroundValidation({ operation: 'bank', bytes: await resources.read('questions.jsonl'), activeFingerprints: bank.fingerprints });
      const expected = new Set(['questions.jsonl', ...report.refs.keys()]);
      if (report.questions !== manifest.questions || expected.size !== manifest.files.length || manifest.files.some(f => !expected.has(f.path))) throw new ImportError([{ path: '/files', message: '清单文件和题库图片引用不一致。' }]);
      let cursor = 0;
      const files = manifest.files.filter(f => f.path !== 'questions.jsonl');
      const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async () => {
        while (cursor < files.length) {
          const file = files[cursor++];
          if (file.bytes > IMPORT_LIMITS.imageBytes) throw new ImportError([{ path: file.path, message: '图片不能超过 16 MiB。' }]);
          const image = inspectImage(await resources.read(file.path), file.path), ref = report.refs.get(file.path);
          if (image.path !== file.path || image.width !== ref.width || image.height !== ref.height) throw new ImportError([{ path: file.path, message: '图片内容或尺寸与题库索引不一致。' }]);
        }
      }));
      const failed = outcomes.find(value => value.status === 'rejected'); if (failed) throw failed.reason;
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      const uploaded = await resources.publishFile({ path: 'manifest.json', bytes: bytes.length, sha256: sha256(bytes) }, bytes);
      return { reused: !uploaded, questions: report.questions, usableQuestions: report.usableQuestions, images: report.images };
    });
    const activation = await runtime.activateResources(manifest.version);
    res.status(result.reused ? 200 : 201).json({ ...result, version: manifest.version, published: true, ...activation });
  });
  router.get('/releases/:version', writer, async (req, res) => {
    const manifest = await store(req.params.version, async resources => {
      try { return validateManifest(JSON.parse(await resources.rawGet('manifest.json', 4 * 1024 * 1024)), req.params.version); }
      catch (error) { if (missing(error)) throw new HttpError(404, '此版本尚未完整发布。', 'resource_not_published'); throw error; }
    });
    const current = runtime?.resourceManager ? await runtime.resourceManager.currentVersion(runtime.pool) : config.resourceVersion;
    res.json({ version: manifest.version, published: true, active: current === manifest.version, questions: manifest.questions, images: manifest.images });
  });
  router.use((_req, _res, next) => next(new HttpError(404, '题库管理接口不存在。')));
  router.use((error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({ error: { code: error.code || (status === 413 ? 'import_too_large' : 'import_failed'),
      message: error instanceof HttpError ? error.message : error instanceof ResourceError ? '资源缺失、内容不一致或存储不可用；未发布的版本不会启用。'
        : status === 413 ? '导入请求超过大小限制。' : status === 400 ? '请求不是合法 JSON。' : '导入暂时失败，请稍后重试。',
      ...(error instanceof ImportError ? { issues: error.issues } : {}) } });
  });
  return router;
}
