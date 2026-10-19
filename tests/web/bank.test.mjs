import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionBank, questionImages } from '../../server/bank.mjs';
import { question, settings } from './fixtures.mjs';

test('paper generation respects module/source/image filters and never duplicates a question', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ ...question, id: `q_${i}`,
    module: i % 2 ? '数量关系' : '判断推理', source_type: i % 3 ? '真题' : '模拟题',
    images: i % 5 ? [] : [{ path: `assets/images/${i}.png`, role: 'stem' }] }));
  const bank = new QuestionBank(null, rows);
  const ids = bank.draw({ ...settings, modules: ['数量关系', '判断推理'], source: 'real', images: 'text', count: 12 });
  assert.equal(new Set(ids).size, 12);
  assert.ok(ids.every(id => bank.byId.get(id).source_type === '真题' && !questionImages(bank.byId.get(id)).length));
  assert.equal(ids.filter(id => bank.byId.get(id).module === '数量关系').length, 6);
});
test('analysis-only images do not require a vision model, and non-single questions are excluded', () => {
  const bank = new QuestionBank(null, [question, { ...question, id: 'multi', question_type: 'multiple', answer: ['A', 'B'] },
    { ...question, id: 'analysis_only', images: [{ path: 'assets/images/answer.png', role: 'analysis' }] }]);
  assert.equal(bank.rows.length, 2); assert.equal(bank.catalog().imageQuestions, 0);
  assert.equal(bank.publicQuestion('analysis_only').hasImages, false);
  assert.throws(() => bank.draw({ ...settings, count: 3 }), /只有 2 道题/);
  assert.throws(() => bank.draw({ ...settings, count: 0 }), /1—100/);
});
test('scoped and explicitly chosen papers cannot escape their permitted question set', () => {
  const bank = new QuestionBank(null, [question, { ...question, id: 'other' }]);
  assert.deepEqual(bank.draw(settings, { allowedQuestionIds: ['other'] }), ['other']);
  assert.deepEqual(bank.draw(settings, { allowedQuestionIds: ['other'], requestedQuestionIds: ['other'] }), ['other']);
  assert.throws(() => bank.draw(settings, { allowedQuestionIds: ['other'], requestedQuestionIds: [question.id] }), /不符合/);
  assert.throws(() => bank.draw({ ...settings, count: 2 }, { requestedQuestionIds: ['other', 'other'] }), /去重/);
  assert.throws(() => bank.draw(settings, { requestedQuestionIds: ['unknown'] }), /不符合/);
  assert.throws(() => bank.draw({ ...settings, modules: ['判断推理'] }, { requestedQuestionIds: ['other'] }), /不符合/);
});

test('random papers keep every selected material group contiguous without changing balance or count', () => {
  const rows = ['数量关系', '判断推理'].flatMap((module, m) => Array.from({ length: 12 }, (_, i) => ({
    ...question, id: `q_${m}_${i}`, module, material_id: `material_${m}_${i % 3}`,
  })));
  const bank = new QuestionBank(null, rows);
  for (let attempt = 0; attempt < 30; attempt++) {
    const ids = bank.draw({ ...settings, modules: ['数量关系', '判断推理'], count: 16 });
    assert.equal(ids.length, 16);
    assert.equal(new Set(ids).size, 16);
    assert.equal(ids.filter(id => bank.byId.get(id).module === '数量关系').length, 8);
    for (const material of new Set(ids.map(id => bank.byId.get(id).material_id))) {
      const positions = ids.flatMap((id, index) => bank.byId.get(id).material_id === material ? [index] : []);
      assert.equal(positions.at(-1) - positions[0] + 1, positions.length);
    }
  }
});

test('explicit papers group numbered materials and legacy content while preserving group and member order', () => {
  const rows = [
    { ...question, id: 'a1', material_id: 'a' },
    { ...question, id: 'b1', material_id: 'b' },
    { ...question, id: 'a2', material_id: 'a' },
    { ...question, id: 'legacy1', material_html: '<p>导入材料</p>' },
    { ...question, id: 'b2', material_id: 'b' },
    { ...question, id: 'legacy2', material_html: '<p>导入材料</p>' },
  ];
  const bank = new QuestionBank(null, rows);
  const ids = rows.map(row => row.id);
  const grouped = bank.draw({ ...settings, count: ids.length }, { requestedQuestionIds: ids, allowedQuestionIds: ids });
  assert.deepEqual(grouped, ['a1', 'a2', 'b1', 'b2', 'legacy1', 'legacy2']);
  assert.deepEqual(bank.draw({ ...settings, count: grouped.length }, { requestedQuestionIds: grouped }), grouped);
  assert.deepEqual(ids, rows.map(row => row.id));
});

