import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Explicit precedence: runtime environment > .env > legacy .env.local.
// Reading files into a separate object avoids polluting process.env or letting a
// legacy empty SITE_PASSWORD erase the account configured in .env.
export function environmentFromFiles(root = ROOT, environment = process.env) {
  const loaded = {};
  for (const name of ['.env.local', '.env']) {
    try { Object.assign(loaded, parseEnv(fs.readFileSync(path.join(root, name), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...loaded, ...environment };
}

const flag = value => /^(true|1|yes)$/i.test(String(value || ''));
const url = (value, fallback) => String(value || fallback || '').replace(/\/+$/, '');
export function loadConfig(overrides = {}) {
  const e = environmentFromFiles();
  const imagesPath = path.resolve(e.QUESTION_IMAGES_PATH || path.join(ROOT, 'assets/images'));
  return {
    host: e.HOST || '0.0.0.0', port: Number(e.PORT || 3210),
    llm: { baseUrl: url(e.LLM_BASE_URL), key: e.LLM_API_KEY || '', model: e.LLM_MODEL || '', imagesPath,
      vision: flag(e.LLM_VISION), timeout: Number(e.LLM_TIMEOUT_MS || 180000), maxTokens: Number(e.LLM_MAX_TOKENS || 8192),
      toolMaxTokens: Number(e.LLM_TOOL_MAX_TOKENS || 2048), reasoningEffort: e.LLM_REASONING_EFFORT || '', thinking: e.LLM_THINKING || '',
      imageMaxTokens: Number(e.LLM_IMAGE_MAX_TOKENS || 32768), imageToolMaxTokens: Number(e.LLM_IMAGE_TOOL_MAX_TOKENS || 8192),
      imageTimeout: Number(e.LLM_IMAGE_TIMEOUT_MS || 300000), maxRetryTokens: Number(e.LLM_MAX_RETRY_TOKENS || 65536) },
    jev: { baseUrl: url(e.JEV_BASE_URL, 'https://api.typesafe.ai/v1'), key: e.JEV_API_KEY || e.TYPESAFE_API_KEY || '',
      model: e.JEV_MODEL || 'jev-latest', timeout: Number(e.JEV_TIMEOUT_MS || 45000) },
    vision: { baseUrl: url(e.VISION_BASE_URL || e.LLM_BASE_URL), key: e.VISION_API_KEY || e.LLM_API_KEY || '',
      model: e.VISION_MODEL || e.LLM_MODEL || '', enabled: flag(e.VISION_ENABLED), timeout: Number(e.LLM_TIMEOUT_MS || 180000),
      reasoningEffort: e.VISION_REASONING_EFFORT || e.LLM_REASONING_EFFORT || '', maxTokens: Number(e.VISION_MAX_TOKENS || 8192),
      thinking: e.VISION_THINKING || e.LLM_THINKING || '' },
    sitePassword: e.SITE_PASSWORD || '',
    jwtSecret: e.JWT_SECRET || '',
    jwtTtlSeconds: Number(e.JWT_TTL_DAYS || 30) * 86400,
    profileName: String(e.LEARNER_NAME || '备考同学').trim().slice(0, 32) || '备考同学',
    trustProxy: /^\d+$/.test(e.TRUST_PROXY || '') ? Number(e.TRUST_PROXY) : e.TRUST_PROXY || false,
    publicUrl: url(e.PUBLIC_URL),
    dataPath: path.resolve(e.QUESTION_BANK_PATH || path.join(ROOT, 'data/xingce/questions.jsonl')),
    imagesPath,
    resourceVersion: e.QUESTION_RESOURCE_VERSION || '',
    resourceDriver: e.RESOURCE_DRIVER || (e.S3_ENDPOINT ? 's3' : 'files'),
    s3: { endpoint: e.S3_ENDPOINT || '', bucket: e.S3_BUCKET || 'xingce-resources', region: e.S3_REGION || 'us-east-1',
      prefix: e.S3_PREFIX || 'question-resources', accessKey: e.S3_ACCESS_KEY_ID || '', secretKey: e.S3_SECRET_ACCESS_KEY || '' },
    questionImport: { token: e.QUESTION_IMPORT_TOKEN || '', accessKey: e.QUESTION_IMPORT_S3_ACCESS_KEY_ID || '', secretKey: e.QUESTION_IMPORT_S3_SECRET_ACCESS_KEY || '' },
    storageDriver: e.STORAGE_DRIVER || (e.DATABASE_URL ? 'postgres' : 'files'),
    databaseUrl: e.DATABASE_URL || '',
    redisUrl: e.REDIS_URL || '',
    redisPrefix: e.REDIS_PREFIX || 'xingce:',
    serveFrontend: e.SERVE_FRONTEND === undefined ? e.NODE_ENV !== 'production' : flag(e.SERVE_FRONTEND),
    runtimePath: path.resolve(e.RUNTIME_PATH || path.join(ROOT, 'data/runtime/matches')),
    maxConcurrent: 3,
    ...overrides,
  };
}

export function providerCatalog(config) {
  return {
    llm: { id: 'llm', name: '多模态 LLM', model: config.llm.model || '待配置',
      ready: Boolean(config.llm.key && config.llm.baseUrl && config.llm.model), vision: config.llm.vision,
      description: '先讲解，再通过工具锁定答案。支持已验证的图片模型。' },
    jev: { id: 'jev', name: 'JEV 决策模型', model: config.jev.model,
      ready: Boolean(config.jev.key), vision: Boolean(config.vision.enabled && config.vision.key && config.vision.model),
      description: '原生结构化决策，展示选项概率。图片可由视觉助手转写。' },
  };
}
