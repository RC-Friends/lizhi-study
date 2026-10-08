import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sha256 } from './resources.mjs';

const MAX_FILE = 128 * 1024 * 1024;
export class ResourceError extends Error {
  constructor(message = '题目资源暂时不可用，请稍后重试。', status = 503) {
    super(message); this.name = 'ResourceError'; this.status = status; this.code = 'resource_unavailable';
  }
}
export function validateManifest(manifest, version) {
  if (manifest?.format !== 1 || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(version || '')
      || manifest.version !== version || sha256(JSON.stringify(manifest.files)) !== version) throw new ResourceError('资源版本清单校验失败。');
  const names = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !(file.path === 'questions.jsonl' || /^assets\/images\/[a-zA-Z0-9_./-]+\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(file.path))
        || file.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(file.path)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ResourceError('资源清单包含无效文件。');
    names.add(file.path);
  }
  if (!names.has('questions.jsonl') || manifest.images !== names.size - 1 || !Number.isSafeInteger(manifest.questions) || manifest.questions < 1) throw new ResourceError('资源清单数量无效。');
  return manifest;
}

export function createS3Client(config) {
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw new ResourceError('请配置 S3_ENDPOINT。'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || !config.accessKey || !config.secretKey || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket || '')) throw new ResourceError('S3 连接或凭证配置不完整。');
  return new S3Client({ endpoint: endpoint.toString(), region: config.region || 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }, maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}

// Keys are release-relative paths from a verified manifest, never raw HTTP paths.
export class ObjectResources {
  constructor(config, version, { client } = {}) {
    if (!/^[a-f0-9]{64}$/.test(version || '')) throw new ResourceError('请配置完整的 QUESTION_RESOURCE_VERSION。');
    const prefix = config.prefix || 'question-resources';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(prefix) || prefix.split('/').some(part => !part)) throw new ResourceError('S3_PREFIX 无效。');
    this.config = config; this.client = client || createS3Client(config); this.version = version;
    this.prefix = `${prefix}/${version}/`; this.files = new Map(); this.cache = new Map(); this.cacheBytes = 0;
    this.inflight = new Map(); this.cacheLimit = 32 * 1024 * 1024;
  }
  async send(Command, input) {
    return this.client.send(new Command({ Bucket: this.config.bucket, ...input }), { abortSignal: AbortSignal.timeout(30000) });
  }
  async rawGet(name, maxBytes = MAX_FILE) {
    const response = await this.send(GetObjectCommand, { Key: this.prefix + name });
    if (response.ContentLength > maxBytes) { response.Body?.destroy(); throw new ResourceError('资源文件超过大小限制。'); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.Body) {
        size += chunk.length;
        if (size > maxBytes) throw new ResourceError('资源文件超过大小限制。');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } catch (error) { response.Body?.destroy(); throw error; }
  }
  async load() {
    try {
      const manifest = validateManifest(JSON.parse(await this.rawGet('manifest.json', 4 * 1024 * 1024)), this.version);
      this.files = new Map(manifest.files.map(file => [file.path, file])); this.manifest = manifest;
      const bytes = await this.read('questions.jsonl');
      const rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const names = ['questions.jsonl', ...new Set(rows.flatMap(q => q.images.map(image => image.path)))].sort();
      if (rows.length !== manifest.questions || JSON.stringify(names) !== JSON.stringify([...this.files.keys()].sort())) throw new ResourceError('题库与资源清单不一致。');
      return rows;
    } catch { throw new ResourceError('无法加载已发布题库，请检查 SeaweedFS、只读凭证和资源版本。'); }
  }
  async read(name) {
    const file = this.files.get(name);
    if (!file) throw new ResourceError('资源文件不存在。', 404);
    try {
      const bytes = await this.rawGet(name, file.bytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new ResourceError('资源校验失败。');
      return bytes;
    } catch { throw new ResourceError(); }
  }
  async image(name) {
    if (!name.startsWith('assets/images/') || !this.files.has(name)) throw new ResourceError('题图不存在。', 404);
    if (this.cache.has(name)) {
      const bytes = this.cache.get(name); this.cache.delete(name); this.cache.set(name, bytes); return bytes;
    }
    if (this.inflight.has(name)) return this.inflight.get(name);
    const task = this.read(name).then(bytes => {
      if (bytes.length <= this.cacheLimit) {
        while (this.cacheBytes + bytes.length > this.cacheLimit) {
          const oldest = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(oldest).length; this.cache.delete(oldest);
        }
        this.cache.set(name, bytes); this.cacheBytes += bytes.length;
      }
      return bytes;
    }).finally(() => this.inflight.delete(name));
    this.inflight.set(name, task); return task;
  }
  async health() {
    try { await this.send(HeadObjectCommand, { Key: this.prefix + 'manifest.json' }); }
    catch { throw new ResourceError(); }
  }
  async publishFile(file, bytes) {
    try {
      const existing = await this.rawGet(file.path, file.bytes);
      if (existing.length !== file.bytes || sha256(existing) !== file.sha256) throw new ResourceError('该版本下已有不同内容，拒绝覆盖。');
      return false;
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NoSuchKey') throw error;
    }
    try {
      await this.send(PutObjectCommand, { Key: this.prefix + file.path, Body: bytes, IfNoneMatch: '*',
        ContentType: file.path.endsWith('.json') || file.path.endsWith('.jsonl') ? 'application/json' : imageMime(file.path),
        Metadata: { sha256: file.sha256 }, CacheControl: 'private, max-age=31536000, immutable' });
    } catch (error) { if (error.$metadata?.httpStatusCode !== 412) throw error; }
    const saved = await this.rawGet(file.path, file.bytes);
    if (saved.length !== file.bytes || sha256(saved) !== file.sha256) throw new ResourceError('上传后的资源校验失败。');
    return true;
  }
  close() { this.client.destroy(); this.cache.clear(); this.cacheBytes = 0; }
}

export const imageMime = name => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' })[name.split('.').at(-1).toLowerCase()] || 'application/octet-stream';
