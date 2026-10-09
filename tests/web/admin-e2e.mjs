import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { checkPageRecovery } from './recovery-e2e.mjs';
import { checkAdminObservation } from './admin-observer-e2e.mjs';

export async function checkAdministration({ browser, base, adminPassword, learnerPassword, screenshot, modelEndpoint, ragModels }) {
  await checkPageRecovery({ browser, base, adminPassword, screenshot });
  await checkAdminObservation({ browser, base, adminPassword, learnerPassword, screenshot });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  const adminNav = name => page.getByRole('navigation', { name: '站点管理导航' }).getByRole('button', { name, exact: true });
  const studyNav = name => page.getByRole('navigation', { name: '学习中心导航' }).getByRole('button', { name, exact: true });
  try {
    await page.goto(base);
    // This 3.6 KB KaTeX font was previously inlined by Vite and rejected by
    // font-src 'self'. Check an actual font load under the page's CSP.
    const font = await page.evaluate(async () => {
      const violations = [], collect = event => { if (event.effectiveDirective === 'font-src') violations.push(event.blockedURI); };
      document.addEventListener('securitypolicyviolation', collect);
      try {
        const faces = await document.fonts.load('20px KaTeX_Size3', '(');
        await document.fonts.ready;
        return { loaded: faces.length > 0 && faces.every(face => face.status === 'loaded'), violations };
      } finally { document.removeEventListener('securitypolicyviolation', collect); }
    });
    assert.deepEqual(font, { loaded: true, violations: [] }, 'KaTeX font must load under the document CSP');
    await page.getByRole('button', { name: '站点管理', exact: true }).click();
    await page.getByLabel('超级管理员口令', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: '进入管理面板', exact: true }).click();
    await page.getByRole('navigation', { name: '站点管理导航' }).waitFor();
    await page.locator('.admin-service').first().waitFor(); await screenshot(page, 'admin-overview');
    await page.reload(); await adminNav('模型配置').click();
    await page.locator('#ai-baseurl').waitFor();
    await page.locator('#ai-baseurl').fill(modelEndpoint || 'https://example.org/v1');
    await page.locator('#ai-key').fill('browser-test-model-key'); await page.locator('#ai-model').fill('browser-managed-model');
    if (modelEndpoint) { await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor(); }
    await page.getByRole('button', { name: '保存模型配置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(await page.locator('#ai-key').inputValue(), '');
    assert.equal((await page.request.get(base + '/api/catalog').then(response => response.json())).providers.llm.model, 'browser-managed-model');
    await page.reload(); await page.locator('#ai-model').waitFor(); assert.equal(await page.locator('#ai-model').inputValue(), 'browser-managed-model');
    await page.getByText('高级参数', { exact: false }).click(); await page.locator('#model-timeout').waitFor();
    await screenshot(page, 'admin-models'); await page.getByText('高级参数', { exact: false }).click();
    await page.getByRole('button', { name: 'JEV 决策模型', exact: true }).click(); assert.equal(await page.locator('#ai-model').inputValue(), 'jev-latest');
    await page.getByRole('button', { name: 'JEV 视觉助手', exact: true }).click(); await page.getByRole('heading', { name: 'JEV 视觉助手', exact: true }).waitFor();
    await adminNav('资料库').click(); await page.locator('.kh-library-controls').waitFor();
    await page.getByRole('button', { name: '新建资料库', exact: true }).first().click();
    await page.getByLabel('资料库名称', { exact: true }).fill('浏览器验收 · 行程笔记');
    await page.getByLabel('简介', { exact: false }).fill('相遇和追及问题的解题依据，整理清楚再练习。');
    await screenshot(page, 'library-create');
    await page.getByRole('button', { name: '创建资料库', exact: true }).click();
    const card = page.locator('.kh-library-card').filter({ hasText: '浏览器验收 · 行程笔记' });
    await card.waitFor(); await screenshot(page, 'knowledge-libraries');
    await card.getByRole('button', { name: '打开资料库', exact: true }).click();
    await page.getByRole('button', { name: '收录资料', exact: true }).first().click();
    const file = { name: '行程讲义.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await fs.readFile(new URL('../fixtures/knowledge-note.docx', import.meta.url)) };
    await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(file); await page.locator('.kh-dropzone.has-file').waitFor();
    assert.equal(await page.locator('#kb-content').count(), 0); await screenshot(page, 'knowledge-word-upload');
    await page.getByRole('button', { name: '收进知识库', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'detached' });
    await page.locator('.kh-document').filter({ hasText: '行程讲义' }).waitFor();
    // Re-upload is idempotent; the original PR threw this.get is not a function.
    await page.getByRole('button', { name: '收录资料', exact: true }).first().click(); await page.getByLabel('选择资料文件', { exact: true }).setInputFiles(file);
    await page.locator('.kh-dropzone.has-file').waitFor(); await page.getByRole('button', { name: '收进知识库', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已经收录' }).waitFor(); assert.equal(await page.locator('.kh-document').count(), 1);
    await page.getByRole('button', { name: '查看内容', exact: true }).click(); await page.locator('.kh-document-content').waitFor(); await screenshot(page, 'knowledge-document');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '删除资料 行程讲义', exact: true }).click(); await page.getByRole('button', { name: '保留', exact: true }).click(); assert.equal(await page.locator('.kh-document').count(), 1);
    await adminNav('模型配置').click(); await page.getByRole('button', { name: 'Embedding 检索', exact: true }).click();
    await page.getByRole('heading', { name: 'Embedding 检索', exact: true }).waitFor(); await page.getByLabel('向量索引进度', { exact: true }).waitFor();
    if (modelEndpoint) {
      const embedding = ragModels?.embedding;
      await page.locator('#ai-baseurl').fill(embedding?.baseUrl || modelEndpoint);
      if (embedding?.authRequired === false) await page.getByLabel('服务需要 API Key', { exact: true }).uncheck();
      else await page.locator('#ai-key').fill(embedding?.key || 'browser-test-embedding-key');
      await page.locator('#ai-model').fill(embedding?.model || 'browser-vector-model');
      await page.getByLabel('启用此模型', { exact: true }).check();
      await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByRole('status').filter({ hasText: '向量接口已响应' }).waitFor();
      await page.getByRole('button', { name: '保存模型配置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      await page.getByText('索引已就绪', { exact: true }).waitFor();
      await page.getByLabel('试着问一句', { exact: true }).fill(ragModels ? '相向而行几小时后相遇' : '迎面走多久碰头');
    } else await page.getByLabel('试着问一句', { exact: true }).fill('相遇问题');
    await page.getByRole('button', { name: '检索资料', exact: true }).click();
    await page.getByRole('status').filter({ hasText: modelEndpoint ? '已结合语义与关键词检索' : '已使用关键词检索' }).waitFor();
    assert.ok(await page.locator('.admin-rag-results article').count() > 0); await screenshot(page, 'admin-embedding');
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'admin-mobile-embedding'); await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole('button', { name: 'Rerank 重排', exact: true }).click();
    await page.getByRole('heading', { name: 'Rerank 重排', exact: true }).waitFor();
    if (modelEndpoint) {
      const rerank = ragModels?.rerank;
      await page.locator('#ai-baseurl').fill(rerank?.baseUrl || modelEndpoint);
      await page.getByLabel('服务需要 API Key', { exact: true }).setChecked(rerank?.authRequired ?? false);
      if (rerank?.authRequired) await page.locator('#ai-key').fill(rerank.key);
      else assert.ok(await page.locator('#ai-key').isDisabled());
      await page.locator('#ai-model').fill(rerank?.model || 'browser-reranker-model'); await page.getByLabel('启用此模型', { exact: true }).check();
      await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByRole('status').filter({ hasText: '重排接口已响应' }).waitFor();
      await page.getByText('高级参数', { exact: false }).click(); await page.locator('#model-minScore').fill('0.025');
      await page.getByRole('button', { name: '保存模型配置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      assert.equal(await page.locator('#model-minScore').inputValue(), '0.025');
      await screenshot(page, 'admin-rerank'); await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, 'admin-mobile-rerank');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.setViewportSize({ width: 1440, height: 1050 });
      for (const embeddingEnabled of [false, true]) for (const rerankEnabled of [false, true]) {
        for (const [name, enabled] of [['Embedding 检索', embeddingEnabled], ['Rerank 重排', rerankEnabled]]) {
          await page.getByRole('button', { name, exact: true }).click(); await page.getByLabel('启用此模型', { exact: true }).setChecked(enabled);
          await page.getByRole('button', { name: '保存模型配置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        }
        await page.getByLabel('试着问一句', { exact: true }).fill('相遇问题');
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kb/search');
        await page.getByRole('button', { name: '检索资料', exact: true }).click(); const result = await (await response).json();
        assert.equal(result.mode, embeddingEnabled ? 'hybrid' : 'keyword'); assert.equal(result.rerank.applied, rerankEnabled); assert.ok(result.items.length > 0);
        await page.getByRole('status').filter({ hasText: `找到 ${result.items.length} 个片段` }).waitFor();
        assert.equal((await page.locator('.admin-rag-results').innerText()).includes('已重排'), rerankEnabled);
        await screenshot(page, `rag-e${Number(embeddingEnabled)}-r${Number(rerankEnabled)}`);
      }
    } else await screenshot(page, 'admin-rerank');
    await adminNav('题库导入').click(); await page.getByLabel('选择标准题库 JSON', { exact: true }).setInputFiles(new URL('../../examples/question-bank/questions.json', import.meta.url).pathname);
    await page.getByRole('status').filter({ hasText: '格式校验通过' }).waitFor(); await screenshot(page, 'admin-import');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, shot] of [['运行概览', 'admin-mobile-overview'], ['模型配置', 'admin-mobile-models'], ['资料库', 'knowledge-mobile'], ['题库导入', 'admin-mobile-import']]) { await adminNav(name).click(); await screenshot(page, shot); }
    await page.getByRole('button', { name: '退出管理', exact: true }).click();
    await page.getByRole('button', { name: '考生登录', exact: true }).click(); await page.getByLabel('学习口令', { exact: true }).fill(learnerPassword); await page.getByRole('button', { name: '进入我的学习中心', exact: true }).click(); await page.locator('.lh-user').waitFor();
    await page.getByRole('button', { name: '打开学习设置', exact: true }).click(); assert.equal(await page.locator('#ai-key').count(), 0);
    await studyNav('知识库').click(); await page.locator('.kh-library-card').filter({ hasText: '浏览器验收 · 行程笔记' }).waitFor();
    await studyNav('AI 出题').click(); await screenshot(page, 'practice-mobile-setup');
    if (modelEndpoint) {
      await page.getByLabel('练习主题', { exact: true }).fill('相遇问题'); await page.getByRole('radio', { name: /3.*道/ }).check();
      await page.getByRole('button', { name: '生成练习', exact: true }).click(); await page.locator('.kh-answer-option').first().waitFor(); await screenshot(page, 'practice-mobile-question');
      for (let i = 0; i < 3; i++) {
        await page.locator('.kh-answer-option').first().click(); assert.equal(await page.locator('.kh-answer-reveal').count(), 0);
        await page.getByRole('button', { name: '提交答案', exact: true }).click(); await page.locator('.kh-answer-reveal').waitFor();
        if (i === 0) { await screenshot(page, 'practice-mobile-answer'); const next = await page.getByRole('button', { name: '下一题', exact: true }).boundingBox(), explanation = await page.locator('.kh-answer-reveal').boundingBox(); assert.ok(next.y < explanation.y); }
        await page.getByRole('button', { name: i === 2 ? '查看结果' : '下一题', exact: true }).click();
      }
      await page.getByRole('heading', { name: '这一组练完啦！', exact: true }).waitFor(); await screenshot(page, 'practice-mobile-results');
    }
    await page.setViewportSize({ width: 1440, height: 1050 }); await studyNav('AI 出题').click(); await screenshot(page, 'practice-desktop');
    assert.deepEqual(errors, []);
  } catch (error) { await screenshot(page, 'admin-failure').catch(() => {}); throw error; }
  finally { await context.close(); }
}
