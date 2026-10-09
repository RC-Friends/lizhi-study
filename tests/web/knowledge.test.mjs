import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeService } from '../../server/knowledge.mjs';
import { chunkDocument, tokenize } from '../../server/kb-text.mjs';

const owner = 'primary', stranger = 'someone';
const lecture = { title: '讲义', format: 'markdown', content: '# 第一章 基础\n\n基础内容第一段。\n\n基础内容第二段。\n\n## 第二章 进阶\n\n进阶内容，讲方程与代入消元。' };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

const setup = () => new KnowledgeService({ runtimePath: '/tmp/kb-test-unused' }, { persist: false });

test('markdown chunking keeps section anchors, merges small blocks, and splits long runs', () => {
  const chunks = chunkDocument('markdown', lecture.content);
  assert.equal(chunks[0].anchor, '第一章 基础');
  assert.ok(chunks[0].text.includes('第一段') && chunks[0].text.includes('第二段'));
  assert.equal(chunks.at(-1).anchor, '第二章 进阶');
  const long = chunkDocument('text', '这是一个完整的句子。'.repeat(400));
  assert.ok(long.length > 1);
  for (const chunk of long) assert.ok(chunk.text.length <= 901);
  assert.ok(tokenize('行程问题 speed').includes('行程') && tokenize('行程问题 speed').includes('speed'));
});

test('libraries isolate documents, enforce visibility, and cascade on delete', () => {
  const service = setup();
  const mine = service.createLibrary({ name: '数量关系讲义库', description: '自用', visibility: 'private' }, owner);
  const shared = service.createLibrary({ name: '共享资料库', visibility: 'public' }, owner);
  assert.equal(service.listLibraries('mine', owner).total, 2);
  assert.equal(service.listLibraries('shared', stranger).items[0].id, shared.id);
  assert.deepEqual(service.listLibraries('mine', stranger).items, []);
  const uploaded = service.upload({ ...lecture, libraryId: mine.id }, owner);
  assert.equal(uploaded.duplicate, false);
  assert.throws(() => service.upload({ ...lecture, libraryId: mine.id }, stranger), /没有访问权限/);
  assert.throws(() => service.upload({ ...lecture, libraryId: shared.id }, stranger), /没有访问权限/);
  assert.equal(service.upload({ ...lecture, libraryId: mine.id }, owner).duplicate, true);
  const detail = service.listDocuments(mine.id, owner);
  assert.equal(detail.total, 1);
  assert.equal(detail.items[0].chunkCount, uploaded.document.chunks.length);
  assert.throws(() => service.listDocuments(mine.id, stranger), /没有访问权限/);
  const exported = service.exportLibrary(shared.id, stranger);
  assert.equal(exported.library.name, '共享资料库');
  assert.throws(() => service.exportLibrary(mine.id, stranger), /没有访问权限/);
  assert.equal(service.removeLibrary(mine.id, owner).documents, 1);
  assert.throws(() => service.listDocuments(mine.id, owner), /不存在/);
});

test('image materials are accepted, deduped per library, and marked pending transcription', () => {
  const service = setup();
  const library = service.createLibrary({ name: '手写笔记库' }, owner);
  const uploaded = service.upload({ libraryId: library.id, title: '手写笔记·概率初步', format: 'image', image }, owner);
  assert.equal(uploaded.document.transcribed, false);
  assert.equal(uploaded.document.chunks.length, 0);
  assert.equal(service.upload({ libraryId: library.id, title: '同样的手写笔记', format: 'image', image }, owner).duplicate, true);
  const other = service.createLibrary({ name: '另一个库' }, owner);
  assert.equal(service.upload({ libraryId: other.id, title: '同一张图放到别的库', format: 'image', image }, owner).duplicate, false, 'same image in another library is a separate document');
  assert.throws(() => service.upload({ libraryId: library.id, title: '坏图片', format: 'image', image: 'data:text/html;base64,PGI+' }, owner), /PNG、JPEG 或 WebP/);
  assert.equal(service.listDocuments(library.id, owner).items[0].preview.includes('待 AI 转写'), true);
});

test('bm25 search ranks matching chunks and respects access scope', () => {
  const service = setup();
  const library = service.createLibrary({ name: '讲义库', visibility: 'private' }, owner);
  service.upload({ libraryId: library.id, title: '行程问题', format: 'markdown', content: '# 行程问题\n\n相遇问题的路程之和等于初始距离，追及问题的路程之差等于初始距离。' }, owner);
  service.upload({ libraryId: library.id, title: '工程问题', format: 'markdown', content: '# 工程问题\n\n把工作总量设为单位 1，合作完成时间为 1 ÷ (1/a + 1/b)。' }, owner);
  const hits = service.searchChunks('行程问题 追及', { ownerId: owner });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].anchor, '行程问题');
  assert.ok(hits[0].score > 0);
  assert.deepEqual(service.searchChunks('完全无关的词汇量子计算机', { ownerId: owner }), []);
  assert.deepEqual(service.searchChunks('行程', { ownerId: stranger }), []);
  assert.throws(() => service.searchChunks('   '), /主题或知识点/);
});
