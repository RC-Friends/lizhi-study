import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const files = git('ls-files', '-z').split('\0').filter(Boolean);
const blocked = /^(?:\.env(?:\..*)?|deploy\/(?:local|k8s)\/|(?:node_modules|dist|artifacts|test-results|backups|\.aws|\.codex|\.agents)\/|data\/(?:runtime|xingce)\/|assets\/images\/)/;
const credentials = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{32,})\b/;
const privateAddress = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
for (const file of files) {
  assert.ok(file === '.env.example' || !blocked.test(file), `Private/generated file is tracked: ${file}`);
  const value = fs.readFileSync(file, 'utf8');
  assert.ok(!credentials.test(value), `Possible credential in ${file}`);
  // Retained, unmodified upstream attribution is not operator configuration.
  if (!file.startsWith('data/raw/')) assert.ok(!privateAddress.test(value), `Private network address in ${file}`);
}
const pkg = JSON.parse(fs.readFileSync('package.json'));
const lock = JSON.parse(fs.readFileSync('package-lock.json'));
assert.equal(pkg.name, 'lizhi-study');
assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].name, pkg.name); assert.equal(lock.packages[''].version, pkg.version);
if (process.argv.includes('--release')) {
  const tag = process.env.RELEASE_TAG;
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/);
  assert.equal(tag, `v${pkg.version}`);
  assert.equal(git('log', '-1', '--format=%s'), `chore: release ${tag}`);
  assert.equal(git('rev-parse', `${tag}^{commit}`), git('rev-parse', 'HEAD'));
  assert.ok(fs.readFileSync('CHANGELOG.md', 'utf8').includes(`## [${pkg.version}]`));
}
console.log(`Repository checks passed (${files.length} tracked files).`);
