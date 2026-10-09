import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createApp } from '../../server/app.mjs';
import { MatchService } from '../../server/matches.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { KnowledgeService } from '../../server/knowledge.mjs';
import { config as fixture, question } from './fixtures.mjs';
import { checkAdministration } from './admin-e2e.mjs';

// Every model request terminates in this synthetic, loopback-only provider.
// No .env files, operator data or paid services are read by this test.
let faults = {}, embeddingCalls = 0, rerankCalls = 0;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), kind = req.url.endsWith('/embeddings') ? 'embedding' : req.url.endsWith('/rerank') ? 'rerank' : 'llm';
  if (faults[kind] === 'timeout') return;
  if (faults[kind] === 'http') { res.writeHead(503); res.end('{}'); return; }
  if (faults[kind] === 'malformed') { res.end('{invalid'); return; }
  if (kind === 'embedding') {
    embeddingCalls++;
    res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: text.includes('相遇') || text.includes('迎面') ? [1, 0] : [0, 1] })) })); return;
  }
  if (kind === 'rerank') {
    rerankCalls++; assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ results: body.documents.map((text, index) => ({ index, relevance_score: text.includes('相遇') ? 0.95 : 0.1 })) })); return;
  }
  const testing = body.messages.some(message => typeof message.content === 'string' && message.content.includes('连接成功'));
  const count = Number(body.messages.at(-1).content.match(/命制 (\d+) 道/)?.[1] || 3);
  const questions = Array.from({ length: count }, (_, index) => ({
    stem: `甲乙两人相距120千米，同时相向而行，速度各为30千米每小时。多久相遇？（练习${index + 1}）`,
    options: { A: '2小时', B: '3小时', C: '4小时', D: '5小时' }, answer: 'A',
    analysis: '相遇时间等于初始距离除以速度和。120÷(30+30)=2小时。', knowledgePoints: ['相遇问题'], source: 'K1',
  }));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: testing ? '连接成功' : JSON.stringify(questions) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const modelEndpoint = `http://127.0.0.1:${provider.address().port}/v1`;
const config = { ...fixture, adminPassword: 'browser-independent-admin-password', serveFrontend: true,
  llm: { ...fixture.llm, baseUrl: modelEndpoint, model: 'synthetic-chat' } };
const bank = new QuestionBank('', [question]), matches = new MatchService(bank, config, { persist: false });
const knowledge = new KnowledgeService(config, { persist: false }), library = knowledge.createLibrary({ name: '验收用公式笔记' }, 'primary');
knowledge.upload({ libraryId: library.id, title: '行程公式', format: 'markdown', content: '# 相遇问题\n相遇时间等于初始距离除以速度和。\n# 追及问题\n追及时间等于距离差除以速度差。' }, 'primary');
const app = createApp(bank, matches, config, { knowledge }), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const candidates = [process.env.BROWSER_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
try { for (const directory of await fs.readdir(path.join(os.homedir(), '.cache/ms-playwright'))) if (directory.startsWith('chromium-')) candidates.push(path.join(os.homedir(), '.cache/ms-playwright', directory, 'chrome-linux64/chrome')); } catch {}
let executablePath;
for (const file of candidates) try { await fs.access(file); executablePath = file; break; } catch {}
await fs.mkdir('test-results', { recursive: true });
const screenshots = [], errors = [];
let browser, page;
const screenshot = async (target, name) => {
  assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
  await target.screenshot({ path: `test-results/rag-${name}.png`, fullPage: true }); screenshots.push(name);
};
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  await checkAdministration({ browser, base, modelEndpoint, adminPassword: config.adminPassword, learnerPassword: config.sitePassword, screenshot });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await page.goto(base); await page.getByRole('button', { name: '站点管理', exact: true }).click();
  await page.getByLabel('超级管理员口令', { exact: true }).fill(config.adminPassword); await page.getByRole('button', { name: '进入管理面板', exact: true }).click();
  await page.getByRole('navigation', { name: '站点管理导航' }).getByRole('button', { name: '模型配置', exact: true }).click();
  for (const name of ['Embedding 检索', 'Rerank 重排']) {
    await page.getByRole('button', { name, exact: true }).click();
    const advanced = page.locator('.admin-model-advanced'); if (!await advanced.evaluate(element => element.open)) await advanced.locator('summary').click();
    await page.locator('#model-timeout').fill('1000'); await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  }
  const cases = [
    { faults: { embedding: 'http' }, mode: 'keyword', ranked: true },
    { faults: { rerank: 'malformed' }, mode: 'hybrid', ranked: false },
    { faults: { embedding: 'timeout', rerank: 'timeout' }, mode: 'keyword', ranked: false },
  ];
  for (const [index, check] of cases.entries()) {
    faults = check.faults; await page.getByLabel('试着问一句', { exact: true }).fill(`相遇问题故障验收${index}`);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kb/search');
    await page.getByRole('button', { name: '检索资料', exact: true }).click(); const result = await (await response).json();
    assert.equal(result.mode, check.mode); assert.equal(result.rerank.applied, check.ranked); assert.ok(result.items.length > 0);
    if (check.faults.embedding) { assert.equal(result.fallback, 'unavailable'); await page.getByText('向量服务暂时不可用，本次已使用关键词检索。', { exact: true }).waitFor(); }
    if (check.faults.rerank) { assert.equal(result.rerank.fallback, 'unavailable'); await page.getByText('重排服务暂时不可用，本次保留检索原排序。', { exact: true }).waitFor(); }
    await screenshot(page, `mobile-fallback-${index}`);
  }
  assert.deepEqual(errors, []); assert.ok(embeddingCalls > 0); assert.ok(rerankCalls > 0);
  const result = { passed: true, combinations: 4, faultCombinations: 3, screenshots, pageErrors: errors, paidModelCalls: 0 };
  await fs.writeFile('test-results/rag-results.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: 'test-results/rag-failure.png', fullPage: true }).catch(() => {});
  await fs.writeFile('test-results/rag-failure.json', JSON.stringify({ error: error.message, pageErrors: errors }, null, 2)); throw error;
} finally {
  await browser?.close(); await app.locals.retrieval.close(); matches.shutdown(); app.locals.coach.shutdown();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
}
