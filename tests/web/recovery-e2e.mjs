import assert from 'node:assert/strict';

export async function checkPageRecovery({ browser, base, adminPassword, screenshot }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const nav = () => page.getByRole('navigation', { name: '站点管理导航' });
  try {
    await page.goto(base);
    await page.getByRole('button', { name: '站点管理', exact: true }).click();
    assert.ok(await page.evaluate(() => scrollY > 0), 'Admin entry starts below the fold');
    await page.getByLabel('超级管理员口令', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: '进入管理面板', exact: true }).click();
    await nav().waitFor();
    await page.waitForFunction(() => scrollY === 0 && document.querySelector('.ad-main h1')?.getBoundingClientRect().top >= 0);
    assert.deepEqual(errors, []);
    await screenshot(page, 'admin-mobile-login-position');

    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token);
    let badStatus = true;
    await page.route('**/api/admin/status', route => badStatus
      ? route.fulfill({ json: { services: null } }) : route.continue());
    // Simulate a malformed upstream response that used to unmount the entire
    // app. Recovery must remain usable and preserve authentication on reload.
    await page.reload();
    await page.getByRole('heading', { name: '页面显示出了点问题', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token), token);
    await page.getByText('查看诊断信息', { exact: true }).click();
    const report = await page.getByLabel('页面诊断信息', { exact: true }).inputValue();
    assert.ok(report.includes('TypeError'));
    assert.ok(!report.includes(token) && !report.includes(adminPassword), 'Diagnostics omit login credentials');
    await screenshot(page, 'admin-mobile-page-recovery');

    badStatus = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await nav().waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingce-study.session.v1')).token), token);
    await page.waitForFunction(() => scrollY === 0);
    await screenshot(page, 'admin-mobile-page-recovered');

    badStatus = true;
    await page.reload();
    await page.getByRole('heading', { name: '页面显示出了点问题', exact: true }).waitFor();
    await page.getByRole('button', { name: '返回游客页面', exact: true }).click();
    await page.locator('.lh-welcome.public').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('xingce-study.session.v1')), null);
  } finally { await context.close(); }
}
