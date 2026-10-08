import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODULES } from '../../server/bank.mjs';
import { question } from '../../tests/web/fixtures.mjs';
import { packageResources } from '../package-resources.mjs';

// Self-contained synthetic questions: CI never downloads third-party questions.
export function makeFixture(root) {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const digest = createHash('sha256').update(image).digest('hex');
  const relative = `assets/images/${digest.slice(0, 2)}/${digest}.png`;
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), image);
  const rows = MODULES.flatMap((module, m) => Array.from({ length: 12 }, (_, i) => ({
    ...question, id: 'xc_' + createHash('sha256').update(`${m}:${i}`).digest('hex').slice(0, 24),
    module, stem: `合成验收题 ${m + 1}-${i + 1}：两本练习册共多少钱？`,
    stem_html: `<p>合成验收题 ${m + 1}-${i + 1}：两本练习册共多少钱？</p>`
      + (i % 2 === 0 ? `<img src="${relative}" alt="合成测试图片" width="48" height="48">` : ''),
    images: i % 2 === 0 ? [{ path: relative, role: 'stem', kind: 'image', width: 1, height: 1 }] : [],
    analysis: '12 × 2 = 24 元。', analysis_html: '<p>12 × 2 = 24 元。</p>',
  })));
  const dataPath = path.join(root, 'questions.jsonl'), bundle = path.join(root, 'bundle');
  fs.writeFileSync(dataPath, rows.map(q => JSON.stringify(q)).join('\n') + '\n');
  packageResources({ dataPath, imagesPath: path.join(root, 'assets/images'), output: bundle });
  return { dataPath, bundle };
}
