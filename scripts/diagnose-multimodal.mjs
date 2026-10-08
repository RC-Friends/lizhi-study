// Explicit, paid diagnostic. Stores only public output and numeric stream metadata.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadConfig } from '../server/config.mjs';
import { QuestionBank, questionImages } from '../server/bank.mjs';
import { runLlm } from '../server/providers.mjs';

const id = process.argv.find(v => v.startsWith('--question='))?.split('=')[1];
if (!id) throw new Error('Pass --question=<id>. This command makes real model requests.');
const config = loadConfig();
const question = new QuestionBank(config.dataPath).byId.get(id);
if (!question) throw new Error('Unknown question ID.');
const budget = Number(process.argv.find(v => v.startsWith('--budget='))?.split('=')[1]) || null;
if (budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 65536)) throw new Error('Budget must be an integer from 1 to 65536.');
const profile = 'production';
const started = Date.now();
const report = { questionId: id, checkedAt: new Date().toISOString(), profile, budget,
  images: questionImages(question).map(i => ({ path: i.path, width: i.width, height: i.height, role: i.role })), requests: [] };
const fetcher = async (url, init) => {
  const body = JSON.parse(init.body);
  if (budget && !body.tools) body.max_tokens = budget;
  const stage = body.tools ? 'tool' : 'explanation';
  const entry = { stage, maxTokens: body.max_tokens, startedMs: Date.now() - started, chunks: 0,
    publicChars: 0, reasoningChars: 0, fields: [], finishReason: null, usage: null };
  report.requests.push(entry);
  const response = await fetch(url, { ...init, body: JSON.stringify(body) });
  entry.status = response.status;
  if (!response.ok) return response;
  const decoder = new TextDecoder(); let buffer = '', lastNotice = 0;
  const examine = block => {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { return; }
    const choice = event.choices?.[0], delta = choice?.delta || {};
    entry.chunks++;
    entry.fields = [...new Set([...entry.fields, ...Object.keys(delta)])];
    entry.model = event.model || entry.model;
    if (typeof delta.content === 'string') entry.publicChars += delta.content.length;
    for (const field of ['reasoning', 'reasoning_content']) if (typeof delta[field] === 'string') entry.reasoningChars += delta[field].length;
    if (choice?.finish_reason) entry.finishReason = choice.finish_reason;
    if (event.usage) entry.usage = { promptTokens: event.usage.prompt_tokens,
      completionTokens: event.usage.completion_tokens, reasoningTokens: event.usage.completion_tokens_details?.reasoning_tokens };
    entry.elapsedMs = Date.now() - started - entry.startedMs;
    if (entry.elapsedMs - lastNotice > 15000) { console.log(JSON.stringify({ stage, elapsedMs: entry.elapsedMs, publicChars: entry.publicChars, reasoningChars: entry.reasoningChars })); lastNotice = entry.elapsedMs; }
  };
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let at; while ((at = buffer.indexOf('\n\n')) >= 0) { examine(buffer.slice(0, at)); buffer = buffer.slice(at + 2); }
      controller.enqueue(chunk);
    }, flush() { if (buffer.trim()) examine(buffer); },
  })), { status: response.status, headers: response.headers });
};
try {
  const result = await runLlm(question, { ...config.llm, timeout: 300000 }, {
    signal: AbortSignal.timeout(420000), fetcher, emit: (type, data) => {
      if (type === 'phase') console.log(data.label);
      if (type === 'explanation_complete') report.explanation = data.text;
    },
  });
  report.passed = true;
  report.result = { choice: result.choice, tool: result.tool, model: result.model, explanation: result.explanation };
} catch (error) { report.passed = false; report.errorCode = error.code || error.name; process.exitCode = 1; }
report.elapsedMs = Date.now() - started;
const filename = path.join(ROOT, 'data/runtime', `multimodal-${id}-${profile}-${Date.now()}.json`);
await fs.writeFile(filename, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
