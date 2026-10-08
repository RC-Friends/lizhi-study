import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function checkObserverSkill({ browser, base, screenshot }) {
  const publicOrigin = 'https://study.example.test:9443';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const errors = [], requests = [];
  try {
    // Transport requests to the isolated stack while the browser sees a TLS
    // reverse-proxy origin. This checks origin binding, not a mocked API.
    await context.route(publicOrigin + '/**', route => {
      const url = new URL(route.request().url());
      return route.fetch({ url: base + url.pathname + url.search }).then(response => route.fulfill({ response }));
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: publicOrigin });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/skills/') || request.url().includes('/api/public/stats')) requests.push(request); });
    await page.goto(publicOrigin);
    await page.locator('.lh-sidebar nav').getByRole('button', { name: 'AI 监督', exact: true }).click();
    assert.equal(new URL(page.url()).hash, '#skill');
    await page.getByRole('button', { name: '下载技能包', exact: true }).waitFor();
    await page.getByRole('button', { name: '找到薄弱模块', exact: true }).click();
    await page.getByRole('button', { name: '复制给 AI', exact: true }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clipboard.includes(publicOrigin + '/skills/lizhi-study-observer/SKILL.md'));
    assert.ok(clipboard.includes('薄弱模块')); assert.ok(!clipboard.includes(base)); assert.ok(!clipboard.includes('blob:'));
    const markdownEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 SKILL.md', exact: true }).click();
    const markdown = await markdownEvent;
    assert.equal(markdown.suggestedFilename(), 'SKILL.md');
    const text = await fs.readFile(await markdown.path(), 'utf8');
    assert.ok(text.includes('站点地址：`' + publicOrigin + '`')); assert.ok(!text.includes('__LIZHI_SITE_URL__'));
    const zipEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载技能包', exact: true }).click();
    const zip = await zipEvent; assert.equal(zip.suggestedFilename(), 'lizhi-study-observer.zip');
    const zipped = JSON.parse(execFileSync('python3', ['-c', 'import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', await zip.path()], { encoding: 'utf8' }));
    assert.equal(zipped['lizhi-study-observer/SKILL.md'], text);
    assert.ok(zipped['lizhi-study-observer/references/api.md'].includes(publicOrigin));
    assert.equal(Object.keys(zipped).length, 3);
    const raw = await context.request.get(base + '/skills/lizhi-study-observer/SKILL.md');
    assert.equal(raw.status(), 200); assert.match(raw.headers()['content-type'], /text\/plain/); assert.match(await raw.text(), /^---\nname:/);
    assert.equal((await context.request.get(base + '/skills/missing/SKILL.md')).status(), 404);
    await page.getByRole('button', { name: '试查公开数据', exact: true }).click();
    await page.locator('.observer-result').waitFor();
    const stats = await (await context.request.get(base + '/api/public/stats')).json();
    const values = await page.locator('.observer-metrics strong').allTextContents();
    assert.deepEqual(values, [String(stats.summary.answered), String(stats.summary.correct), `${stats.summary.accuracy}%`]);
    assert.ok(!JSON.stringify(stats).includes('PRIVATE_STACK_NOTE'));
    await screenshot(page, 'desktop-observer-skill');
    await page.reload(); await page.locator('.observer-skill').waitFor(); // Deep link survives refresh.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '试查公开数据', exact: true }).click(); await page.locator('.observer-result').waitFor();
    await screenshot(page, 'mobile-observer-skill');
    // A failed refresh preserves the last confirmed result, with an explicit error.
    await page.route('**/api/public/stats', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.getByRole('button', { name: '刷新公开数据', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '下方保留上次查询结果' }).waitFor();
    assert.deepEqual(await page.locator('.observer-metrics strong').allTextContents(), values);
    await page.unroute('**/api/public/stats');
    await page.getByRole('button', { name: '刷新公开数据', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await page.goto(publicOrigin + '/#history'); await page.locator('.lh-match-list').waitFor();
    for (const request of requests) { const headers = await request.allHeaders(); assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined); }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
