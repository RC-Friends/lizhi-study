import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeService } from '../../server/knowledge.mjs';
import { DraftService } from '../../server/question-drafts.mjs';

const owner = 'primary';
const llm = { key: 'test-key', baseUrl: 'https://example.org/v1', model: 'test-model', maxTokens: 2048 };
const canned = JSON.stringify([{
  stem: '甲乙两人相向而行，几小时后相遇？',
  options: { A: '2 小时', B: '3 小时', C: '4 小时', D: '5 小时' },
  answer: 'A',
  analysis: '依据资料：相遇问题的路程之和等于初始距离，故 120 ÷ (30 + 30) = 2 小时。',
  knowledgePoints: ['相遇问题'],
  source: 'K1',
}]);

const setup = (complete = async () => canned) => {
  const knowledge = new KnowledgeService({ runtimePath: '/tmp/drafts-test-unused' }, { persist: false });
  const library = knowledge.createLibrary({ name: '讲义库' }, owner);
  knowledge.upload({ libraryId: library.id, title: '行程问题讲义', format: 'markdown',
    content: '# 行程问题\n\n相遇问题的路程之和等于初始距离。例如甲乙速度分别为 30 与 30，相距 120，2 小时后相遇。' }, owner);
  const drafts = new DraftService({ llm, runtimePath: '/tmp/drafts-test-unused' }, { persist: false, complete });
  return { knowledge, drafts };
};

test('generate retrieves relevant chunks, stores reviewed drafts, and exports confirmed ones', async () => {
  const { knowledge, drafts } = setup();
  assert.equal(drafts.ready(), true);
  const result = await drafts.generate({ query: '相遇问题', module: '数量关系', count: 2 }, knowledge, owner);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.sources[0].title, '行程问题讲义');
  const draft = result.drafts[0];
  assert.equal(draft.status, 'draft');
  assert.equal(draft.answer, 'A');
  assert.deepEqual(draft.source, { title: '行程问题讲义', anchor: '行程问题' });
  const confirmed = drafts.confirm(draft.id);
  assert.equal(confirmed.status, 'confirmed');
  const exported = drafts.export();
  assert.equal(exported.schemaVersion, '1.0');
  assert.equal(exported.questions.length, 1);
  assert.equal(exported.questions[0].module, '数量关系');
  assert.equal(exported.questions[0].source.type, '模拟题');
  assert.deepEqual(await drafts.generate({ query: '完全无关的主题量子芯片', module: '数量关系', count: 2 }, knowledge, owner).catch(issue => issue.message), '知识库里没有找到与该主题相关的片段，请先上传相关资料或换个关键词。');
});

test('generation validates input, configuration, and model output format', async () => {
  const { knowledge, drafts } = setup();
  await assert.rejects(() => drafts.generate({ query: '相遇', module: '不存在模块' }, knowledge, owner), /模块/);
  await assert.rejects(() => drafts.generate({ query: '相遇', module: '数量关系', count: 99 }, knowledge, owner), /1—10/);
  const unconfigured = new DraftService({ runtimePath: '/tmp/drafts-test-unused' }, { persist: false });
  await assert.rejects(() => unconfigured.generate({ query: '相遇问题', module: '数量关系' }, knowledge, owner), /尚未配置模型服务/);
  const { drafts: messy } = setup(async () => '抱歉，我不能以 JSON 之外的格式回答。');
  await assert.rejects(() => messy.generate({ query: '相遇问题', module: '数量关系' }, knowledge, owner), /没有按约定格式/);
  const { drafts: invalid } = setup(async () => JSON.stringify([{ stem: '太短', options: {}, answer: 'Z', analysis: '' }]));
  await assert.rejects(() => invalid.generate({ query: '相遇问题', module: '数量关系' }, knowledge, owner), /均未通过校验/);
});
