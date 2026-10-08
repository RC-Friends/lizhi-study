import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.mjs';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const questionFingerprint = question => sha256(JSON.stringify(question));
export const defaultImagesPath = path.join(ROOT, 'assets/images');

// Dataset paths stay portable. The filesystem root is runtime configuration,
// never a value accepted from an HTTP client or an upstream model.
export function resolveQuestionImage(relative, imagesPath = defaultImagesPath) {
  if (typeof relative !== 'string' || !/^assets\/images\/[a-zA-Z0-9_./-]+$/.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('题图路径无效。');
  }
  const root = fs.realpathSync(imagesPath);
  const filename = fs.realpathSync(path.resolve(root, relative.slice('assets/images/'.length)));
  if (!filename.startsWith(root + path.sep) || !fs.statSync(filename).isFile()) throw new Error('题图路径越界或不是文件。');
  return filename;
}

export function verifyResourceFiles(rows, imagesPath = defaultImagesPath) {
  const images = new Set(rows.flatMap(q => (q.images || []).map(image => image.path)));
  for (const relative of images) resolveQuestionImage(relative, imagesPath);
  return { questions: rows.length, images: images.size };
}

export function verifyResources(directory) {
  const root = fs.realpathSync(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || sha256(JSON.stringify(manifest.files)) !== manifest.version) throw new Error('资源清单版本或校验和无效。');
  for (const file of manifest.files) {
    const filename = file.path === 'questions.jsonl' ? path.join(root, 'questions.jsonl') : resolveQuestionImage(file.path, path.join(root, 'assets/images'));
    if (!fs.realpathSync(filename).startsWith(root + path.sep)) throw new Error('资源文件越界。');
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`资源文件校验失败：${file.path}`);
  }
  const rows = fs.readFileSync(path.join(root, 'questions.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const expected = ['questions.jsonl', ...new Set(rows.flatMap(q => q.images.map(image => image.path)))].sort();
  const actual = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual) || rows.length !== manifest.questions || expected.length - 1 !== manifest.images) throw new Error('资源清单与题库引用不一致。');
  return manifest;
}
