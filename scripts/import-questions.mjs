import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compileImport, validateImport, inspectImage, parseQuestionLines, validateCanonical, ImportError, IMPORT_LIMITS } from '../server/question-import.mjs';
import { packageResources } from './package-resources.mjs';
import { verifyResources, resolveQuestionImage, questionFingerprint } from '../server/resources.mjs';

export function prepareQuestionImport({ input, output, base, check = false }) {
  if (fs.statSync(input).size > IMPORT_LIMITS.documentBytes) throw new ImportError([{ path: '', message: '导入 JSON 不能超过 64 MiB。' }]);
  let document;
  try { document = JSON.parse(fs.readFileSync(input, 'utf8')); } catch { throw new ImportError([{ path: '', message: '输入文件不是合法的 JSON。' }]); }
  const summary = validateImport(document), root = fs.realpathSync(path.dirname(input)), imageInfo = new Map(), sources = new Map();
  for (const image of document.questions.flatMap(q => q.images || [])) {
    if (imageInfo.has(image.path)) continue;
    let filename;
    try { filename = fs.realpathSync(path.resolve(root, image.path)); } catch { throw new ImportError([{ path: image.path, message: '找不到图片文件。' }]); }
    if (!filename.startsWith(root + path.sep) || !fs.statSync(filename).isFile()) throw new ImportError([{ path: image.path, message: '图片不在输入文件所在目录内，或不是普通文件。' }]);
    if (fs.statSync(filename).size > IMPORT_LIMITS.imageBytes) throw new ImportError([{ path: image.path, message: '图片不能超过 16 MiB。' }]);
    const meta = inspectImage(fs.readFileSync(filename), image.path);
    imageInfo.set(image.path, meta); sources.set(meta.path, filename);
  }
  const added = compileImport(document, imageInfo), rows = [];
  if (base) {
    verifyResources(base);
    rows.push(...parseQuestionLines(fs.readFileSync(path.join(base, 'questions.jsonl'))));
    for (const image of rows.flatMap(q => q.images)) sources.set(image.path, resolveQuestionImage(image.path, path.join(base, 'assets/images')));
  }
  const existing = new Map(rows.map(q => [q.id, q])); let reused = 0;
  for (const q of added) {
    if (existing.has(q.id)) {
      if (questionFingerprint(existing.get(q.id)) !== questionFingerprint(q)) throw new ImportError([{ path: q.id, message: '同一题目 ID 的内容发生变化，请用新的外部 ID 导入修订题。' }], 409, 'question_conflict');
      reused++;
    } else { rows.push(q); existing.set(q.id, q); }
  }
  const report = validateCanonical(rows);
  const bytes = Buffer.from(rows.map(q => JSON.stringify(q)).join('\n') + '\n');
  if (bytes.length > IMPORT_LIMITS.bankBytes) throw new ImportError([{ path: '', message: '合并后的题库不能超过 128 MiB。' }]);
  if (check) return { ...summary, questions: rows.length, usableQuestions: report.usableQuestions, added: added.length - reused, reused, checkedImageFiles: sources.size };
  if (!output) throw new Error('请指定 --output=新资源包目录，或使用 --check 仅校验。');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-question-import-'));
  try {
    const imagesPath = path.join(stage, 'assets/images'); fs.mkdirSync(imagesPath, { recursive: true });
    for (const [relative, source] of sources) {
      const target = path.join(stage, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
      const meta = inspectImage(fs.readFileSync(target), relative), ref = report.refs.get(relative);
      if (meta.path !== relative || ref && (meta.width !== ref.width || meta.height !== ref.height)) throw new ImportError([{ path: relative, message: '图片内容或尺寸与题库不一致。' }]);
    }
    const dataPath = path.join(stage, 'questions.jsonl'); fs.writeFileSync(dataPath, bytes);
    const manifest = packageResources({ dataPath, imagesPath, output: path.resolve(output) });
    return { valid: true, version: manifest.version, questions: rows.length, usableQuestions: report.usableQuestions, images: manifest.images, added: added.length - reused, reused, output };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, base: { type: 'string' }, check: { type: 'boolean' } } });
  try {
    if (!values.input) throw new Error('使用 --input=questions.json --check 或 --output=新资源包目录；增量导入使用 --base=当前资源包目录。');
    console.log(JSON.stringify(prepareQuestionImport(values), null, 2));
  } catch (error) { console.error(JSON.stringify({ error: error instanceof ImportError ? { code: error.code, message: error.message, issues: error.issues } : { message: error.message } })); process.exitCode = 1; }
}
