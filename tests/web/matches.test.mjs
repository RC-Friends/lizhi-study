import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService, scoreRounds } from '../../server/matches.mjs';
import { question, config, settings, result } from './fixtures.mjs';
import { ProviderError } from '../../server/providers.mjs';

const make = (provider, rows = [question], extra = {}) => {
  const bank = new QuestionBank('', rows);
  return new MatchService(bank, { ...config, ...extra }, { persist: false, providers: { llm: provider } });
};
test('no gold answers are exposed before BOTH submissions; duplicate submit is idempotent', async () => {
  let resolve, invoked = 0;
  const service = make(async () => { invoked++; return new Promise(r => { resolve = r; }); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  assert.ok(!JSON.stringify(created.match).includes('GOLD_SECRET'));
  assert.equal(created.match.current.result, null);
  assert.equal(invoked, 1, 'LLM starts at question release, before human submission');
  assert.equal(created.match.current.parallel, true);
  assert.throws(() => service.next(match, { index: 0 }), /等待双方/);
  const submitted = service.submit(match, { choice: 'D', index: 0 });
  assert.equal(submitted.current.phase, 'ai'); assert.equal(submitted.scores.completed, 0);
  assert.ok(!JSON.stringify(submitted).includes('GOLD_SECRET'));
  service.submit(match, { choice: 'D', index: 0 });
  assert.equal(invoked, 1);
  assert.throws(() => service.submit(match, { choice: 'B', index: 0 }), /已经锁定/);
  const task = service.jobs.get(match.id).task; resolve(result('A')); await task;
  const revealed = service.snapshot(match);
  assert.equal(revealed.current.result.correctAnswer, 'D');
  assert.equal(revealed.scores.human, 1); assert.equal(revealed.scores.ai, 0); assert.equal(revealed.scores.completed, 1);
  assert.ok(JSON.stringify(revealed).includes('GOLD_SECRET'));
  assert.equal(match.status, 'active');
  assert.equal(service.next(match, { index: 0 }).status, 'finished');
});
test('AI errors preserve the locked human answer and remain unscored until retry succeeds', async () => {
  let calls = 0;
  const service = make(async () => { if (++calls === 1) throw new Error('SECRET PROVIDER DETAILS'); return result('D'); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  service.submit(match, { choice: 'D', index: 0 }); await service.jobs.get(match.id).task;
  let snapshot = service.snapshot(match);
  assert.equal(snapshot.current.phase, 'error'); assert.equal(snapshot.current.humanChoice, 'D');
  assert.equal(snapshot.scores.humanAccuracy, null); assert.ok(!JSON.stringify(snapshot).includes('SECRET PROVIDER'));
  service.retry(match, { index: 0 }); await service.jobs.get(match.id).task;
  snapshot = service.snapshot(match);
  assert.equal(snapshot.scores.completed, 1); assert.equal(snapshot.scores.aiAccuracy, 100);
});
test('ending during an AI request excludes the unfinished round even if provider resolves later', async () => {
  let resolve;
  const service = make(async () => new Promise(r => { resolve = r; }));
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  service.submit(match, { choice: 'D', index: 0 });
  const task = service.jobs.get(match.id).task;
  const ended = service.finish(match); resolve(result('D')); await task;
  assert.equal(ended.scores.completed, 0); assert.equal(ended.scores.unscoredSubmissions, 1);
  assert.equal(service.snapshot(match).scores.completed, 0); assert.equal(service.snapshot(match).history.length, 0);
});
test('next question requires explicit acknowledgement and stale requests cannot advance it', async () => {
  const service = make(async () => result('D'), [question, { ...question, id: 'question_2' }]);
  const created = service.create({ ...settings, count: 2 }), match = service.authenticate(created.match.id, created.token);
  service.submit(match, { choice: 'D', index: 0 }); await service.jobs.get(match.id).task;
  assert.equal(service.snapshot(match).index, 0);
  const next = service.next(match, { index: 0 }); assert.equal(next.index, 1); assert.equal(next.current.phase, 'human');
  assert.throws(() => service.next(match, { index: 0 }), /题目已切换/);
  assert.equal(next.current.result, null);
});
test('session tokens isolate friends and never appear in public snapshots', () => {
  const service = make(async () => result('D'));
  const a = service.create(settings), b = service.create(settings);
  assert.throws(() => service.authenticate(a.match.id, b.token), /无权访问/);
  assert.ok(!JSON.stringify(a.match).includes(a.token));
  assert.ok(!JSON.stringify(a.match).includes('tokenHash'));
});
test('statistics use the same completed-round denominator, including a valid zero-round result', () => {
  assert.equal(scoreRounds([]).humanAccuracy, null);
  const scores = scoreRounds([{ phase: 'revealed', humanCorrect: true, aiCorrect: false }, { phase: 'revealed', humanCorrect: false, aiCorrect: true }, { phase: 'error', humanChoice: 'A' }]);
  assert.equal(scores.completed, 2); assert.equal(scores.humanAccuracy, 50); assert.equal(scores.aiAccuracy, 50); assert.equal(scores.unscoredSubmissions, 1);
});
test('a restart restores the question and locked answer without automatically billing again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duel-recovery-'));
  try {
    const bank = new QuestionBank('', [question]);
    const first = new MatchService(bank, { ...config, runtimePath: directory }, { providers: { llm: () => new Promise(() => {}) } });
    const created = first.create(settings), match = first.authenticate(created.match.id, created.token);
    first.submit(match, { choice: 'D', index: 0 });
    const second = new MatchService(bank, { ...config, runtimePath: directory });
    const recovered = second.snapshot(second.authenticate(match.id, created.token));
    assert.equal(recovered.current.phase, 'error'); assert.equal(recovered.current.humanChoice, 'D');
    assert.equal(second.jobs.size, 0); assert.equal(recovered.current.result, null);
    first.shutdown();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('private continuation stays only in memory while numeric progress survives refresh and a failed tool retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duel-private-continuation-'));
  const secret = 'PRIVATE_MODEL_CONTEXT'; let calls = 0;
  const bank = new QuestionBank('', [question]);
  const service = new MatchService(bank, { ...config, runtimePath: directory }, { providers: { llm: async (_q, _config, context) => {
    if (++calls === 1) {
      context.saveContinuation({ reasoning_content: secret });
      context.emit('explanation_complete', { text: '数量乘以单价得到总价。' });
      context.emit('model_progress', { stage: 'choosing', elapsedMs: 1200, chunks: 3, publicChars: 0, reasoningChars: secret.length });
      context.emit('provider_request', { stage: 'choosing', maxTokens: 2048, finishReason: 'length', usage: { completionTokens: 2048 } });
      throw new ProviderError('额度已用尽。', 'output_limit');
    }
    assert.deepEqual(context.savedContinuation, { reasoning_content: secret });
    assert.equal(context.previousRequests[0].finishReason, 'length');
    assert.equal(context.savedExplanation, '数量乘以单价得到总价。');
    return result('D');
  } } });
  try {
    const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
    const events = []; service.subscribe(match, event => events.push(event));
    service.submit(match, { choice: 'D', index: 0 }); await service.jobs.get(match.id).task;
    const snapshot = service.snapshot(match);
    assert.equal(snapshot.current.progress.chunks, 3); assert.equal(snapshot.current.canRetry, true);
    assert.equal(snapshot.scores.completed, 0);
    assert.ok(!JSON.stringify({ snapshot, events }).includes(secret));
    assert.ok(!fs.readFileSync(path.join(directory, `${match.id}.json`), 'utf8').includes(secret));
    service.retry(match, { index: 0 }); await service.jobs.get(match.id).task;
    assert.equal(service.snapshot(match).scores.completed, 1); assert.equal(service.continuations.size, 0);
  } finally { service.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('a repaired legacy image round can retry after three old attempts but cannot exceed the new token cap', () => {
  const visual = { ...question, images: [{ path: 'assets/images/test.png', role: 'stem' }] };
  const service = make(async () => result('D'), [visual]);
  const created = service.create({ ...settings, images: 'visual' }), match = service.authenticate(created.match.id, created.token);
  const round = service.current(match);
  Object.assign(round, { phase: 'error', stage: 'explaining', attempts: 3, humanChoice: 'D', error: '模型输出超过长度上限，尚未完整提交。' });
  assert.equal(service.snapshot(match).current.canRetry, true);
  assert.equal(service.snapshot(match).current.humanChoice, 'D');
  round.requests = [{ stage: 'explaining', finishReason: 'length', maxTokens: 65536 }];
  assert.equal(service.snapshot(match).current.canRetry, false);
  assert.throws(() => service.retry(match, { index: 0 }), /上限/);
});

test('AI-first answer and all streamed content stay sealed until human submits; independent clocks stop at submission', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let resolve, context, calls = 0;
  const secret = 'SEALED_MODEL_ANSWER';
  const service = make(async (_q, _config, ctx) => { calls++; context = ctx; return new Promise(r => { resolve = r; }); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  const events = []; service.subscribe(match, event => events.push(event));
  assert.equal(service.current(match).aiStartedAt, service.current(match).startedAt);
  const task = service.jobs.get(match.id).task;
  context.emit('phase', { phase: 'explaining', label: secret });
  context.emit('explanation', { text: secret });
  context.emit('transcription', { text: secret });
  context.emit('explanation_complete', { text: secret });
  context.emit('model_progress', { publicChars: 42, chunks: 10 });
  context.emit('provider_request', { stage: 'explaining', model: secret });
  t.mock.timers.tick(1200);
  resolve({ ...result('D'), explanation: secret }); await task;
  const sealed = service.snapshot(match);
  assert.equal(sealed.current.aiStatus, 'ready'); assert.equal(sealed.current.phase, 'human');
  assert.equal(sealed.current.result, null); assert.equal(sealed.current.aiMs, null);
  assert.equal(sealed.scores.completed, 0); assert.equal(sealed.history.length, 0);
  assert.equal(service.current(match).aiCorrect, undefined, 'do not grade before both submissions');
  const publicData = JSON.stringify({ sealed, events });
  for (const marker of [secret, 'GOLD_SECRET', 'submit_answer', 'aiChoice']) assert.ok(!publicData.includes(marker), marker);
  assert.equal(events.some(e => ['explanation', 'transcription', 'model_progress'].includes(e.type)), false);
  t.mock.timers.tick(3800);
  const revealed = service.submit(match, { index: 0, choice: 'A' });
  assert.equal(revealed.current.phase, 'revealed'); assert.equal(revealed.current.result.aiChoice, 'D');
  assert.equal(revealed.current.explanation, secret); assert.equal(revealed.current.result.humanMs, 5000);
  assert.equal(revealed.current.result.aiMs, 1200); assert.equal(calls, 1);
  t.mock.timers.tick(9000);
  assert.equal(service.submit(match, { index: 0, choice: 'A' }).current.result.humanMs, 5000);
  assert.equal(service.snapshot(match).history[0].aiMs, 1200);
});

test('human-first locks human time while AI continues streaming and preserves accumulated hidden explanation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let resolve, context;
  const service = make(async (_q, _config, ctx) => { context = ctx; return new Promise(r => { resolve = r; }); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  const task = service.jobs.get(match.id).task, events = []; service.subscribe(match, e => events.push(e));
  context.emit('explanation', { text: '已生成的说明。' });
  t.mock.timers.tick(800);
  const submitted = service.submit(match, { index: 0, choice: 'D' });
  assert.equal(submitted.current.phase, 'ai'); assert.equal(submitted.current.humanMs, 800);
  assert.equal(submitted.current.explanation, '已生成的说明。');
  context.emit('explanation', { text: '后续实时说明。' });
  assert.ok(events.some(e => e.type === 'explanation' && e.data.text === '后续实时说明。'));
  t.mock.timers.tick(4200); resolve(result('D')); await task;
  const revealed = service.snapshot(match);
  assert.equal(revealed.current.result.aiMs, 5000); assert.equal(revealed.current.result.humanMs, 800);
  assert.equal(revealed.history[0].parallel, true);
});

test('an AI error before human submission stays hidden, and retries add active time without counting retry wait', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let reject, resolve, calls = 0;
  const service = make(async () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  let task = service.jobs.get(match.id).task;
  t.mock.timers.tick(2000); reject(new ProviderError('先前生成的内容可能包含答案', 'output_limit')); await task;
  const hidden = service.snapshot(match);
  assert.equal(hidden.current.phase, 'human'); assert.equal(hidden.current.aiStatus, 'error');
  assert.equal(hidden.current.error, null); assert.equal(hidden.current.canRetry, false);
  t.mock.timers.tick(1000);
  const submitted = service.submit(match, { index: 0, choice: 'D' });
  assert.equal(submitted.current.phase, 'error'); assert.equal(submitted.current.canRetry, true); assert.equal(calls, 1);
  t.mock.timers.tick(7000);
  service.retry(match, { index: 0 }); task = service.jobs.get(match.id).task;
  t.mock.timers.tick(4000); resolve(result('D')); await task;
  const final = service.snapshot(match).current.result;
  assert.equal(final.humanMs, 3000); assert.equal(final.aiMs, 6000); assert.equal(final.attempts, 2);
});

test('capacity is checked before creating or advancing a parallel question; submission needs no new slot', async () => {
  let resolve;
  const service = make(async () => new Promise(r => { resolve = r; }), [question, { ...question, id: 'question_2' }], { maxConcurrent: 1 });
  const created = service.create({ ...settings, count: 2 }), match = service.authenticate(created.match.id, created.token);
  assert.throws(() => service.create(settings), e => e.code === 'arena_busy');
  assert.equal(service.matches.size, 1);
  service.submit(match, { index: 0, choice: 'D' });
  const task = service.jobs.get(match.id).task; resolve(result('D')); await task;
  const other = service.create(settings);
  assert.throws(() => service.next(match, { index: 0 }), e => e.code === 'arena_busy');
  assert.equal(match.index, 0); assert.equal(match.rounds.length, 1);
  const otherTask = service.jobs.get(other.match.id).task; resolve(result('D')); await otherTask;
  const next = service.next(match, { index: 0 });
  assert.equal(next.current.aiStatus, 'running'); assert.equal(next.current.phase, 'human');
  const nextTask = service.jobs.get(match.id).task; resolve(result('D')); await nextTask;
});

test('finish before human submits cancels parallel AI without scoring or revealing its answer', async () => {
  let resolve, signal;
  const service = make(async (_q, _config, context) => { signal = context.signal; return new Promise(r => { resolve = r; }); });
  const created = service.create(settings), match = service.authenticate(created.match.id, created.token);
  const task = service.jobs.get(match.id).task;
  const ended = service.finish(match); assert.ok(signal.aborted);
  resolve(result('D')); await task;
  assert.equal(ended.scores.completed, 0); assert.equal(ended.scores.unscoredSubmissions, 0);
  assert.equal(service.snapshot(match).current, null); assert.equal(service.snapshot(match).history.length, 0);
});

test('restart preserves a sealed completed AI answer, and marks unsubmitted interrupted work for explicit retry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duel-parallel-recovery-'));
  const bank = new QuestionBank('', [question]);
  let calls = 0;
  const provider = async () => { if (++calls === 1) return result('D'); return new Promise(() => {}); };
  const first = new MatchService(bank, { ...config, runtimePath: directory }, { providers: { llm: provider } });
  try {
    const completed = first.create(settings); await first.jobs.get(completed.match.id).task;
    const running = first.create(settings);
    const recovered = new MatchService(bank, { ...config, runtimePath: directory }, { providers: { llm: provider } });
    const readyMatch = recovered.authenticate(completed.match.id, completed.token);
    assert.equal(recovered.snapshot(readyMatch).current.aiStatus, 'ready');
    assert.equal(recovered.snapshot(readyMatch).current.result, null);
    const readyResult = recovered.submit(readyMatch, { index: 0, choice: 'D' });
    assert.equal(readyResult.current.result.aiChoice, 'D'); assert.equal(readyResult.current.result.aiTimingIncomplete, false);
    const interrupted = recovered.authenticate(running.match.id, running.token);
    const hidden = recovered.snapshot(interrupted);
    assert.equal(hidden.current.phase, 'human'); assert.equal(hidden.current.aiStatus, 'error');
    assert.equal(hidden.current.error, null); assert.equal(hidden.current.result, null);
    const submitted = recovered.submit(interrupted, { index: 0, choice: 'D' });
    assert.equal(submitted.current.errorCode, 'server_restart'); assert.equal(submitted.current.canRetry, true);
    assert.equal(recovered.current(interrupted).aiTimingIncomplete, true);
    assert.equal(recovered.jobs.size, 0); assert.equal(calls, 2);
  } finally { first.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('JEV retains its submit-then-decide flow', async () => {
  let calls = 0;
  const service = new MatchService(new QuestionBank('', [question]), config, { persist: false, providers: { jev: async () => { calls++; return result('D'); } } });
  const created = service.create({ ...settings, mode: 'jev' }), match = service.authenticate(created.match.id, created.token);
  assert.equal(calls, 0); assert.equal(created.match.current.parallel, false);
  service.submit(match, { index: 0, choice: 'D' }); await service.jobs.get(match.id).task;
  assert.equal(calls, 1); assert.equal(service.snapshot(match).current.phase, 'revealed');
});
test('human-only practice reveals once without consuming a model slot and has no fake AI score', () => {
  let calls = 0;
  const service = make(async () => { calls++; return result('D'); }, [question], { maxConcurrent: 0 });
  const created = service.create({ ...settings, mode: 'practice' }, { ownerId: 'primary' });
  const match = service.authenticate(created.match.id, created.token);
  assert.equal(match.ownerId, 'primary'); assert.equal(calls, 0);
  assert.ok(!JSON.stringify(created.match).includes('GOLD_SECRET'));
  const submitted = service.submit(match, { choice: 'D', index: 0 });
  assert.equal(submitted.current.phase, 'revealed'); assert.equal(submitted.current.result.aiChoice, null);
  assert.equal(submitted.scores.humanAccuracy, 100); assert.equal(submitted.scores.aiAccuracy, null);
  assert.equal(submitted.scores.humanOnly, null); assert.equal(submitted.history[0].submittedAt, match.rounds[0].submittedAt);
  assert.ok(submitted.history[0].completedAt); assert.equal(calls, 0);
  assert.deepEqual(service.submit(match, { choice: 'D', index: 0 }), submitted);
  assert.throws(() => service.submit(match, { choice: 'B', index: 0 }), /已经锁定/);
  assert.equal(service.next(match, { index: 0 }).status, 'finished');
});
test('practice honors the caller-owned scope and supports exact question replays', () => {
  const service = make(() => { throw new Error('No model expected'); }, [question, { ...question, id: 'second' }]);
  const created = service.create({ ...settings, mode: 'practice', scope: 'wrong', questionIds: ['second'] }, { ownerId: 'primary', allowedQuestionIds: ['second'] });
  assert.equal(created.match.current.question.id, 'second');
  assert.throws(() => service.create({ ...settings, mode: 'practice', scope: 'wrong' }), /范围无效/);
  assert.throws(() => service.create({ ...settings, mode: 'practice', scope: 'wrong', questionIds: [question.id] }, { allowedQuestionIds: ['second'] }), /不符合/);
});
test('practice pauses and resumes idempotently, excludes time away, and rejects answers while paused', () => {
  const service = make(() => { throw new Error('No model expected'); });
  const created = service.create({ ...settings, mode: 'practice' });
  const match = service.authenticate(created.match.id, created.token), round = match.rounds[0];
  round.humanResumedAt = new Date(Date.now() - 5000).toISOString();
  const paused = service.pause(match), accumulated = paused.current.humanElapsedMs;
  assert.equal(paused.current.paused, true); assert.equal(paused.current.humanTimerStartedAt, null);
  assert.ok(accumulated >= 5000 && accumulated < 5500);
  assert.deepEqual(service.pause(match), paused);
  assert.throws(() => service.submit(match, { index: 0, choice: 'D' }), /已暂停/);
  assert.equal(round.humanChoice, undefined);
  round.pausedAt = '2020-01-01T00:00:00Z'; // Returning years later does not count the absence.
  const resumed = service.resume(match);
  assert.equal(resumed.current.paused, false); assert.equal(resumed.current.humanElapsedMs, accumulated);
  assert.ok(resumed.current.humanTimerStartedAt);
  assert.deepEqual(service.resume(match), resumed);
  round.humanResumedAt = new Date(Date.now() - 2000).toISOString();
  const submitted = service.submit(match, { index: 0, choice: 'D' });
  assert.ok(submitted.current.result.humanMs >= accumulated + 2000 && submitted.current.result.humanMs < accumulated + 2500);
  assert.equal(submitted.current.humanTimerStartedAt, null);
  assert.deepEqual(service.resume(match), submitted);
});
test('paused practice survives service restart and does not alter duel clocks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-pause-'));
  try {
    const bank = new QuestionBank('', [question]), configuration = { ...config, runtimePath: directory };
    const service = new MatchService(bank, configuration);
    const created = service.create({ ...settings, mode: 'practice' });
    const match = service.authenticate(created.match.id, created.token);
    match.rounds[0].humanResumedAt = new Date(Date.now() - 3000).toISOString();
    const paused = service.pause(match);
    const recovered = new MatchService(bank, configuration);
    assert.deepEqual(recovered.snapshot(recovered.authenticate(created.match.id, created.token)), paused);
    const duel = make(async () => new Promise(() => {})), duelCreated = duel.create(settings);
    const duelMatch = duel.authenticate(duelCreated.match.id, duelCreated.token);
    assert.throws(() => duel.pause(duelMatch), /不能暂停/);
    assert.equal(duel.snapshot(duelMatch).current.paused, false); duel.shutdown();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('smart scope stores the server-computed composition and rejects unknown scopes', () => {
  const service = make(() => { throw new Error('No model expected'); }, [question, { ...question, id: 'second' }]);
  const created = service.create({ ...settings, mode: 'practice', scope: 'smart', count: 1, questionIds: [question.id] },
    { ownerId: 'primary', allowedQuestionIds: [question.id], composition: { review: 1, weak: 0, extend: 0 } });
  assert.equal(created.match.settings.scope, 'smart');
  assert.deepEqual(created.match.settings.composition, { review: 1, weak: 0, extend: 0 });
  assert.equal(created.match.current.question.id, question.id);
  assert.throws(() => service.create({ ...settings, mode: 'practice', scope: 'hunch' }, { ownerId: 'primary', allowedQuestionIds: [question.id] }), /范围无效/);
  const plain = service.create({ ...settings, mode: 'practice' }, { ownerId: 'primary', allowedQuestionIds: [question.id] });
  assert.equal('composition' in plain.match.settings, false);
});
