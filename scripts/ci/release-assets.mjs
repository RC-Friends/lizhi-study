import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { version } = JSON.parse(fs.readFileSync('package.json'));
const output = path.resolve('artifacts', `release-v${version}`);
fs.mkdirSync(output, { recursive: true });
// git archive uses only committed files, never the operator's working directory.
const source = `lizhi-study-v${version}-source.tar.gz`;
execFileSync('git', ['archive', '--format=tar.gz', `--prefix=lizhi-study-v${version}/`, `--output=${path.join(output, source)}`, 'HEAD']);
const deploy = `lizhi-study-v${version}-deploy.tar.gz`;
execFileSync('git', ['archive', '--format=tar.gz', `--prefix=lizhi-study-v${version}/`, `--output=${path.join(output, deploy)}`, 'HEAD',
  'compose.yaml', 'deploy', 'scripts', 'server', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'docs', 'sources.json', 'requirements.txt', 'schema']);
const frontend = `lizhi-study-v${version}-frontend.tar.gz`;
execFileSync('tar', ['-czf', path.join(output, frontend), '-C', 'dist', '.']);
if (process.env.IMAGE_BASE) {
  const images = Object.fromEntries(['backend', 'frontend'].map(component => {
    const digest = process.env[`${component.toUpperCase()}_DIGEST`];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error(`Missing ${component} image digest`);
    return [component, { tag: `${process.env.IMAGE_BASE}-${component}:v${version}`, image: `${process.env.IMAGE_BASE}-${component}@${digest}` }];
  }));
  fs.writeFileSync(path.join(output, 'images.json'), JSON.stringify({ version, platforms: ['linux/amd64'], images }, null, 2) + '\n');
}
const files = [source, deploy, frontend, ...(process.env.IMAGE_BASE ? ['images.json'] : [])];
fs.writeFileSync(path.join(output, 'SHA256SUMS'), files.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n') + '\n');
console.log(`Release assets prepared in ${path.relative(process.cwd(), output)}`);
