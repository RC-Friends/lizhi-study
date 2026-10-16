import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createApp } from '../../server/app.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { question, config, settings } from './fixtures.mjs';

// Self-contained synthetic materials: no real bank, saved account or provider.
const rows = [['a', 3], ['b', 2]].flatMap(([key, count]) => Array.from({ length: count }, (_, i) => ({
  ...question, id: `${key}_${i}`, material_id: key, material: `材料 ${key}`,
  material_html: Array.from({ length: 40 }, (_, j) => `<p>材料 ${key} 第 ${j + 1} 段：这是一份用于验收连续作答的合成材料，可上下翻阅并对照小题。</p>`).join(''),
  stem_html: `<p>材料 ${key} 的第 ${i + 1} 小题：两本练习册共多少钱？</p>`,
})));
const bank = new QuestionBank(null, rows);
const isolated = { ...config, llm: { key: '' }, jev: { key: '' }, vision: { key: '', enabled: false } };
const service = new MatchService(bank, isolated, { persist: false });
const app = createApp(bank, service, isolated);
const candidates = [process.env.BROWSER_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
for (const folder of await fs.readdir(path.join(os.homedir(), '.cache/ms-playwright')).catch(() => [])) {
  if (folder.startsWith('chromium-')) candidates.push(path.join(os.homedir(), '.cache/ms-playwright', folder, 'chrome-linux64/chrome'));
}
let executablePath;
for (const candidate of candidates.filter(Boolean)) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
if (!executablePath) throw new Error('Set BROWSER_PATH to an installed Chromium/Chrome executable.');
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const output = path.resolve('test-results/materials'); await fs.mkdir(output, { recursive: true });
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    try {
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.getByRole('button', { name: '考生登录', exact: true }).click();
      await page.getByLabel('学习口令', { exact: true }).fill(isolated.sitePassword);
      await page.getByRole('button', { name: '进入我的学习中心' }).click();
      await page.locator('.lh-user').waitFor();
      const token = await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token);
      const headers = { Authorization: `Bearer ${token}` };
      await page.locator('.lh-sidebar nav button').filter({ hasText: '开始练习' }).click();
      await page.getByRole('spinbutton', { name: '自定义题量' }).fill('1');
      await page.locator('.lh-availability').filter({ hasText: '当前条件可出' }).waitFor();
      assert.ok((await page.locator('.lh-count-field').innerText()).includes('材料题整组抽取'));
      await page.locator('.lh-setup-bottom').getByRole('button', { name: '开始练习', exact: true }).click();
      await page.locator('.material-panel').waitFor();
      const normalId = new URL(page.url()).hash.slice('#match/'.length);
      const normal = await (await context.request.get(`${base}/api/matches/${normalId}`, { headers })).json();
      assert.ok(normal.count === 2 || normal.count === 3); assert.equal(normal.settings.requestedCount, 1);
      await context.request.post(`${base}/api/matches/${normalId}/finish`, { headers, data: {} });

      const response = await context.request.post(`${base}/api/matches`, { headers,
        data: { ...settings, mode: 'practice', count: 2, questionIds: ['a_1', 'b_0'] } });
      assert.equal(response.status(), 201);
      const { match } = await response.json(); assert.equal(match.count, 5);
      await page.goto(`${base}/#match/${match.id}`);
      await page.locator('.material-panel summary').filter({ hasText: '第 1 / 3 小题' }).waitFor();
      await page.locator('.material-panel .rich-text').evaluate(el => { el.scrollTop = 220; window.__materialNode = el; });
      for (let i = 0; i < 3; i++) {
        await page.locator('.material-panel summary').filter({ hasText: `第 ${i + 1} / 3 小题` }).waitFor();
        if (i > 0) {
          assert.ok(await page.locator('.material-panel .rich-text').evaluate(el => el === window.__materialNode));
          assert.equal(await page.locator('.material-panel .rich-text').evaluate(el => el.scrollTop), 220);
        }
        if (i === 1) {
          assert.ok(await page.locator('.material-panel .rich-text').innerText().then(value => value.includes('材料 a')));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          await page.screenshot({ path: path.join(output, `${name}-same-material.png`), fullPage: true });
        }
        if (i === 2) await page.locator('.material-panel summary').click();
        await page.locator('.answer-option').nth(3).click();
        await page.getByRole('button', { name: '提交答案，看解析', exact: true }).click();
        await page.getByRole('button', { name: '确认，下一题', exact: true }).click();
      }
      await page.locator('.material-panel summary').filter({ hasText: '第 1 / 2 小题' }).waitFor();
      assert.ok(await page.locator('.material-panel').evaluate(el => el.open));
      assert.equal(await page.locator('.material-panel .rich-text').evaluate(el => el.scrollTop), 0);
      assert.ok((await page.locator('.material-panel .rich-text').innerText()).includes('材料 b'));
      await page.reload();
      await page.locator('.material-panel summary').filter({ hasText: '第 1 / 2 小题' }).waitFor();
      for (let i = 0; i < 2; i++) {
        await page.locator('.answer-option').nth(3).click();
        await page.getByRole('button', { name: '提交答案，看解析', exact: true }).click();
        await page.getByRole('button', { name: i ? '完成练习，查看报告' : '确认，下一题', exact: true }).click();
      }
      await page.locator('.report-page').waitFor();
      assert.equal(await page.locator('.review-item').count(), 5);
      console.log(`${name}: whole-material draw, adjusted counts, all 5 answers, retained reading position, new-material reset and refresh passed`);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true });
      console.error(JSON.stringify({ browserErrors: errors, page: await page.locator('body').innerText() }));
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); app.locals.coach.shutdown(); service.shutdown(); server.closeAllConnections(); server.close();
}
