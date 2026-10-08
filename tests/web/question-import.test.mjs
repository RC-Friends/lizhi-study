import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { validateImport, compileImport, inspectImage, validateCanonical, parseQuestionLines } from '../../server/question-import.mjs';
import { prepareQuestionImport } from '../../scripts/import-questions.mjs';
import { QuestionBank } from '../../server/bank.mjs';
import { MatchService } from '../../server/matches.mjs';
import { createApp } from '../../server/app.mjs';
import { question, config } from './fixtures.mjs';

const example = 'examples/question-bank/questions.json';
const document = () => JSON.parse(fs.readFileSync(example));
test('standard examples compile deterministically, carry local image paths and can draw and grade', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-format-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const one = prepareQuestionImport({ input: example, output: path.join(root, 'one') });
  const two = prepareQuestionImport({ input: example, output: path.join(root, 'two') });
  assert.equal(one.version, two.version); assert.equal(one.images, 2);
  const merged = prepareQuestionImport({ input: example, base: path.join(root, 'one'), output: path.join(root, 'merged') });
  assert.equal(merged.version, one.version); assert.equal(merged.added, 0); assert.equal(merged.reused, 3);
  const rows = parseQuestionLines(fs.readFileSync(path.join(root, 'one/questions.jsonl'))), bank = new QuestionBank(null, rows);
  assert.equal(validateCanonical(rows).usableQuestions, 3);
  assert.ok(rows[1].tags.includes('has_image')); assert.match(rows[1].images[0].path, /^assets\/images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);
  const service = new MatchService(bank, config, { persist: false }); t.after(() => service.shutdown());
  const created = service.create({ mode: 'practice', count: 1, modules: ['数量关系'], images: 'text', source: 'mock' }, { ownerId: 'primary' });
  const match = service.matches.get(created.match.id);
  service.submit(match, { index: 0, choice: 'D' }); assert.equal(service.snapshot(match).scores.human, 1);
});
test('format errors identify paths and reject duplicate IDs, invalid answers, unsafe paths and orphan option images', () => {
  for (const change of [d => d.questions.push(d.questions[0]), d => d.questions[0].answer = 'F', d => d.questions[1].images[0].path = '../escape.png',
    d => d.questions[1].images[0].path = 'https://example.com/x.png', d => d.questions[1].images[0].path = 'data:image/png;base64,AA==',
    d => d.questions[1].images[0].role = 'option_F', d => d.questions[0].stem = ' ', d => d.schemaVersion = '9']) {
    const d = document(); change(d); assert.throws(() => validateImport(d), e => e.status === 422 && e.issues[0].path.startsWith('/'));
  }
});
test('compiler escapes text; canonical uploads cannot introduce active HTML or undeclared images', () => {
  const d = document(); d.questions = [d.questions[0]]; d.questions[0].stem = '<script>alert(1)</script>';
  const rows = compileImport(d, new Map()); assert.ok(rows[0].stem_html.includes('&lt;script&gt;')); validateCanonical(rows);
  for (const html of ['<script>alert(1)</script>', '<img src="https://example.com/track.png">', '<p onclick="alert(1)">text</p>', '<svg onload="alert(1)"></svg>']) {
    const bad = structuredClone(rows); bad[0].stem_html = html; assert.throws(() => validateCanonical(bad), { status: 422 });
  }
  assert.throws(() => parseQuestionLines(Buffer.from('{bad}\n')), e => e.issues[0].path === '/lines/1');
  assert.throws(() => inspectImage(Buffer.from('<svg/>'), 'wrong.png'), { status: 422 });
});
test('local import checks real image bytes, refuses escaping symlinks and altered IDs in a base', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-import-path-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('examples/question-bank', path.join(root, 'input'), { recursive: true });
  const input = path.join(root, 'input/questions.json'), base = path.join(root, 'base'); prepareQuestionImport({ input, output: base });
  const changed = document(); changed.questions[0].answer = 'A'; fs.writeFileSync(input, JSON.stringify(changed));
  assert.throws(() => prepareQuestionImport({ input, base, check: true }), { status: 409 });
  fs.writeFileSync(input, JSON.stringify(document())); fs.renameSync(path.join(root, 'input/images/dots.png'), path.join(root, 'outside.png'));
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(root, 'input/images/dots.png'));
  assert.throws(() => prepareQuestionImport({ input, check: true }), { status: 422 });
});
test('operator routes authenticate before parsing, reject learner JWTs, and keep ordinary request limits', async t => {
  const bank = new QuestionBank(null, [question]), settings = { ...config, questionImport: { token: 'operator-test-' + 'a'.repeat(32) } };
  const service = new MatchService(bank, settings, { persist: false }), app = createApp(bank, service, settings);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { app.locals.coach.shutdown(); service.shutdown(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (url, body, token) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const token = (await (await send('/api/login', { password: config.sitePassword })).json()).token;
  assert.equal((await send('/api/admin/question-bank/validate', '{invalid', token)).status, 401);
  assert.equal((await send('/api/admin/question-bank/validate', document())).status, 401);
  const d = document(); d.questions[0].material = '材料'.repeat(18000);
  assert.equal((await send('/api/admin/question-bank/validate', d, settings.questionImport.token)).status, 200);
  assert.equal((await send('/api/learning/profile', d, token)).status, 413);
  d.questions[0].answer = 'F'; const error = await send('/api/admin/question-bank/validate', d, settings.questionImport.token);
  assert.equal(error.status, 422); assert.ok((await error.json()).error.issues.length);
  const schema = await fetch(base + '/api/admin/question-bank/schema', { headers: { Authorization: `Bearer ${settings.questionImport.token}` } }); assert.equal(schema.status, 200);
});
