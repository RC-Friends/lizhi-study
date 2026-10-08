import test from 'node:test';
import assert from 'node:assert/strict';
import { publicStats, publicStatsQuery } from '../../server/public-stats.mjs';
import { LearningService } from '../../server/learning.mjs';
import { MatchService } from '../../server/matches.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { config, question, settings } from './fixtures.mjs';

const now = Date.parse('2026-10-03T18:00:00Z'); // Already October 4 in China.
const range = { from: '2026-10-02', to: '2026-10-03', module: 'all' };
function setup(t) {
  const bank = new QuestionBank(null, [question, { ...question, id: 'q2', module: '判断推理' }]);
  const matches = new MatchService(bank, config, { persist: false });
  const learning = new LearningService(bank, matches, config, { persist: false, clock: () => now });
  t.after(() => matches.shutdown());
  function add({ choice = 'D', ownerId = 'primary', id = question.id, submittedAt = '2026-10-02T01:00:00Z', count = 1 } = {}) {
    const created = matches.create({ ...settings, mode: 'practice', modules: ['数量关系', '判断推理'], count,
      questionIds: count === 1 ? [id] : [question.id, 'q2'] }, { ownerId });
    const match = matches.authenticate(created.match.id, created.token);
    matches.submit(match, { choice, index: 0 });
    Object.assign(match.rounds[0], { submittedAt, completedAt: '2026-10-05T00:00:00Z', humanMs: 10000 });
    return match;
  }
  return { matches, learning, add };
}

test('guest date ranges use China calendar, validate dates and bound cache cardinality', () => {
  assert.deepEqual(publicStatsQuery({}, now), { from: '2026-09-28', to: '2026-10-04', module: 'all' });
  assert.deepEqual(publicStatsQuery({ to: '2026-10-01', module: '数量关系' }, now), { from: '2026-09-25', to: '2026-10-01', module: '数量关系' });
  for (const query of [{ to: '2026-02-30' }, { to: '2026-10-05' }, { from: '2026-10-04', to: '2026-10-03' },
    { from: '2025-10-01', to: '2026-10-04' }, { from: ['2026-10-01'] }, { to: '' }, { module: 'invalid' }, { token: 'anything' }]) {
    assert.throws(() => publicStatsQuery(query, now), error => error.status === 400);
  }
  assert.equal(publicStatsQuery({ from: '2025-10-04', to: '2026-10-04' }, now).from, '2025-10-04'); // 366 days inclusive.
});

test('public stats weight attempts, retain calendar boundaries and exclude private/demo/unrevealed rows', t => {
  const { matches, learning, add } = setup(t);
  const live = add({ count: 2, submittedAt: '2026-10-01T16:00:00Z' });
  live.rounds[0].coachMessages = [{ content: 'PRIVATE_CHAT' }]; matches.next(live, { index: 0 });
  add({ choice: 'A', submittedAt: '2026-10-03T15:59:59Z' });
  add({ choice: 'A', id: 'q2', submittedAt: '2026-10-02T15:59:59Z' });
  add({ submittedAt: '2026-10-01T15:59:59Z' }); // Previous period, despite completedAt being later.
  add({ submittedAt: '2026-10-03T16:00:00Z' }); // Next day in China.
  const demo = add(); demo.settings.demo = true;
  const other = add({ ownerId: 'other' }), legacy = add(); delete legacy.ownerId;
  const pending = add(); pending.rounds[0].phase = 'ai_thinking';
  learning.updateQuestion(question.id, { note: 'PRIVATE_NOTE', bookmarked: true });
  const result = publicStats(learning, range);
  assert.deepEqual(result.summary, { answered: 3, correct: 1, accuracy: 33.3, uniqueAnswered: 2, studyMs: 30000, averageMs: 10000, sessions: 3 });
  assert.equal(result.previous.summary.accuracy, 100); assert.equal(result.previous.accuracyChangePoints, -66.7);
  assert.deepEqual(result.activity.map(day => day.answered), [2, 1]);
  assert.equal(result.modules.find(row => row.name === '数量关系').accuracy, 50);
  assert.equal(result.modules.find(row => row.name === '判断推理').accuracy, 0);
  assert.equal(result.modules.find(row => row.name === '资料分析').accuracy, null);
  assert.equal(result.recent.length, 3); assert.equal(result.range.includesToday, false);
  assert.equal(result.lastAnsweredAt, '2026-10-03T15:59:59Z');
  for (const secret of ['PRIVATE_CHAT', 'PRIVATE_NOTE', 'coachMessages', 'tokenHash', live.tokenHash, demo.id, other.id, legacy.id, pending.id, 'GOLD_SECRET']) assert.ok(!JSON.stringify(result).includes(secret), secret);
  const filtered = publicStats(learning, { ...range, module: '判断推理' });
  assert.equal(filtered.summary.answered, 1); assert.equal(filtered.summary.accuracy, 0); assert.equal(filtered.previous.summary.accuracy, null);
  const empty = publicStats(learning, { from: '2020-01-01', to: '2020-01-02', module: 'all' });
  assert.equal(empty.summary.accuracy, null); assert.equal(empty.summary.averageMs, null); assert.equal(empty.lastAnsweredAt, null);
  assert.equal(empty.activity.length, 2); assert.equal(empty.previous.accuracyChangePoints, null);
});

test('duel accuracy uses paired rounds and timing includes only complete simultaneous attempts', t => {
  const { learning, add } = setup(t);
  for (const [mode, choice, aiCorrect, parallel, incomplete] of [
    ['llm', 'D', true, true, false], ['llm', 'A', true, true, true], ['llm', 'A', false, false, false],
    ['jev', 'D', false, false, false],
  ]) {
    const match = add({ choice }); match.settings.mode = mode;
    Object.assign(match.rounds[0], { aiCorrect, aiMs: 2000, parallel, aiTimingIncomplete: incomplete });
  }
  add(); // Practice doesn't inflate human accuracy in the duel comparison.
  const { duels } = publicStats(learning, range), [llm, jev] = duels;
  assert.equal(llm.answered, 3); assert.equal(llm.humanAccuracy, 33.3); assert.equal(llm.aiAccuracy, 66.7);
  assert.deepEqual(llm.timing, { compared: 1, excluded: 2, humanMs: 10000, aiMs: 2000, humanAverageMs: 10000, aiAverageMs: 2000 });
  assert.equal(jev.humanAccuracy, 100); assert.equal(jev.aiAccuracy, 0); assert.equal(jev.timing.compared, 0); assert.equal(jev.timing.aiAverageMs, null);
});
