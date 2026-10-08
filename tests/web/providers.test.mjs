import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { question, config, streamingResponse } from './fixtures.mjs';
import { questionState, runLlm, runJev, PublicTextFilter, sseData, validateToolCall, validateJevResponse, streamCompletion, llmBudgets } from '../../server/providers.mjs';

test('model inputs exclude answer key, reference explanation, human choice and analysis images', () => {
  const input = questionState({ ...question, humanChoice: 'HUMAN_SECRET', images: [{ role: 'analysis', path: 'assets/images/secret.png' }] });
  assert.deepEqual(Object.keys(input).sort(), ['material', 'module', 'options', 'question']);
  assert.ok(!JSON.stringify(input).includes('GOLD_SECRET'));
  assert.ok(!JSON.stringify(input).includes('HUMAN_SECRET'));
  assert.ok(!JSON.stringify(input).includes('secret.png'));
});
test('stream parser handles fragmented UTF-8 and CRLF boundaries', async () => {
  const response = streamingResponse([{ content: '你好，模型。' }, '[DONE]'], { crlf: true, split: true });
  const values = []; for await (const value of sseData(response.body)) values.push(value);
  assert.equal(JSON.parse(values[0]).content, '你好，模型。'); assert.equal(values[1], '[DONE]');
});
test('private think blocks are omitted even when their delimiters cross chunks', () => {
  const filter = new PublicTextFilter();
  const shown = ['公开说明。<thi', 'nk>私密推理', '</th', 'ink>可核验结论。'].map(t => filter.push(t)).join('') + filter.push('', true);
  assert.equal(shown, '公开说明。可核验结论。');
});
test('LLM streams a public explanation before committing a validated tool call', async () => {
  const calls = [], events = [];
  const fetcher = async (url, request) => {
    const body = JSON.parse(request.body); calls.push({ url, body });
    assert.ok(!request.body.includes('GOLD_SECRET'));
    if (calls.length === 1) return streamingResponse([
      { model: 'resolved-model', choices: [{ delta: { reasoning_content: 'HIDDEN_REASONING' } }] },
      { choices: [{ delta: { content: '先确认数量与单价，' } }] },
      { choices: [{ delta: { content: '用数量乘以单价得到总价。' }, finish_reason: 'stop' }] }, '[DONE]',
    ], { split: true });
    return streamingResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'submit_answer', arguments: '{"cho' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ice":"D"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]);
  };
  const result = await runLlm(question, { ...config.llm, reasoningEffort: 'low' }, { signal: new AbortController().signal, fetcher, emit: (type, data) => events.push({ type, data }) });
  assert.equal(result.choice, 'D'); assert.equal(result.tool.name, 'submit_answer');
  assert.equal(calls.length, 2); assert.ok(!calls[0].body.tools); assert.equal(calls[1].body.tool_choice.function.name, 'submit_answer');
  assert.equal(calls[1].body.max_tokens, 2048, 'tool phase needs room for reasoning-model token overhead');
  assert.ok(calls.every(call => call.body.reasoning_effort === 'low'));
  assert.equal(calls[1].body.messages[2].reasoning_content, 'HIDDEN_REASONING', 'the tool phase reuses the model continuation');
  assert.ok(events.some(e => e.type === 'explanation'));
  assert.ok(events.findIndex(e => e.type === 'explanation_complete') < events.findIndex(e => e.data.phase === 'choosing'));
  assert.ok(!JSON.stringify(events).includes('HIDDEN_REASONING'));
});
test('retrying a failed tool phase reuses the completed public explanation without billing for it again', async () => {
  let requests = 0;
  const explanation = '数量乘以单价即可得到总价，题目给出的条件已经足够。';
  const result = await runLlm(question, config.llm, { savedExplanation: explanation,
    signal: new AbortController().signal, emit: () => {}, fetcher: async (_url, request) => {
      requests++;
      const body = JSON.parse(request.body);
      assert.equal(body.messages[2].role, 'user', 'restart fallback must not fabricate an incomplete reasoning-model assistant turn');
      assert.ok(body.messages[2].content.includes(explanation));
      assert.ok(body.tools);
      return streamingResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'submit_answer', arguments: '{"choice":"D"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
    } });
  assert.equal(requests, 1); assert.equal(result.choice, 'D');
});
test('image budgets and explicit retries allow reasoning tokens, grow only the exhausted phase, and have a cap', () => {
  const visual = { ...question, images: [{ role: 'stem', path: 'assets/images/example.png' }] };
  assert.deepEqual(llmBudgets(visual, config.llm), { explaining: 32768, choosing: 8192 });
  assert.deepEqual(llmBudgets(question, config.llm), { explaining: 1000, choosing: 2048 });
  const history = [{ stage: 'choosing', finishReason: 'length', maxTokens: 8192 }];
  assert.deepEqual(llmBudgets(visual, config.llm, history), { explaining: 32768, choosing: 16384 });
  history.push({ stage: 'explaining', finishReason: 'length', maxTokens: 65536 });
  assert.equal(llmBudgets(visual, config.llm, history).explaining, 65536);
  assert.equal(llmBudgets(visual, config.llm, [{ stage: 'explaining', errorCode: 'upstream_502', maxTokens: 32768 }]).explaining, 32768);
});
test('reasoning-only streams report numeric progress and output-limit diagnostics without exposing private text', async () => {
  const progress = [], diagnostics = [];
  const secret = 'MODEL_PRIVATE_CONTENT';
  await assert.rejects(streamCompletion(config.llm, { max_tokens: 8192 }, {
    signal: new AbortController().signal, onProgress: data => progress.push(data), onDiagnostics: data => diagnostics.push(data),
    fetcher: async () => streamingResponse([
      { choices: [{ delta: { reasoning_content: secret } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 436, completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } } }, '[DONE]',
    ]),
  }), error => error.code === 'output_limit' && error.diagnostics.usage.reasoningTokens === 8192);
  assert.ok(progress[0].chunks > 0); assert.equal(progress[0].publicChars, 0);
  assert.equal(diagnostics[0].maxTokens, 8192); assert.equal(diagnostics[0].finishReason, 'length');
  assert.ok(!JSON.stringify({ progress, diagnostics }).includes(secret));
});
test('retrying the tool phase can keep its private continuation without sending it to the UI', async () => {
  const secret = 'PRIVATE_CONTINUATION', events = [];
  const result = await runLlm(question, config.llm, {
    savedExplanation: '公开说明已经计算出两本书的总价。', savedContinuation: { reasoning_content: secret },
    signal: new AbortController().signal, emit: (type, data) => events.push({ type, data }),
    fetcher: async (_url, init) => {
      assert.equal(JSON.parse(init.body).messages[2].reasoning_content, secret);
      return streamingResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'submit_answer', arguments: '{"choice":"D"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
    },
  });
  assert.equal(result.choice, 'D'); assert.ok(!JSON.stringify({ result, events }).includes(secret));
});
test('image questions send local image bytes only to the vision helper, then text to JEV with separate credentials', async t => {
  const imagesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xingce-provider-image-'));
  t.after(() => fs.rmSync(imagesPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(imagesPath, 'fixture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const actualPath = 'assets/images/fixture.png';
  const imageQuestion = { ...question, stem: `根据表格选择。![图](${actualPath})`,
    images: [{ role: 'stem', path: actualPath }, { role: 'analysis', path: 'assets/images/DO_NOT_READ.png' }] };
  const calls = [], events = [];
  const response = await runJev(imageQuestion, { ...config, imagesPath }, { signal: new AbortController().signal,
    emit: (type, data) => events.push({ type, data }), fetcher: async (url, request) => {
      calls.push({ url, body: JSON.parse(request.body), auth: request.headers.Authorization });
      if (calls.length === 1) return streamingResponse([{ choices: [{ delta: { content: '图片 1 为包含金属粉尘数值的表格。' }, finish_reason: 'stop' }] }, '[DONE]']);
      return Response.json({ model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice: 'D', probabilities: { A: .1, B: .1, C: .1, D: .7 }, confidence: .8 } } });
    } });
  assert.ok(calls[0].body.messages[1].content.some(part => part.image_url?.url.startsWith('data:image/png;base64,')));
  assert.equal(calls[0].body.messages[1].content.find(part => part.image_url).image_url.detail, 'high');
  assert.equal(calls[0].auth, `Bearer ${config.vision.key}`); assert.equal(calls[1].auth, `Bearer ${config.jev.key}`);
  assert.ok(!JSON.stringify(calls[1].body).includes('base64'));
  assert.ok(calls[1].body.state.visual_transcription.includes('图片 1'));
  assert.ok(events.some(event => event.type === 'transcription'));
  assert.equal(response.visualAssisted, true); assert.equal(response.explanation, '');
});
test('a plain prose answer, invalid option, or multiple tool calls cannot be scored', () => {
  assert.throws(() => validateToolCall([], question.options), /没有通过/);
  assert.throws(() => validateToolCall([{ name: 'submit_answer', arguments: '{"choice":"Z"}' }], question.options), /无效选项/);
  assert.throws(() => validateToolCall([{ name: 'submit_answer', arguments: '{"choice":"D","extra":true}' }], question.options), /无效选项/);
  assert.throws(() => validateToolCall([{ name: 'submit_answer', arguments: '{' }], question.options), /JSON/);
});
test('interrupted or non-streamed provider output is rejected', async () => {
  const context = { signal: new AbortController().signal, fetcher: async () => streamingResponse([{ choices: [{ delta: { content: '还没写完' } }] }]) };
  await assert.rejects(streamCompletion(config.llm, {}, context), /响应中断/);
  await assert.rejects(streamCompletion(config.llm, {}, { ...context, fetcher: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }), /没有返回流式/);
});
test('JEV uses the official native Choice contract, no chat endpoint or fake narration', async () => {
  let sent;
  const fetcher = async (url, options) => {
    sent = { url, request: JSON.parse(options.body) };
    return Response.json({ model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice: 'D', probabilities: { A: .1, B: .1, C: .1, D: .7 }, confidence: .8 } } });
  };
  const events = [];
  const response = await runJev(question, config, { signal: new AbortController().signal, fetcher, emit: (t, data) => events.push({ t, data }) });
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.request.questions.answer.type, 'choice');
  assert.deepEqual(sent.request.questions.answer.criteria, question.options);
  assert.ok(!JSON.stringify(sent.request).includes('GOLD_SECRET'));
  assert.equal(response.choice, 'D'); assert.equal(response.tool.origin, 'jev_choice_adapter');
  assert.equal(response.explanation, ''); assert.ok(events.every(event => event.t !== 'explanation'));
});
test('JEV validates all option probabilities and confidence', () => {
  const body = { answers: { answer: { type: 'choice', choice: 'A', confidence: .8, probabilities: { A: .2, B: .2, C: .2, D: .2 } } } };
  assert.throws(() => validateJevResponse(body, question.options), /概率分布/);
  body.answers.answer.probabilities.A = .4;
  assert.equal(validateJevResponse(body, question.options).choice, 'A');
  body.answers.answer.confidence = 5;
  assert.throws(() => validateJevResponse(body, question.options), /置信度/);
});
