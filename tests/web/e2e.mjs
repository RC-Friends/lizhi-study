import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { createApp } from '../../server/app.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { CoachService } from '../../server/coach.mjs';
import { loadConfig, ROOT } from '../../server/config.mjs';
import { runDemo } from '../../server/providers.mjs';
import { openStorage } from '../../server/storage.mjs';
import { loadQuestionResources } from '../../server/resource-loader.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const output = path.join(ROOT, 'test-results');
await fs.mkdir(output, { recursive: true });
const candidates = [process.env.BROWSER_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
for (const folder of await fs.readdir(path.join(os.homedir(), '.cache/ms-playwright')).catch(() => [])) if (folder.startsWith('chromium-')) candidates.push(path.join(os.homedir(), '.cache/ms-playwright', folder, 'chrome-linux64/chrome'));
let executablePath;
for (const candidate of candidates.filter(Boolean)) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
if (!executablePath) throw new Error('Set BROWSER_PATH to an installed Chromium/Chrome executable.');

// No production account, state, provider or gateway is reachable from this test.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xingce-browser-'));
const password = `browser-${crypto.randomBytes(18).toString('hex')}`;
const databaseUrl = process.env.E2E_DATABASE_URL || '';
if (databaseUrl && !new URL(databaseUrl).pathname.startsWith('/xingce_test')) throw new Error('E2E_DATABASE_URL must use an isolated xingce_test* database.');
const config = loadConfig({ sitePassword: password, jwtSecret: crypto.randomBytes(48).toString('hex'), jwtTtlSeconds: 86400,
  storageDriver: databaseUrl ? 'postgres' : 'files', databaseUrl,
  profileName: '浏览器验收同学', runtimePath: path.join(temporary, 'matches'), learningPath: path.join(temporary, 'learning.json'),
  publicUrl: '', trustProxy: false,
  llm: { model: 'browser-test-model', key: 'test-only', baseUrl: 'https://invalid.example/v1', vision: true },
  jev: { model: 'jev-latest', key: '' }, vision: { enabled: true, key: 'test-only', model: 'browser-test' } });
const { bank, resources } = await loadQuestionResources(config);
let forbiddenCalls = 0, coachCalls = 0;
const blocked = async () => { forbiddenCalls++; throw new Error('Real model calls are forbidden in browser tests'); };
const demo = async (question, mode, context) => {
  if (mode === 'llm') {
    context.emit('phase', { phase: 'explaining', label: '演示等待阶段' });
    context.emit('model_progress', { stage: 'explaining', elapsedMs: 100, chunks: 3, publicChars: 0, reasoningChars: 20 });
    await delay(3000, undefined, { signal: context.signal });
  }
  return runDemo(question, mode, context);
};
let storage = await openStorage(config, bank);
let service = new MatchService(bank, config, { storage, providers: { llm: blocked, jev: blocked, demo } });
let coach = new CoachService(bank, service, config, { provider: async (_config, _payload, context) => {
  coachCalls++;
  const content = '这是浏览器测试的隔离陪练回复。咱们先圈出题目的限制条件，再对照解析复盘。';
  context.onText(content.slice(0, 16)); await delay(150); context.onText(content.slice(16)); return { content };
} });
let app = createApp(bank, service, config, { coach });
let server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const errors = [], failures = [], checks = [], expectedFailures = [];
let currentPage;
const watch = page => {
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400 || response.url().endsWith('/favicon.ico')) return;
    const entry = `${response.status()} ${new URL(response.url()).pathname}`;
    if (entry === '401 /api/login') expectedFailures.push(entry); else failures.push(entry);
  });
};
const visible = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible' });
const nav = (page, name) => page.locator('.lh-sidebar nav').getByRole('button', { name });
async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    culprits: [...document.querySelectorAll('body *')].filter(e => { const box = e.getBoundingClientRect(); return box.width && box.right > innerWidth + 2 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 8).map(e => e.className) }));
  assert.ok(overflow.scroll <= overflow.width + 1, `${label}: ${JSON.stringify(overflow)}`);
}
async function snapshot(page, name) { currentPage = page; await noOverflow(page, name); await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); }
async function state(page) {
  return page.evaluate(async () => {
    const session = JSON.parse(localStorage.getItem('xingce-study.session.v1'));
    const id = location.hash.split('/')[1];
    return (await fetch(`/api/matches/${id}`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
  });
}
async function login(page) {
  await page.getByRole('button', { name: '考生登录', exact: true }).click();
  await page.getByLabel('学习口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入我的学习中心' }).click();
  await visible(page, '.lh-user');
}
async function home(page) {
  const report = page.locator('.report-actions').getByRole('button', { name: '返回学习中心', exact: true });
  if (await report.count()) await report.click();
  else await page.locator('.brand').click();
  await visible(page, '.lh-welcome');
}
async function setup(page, { mode = 'practice', count = 1, images = 'text', demo = false } = {}) {
  await nav(page, '开始练习').click();
  await visible(page, '.lh-setup');
  if (mode !== 'practice') await page.locator('.lh-mode-card').filter({ hasText: mode === 'llm' ? '与小栗对战' : 'JEV 决策模型' }).click();
  if (demo) await page.getByRole('switch', { name: '演示模式' }).click();
  await page.getByRole('spinbutton', { name: '自定义题量' }).fill(String(count));
  await page.getByLabel('图文类型', { exact: true }).selectOption(images);
  await page.locator('.lh-availability').filter({ hasText: '当前条件可出' }).waitFor();
}
async function start(page, demo = false) {
  await page.locator('.lh-setup-bottom').getByRole('button', { name: demo ? '开始演示对战' : '开始练习', exact: true }).click();
  await visible(page, '.question-stem');
}
async function answer(page, choice, button) {
  await page.locator('.answer-option').nth('ABCD'.indexOf(choice)).locator('.option-letter').click();
  await page.getByRole('button', { name: button, exact: true }).click();
}
async function zoomQuestion(page) {
  const standalone = page.locator('.question-stem img,.material-panel img');
  if (await standalone.count()) await standalone.first().click();
  else if (await page.locator('.option-zoom').count()) await page.locator('.option-zoom').first().click();
  else await page.locator('.question-card img').first().click();
  await visible(page, '.image-dialog[open]');
}
async function imagesLoaded(page) { await page.waitForFunction(() => [...document.querySelectorAll('.question-card img')].length && [...document.querySelectorAll('.question-card img')].every(img => img.complete && img.naturalWidth > 0)); }
const privateNote = 'PRIVATE_E2E_NOTE_57：先圈出限制条件。';
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); currentPage = page; watch(page);
  await page.goto(base); await visible(page, '.lh-welcome.public');
  assert.equal(await page.locator('.lh-user').count(), 0);
  await snapshot(page, 'desktop-guest');
  await page.getByRole('button', { name: '考生登录', exact: true }).click();
  await page.getByLabel('学习口令', { exact: true }).fill('deliberately-wrong-password');
  await page.getByRole('button', { name: '进入我的学习中心' }).click();
  await visible(page, '.lh-login .lh-error');
  assert.equal(await page.evaluate(() => localStorage.getItem('xingce-study.session.v1')), null);
  await page.getByLabel('学习口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入我的学习中心' }).click(); await visible(page, '.lh-user');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token.split('.').length), 3);
  await page.reload(); await visible(page, '.lh-user');
  await page.getByRole('button', { name: '打开学习设置' }).click();
  await page.getByLabel('公开昵称', { exact: true }).fill('认真练习的同学');
  await page.locator('#profile-goal').fill('2');
  await page.locator('#profile-exam').fill('2026-12-20');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('已保存，按自己的节奏来', { exact: true }).waitFor();
  await nav(page, '学习概览').click();
  assert.ok((await page.locator('.lh-welcome h1').textContent()).includes('认真练习的同学'));
  await snapshot(page, 'desktop-dashboard');
  checks.push('guest supervision, wrong password, JWT local storage, refresh login persistence, profile and daily goal');

  await setup(page, { count: 2, images: 'visual' });
  await snapshot(page, 'desktop-setup'); await start(page); await imagesLoaded(page);
  const first = await state(page), practiceId = first.id, firstQuestion = first.current.question.id;
  assert.equal(first.settings.mode, 'practice'); assert.equal(first.current.result, null);
  assert.equal(first.current.question.hasImages, true); assert.equal(service.jobs.size, 0);
  await zoomQuestion(page);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '收藏这道题', exact: true }).click();
  await page.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.getByRole('button', { name: '我的笔记', exact: true }).click();
  await page.locator('.note-editor textarea').fill(privateNote);
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  assert.equal(await page.locator('.answer-option.selected').count(), 0, 'typing notes must not trigger answer shortcuts');
  const gold = bank.byId.get(firstQuestion).answer[0], wrongChoice = gold === 'A' ? 'B' : 'A';
  await answer(page, wrongChoice, '提交答案，看解析'); await visible(page, '.round-reveal');
  assert.equal((await state(page)).current.result.humanCorrect, false);
  assert.equal(await page.locator('.timing-comparison').count(), 0, 'practice does not invent AI timing');
  await page.getByRole('textbox', { name: '问小栗', exact: true }).fill('PRIVATE_E2E_CHAT_57：这里最容易漏看什么条件？');
  await page.getByRole('button', { name: '发送给小栗', exact: true }).click();
  await page.locator('.coach-message.assistant').filter({ hasText: '隔离陪练回复' }).waitFor();
  await snapshot(page, 'desktop-practice-reveal');
  await page.getByRole('button', { name: '确认，下一题', exact: true }).click(); await visible(page, '.human-submit');
  await home(page);
  const paused = service.current(service.matches.get(practiceId));
  assert.ok(paused.pausedAt, 'returning to hub pauses practice clock'); const pausedMs = paused.activeHumanMs;
  await delay(1250);
  await page.locator('.lh-resume').getByRole('button', { name: '继续做题' }).click(); await visible(page, '.human-submit');
  const resumed = await state(page);
  assert.equal(resumed.index, 1); assert.equal(resumed.current.paused, false); assert.equal(resumed.current.humanElapsedMs, pausedMs);
  await answer(page, bank.byId.get(resumed.current.question.id).answer[0], '提交答案，看解析'); await visible(page, '.round-reveal');
  await page.getByRole('button', { name: '完成练习，查看报告' }).click(); await visible(page, '.practice-report');
  const done = await state(page); assert.equal(done.scores.completed, 2); assert.equal(done.scores.human, 1); assert.equal(done.scores.humanAccuracy, 50);
  await page.locator('.review-item summary').first().click(); await visible(page, '.review-expanded');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '保存报告' }).click();
  const reportFile = path.join(output, 'practice-report.json'); await (await downloading).saveAs(reportFile);
  const exported = JSON.parse(await fs.readFile(reportFile, 'utf8')); assert.equal(exported.history.length, 2); assert.ok(!JSON.stringify(exported).includes('token'));
  await snapshot(page, 'desktop-practice-report'); await home(page);
  checks.push('two real image questions, image zoom, saved bookmark/private note, independent answer, streamed coach, pause/resume excludes away time, report and export');

  await nav(page, /错题本/).click(); await visible(page, '.lh-notebook-item');
  await page.getByRole('textbox', { name: '搜索题目' }).fill('PRIVATE_E2E_NOTE_57');
  await page.waitForResponse(response => response.url().includes('/api/learning/questions?') && response.url().includes('PRIVATE_E2E_NOTE_57'));
  assert.equal(await page.locator('.lh-notebook-item').count(), 1);
  await page.locator('.lh-notebook-item summary').click(); assert.ok((await page.locator('.lh-note').textContent()).includes(privateNote));
  await page.getByRole('button', { name: '标记掌握', exact: true }).click(); await visible(page, '.lh-empty');
  await page.getByRole('checkbox', { name: '包括已掌握' }).check(); await visible(page, '.lh-notebook-item');
  await page.getByRole('button', { name: '还需巩固', exact: true }).click();
  await page.getByRole('button', { name: '标记掌握', exact: true }).waitFor();
  await snapshot(page, 'desktop-wrong-notebook');
  await page.getByRole('button', { name: '重做此题', exact: true }).click(); await visible(page, '.question-stem');
  assert.equal((await state(page)).current.question.id, firstQuestion);
  await answer(page, gold, '提交答案，看解析'); await visible(page, '.round-reveal');
  await page.getByRole('button', { name: '完成练习，查看报告' }).click(); await visible(page, '.practice-report'); await home(page);
  await nav(page, /收藏夹/).click(); await visible(page, '.lh-notebook-item');
  await page.getByRole('button', { name: '取消收藏', exact: true }).click(); await visible(page, '.lh-empty');
  await nav(page, '学习记录').click(); await visible(page, '.lh-match-item');
  await page.getByRole('button', { name: '自主练习', exact: true }).click();
  await page.locator('.lh-match-item').last().getByRole('button', { name: '查看记录' }).click(); await visible(page, '.practice-report');
  assert.ok(page.url().includes('#record/'));
  await home(page); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await visible(page, '.lh-welcome.public');
  assert.equal(await page.evaluate(() => localStorage.getItem('xingce-study.session.v1')), null);
  await nav(page, '学习记录').click(); await page.locator('.lh-match-item').last().getByRole('button', { name: '查看记录' }).click(); await visible(page, '.reading-note');
  await page.locator('.review-item summary').first().click();
  assert.equal(await page.locator('.review-private-tools,.question-notebook,.coach-panel').count(), 0);
  assert.ok(!(await page.locator('body').textContent()).includes(privateNote));
  const visitor = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const publicPage = await visitor.newPage(); watch(publicPage); await publicPage.goto(`${base}/#record/${practiceId}`); await visible(publicPage, '.reading-note');
  const publicJson = await publicPage.evaluate(async id => (await fetch(`/api/public/matches/${id}`)).json(), practiceId);
  const serialized = JSON.stringify(publicJson); assert.ok(!serialized.includes(privateNote)); assert.ok(!serialized.includes('PRIVATE_E2E_CHAT_57')); assert.ok(!serialized.includes('coachMessages')); assert.ok(!serialized.includes('tokenHash'));
  await snapshot(publicPage, 'desktop-public-record'); await visitor.close(); currentPage = page;
  checks.push('wrong-question full-text note search, mastery and reopen, exact-question retry, bookmark removal, history and public share link without notes/chat/token');

  await home(page); await login(page);
  await setup(page, { mode: 'llm', count: 2, demo: true }); await start(page, true);
  const simultaneous = await state(page); assert.equal(simultaneous.current.parallel, true); assert.equal(simultaneous.current.aiStatus, 'running'); assert.equal(simultaneous.current.explanation, '');
  assert.equal(simultaneous.current.attempts, 1); assert.equal(await page.locator('.tool-receipt,.stream-text,.round-reveal').count(), 0);
  await answer(page, 'A', '提交答案，查看 AI'); await visible(page, '.model-waiting'); await visible(page, '.stream-text');
  assert.equal(await page.locator('.round-reveal').count(), 0, 'explanation streams before final tool submission');
  await visible(page, '.round-reveal'); const humanFirst = await state(page); assert.ok(humanFirst.current.result.humanMs < humanFirst.current.result.aiMs);
  await page.getByRole('button', { name: '用简单的话讲讲这题' }).click(); await page.locator('.coach-message.assistant').filter({ hasText: '演示回复' }).waitFor();
  await snapshot(page, 'desktop-llm-human-first');
  await page.getByRole('button', { name: '确认，下一题' }).click();
  await page.getByRole('heading', { name: 'AI 已交卷，等你。' }).waitFor();
  const sealed = await state(page); const frozenAiMs = service.current(service.matches.get(sealed.id)).aiMs;
  assert.equal(sealed.current.phase, 'human'); assert.equal(sealed.current.result, null); assert.equal(sealed.current.explanation, '');
  await page.reload(); await page.getByRole('heading', { name: 'AI 已交卷，等你。' }).waitFor();
  assert.equal((await state(page)).current.attempts, 1); assert.equal(await page.locator('.tool-receipt,.stream-text').count(), 0);
  await snapshot(page, 'desktop-llm-sealed');
  await answer(page, 'B', '提交答案，查看 AI'); await visible(page, '.timing-comparison');
  const aiFirst = await state(page); assert.equal(aiFirst.current.result.aiMs, frozenAiMs); assert.ok(aiFirst.current.result.humanMs > frozenAiMs);
  await page.getByRole('button', { name: '完成对战，查看战报' }).click(); await visible(page, '.report-page');
  await page.locator('.review-item summary').first().click(); await visible(page, '.review-expanded .timing-comparison');
  await snapshot(page, 'desktop-llm-report'); await home(page);
  checks.push('concurrent LLM demo, human-first streaming, AI-first sealed answer through refresh, independent frozen timing, demo coach and report');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(); currentPage = mobile; watch(mobile); await mobile.goto(base); await visible(mobile, '.lh-welcome.public');
  await snapshot(mobile, 'mobile-guest'); await login(mobile); await snapshot(mobile, 'mobile-dashboard');
  for (const menu of ['开始练习', /错题本/, /收藏夹/, '学习记录', '公开监督', '学习概览']) { await nav(mobile, menu).click(); await noOverflow(mobile, `mobile navigation ${menu}`); }
  await mobile.getByRole('button', { name: '打开学习设置' }).click(); await snapshot(mobile, 'mobile-settings');
  await nav(mobile, '学习概览').click(); await setup(mobile, { mode: 'jev', count: 2, images: 'visual', demo: true }); await snapshot(mobile, 'mobile-setup'); await start(mobile, true); await imagesLoaded(mobile);
  await zoomQuestion(mobile); await noOverflow(mobile, 'mobile zoom dialog');
  await mobile.getByRole('button', { name: '关闭', exact: true }).click();
  await answer(mobile, 'A', '锁定答案，轮到 AI'); await visible(mobile, '.probabilities');
  assert.equal(await mobile.locator('.stream-text').count(), 0); assert.equal(await mobile.locator('.probability-row').count(), (await state(mobile)).current.question.options.length);
  await snapshot(mobile, 'mobile-jev-reveal');
  await mobile.getByRole('button', { name: '确认，下一题' }).click(); await visible(mobile, '.human-submit');
  await mobile.getByRole('button', { name: '结束本场' }).click(); await mobile.getByRole('button', { name: '结束并查看报告' }).click(); await visible(mobile, '.report-page');
  assert.equal((await state(mobile)).scores.completed, 1); await snapshot(mobile, 'mobile-jev-report'); await home(mobile);
  await setup(mobile, { mode: 'llm', count: 1, images: 'visual', demo: true }); await start(mobile, true); await imagesLoaded(mobile);
  await mobile.getByRole('heading', { name: 'AI 已交卷，等你。' }).waitFor();
  await answer(mobile, 'C', '提交答案，查看 AI'); await visible(mobile, '.timing-comparison');
  await snapshot(mobile, 'mobile-llm-timing'); await mobile.getByRole('button', { name: '完成对战，查看战报' }).click(); await visible(mobile, '.report-page');
  checks.push('390px guest/login, all study navigation, profile and setup, image zoom, JEV probabilities and early finish, multimodal LLM sealed reveal and timing, no horizontal overflow');

  assert.equal(forbiddenCalls, 0); assert.equal(coachCalls, 1); assert.equal(expectedFailures.length, 1);
  assert.deepEqual(errors, [], 'browser JavaScript errors'); assert.deepEqual(failures, [], 'unexpected failed requests');
  if (storage) {
    await service.flush();
    assert.ok((await storage.client.query('SELECT count(*)::int AS n FROM study_matches')).rows[0].n >= 5);
    assert.ok(JSON.stringify((await storage.client.query('SELECT payload FROM study_annotations')).rows).includes(privateNote));
    const port = server.address().port;
    coach.shutdown(); service.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await storage.close(); storage = await openStorage(config, bank);
    service = new MatchService(bank, config, { storage, providers: { llm: blocked, jev: blocked, demo } });
    coach = new CoachService(bank, service, config, { provider: blocked });
    app = createApp(bank, service, config, { coach }); await service.flush();
    server = app.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    await mobile.reload(); await visible(mobile, '.report-page'); assert.equal((await state(mobile)).scores.completed, 1);
    await home(mobile); await visible(mobile, '.lh-user');
    await nav(mobile, /错题本/).click();
    assert.ok(JSON.stringify(app.locals.learning.data).includes(privateNote));
    await snapshot(mobile, 'mobile-postgres-restart');
    checks.push('PostgreSQL restart preserves JWT, completed report, private notes and study profile with external resources');
  } else {
    assert.ok((await fs.readdir(config.runtimePath)).filter(name => name.endsWith('.json')).length >= 5, 'isolated matches persisted');
    assert.ok((await fs.readFile(config.learningPath, 'utf8')).includes(privateNote), 'private annotation persisted');
  }
  const result = { passed: true, checks, pageErrors: errors, failedRequests: failures, expectedInvalidLogins: expectedFailures.length, paidProviderCalls: forbiddenCalls, screenshots: output };
  await fs.writeFile(path.join(output, 'e2e-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await currentPage?.screenshot({ path: path.join(output, 'e2e-failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'e2e-failure.json'), JSON.stringify({ error: error.message, pageErrors: errors, failedRequests: failures, url: currentPage?.url() }, null, 2));
  throw error;
} finally {
  coach.shutdown(); service.shutdown(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await storage?.close();
  resources?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