test('questions without material and different image-only materials are not merged', () => {
  const rows = [
    { ...question, id: 'plain1', material: '', material_html: '' },
    { ...question, id: 'image1', material: '', material_html: '<img src="assets/images/a.png">' },
    { ...question, id: 'plain2', material: '', material_html: '' },
    { ...question, id: 'image2', material: '', material_html: '<img src="assets/images/b.png">' },
    { ...question, id: 'image1b', material: '', material_html: '<img src="assets/images/a.png">' },
  ];
  const bank = new QuestionBank(null, rows);
  assert.deepEqual(bank.draw({ ...settings, count: 5, images: 'mixed' }, { requestedQuestionIds: rows.map(row => row.id) }), ['plain1', 'image1', 'image1b', 'plain2', 'image2']);
  const textOnly = new QuestionBank(null, [
    { ...question, id: 'text1', material_html: '', material: '共享文字材料' },
    { ...question, id: 'other', material_html: '', material: '另一份材料' },
    { ...question, id: 'text2', material_html: '', material: '共享文字材料' },
  ]);
  assert.deepEqual(textOnly.draw({ ...settings, count: 3 }, { requestedQuestionIds: ['text1', 'other', 'text2'] }), ['text1', 'text2', 'other']);
});

const materialRows = (key, size, extra = {}) => Array.from({ length: size }, (_, i) => ({
  ...question, id: `${key}_${i}`, material_id: key, material: `材料 ${key}`, material_html: `<p>材料 ${key}</p>`, ...extra,
}));

test('drawing one question selects its entire material, in original paper order', () => {
  const rows = materialRows('a', 5).map((row, index) => ({ ...row,
    occurrences: [{ paper_title: '原试卷', dataset: 'bank', question_number: 105 - index }],
  }));
  const bank = new QuestionBank(null, rows);
  const expected = [...rows].reverse().map(row => row.id);
  assert.deepEqual(bank.draw(settings), expected);
  assert.deepEqual(bank.draw(settings, { requestedQuestionIds: ['a_2'] }), expected);
  assert.deepEqual(bank.draw(settings, { allowedQuestionIds: ['a_2'] }), expected);
  assert.equal(bank.publicQuestion('a_0').materialHtml, bank.publicQuestion('a_4').materialHtml);
});

test('explicit imported material order survives differing per-question source titles', () => {
  const rows = materialRows('imported', 3).map((row, index) => ({ ...row,
    occurrences: [{ dataset: 'bank', raw_path: 'question-import/1.0', paper_title: `来源 ${index}`,
      question_number: 3 - index }],
  }));
  assert.deepEqual(new QuestionBank(null, rows).draw(settings), ['imported_2', 'imported_1', 'imported_0']);
});

test('material groups cross a target intact, without duplication or exceeding the paper cap', () => {
  const bank = new QuestionBank(null, [...materialRows('a', 5), ...materialRows('b', 5), ...materialRows('c', 5)]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const ids = bank.draw({ ...settings, count: 6 });
    assert.equal(ids.length, 10); assert.equal(new Set(ids).size, 10);
    for (const key of new Set(ids.map(id => bank.materialKeys.get(id)))) {
      assert.deepEqual(ids.filter(id => bank.materialKeys.get(id) === key), bank.materials.get(key));
    }
  }
  const capped = new QuestionBank(null, [...materialRows('a', 40), ...materialRows('b', 40), ...materialRows('c', 40)]);
  assert.equal(capped.draw({ ...settings, count: 100 }).length, 80);
  assert.throws(() => capped.draw({ ...settings, count: 3 }, { requestedQuestionIds: ['a_0', 'b_0', 'c_0'] }), /超过 100/);
  const oversized = new QuestionBank(null, [...materialRows('large', 101), question]);
  assert.deepEqual(oversized.draw(settings), [question.id]);
});

test('legacy imported materials and image-only materials are sampled as whole groups', () => {
  const bank = new QuestionBank(null, materialRows('legacy', 3, { material_id: null }));
  assert.deepEqual(bank.draw(settings), ['legacy_0', 'legacy_1', 'legacy_2']);
  const images = [{ path: 'assets/images/chart.png', role: 'material' }];
  const imageBank = new QuestionBank(null, materialRows('image', 2, { material_id: null, material: '',
    material_html: '<img src="assets/images/chart.png">', images }));
  assert.deepEqual(imageBank.draw({ ...settings, images: 'visual' }), ['image_0', 'image_1']);
});

test('hard filters exclude incompatible materials intact; scope seeds include companion questions', () => {
  const rows = [...materialRows('mixed', 2), ...materialRows('ok', 2)];
  rows[1].images = [{ path: 'assets/images/figure.png', role: 'stem' }];
  const bank = new QuestionBank(null, rows);
  assert.deepEqual(bank.draw(settings), ['ok_0', 'ok_1']);
  assert.throws(() => bank.draw(settings, { allowedQuestionIds: ['mixed_0'] }), /只有 0 道题/);
  assert.deepEqual(bank.draw({ ...settings, images: 'mixed' }, { allowedQuestionIds: ['mixed_0'] }), ['mixed_0', 'mixed_1']);
  assert.throws(() => bank.draw({ ...settings, images: 'visual' }), /只有 0 道题/);
  rows[1].images = []; rows[1].source_type = '真题';
  const sourceBank = new QuestionBank(null, rows);
  assert.deepEqual(sourceBank.draw({ ...settings, source: 'mock' }), ['ok_0', 'ok_1']);
  rows[1].source_type = '模拟题'; rows[1].module = '判断推理';
  const moduleBank = new QuestionBank(null, rows);
  assert.deepEqual(moduleBank.draw(settings), ['ok_0', 'ok_1']);
});
