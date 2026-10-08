import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoachService } from '../../server/coach.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { LearningService } from '../../server/learning.mjs';
import { question, config, settings, result } from './fixtures.mjs';

function setup({ configuration = config, provider = async () => ({ content: '公开学习说明' }), persist = false, demo = false } = {}) {
  const bank = new QuestionBank('', [question]);
  const matches = new MatchService(bank, configuration, { persist, providers: { demo: async () => result('D') } });
  const created = matches.create({ ...settings, mode: demo ? 'jev' : 'practice', demo }, { ownerId: 'primary' });
  const match = matches.authenticate(created.match.id, created.token);
  const coach = new CoachService(bank, matches, configuration, { provider });
  return { bank, matches, match, coach };
}
const reveal = ({ matches, match }) => matches.submit(match, { index: 0, choice: 'A' });

test('coaching never reads or discusses a question before the learner and model finish', async () => {
  let calls = 0;
  const state = setup({ provider: async () => { calls++; return { content: 'explanation' }; } });
  assert.throws(() => state.coach.snapshot(state.match, 0), /揭晓/);
  await assert.rejects(state.coach.reply(state.match, 0, '告诉我答案', { emit() {} }), /揭晓/);
  assert.equal(calls, 0); assert.equal(state.match.rounds[0].coachTurns, undefined);
});

test('successful post-answer discussion streams, persists, and remains excluded from spectator records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-persist-'));
  try {
    let payload;
    const state = setup({ persist: true, configuration: { ...config, runtimePath: directory }, provider: async (_config, body, hooks) => {
      payload = body; hooks.onText('PRIVATE_LEARNER_REPLY'); return { content: 'PRIVATE_LEARNER_REPLY' };
    } });
    reveal(state); const events = [];
    await state.coach.reply(state.match, 0, '  为什么我会选错？  ', { emit: (type, data) => events.push({ type, data }) });
    assert.deepEqual(events.map(event => event.type), ['text', 'complete']);
    assert.equal(events.at(-1).data.busy, false); assert.equal(events.at(-1).data.remaining, 7);
    assert.equal(state.match.rounds[0].coachMessages[0].content, '为什么我会选错？');
    assert.ok(JSON.stringify(payload).includes('GOLD_SECRET_NEVER_SEND'), 'gold is allowed only for post-answer tutoring');
    const recovered = new MatchService(state.bank, { ...config, runtimePath: directory });
    const recoveredMatch = recovered.matches.get(state.match.id), coach = new CoachService(state.bank, recovered, config);
    assert.equal(coach.snapshot(recoveredMatch, 0).messages[1].content, 'PRIVATE_LEARNER_REPLY');
    const learning = new LearningService(state.bank, recovered, config, { persist: false });
    assert.ok(!JSON.stringify(learning.record(state.match.id, { publicOnly: true })).includes('PRIVATE_LEARNER_REPLY'));
    assert.ok(!JSON.stringify(recovered.snapshot(recoveredMatch)).includes('PRIVATE_LEARNER_REPLY'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('demo coaching is explicitly labeled and never invokes a paid provider', async () => {
  let calls = 0;
  const state = setup({ demo: true, provider: async () => { calls++; throw new Error('Unexpected paid call'); } });
  reveal(state); await state.matches.jobs.get(state.match.id).task;
  const snapshot = await state.coach.reply(state.match, 0, '怎么做', { emit() {} });
  assert.equal(snapshot.demo, true); assert.equal(calls, 0); assert.ok(snapshot.messages[1].content.includes('演示回复'));
});

test('per-question concurrency, global capacity, and eight reserved attempts bound model spending', async () => {
  let finish;
  const state = setup({ provider: async () => new Promise(resolve => { finish = resolve; }) }); reveal(state);
  const pending = state.coach.reply(state.match, 0, '解释一下', { emit() {} });
  await assert.rejects(state.coach.reply(state.match, 0, '再解释', { emit() {} }), /正在回答/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish({ content: '完成' }); await pending;
  state.match.rounds[0].coachTurns = 8;
  await assert.rejects(state.coach.reply(state.match, 0, '继续', { emit() {} }), /8 轮/);
  state.match.rounds[0].coachTurns = 1;
  for (let i = 0; i < config.maxConcurrent; i++) state.matches.jobs.set('job' + i, { controller: new AbortController() });
  await assert.rejects(state.coach.reply(state.match, 0, '继续', { emit() {} }), /正在忙/);
  assert.equal(state.match.rounds[0].coachTurns, 1);
});

test('cancelled requests retain quota but never persist a partial reply or change grades', async () => {
  let invoked;
  const state = setup({ provider: async (_config, _body, { signal, onText }) => {
    onText('尚未完成的说明'); invoked = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }); reveal(state);
  const controller = new AbortController(), pending = state.coach.reply(state.match, 0, '帮我理解', { signal: controller.signal, emit() {} });
  while (!invoked) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(state.coach.jobs.size, 0); assert.equal(state.match.rounds[0].coachTurns, 1);
  assert.equal(state.match.rounds[0].coachMessages, undefined); assert.equal(state.match.rounds[0].humanCorrect, false);
  const before = state.match.rounds[0].coachTurns;
  await assert.rejects(state.coach.reply(state.match, 0, '断开后', { signal: controller.signal, emit() {} }), error => error.name === 'AbortError');
  assert.equal(state.match.rounds[0].coachTurns, before, 'already aborted requests consume no quota');
});

test('input validation and unsupported vision do not spend a turn or save private provider errors', async () => {
  const state = setup({ provider: async () => { throw new Error('PRIVATE_PROVIDER_FAILURE'); } }); reveal(state);
  await assert.rejects(state.coach.reply(state.match, 0, ' ', { emit() {} }), /800/);
  await assert.rejects(state.coach.reply(state.match, 0, 'x'.repeat(801), { emit() {} }), /800/);
  assert.equal(state.match.rounds[0].coachTurns, undefined);
  await assert.rejects(state.coach.reply(state.match, 0, '有效问题', { emit() {} }), /PRIVATE_PROVIDER_FAILURE/);
  assert.ok(!JSON.stringify(state.match).includes('PRIVATE_PROVIDER_FAILURE'));
  state.bank.byId.set(question.id, { ...question, images: [{ role: 'stem', path: 'assets/images/unused.png' }] });
  state.coach.config = { ...config, llm: { ...config.llm, vision: false } };
  await assert.rejects(state.coach.reply(state.match, 0, '看图', { emit() {} }), /不能读取图片/);
  assert.equal(state.match.rounds[0].coachTurns, 1);
});
