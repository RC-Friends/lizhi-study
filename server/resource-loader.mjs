import fs from 'node:fs';
import path from 'node:path';
import { QuestionBank } from './bank.mjs';
import { ObjectResources } from './object-resources.mjs';
import { verifyResourceFiles, verifyResources } from './resources.mjs';

export async function loadQuestionResources(config) {
  if (config.resourceDriver === 's3') {
    const resources = new ObjectResources(config.s3, config.resourceVersion);
    try {
      const bank = new QuestionBank(null, await resources.load());
      config.questionResources = resources; config.llm.questionResources = resources;
      return { bank, resources };
    } catch (error) { resources.close(); throw error; }
  }
  if (config.resourceDriver && config.resourceDriver !== 'files') throw new Error('RESOURCE_DRIVER 必须为 s3 或 files。');
  const bank = new QuestionBank(config.dataPath);
  verifyResourceFiles(bank.rows, config.imagesPath);
  const directory = path.dirname(config.dataPath);
  if (config.resourceVersion || fs.existsSync(path.join(directory, 'manifest.json'))) {
    const manifest = verifyResources(directory);
    if (config.resourceVersion && manifest.version !== config.resourceVersion) throw new Error('资源包版本与配置不一致。');
    if (fs.realpathSync(config.imagesPath) !== fs.realpathSync(path.join(directory, 'assets/images'))) throw new Error('题库和题图必须来自同一个资源版本。');
  }
  return { bank, resources: null };
}
