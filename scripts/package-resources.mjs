import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.mjs';
import { resolveQuestionImage, sha256, verifyResources } from '../server/resources.mjs';
export { verifyResources } from '../server/resources.mjs';

export function packageResources({ dataPath, imagesPath, output }) {
  if (fs.existsSync(output)) throw new Error('输出目录已存在，请选择新的版本目录，避免覆盖已有资源。');
  const bytes = fs.readFileSync(dataPath);
  const rows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!rows.length || new Set(rows.map(q => q.id)).size !== rows.length) throw new Error('题库为空或存在重复 ID。');
  const paths = [...new Set(rows.flatMap(q => q.images.map(image => image.path)))].sort();
  const sources = paths.map(relative => ({ path: relative, source: resolveQuestionImage(relative, imagesPath) }));
  const files = [{ path: 'questions.jsonl', bytes: bytes.length, sha256: sha256(bytes) }, ...sources.map(file => {
    const image = fs.readFileSync(file.source);
    return { path: file.path, bytes: image.length, sha256: sha256(image) };
  })];
  const version = sha256(JSON.stringify(files));
  const manifest = { format: 1, version, questions: rows.length, images: paths.length, files };
  const stage = `${output}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'questions.jsonl'), bytes);
    for (const file of sources) {
      const target = path.join(stage, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file.source, target);
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    verifyResources(stage);
    fs.renameSync(stage, output);
    return manifest;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, verify: { type: 'string' } } });
  if (!values.output && !values.verify || values.output && values.verify) throw new Error('使用 --output=新资源目录 或 --verify=已有资源目录。');
  const config = loadConfig();
  const manifest = values.verify ? verifyResources(values.verify) : packageResources({ ...config, output: path.resolve(values.output) });
  console.log(JSON.stringify({ version: manifest.version, questions: manifest.questions, images: manifest.images, verified: true }));
}
