import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, providerCatalog, ROOT } from '../server/config.mjs';
import { questionImages } from '../server/bank.mjs';
import { runLlm } from '../server/providers.mjs';
import { loadQuestionResources } from '../server/resource-loader.mjs';

const config = loadConfig(), { bank, resources } = await loadQuestionResources(config), providers = providerCatalog(config);
console.log(JSON.stringify({ node: process.version, questions: bank.rows.length, providers,
  frontendBuilt: await fs.access(path.join(ROOT, 'dist/index.html')).then(() => true).catch(() => false) }, null, 2));
if (!process.argv.includes('--live')) {
  console.log('Offline checks complete. Add --live to call the configured LLM on one text and, if enabled, one image question (two API calls per question).');
  resources?.close(); process.exit(0);
}
if (!providers.llm.ready) throw new Error('Configure LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env.local first.');
const textQuestion = bank.rows.find(q => q.source_type === '模拟题' && q.module === '数量关系' && !questionImages(q).length);
const imageQuestion = bank.byId.get('xc_18c98ee1e5279b9de2856871');
const report = { checkedAt: new Date().toISOString(), provider: config.llm.model,
  generation: { thinking: config.llm.thinking || 'provider_default', reasoningEffort: config.llm.reasoningEffort || 'provider_default', maxTokens: config.llm.maxTokens, toolMaxTokens: config.llm.toolMaxTokens },
  tests: [], jev: 'Not called: needs its own credentials.' };
const questionId = process.argv.find(arg => arg.startsWith('--question='))?.slice('--question='.length);
if (questionId && !bank.byId.has(questionId)) throw new Error('Unknown question ID.');
const candidates = questionId ? [bank.byId.get(questionId)] : process.argv.includes('--image-only') ? [imageQuestion] : [textQuestion, ...(providers.llm.vision ? [imageQuestion] : [])];
await fs.mkdir(path.join(ROOT, 'data/runtime'), { recursive: true });
for (const q of candidates.filter(Boolean)) {
  const started = Date.now(), events = []; let characters = 0;
  let explanation = '';
  try {
  const result = await runLlm(q, config.llm, { signal: AbortSignal.timeout(240000),
    emit: (type, data) => {
      events.push({ type, elapsedMs: Date.now() - started });
      if (type === 'explanation') characters += data.text.length;
      if (type === 'explanation_complete') explanation = data.text;
      if (type === 'phase') console.log(`${q.id}: ${data.label}`);
    } });
  const check = { questionId: q.id, hasImages: questionImages(q).length > 0,
    passed: Boolean(result.tool?.name === 'submit_answer' && events.some(e => e.type === 'explanation') && characters > 10),
    elapsedMs: Date.now() - started, model: result.model, streamChunks: events.filter(e => e.type === 'explanation').length,
    firstTextMs: events.find(e => e.type === 'explanation')?.elapsedMs, choice: result.choice,
    referenceAnswer: q.answer[0], correct: result.choice === q.answer[0], tool: result.tool,
    explanation: result.explanation, events };
  report.tests.push(check);
  console.log(JSON.stringify({ questionId: check.questionId, passed: check.passed, hasImages: check.hasImages,
    elapsedMs: check.elapsedMs, firstTextMs: check.firstTextMs, streamChunks: check.streamChunks, choice: check.choice, correct: check.correct }));
  } catch (error) {
    const failed = { questionId: q.id, passed: false, hasImages: questionImages(q).length > 0,
      elapsedMs: Date.now() - started, code: error.code || 'connection_error', explanation, events };
    report.tests.push(failed); console.error(JSON.stringify({ questionId: failed.questionId, passed: false, code: failed.code }));
  }
  await fs.writeFile(path.join(ROOT, 'data/runtime/live-check.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
resources?.close();
if (report.tests.some(test => !test.passed)) process.exitCode = 1;
console.log('Saved public explanations and verification results to data/runtime/live-check.json. No credentials are included.');
