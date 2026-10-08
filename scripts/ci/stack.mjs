import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { makeFixture } from './fixture.mjs';

// Only this newly generated project is ever stopped or removed.
const project = `lizhi-ci-${randomBytes(6).toString('hex')}`;
const root = path.resolve('test-results', project);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const { dataPath, bundle } = makeFixture(root);
const envFile = path.join(root, '.env.stack'), secrets = path.join(root, 'secrets');
function run(command, args, { capture = false, env = {}, input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit', input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    if (capture || input !== undefined) process.stderr.write(result.stderr || '');
    throw new Error(`${command} failed (${result.status})`);
  }
  return result.stdout?.trim();
}
run(process.execPath, ['scripts/prepare-stack.mjs', `--bundle=${bundle}`, `--output=${envFile}`, `--secrets-dir=${secrets}`]);
const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
// Avoid ambient shell variables selecting existing images or application ports.
Object.assign(env, { COMPOSE_PROJECT_NAME: project, FRONTEND_IMAGE: `${project}-frontend:ci`, BACKEND_IMAGE: `${project}-backend:ci` });
const override = path.join(root, 'compose.ci.yaml');
fs.writeFileSync(override, `services:
  frontend:
    ports: !override ["127.0.0.1::8080"]
  database:
    ports: ["127.0.0.1::5432"]
  redis:
    ports: ["127.0.0.1::6379"]
  seaweedfs:
    ports: ["127.0.0.1::8333"]
`);
const args = ['compose', '--project-name', project, '--env-file', envFile, '-f', 'compose.yaml', '-f', override];
const compose = (options, extra = {}) => run('docker', [...args, ...options], { env, ...extra });
const port = (service, target) => compose(['port', service, String(target)], { capture: true });
const test = (name, variables) => run('npm', ['run', `test:${name}`], { env: variables });
let passed = false;
try {
  compose(['build', '--quiet']);
  compose(['up', '-d', '--wait', '--wait-timeout', '180', 'database', 'redis', 'seaweedfs']);
  const database = port('database', 5432), redis = port('redis', 6379), s3 = port('seaweedfs', 8333);
  for (const db of ['xingce_test_legacy', 'xingce_test_distributed']) compose(['exec', '-T', 'database', 'createdb', '-U', 'xingce', db]);
  const connection = db => `postgresql://xingce:${env.POSTGRES_PASSWORD}@${database}/${db}`;
  test('postgres', { TEST_DATABASE_URL: connection('xingce_test_legacy') });
  test('distributed', { TEST_DATABASE_URL: connection('xingce_test_distributed'), TEST_REDIS_URL: `redis://:${env.REDIS_PASSWORD}@${redis}/1` });
  const publisher = JSON.parse(fs.readFileSync(path.join(secrets, 'seaweedfs-publisher.json'), 'utf8'));
  test('seaweedfs', {
    TEST_S3_ENDPOINT: `http://${s3}`, TEST_S3_BUCKET: env.S3_BUCKET,
    TEST_S3_READER_KEY: env.S3_ACCESS_KEY_ID, TEST_S3_READER_SECRET: env.S3_SECRET_ACCESS_KEY,
    TEST_S3_PUBLISHER_KEY: publisher.accessKey, TEST_S3_PUBLISHER_SECRET: publisher.secretKey,
  });
  compose(['run', '--rm', '--no-deps', '-T', '-v', `${bundle}:/bundle:ro`, 'backend',
    'node', 'scripts/upload-resources.mjs', '--source=/bundle', '--credentials-stdin'], { input: JSON.stringify(publisher) });
  compose(['up', '-d', '--wait', '--wait-timeout', '180', '--scale', 'backend=2']);
  test('stack', { E2E_BASE_URL: `http://${port('frontend', 8080)}`, E2E_PASSWORD: env.SITE_PASSWORD, E2E_BANK_PATH: dataPath });
  passed = true;
} finally {
  // Logs are never uploaded: they can contain generated test configuration.
  if (!passed) compose(['logs', '--tail', '60', 'backend', 'frontend'], { allowFailure: true });
  compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], { allowFailure: true });
  fs.rmSync(root, { recursive: true, force: true });
}
