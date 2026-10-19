import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { materialKey, materialSources, orderMaterialQuestions } from '../server/materials.mjs';
import { QuestionBank } from '../server/bank.mjs';
import { parseQuestionLines, validateCanonical } from '../server/question-import.mjs';
import { questionFingerprint, verifyResources } from '../server/resources.mjs';
import { packageResources } from './package-resources.mjs';

export function repairMaterialGroups({ source, output, check = false }) {
  if (!source || !check && !output) throw new Error('使用 --source=完整资源包 --check 或 --output=新的资源包目录。');
  const manifest = verifyResources(source), rows = parseQuestionLines(fs.readFileSync(path.join(source, 'questions.jsonl')));
  validateCanonical(rows);
  const original = new Map(rows.map(question => [question.id, questionFingerprint(question)]));
  const groups = new Map();
  for (const question of rows) {
    const key = materialKey(question);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  const materials = [], reordered = [];
  for (const [key, questions] of groups) {
    const ordered = orderMaterialQuestions(questions); reordered.push(...ordered);
    if (key.startsWith('question:')) continue;
    if (new Set(questions.map(q => q.material_html?.trim() || q.material?.trim() || '')).size > 1) {
      throw new Error(`材料 ${key} 对应多个不同正文，请先人工核对来源；没有生成修复包。`);
    }
    const sources = materialSources(questions);
    materials.push({ key, questionIds: ordered.map(q => q.id), sourcePapers: sources.length,
      anchorSource: sources[0]?.key || null, anchorQuestions: sources[0]?.positions.size || 0,
      sourceVariants: sources.length > 1 && sources[0].positions.size < questions.length,
      orderChanged: questions.some((q, i) => q.id !== ordered[i].id) });
  }
  if (reordered.length !== original.size || reordered.some(q => original.get(q.id) !== questionFingerprint(q))) {
    throw new Error('修复包未完整保留原题，拒绝生成。');
  }
  const activeBank = new QuestionBank(null, rows), result = validateCanonical(reordered, { activeBank });
  const usable = new Set(activeBank.byId.keys());
  const report = { valid: true, sourceVersion: manifest.version, questions: rows.length, usableQuestions: result.usableQuestions,
    images: manifest.images, materials: materials.length,
    materialQuestions: materials.reduce((n, group) => n + group.questionIds.length, 0),
    usableMaterialGroups: materials.filter(group => group.questionIds.filter(id => usable.has(id)).length > 1).length,
    orderedMaterials: materials.filter(group => group.orderChanged).length,
    sourceVariantMaterials: materials.filter(group => group.sourceVariants).length,
    allQuestionFingerprintsPreserved: true, groups: materials };
  if (check) return report;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-material-repair-'));
  try {
    const filename = path.join(temporary, 'questions.jsonl');
    const jsonLine = question => JSON.stringify(question).replace(/[\u0085\u2028\u2029]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    fs.writeFileSync(filename, reordered.map(jsonLine).join('\n') + '\n');
    const next = packageResources({ dataPath: filename, imagesPath: path.join(source, 'assets/images'), output: path.resolve(output) });
    const originalFiles = new Map(manifest.files.map(file => [file.path, file]));
    if (next.files.some(file => file.path !== 'questions.jsonl' && (file.sha256 !== originalFiles.get(file.path)?.sha256
      || file.bytes !== originalFiles.get(file.path)?.bytes))) {
      fs.rmSync(output, { recursive: true, force: true });
      throw new Error('整理期间图片内容发生变化，已丢弃新资源包，请核对原资源后重试。');
    }
    return { ...report, allImageFingerprintsPreserved: true, version: next.version, output };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' },
      check: { type: 'boolean' }, report: { type: 'string' } } });
    const report = repairMaterialGroups(values);
    if (values.report) fs.writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    const { groups, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
