import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { LearningService } from '../../server/learning.mjs';
import { question, config, settings } from './fixtures.mjs';

const setup = (extra = {}) => {
  const bank = new QuestionBank(null, [question, { ...question, id: 'q2', module: '判断推理', stem_html: 'UNSEEN_ACTIVE_QUESTION' }]);
  const matches = new MatchService(bank, config, { persist: false, providers: { llm: () => new Promise(() => {}) } });
  const learning = new LearningService(bank, matches, { ...config, ...extra }, { persist: false, clock: () => Date.parse('2026-10-03T02:00:00Z') });
  return { bank, matches, learning };
};
const practice = (matches, { choice = 'A', ownerId = 'primary', id = question.id, timestamp = '2026-10-03T01:00:00Z', count = 1, finish = true } = {}) => {
  const created = matches.create({ ...settings, modules: ['数量关系', '判断推理'], mode: 'practice', count, questionIds: count === 1 ? [id] : [question.id, 'q2'] }, { ownerId });
  const match = matches.authenticate(created.match.id, created.token);
  matches.submit(match, { choice, index: 0 });
  match.rounds[0].submittedAt = timestamp; match.rounds[0].completedAt = timestamp;
  match.rounds[0].humanMs = 15000;
  if (finish) matches.finish(match);
  return match;
};
test('public records omit legacy, demo, live questions, credentials, annotations, and private coach messages', () => {
  const { matches, learning } = setup();
  const old = practice(matches, { ownerId: 'legacy' }); delete old.ownerId;
  const other = practice(matches, { ownerId: 'other' });
  const demo = practice(matches); demo.settings.demo = true;
  const live = practice(matches, { count: 2, finish: false });
  live.rounds[0].coachMessages = [{ content: 'PRIVATE_COACH_MESSAGE' }];
  matches.next(live, { index: 0 });
  learning.updateQuestion(question.id, { note: 'PRIVATE_NOTE', bookmarked: true });
  const serialized = JSON.stringify({ dashboard: learning.publicDashboard(), history: learning.history({ publicOnly: true }), record: learning.record(live.id, { publicOnly: true }) });
  for (const secret of ['PRIVATE_NOTE', 'PRIVATE_COACH_MESSAGE', 'UNSEEN_ACTIVE_QUESTION', 'tokenHash', live.tokenHash, old.id, other.id, demo.id]) assert.ok(!serialized.includes(secret), secret);
  const record = learning.record(live.id, { publicOnly: true });
  assert.equal(record.current, null); assert.equal(record.originalStatus, 'active'); assert.equal(record.history.length, 1);
  assert.equal(record.history[0].correctAnswer, 'D'); assert.equal(record.scores.aiAccuracy, null);
  assert.throws(() => learning.record(other.id, { publicOnly: true }), /不存在/);
  assert.equal(learning.publicDashboard().summary.answered, 1);
  assert.equal(learning.dashboard().active.length, 1);
});
test('wrong-book tracks latest answer, manual mastery, and later regression; bookmarked unseen cards never leak gold', () => {
  const { matches, learning } = setup();
  practice(matches, { timestamp: '2026-10-03T01:00:00Z' });
  assert.deepEqual(learning.eligibleIds('wrong'), [question.id]);
  assert.deepEqual(learning.eligibleIds('unseen'), ['q2']);
  learning.updateQuestion(question.id, { mastered: true, note: 'Use a diagram' });
  assert.deepEqual(learning.eligibleIds('wrong'), []);
  practice(matches, { timestamp: '2026-10-03T03:00:00Z' });
  assert.deepEqual(learning.eligibleIds('wrong'), [question.id]);
  practice(matches, { choice: 'D', timestamp: '2026-10-03T04:00:00Z' });
  assert.deepEqual(learning.eligibleIds('wrong'), []);
  learning.updateQuestion('q2', { bookmarked: true });
  const unseen = learning.collection({ kind: 'bookmarked' }).items[0];
  assert.equal(unseen.questionId, 'q2'); assert.equal(unseen.correctAnswer, undefined);
  assert.ok(!JSON.stringify(unseen).includes('GOLD_SECRET'));
  assert.equal(learning.questionMeta(question.id).note, 'Use a diagram');
  assert.equal(learning.questionMeta(question.id).attempts, 3);
  learning.updateQuestion('q2', { bookmarked: false });
  assert.equal(learning.collection({ kind: 'bookmarked' }).total, 0);
});
test('dashboard counts submission dates in China time and computes streaks, targets, and module accuracy', () => {
  const { matches, learning } = setup();
  learning.updateProfile({ nickname: '备考人', dailyGoal: 2, examDate: '2026-10-10' });
  practice(matches, { choice: 'D', timestamp: '2026-10-01T15:59:00Z' }); // Oct 1 China
  practice(matches, { choice: 'A', timestamp: '2026-10-01T16:00:00Z' }); // Oct 2 China
  const midnight = practice(matches, { choice: 'D', timestamp: '2026-10-02T16:01:00Z' }); // Oct 3 China
  midnight.createdAt = '2026-09-01T00:00:00Z';
  const dashboard = learning.dashboard();
  assert.equal(dashboard.summary.answered, 3); assert.equal(dashboard.summary.correct, 2);
  assert.equal(dashboard.summary.accuracy, 66.7); assert.equal(dashboard.summary.streak, 3);
  assert.equal(dashboard.summary.todayAnswered, 1); assert.equal(dashboard.summary.goalProgress, 50);
  assert.equal(dashboard.summary.daysToExam, 7); assert.equal(dashboard.summary.weekAnswered, 3);
  assert.equal(dashboard.summary.totalStudyMs, 45000);
  assert.equal(dashboard.activity.at(-1).date, '2026-10-03');
  assert.equal(dashboard.activity.at(-1).answered, 1);
  assert.equal(dashboard.modules.find(m => m.name === '数量关系').accuracy, 66.7);
  assert.equal(dashboard.modules.find(m => m.name === '判断推理').accuracy, null);
});
test('question scope counts obey real filters, and pagination and mutations are validated', () => {
  const { learning, matches } = setup();
  practice(matches);
  assert.equal(learning.availability({ scope: 'wrong', modules: ['数量关系'] }).count, 1);
  assert.equal(learning.availability({ scope: 'wrong', modules: ['判断推理'] }).count, 0);
  assert.equal(learning.availability({ scope: 'unseen' }).count, 1);
  assert.throws(() => learning.eligibleIds('everything'), /范围无效/);
  assert.throws(() => learning.history({ page: -1 }), /分页/);
  assert.throws(() => learning.collection({ kind: 'wrong', pageSize: 101 }), /分页/);
  assert.throws(() => learning.updateQuestion(question.id, { bookmarked: 'yes' }), /布尔/);
  assert.throws(() => learning.updateQuestion('q2', { mastered: true }), /完成过/);
  assert.throws(() => learning.updateQuestion(question.id, { note: 'x'.repeat(4001) }), /4000/);
  assert.throws(() => learning.updateProfile({ dailyGoal: 0 }), /每日目标/);
  assert.throws(() => learning.updateProfile({ examDate: '2026-02-30' }), /日期无效/);
  assert.throws(() => learning.updateProfile({ nickname: ' ' }), /昵称/);
  assert.throws(() => learning.updateProfile({ ownerId: 'other' }), /设置无效/);
});
test('profile and notebook survive restart atomically, without copying notes into public views', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'study-learning-'));
  try {
    const { bank, matches } = setup(); practice(matches);
    const configuration = { ...config, learningPath: path.join(directory, 'learning.json') };
    const first = new LearningService(bank, matches, configuration);
    first.updateProfile({ nickname: '坚持的朋友', dailyGoal: 20 });
    first.updateQuestion(question.id, { bookmarked: true, note: 'DO_NOT_PUBLISH_NOTE' });
    const second = new LearningService(bank, matches, configuration);
    assert.equal(second.profile().dailyGoal, 20);
    assert.equal(second.collection({ kind: 'bookmarked' }).items[0].note, 'DO_NOT_PUBLISH_NOTE');
    assert.ok(!JSON.stringify(second.publicDashboard()).includes('DO_NOT_PUBLISH_NOTE'));
    assert.equal(fs.statSync(configuration.learningPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('private dashboard can resume demos without adding them to public study history', () => {
  const { bank, matches } = setup();
  const learning = new LearningService(bank, matches, { ...config, profileName: '小明' }, { persist: false });
  const demo = practice(matches, { finish: false }); demo.settings.demo = true;
  assert.equal(learning.profile().nickname, '小明');
  assert.equal(learning.dashboard().active.length, 1); assert.equal(learning.dashboard().active[0].demo, true);
  assert.equal(learning.dashboard().summary.answered, 0); assert.equal(learning.publicDashboard().recent.length, 0);
  assert.equal(learning.history({ publicOnly: true }).total, 0);
});
test('notebook filters run before pagination and mastered past mistakes can be reopened manually', () => {
  const { learning, matches } = setup();
  practice(matches, { timestamp: '2026-10-01T01:00:00Z' });
  practice(matches, { choice: 'D', timestamp: '2026-10-02T01:00:00Z' });
  practice(matches, { id: 'q2', timestamp: '2026-10-02T01:00:00Z' });
  assert.equal(learning.collection({ kind: 'wrong' }).total, 1);
  const archived = learning.collection({ kind: 'wrong', includeMastered: 'true', mastered: 'true', pageSize: 1 });
  assert.equal(archived.total, 1); assert.equal(archived.items[0].questionId, question.id); assert.equal(archived.items[0].wrongCount, 1);
  learning.updateQuestion(question.id, { mastered: false, note: '先画图再计算' });
  assert.equal(learning.collection({ kind: 'wrong' }).total, 2);
  assert.ok(learning.eligibleIds('wrong').includes(question.id));
  const filtered = learning.collection({ kind: 'wrong', module: '数量关系', search: '画图', pageSize: 1 });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].questionId, question.id);
  assert.equal(learning.collection({ kind: 'wrong', module: '判断推理', search: '画图' }).total, 0);
  assert.throws(() => learning.collection({ search: 'x'.repeat(101) }), /100/);
  assert.throws(() => learning.collection({ module: 'bad' }), /模块无效/);
  assert.throws(() => learning.collection({ mastered: 'maybe' }), /筛选无效/);
});
test('smart scope ranks redo, weak-module, and extend questions deterministically', () => {
  const { matches, learning } = setup();
  assert.deepEqual(learning.eligibleIds('smart'), ['q2', question.id]);
  practice(matches, { choice: 'A', timestamp: '2026-10-03T01:00:00Z' });
  assert.deepEqual(learning.eligibleIds('smart'), [question.id, 'q2']);
  const plan = learning.smartPlan({ count: 2, modules: ['数量关系', '判断推理'] });
  assert.deepEqual(plan, { ids: [question.id, 'q2'], composition: { review: 1, weak: 0, extend: 1 } });
  assert.deepEqual(learning.smartPlan({ count: 2, modules: ['数量关系', '判断推理'] }), plan);
  assert.deepEqual(learning.smartPlan({ count: 1, modules: ['判断推理'] }), { ids: ['q2'], composition: { review: 0, weak: 0, extend: 1 } });
  assert.equal(learning.availability({ scope: 'smart', modules: ['数量关系'] }).count, 1);
  assert.throws(() => learning.smartPlan({ count: 3, modules: ['数量关系', '判断推理'] }), /只有 2 道题/);
  assert.throws(() => learning.smartPlan({ count: 0 }), /题量/);
});
test('smart plan avoids repeating a knowledge point while the pool allows, then backfills', () => {
  const bank = new QuestionBank(null, [question, { ...question, id: 'q3', knowledge_points: ['方程'] }, { ...question, id: 'q4', knowledge_points: ['方程', '应用题'] }]);
  const matches = new MatchService(bank, config, { persist: false, providers: { llm: () => new Promise(() => {}) } });
  const learning = new LearningService(bank, matches, config, { persist: false, clock: () => Date.parse('2026-10-03T02:00:00Z') });
  const plan = learning.smartPlan({ count: 2, modules: ['数量关系'] });
  assert.deepEqual(plan.ids, ['q3', question.id]);
  assert.deepEqual(plan.composition, { review: 0, weak: 0, extend: 2 });
  const full = learning.smartPlan({ count: 3, modules: ['数量关系'] });
  assert.deepEqual(full.ids, ['q3', question.id, 'q4']);
});
