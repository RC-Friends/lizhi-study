import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.mjs';
import { verifyResources, sha256 } from '../server/resources.mjs';
import { ObjectResources, ResourceError, validateManifest } from '../server/object-resources.mjs';

export async function uploadResources(directory, config, { progress = () => {} } = {}) {
  const manifest = verifyResources(directory);
  validateManifest(manifest, manifest.version);
  const store = new ObjectResources(config, manifest.version);
  let next = 0, uploaded = 0, reused = 0, completed = 0;
  try {
    // All payloads are verified after writing. Publish the manifest last so that
    // an interrupted upload cannot be mistaken for a complete release.
    const workers = Array.from({ length: 6 }, async () => {
      while (next < manifest.files.length) {
        const file = manifest.files[next++];
        const bytes = fs.readFileSync(path.join(directory, file.path));
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new ResourceError('上传期间源文件发生变化。');
        if (await store.publishFile(file, bytes)) uploaded++; else reused++;
        completed++; if (completed % 250 === 0) progress({ completed, total: manifest.files.length });
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await store.publishFile({ path: 'manifest.json', bytes: bytes.length, sha256: sha256(bytes) }, bytes);
    await store.load();
    return { version: manifest.version, questions: manifest.questions, images: manifest.images, uploaded, reused, verified: true };
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, 'credentials-stdin': { type: 'boolean', default: false } } });
  try {
    if (!values.source) throw new ResourceError('使用 --source=资源包目录；发布凭证可用 --credentials-stdin 从标准输入传入。');
    const config = loadConfig().s3;
    if (values['credentials-stdin']) {
      const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
      config.accessKey = credentials.accessKey; config.secretKey = credentials.secretKey;
    }
    console.log(JSON.stringify(await uploadResources(path.resolve(values.source), config, { progress: value => console.log(JSON.stringify(value)) })));
  } catch (error) {
    console.error(error instanceof ResourceError ? error.message : '资源上传失败；请检查 SeaweedFS 状态和发布凭证。未发布的版本不会启用。');
    process.exitCode = 1;
  }
}
