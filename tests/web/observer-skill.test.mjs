import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL_NAME, SKILL_FILES, bindSkill, observerPrompt, skillUrl, skillZip, siteOrigin } from '../../src/observer-skill.mjs';

test('browser-origin binding preserves public TLS and ports and produces a portable UTF-8 ZIP', async t => {
  const origin = 'https://study.example.org:9443';
  assert.equal(siteOrigin(origin + '/#skill'), origin);
  for (const bad of ['javascript:alert(1)', 'file:///tmp/SKILL.md', 'https://password@example.org']) assert.throws(() => siteOrigin(bad));
  assert.equal(skillUrl(origin), origin + '/skills/lizhi-study-observer/SKILL.md');
  assert.ok(observerPrompt(origin, '看看近七天').includes('看看近七天'));
  assert.ok(!observerPrompt(origin, '').includes('blob:'));
  const files = SKILL_FILES.map(name => ({ name: `${SKILL_NAME}/${name}`, text: bindSkill(fs.readFileSync(`public/skills/${SKILL_NAME}/${name}`, 'utf8'), origin) }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizhi-skill-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'skill.zip'); fs.writeFileSync(archive, Buffer.from(await skillZip(files).arrayBuffer()));
  const unpacked = JSON.parse(execFileSync('python3', ['-c', 'import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', archive], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(unpacked), files.map(file => file.name));
  for (const file of files) assert.equal(unpacked[file.name], file.text);
  assert.ok(!JSON.stringify(unpacked).includes('__LIZHI_SITE_URL__'));
  assert.ok(unpacked[`${SKILL_NAME}/SKILL.md`].includes('站点地址：`' + origin + '`'));
  assert.ok(unpacked[`${SKILL_NAME}/references/api.md`].includes(origin + '/api/public/stats'));
});
