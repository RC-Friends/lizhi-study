import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODULES } from '../../server/bank.mjs';
import { packageResources } from '../package-resources.mjs';
import { compileImport } from '../../server/question-import.mjs';

// Self-contained synthetic questions: CI never downloads third-party questions.
export function makeFixture(root) {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const digest = createHash('sha256').update(image).digest('hex');
  const relative = `assets/images/${digest.slice(0, 2)}/${digest}.png`;
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), image);
  const questions = MODULES.flatMap((module, m) => Array.from({ length: 12 }, (_, i) => ({
    id: `test-${m}-${i}`,
    module, stem: `合成验收题 ${m + 1}-${i + 1}：两本练习册共多少钱？`,
    material: '每本练习册 12 元。', options: { A: '12 元', B: '18 元', C: '20 元', D: '24 元' }, answer: 'D',
    images: i % 2 === 0 ? [{ path: relative, role: 'stem' }] : [], analysis: '12 × 2 = 24 元。',
  })));
  const rows = compileImport({ schemaVersion: '1.0', bankId: 'ci-fixture', questions }, new Map([[relative, { path: relative, width: 1, height: 1 }]]));
  const dataPath = path.join(root, 'questions.jsonl'), bundle = path.join(root, 'bundle');
  fs.writeFileSync(dataPath, rows.map(q => JSON.stringify(q)).join('\n') + '\n');
  packageResources({ dataPath, imagesPath: path.join(root, 'assets/images'), output: bundle });
  return { dataPath, bundle };
}
