import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderMaterialQuestions } from '../../server/materials.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { validateMatch } from '../../server/storage.mjs';
import { compileImport, parseQuestionLines, inspectImage } from '../../server/question-import.mjs';
import { questionFingerprint, verifyResources } from '../../server/resources.mjs';
import { packageResources } from '../../scripts/package-resources.mjs';
import { repairMaterialGroups } from '../../scripts/repair-material-groups.mjs';
import { config } from './fixtures.mjs';

const source = (paper, number) => ({ dataset: 'synthetic', paper_id: paper, paper_title: `原卷 ${paper}`,
  source_id: `${paper}-${number}`, source_url: `https://example.org/${paper}`, raw_path: `snapshot/${paper}.json`,
  province: '合成', year: 2025, question_number: number });
function questions(image) {
  const rows = compileImport({ schemaVersion: '1.0', bankId: 'repair-fixture', materials: [{ id: 'chart', text: '同一材料\u2028第二段',
    ...(image ? { images: [{ path: 'images/material.png' }] } : {}) }],
    questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, module: '资料分析', materialId: 'chart', materialOrder: i + 1,
      stem: `小题 ${i + 1}`, options: { A: '甲', B: '乙' }, answer: 'A', analysis: '合成解析' })) },
    new Map(image ? [['images/material.png', image]] : []));
  rows.forEach((row, i) => { row.occurrences = [source(i < 4 ? 'a' : 'b', i + 1)]; });
  for (let i = 1; i < 4; i++) rows[i].occurrences.push(source('b', 10 + i));
  return rows;
}

test('source variants use the most complete paper order with deterministic ties and no lost questions', () => {
  const rows = questions(), shuffled = [rows[4], rows[2], rows[0], rows[3], rows[1]];
  const before = JSON.stringify(shuffled);
  // Both sources cover four questions; source a anchors the first four.
  assert.deepEqual(orderMaterialQuestions(shuffled).map(q => q.id), rows.map(q => q.id));
  assert.deepEqual(orderMaterialQuestions([...shuffled].reverse()).map(q => q.id), rows.map(q => q.id));
  rows[4].occurrences.push(source('b', 15));
  assert.equal(new Set(orderMaterialQuestions(shuffled).map(q => q.id)).size, 5);
  rows[4].occurrences.pop(); assert.equal(JSON.stringify(shuffled), before);
  // An extra source occurrence changes the anchor only when coverage grows.
  rows[0].occurrences.push(source('b', 20));
  assert.deepEqual(orderMaterialQuestions(shuffled).map(q => q.id), [rows[4], rows[1], rows[2], rows[3], rows[0]].map(q => q.id));
});

test('unprovenanced companions stay present while complete source order wins over file ordering', () => {
  const rows = questions(); rows[4].occurrences = [];
  assert.deepEqual(orderMaterialQuestions([rows[4], rows[2], rows[0], rows[3], rows[1]]).map(q => q.id), rows.map(q => q.id));
  rows.forEach(q => { q.occurrences = []; });
  assert.deepEqual(orderMaterialQuestions(rows), rows);
});

test('repair is idempotent, validates all files and preserves existing match fingerprints', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = fs.readFileSync('examples/question-bank/images/loans.png'), image = inspectImage(bytes, 'images/material.png');
  const rows = questions(image), shuffled = [rows[4], rows[2], rows[0], rows[3], rows[1]];
  const imageFile = path.join(root, 'images', image.path.slice('assets/images/'.length));
  fs.mkdirSync(path.dirname(imageFile), { recursive: true }); fs.writeFileSync(imageFile, bytes);
  fs.writeFileSync(path.join(root, 'input.jsonl'), shuffled.map(q => JSON.stringify(q)).join('\n') + '\n');
  const base = path.join(root, 'base'); packageResources({ dataPath: path.join(root, 'input.jsonl'), imagesPath: path.join(root, 'images'), output: base });
  const oldBank = new QuestionBank(null, shuffled), service = new MatchService(oldBank, config, { persist: false });
  const { match } = service.create({ mode: 'practice', count: 1, modules: ['资料分析'], source: 'all', images: 'mixed' }, { ownerId: 'primary' });
  t.after(() => service.shutdown());
  const report = repairMaterialGroups({ source: base, output: path.join(root, 'repaired') });
  assert.equal(report.sourceVariantMaterials, 1); assert.equal(report.orderedMaterials, 1);
  assert.ok(report.allQuestionFingerprintsPreserved); assert.notEqual(report.version, report.sourceVersion);
  const nextRows = parseQuestionLines(fs.readFileSync(path.join(root, 'repaired/questions.jsonl')));
  assert.deepEqual(nextRows, rows);
  assert.deepEqual(fs.readFileSync(path.join(root, 'repaired', image.path)), bytes);
  assert.ok(!fs.readFileSync(path.join(root, 'repaired/questions.jsonl'), 'utf8').includes('\u2028'));
  for (const row of nextRows) assert.equal(questionFingerprint(row), oldBank.fingerprints.get(row.id));
  assert.ok(validateMatch(service.matches.get(match.id), new QuestionBank(null, nextRows)));
  const again = repairMaterialGroups({ source: path.join(root, 'repaired'), output: path.join(root, 'again') });
  assert.equal(again.version, report.version); assert.equal(again.orderedMaterials, 0);
  verifyResources(base); verifyResources(path.join(root, 'again'));
  const check = repairMaterialGroups({ source: base, check: true, output: path.join(root, 'check-only') });
  assert.equal(check.questions, 5); assert.ok(!fs.existsSync(path.join(root, 'check-only')));
  assert.throws(() => repairMaterialGroups({ source: base, output: path.join(root, 'repaired') }), /已存在/);
});

test('repair refuses one material ID with conflicting bodies without producing an output bundle', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-repair-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = questions(); rows[4].material = '另一份材料'; rows[4].material_html = '<p>另一份材料</p>';
  fs.mkdirSync(path.join(root, 'images')); fs.writeFileSync(path.join(root, 'input.jsonl'), rows.map(q => JSON.stringify(q)).join('\n') + '\n');
  const base = path.join(root, 'base'), output = path.join(root, 'next');
  packageResources({ dataPath: path.join(root, 'input.jsonl'), imagesPath: path.join(root, 'images'), output: base });
  assert.throws(() => repairMaterialGroups({ source: base, output }), /不同正文/);
  assert.ok(!fs.existsSync(output)); verifyResources(base);
});
