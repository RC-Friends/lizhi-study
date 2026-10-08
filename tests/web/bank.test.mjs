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
