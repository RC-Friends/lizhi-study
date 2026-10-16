import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileImport, validateImport, validateCanonical, parseQuestionLines, inspectImage, importImages } from '../../server/question-import.mjs';
import { prepareQuestionImport } from '../../scripts/import-questions.mjs';

const example = 'examples/question-bank/materials.json';
const document = () => JSON.parse(fs.readFileSync(example));

test('one shared material compiles into complete, stably linked questions with explicit order', () => {
  const input = document(); input.questions.reverse();
  const rows = compileImport(input, new Map());
  assert.equal(validateCanonical(rows).usableQuestions, 3);
  assert.equal(new Set(rows.map(row => row.material_id)).size, 1);
  assert.match(rows[0].material_id, /^mat_[a-f0-9]{24}$/);
  assert.ok(rows.every(row => row.material === input.materials[0].text));
  assert.deepEqual(rows.map(row => row.occurrences[0].question_number), [3, 2, 1]);
  assert.deepEqual(compileImport(input, new Map()), rows);
  const otherBank = structuredClone(input); otherBank.bankId = 'another-bank';
  assert.notEqual(compileImport(otherBank, new Map())[0].material_id, rows[0].material_id);
  input.materials.push({ id: 'same-content', text: input.materials[0].text });
  input.questions[2].materialId = 'same-content'; input.questions[2].materialOrder = 1;
  input.questions[0].materialOrder = 2; input.questions[1].materialOrder = 1;
  const distinct = compileImport(input, new Map());
  assert.notEqual(distinct[0].material_id, distinct[2].material_id);
});

test('shared material validation rejects broken references, ambiguity and incomplete ordering', () => {
  const changes = [
    d => d.materials.push(d.materials[0]),
    d => d.materials.push({ id: 'unused', text: '未被引用' }),
    d => d.materials[0].text = ' ',
    d => d.materials[0].images = [{ path: '../escape.png' }],
    d => d.materials[0].images = [{ path: 'images/x.png' }, { path: 'images/x.png' }],
    d => d.questions[0].materialId = 'missing',
    d => delete d.questions[0].materialOrder,
    d => delete d.questions[0].materialId,
    d => d.questions[0].materialOrder = 0,
    d => d.questions[0].materialOrder = 101,
    d => d.questions[0].materialOrder = 2,
    d => d.questions.splice(1, 1),
    d => d.questions[0].material = '重复的内联材料',
    d => d.questions[0].images = [{ path: 'images/x.png', role: 'material' }],
  ];
  for (const change of changes) {
    const input = document(); change(input);
    assert.throws(() => validateImport(input), error => error.status === 422 && error.issues.some(issue => issue.path.startsWith('/')));
  }
});

test('image-only shared materials are checked, archived once and inherited by every question', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-material-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'images'));
  fs.copyFileSync('examples/question-bank/images/loans.png', path.join(root, 'images/chart.png'));
  const input = document(); delete input.materials[0].text;
  input.materials[0].images = [{ path: 'images/chart.png' }];
  const bytes = fs.readFileSync(path.join(root, 'images/chart.png')), meta = inspectImage(bytes, 'images/chart.png');
  const rows = compileImport(input, new Map([['images/chart.png', meta]]));
  validateCanonical(rows);
  assert.equal(validateImport(input).images, 1); assert.equal(importImages(input).length, 1);
  assert.ok(rows.every(row => row.images[0].role === 'material' && row.images[0].path === meta.path && row.material_html.includes(meta.path)));
  assert.throws(() => compileImport(input, new Map()), { status: 422 });
  const inputPath = path.join(root, 'questions.json'); fs.writeFileSync(inputPath, JSON.stringify(input));
  const first = prepareQuestionImport({ input: inputPath, output: path.join(root, 'one') });
  const next = prepareQuestionImport({ input: inputPath, base: path.join(root, 'one'), output: path.join(root, 'two') });
  assert.equal(first.images, 1); assert.equal(first.questions, 3);
  assert.equal(next.reused, 3); assert.equal(next.added, 0); assert.equal(next.version, first.version);
  const stored = parseQuestionLines(fs.readFileSync(path.join(root, 'one/questions.jsonl')));
  assert.deepEqual(stored, rows);
});

test('old inline material imports retain their IDs and original metadata shape', () => {
  const input = document(); delete input.materials;
  for (const q of input.questions) { delete q.materialId; delete q.materialOrder; q.material = '旧格式材料'; }
  const rows = compileImport(input, new Map());
  assert.ok(rows.every(row => row.material_id === null && !Object.hasOwn(row.occurrences[0], 'question_number')));
  assert.ok(rows.every(row => row.material === '旧格式材料'));
});

test('merged banks reject reused material IDs with different content or duplicate and missing positions', () => {
  const rows = compileImport(document(), new Map());
  const extra = { ...structuredClone(rows[0]), id: 'xc_' + 'f'.repeat(24) };
  assert.throws(() => validateCanonical([...rows, extra]), error => error.issues.some(issue => issue.message.includes('序号重复')));
  extra.material = '修订材料'; extra.material_html = '<p>修订材料</p>';
  assert.throws(() => validateCanonical([...rows, extra]), error => error.issues.some(issue => issue.message.includes('内容不一致')));
  assert.throws(() => validateCanonical([rows[0], rows[2]]), error => error.issues.some(issue => issue.message.includes('连续排列')));
  extra.material_id = 'mat_revision';
  assert.equal(validateCanonical([...rows, extra]).usableQuestions, 4);
});
