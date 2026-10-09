import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export async function checkAdminObservation({ browser, base, adminPassword, learnerPassword, screenshot }) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Observation regression requires an isolated local test server');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [], denied = [];
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() === 403) denied.push(new URL(response.url()).pathname); });
  const adminNav = name => page.getByRole('navigation', { name: '站点管理导航' }).getByRole('button', { name, exact: true });
  const studyNav = name => page.getByRole('navigation', { name: '学习中心导航' }).getByRole('button', { name, exact: true });
  const login = async (target, role, password) => {
    await target.getByRole('button', { name: role === 'admin' ? '站点管理' : '考生登录', exact: true }).click();
    await target.getByLabel(role === 'admin' ? '超级管理员口令' : '学习口令', { exact: true }).fill(password);
    await target.getByRole('button', { name: role === 'admin' ? '进入管理面板' : '进入我的学习中心', exact: true }).click();
    await target.locator(role === 'admin' ? '.admin-main' : '.lh-user').waitFor();
  };
  try {
    // Seed only the isolated test service, without invoking any model. This
    // exercises real public record DTOs rather than inventing a second schema.
    const learner = await (await context.request.post(base + '/api/login', { data: { password: learnerPassword, role: 'learner' } })).json();
    const headers = { Authorization: `Bearer ${learner.token}` };
    const catalog = await (await context.request.get(base + '/api/catalog')).json();
    for (let i = 0; i < 2; i++) {
      const response = await context.request.post(base + '/api/matches', { headers, data: { mode: 'practice', count: 1, modules: catalog.bank.modules.filter(m => m.count).map(m => m.name), images: 'mixed', source: 'all' } });
      assert.ok(response.ok()); const { match } = await response.json();
      assert.ok((await context.request.post(base + `/api/matches/${match.id}/answer`, { headers, data: { choice: 'A', index: 0 } })).ok());
      assert.ok((await context.request.post(base + `/api/matches/${match.id}/finish`, { headers, data: {} })).ok());
    }
    let second;
    // A two-page fixture checks that an administrator's "load more" follows
    // the public endpoint instead of calling the learner-only history route.
    await page.route('**/api/public/overview*', async route => {
      const response = await route.fetch(), data = await response.json(); second = data.history.items[1];
      data.history = { ...data.history, items: data.history.items.slice(0, 1), page: 1, pages: 2, pageSize: 1, total: 2 };
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/public/history?*', route => route.fulfill({ json: { items: [second], page: 2, pages: 2, pageSize: 1, total: 2 } }));
    await page.goto(base); await login(page, 'admin', adminPassword);
    await page.addStyleTag({ content: '.ad-main { display: none !important; }' });
    await page.locator('.admin-main').waitFor({ state: 'visible' });
    for (const button of await page.getByRole('navigation', { name: '站点管理导航' }).getByRole('button').all()) {
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 844, 'All management and observation entries fit the mobile viewport');
    }
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token);
    await adminNav('公开监督').click(); await page.locator('.lh-welcome.public').waitFor();
    await page.getByRole('button', { name: '返回管理面板', exact: true }).waitFor();
    await screenshot(page, 'admin-mobile-supervision');
    await studyNav('学习记录').click(); await page.locator('.lh-match-item').first().waitFor();
    const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/history');
    await page.getByRole('button', { name: '加载更多记录', exact: true }).click(); assert.equal((await next).status(), 200);
    assert.equal(await page.locator('.lh-match-item').count(), 2);
    await page.locator('.lh-match-item').first().getByRole('button', { name: '查看记录', exact: true }).click();
    await page.locator('.reading-note').waitFor();
    await page.locator('.review-item summary').first().click();
    await page.locator('.review-gold').first().waitFor();
    assert.equal(await page.locator('.review-private-tools,.question-notebook,.coach-panel').count(), 0);
    await screenshot(page, 'admin-mobile-public-review');
    await page.reload(); await page.locator('.reading-note').waitFor();
    await page.goBack(); await page.locator('.lh-match-item').first().waitFor();
    await studyNav('AI 监督').click(); await page.locator('.observer-skill').waitFor();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 SKILL.md', exact: true }).click();
    const download = await downloadEvent, markdown = await fs.readFile(await download.path(), 'utf8');
    assert.ok(markdown.includes(base) && !markdown.includes(token));
    await page.getByRole('button', { name: '试查公开数据', exact: true }).click(); await page.locator('.observer-result').waitFor();
    await screenshot(page, 'admin-mobile-observer-skill');
    await page.reload(); await page.locator('.observer-skill').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token), token);
    await page.getByRole('button', { name: '返回管理面板', exact: true }).click(); await adminNav('模型配置').waitFor();

    const other = await context.newPage(); other.setDefaultTimeout(20000);
    await other.goto(base); await other.getByRole('navigation', { name: '站点管理导航' }).waitFor();
    await other.getByRole('button', { name: '退出管理', exact: true }).click();
    await page.locator('.lh-welcome.public').waitFor();
    assert.equal(await page.getByRole('navigation', { name: '站点管理导航' }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('xingce-study.session.v1')), null);
    await login(other, 'learner', learnerPassword); await page.locator('.lh-user').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).role), 'learner');
    await login(other, 'admin', adminPassword); await page.locator('.admin-main').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).role), 'admin');
    await screenshot(page, 'admin-mobile-cross-tab-session');
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);

    // A restored/focused page must confirm revocation and leave no admin UI.
    await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: { code: 'login_required', message: '测试会话已过期' } } }));
    await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByLabel('超级管理员口令', { exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '站点管理导航' }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('xingce-study.session.v1')), null);
  } finally { await context.close(); }
}
