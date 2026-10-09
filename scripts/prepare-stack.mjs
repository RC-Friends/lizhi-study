import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyResources } from '../server/resources.mjs';

const { values } = parseArgs({ options: { bundle: { type: 'string' }, output: { type: 'string', default: '.env.stack' },
  'secrets-dir': { type: 'string', default: 'deploy/local' } } });
if (!values.bundle) throw new Error('使用 --bundle=资源包目录；可选 --output=.env.stack --secrets-dir=deploy/local。');
const manifest = verifyResources(path.resolve(values.bundle));
const directory = path.resolve(values['secrets-dir']);
const output = path.resolve(values.output), configFile = path.join(directory, 'seaweedfs-s3.json'), publisherFile = path.join(directory, 'seaweedfs-publisher.json');
for (const filename of [output, configFile, publisherFile]) if (fs.existsSync(filename)) throw new Error('输出文件已存在，拒绝覆盖现有密码和配置。');
const secret = () => crypto.randomBytes(32).toString('hex');
const reader = { accessKey: 'reader-' + crypto.randomBytes(12).toString('hex'), secretKey: secret() };
const publisher = { accessKey: 'publisher-' + crypto.randomBytes(12).toString('hex'), secretKey: secret() };
const dbPassword = secret(), redisPassword = secret(), bucket = 'xingce-resources';
const env = {
  APP_ENV_FILE: './' + path.relative(process.cwd(), output), COMPOSE_PROJECT_NAME: 'xingce-study',
  APP_BIND: '127.0.0.1', APP_PORT: '3210', SITE_PASSWORD: secret(), SUPERADMIN_PASSWORD: secret(), JWT_SECRET: secret(), JWT_TTL_DAYS: '30', LEARNER_NAME: '备考同学',
  PUBLIC_URL: '', TRUST_PROXY: '', STORAGE_DRIVER: 'postgres', POSTGRES_PASSWORD: dbPassword,
  DATABASE_URL: `postgresql://xingce:${dbPassword}@database:5432/xingce`, RESOURCE_DRIVER: 's3',
  REDIS_PASSWORD: redisPassword, REDIS_URL: `redis://:${redisPassword}@redis:6379/0`, REDIS_PREFIX: 'xingce:',
  QUESTION_RESOURCE_VERSION: manifest.version, S3_ENDPOINT: 'http://seaweedfs:8333', S3_BUCKET: bucket,
  S3_REGION: 'us-east-1', S3_PREFIX: 'question-resources', S3_ACCESS_KEY_ID: reader.accessKey, S3_SECRET_ACCESS_KEY: reader.secretKey,
  SEAWEEDFS_CONFIG_FILE: './' + path.relative(process.cwd(), configFile),
  LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', LLM_VISION: 'false', JEV_API_KEY: '', TYPESAFE_API_KEY: '', VISION_API_KEY: '',
};
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(configFile, JSON.stringify({ identities: [
  { name: 'app-reader', credentials: [reader], actions: [`Read:${bucket}`] },
  { name: 'resource-publisher', credentials: [publisher], actions: [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`] },
] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
fs.writeFileSync(publisherFile, JSON.stringify(publisher) + '\n', { mode: 0o600, flag: 'wx' });
fs.writeFileSync(output, Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ created: [values.output, path.relative(process.cwd(), configFile), path.relative(process.cwd(), publisherFile)],
  resourceVersion: manifest.version, passwordLocation: `${values.output}: SITE_PASSWORD`, services: ['frontend', 'backend', 'database', 'redis', 'seaweedfs'] }));
