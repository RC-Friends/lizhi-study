import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.mjs';
import { QuestionBank } from '../server/bank.mjs';
import { PostgresStore, validateMatch, validateLearning } from '../server/storage.mjs';
import { sha256 } from '../server/resources.mjs';
import { loadQuestionResources } from '../server/resource-loader.mjs';

export function readLegacy(source, bank) {
  const directory = path.resolve(source), matchesPath = path.join(directory, 'matches');
  const files = fs.readdirSync(matchesPath).filter(name => name.endsWith('.json')).sort().map(name => `matches/${name}`);
  if (fs.existsSync(path.join(directory, 'learning.json'))) files.push('learning.json');
  const blobs = files.map(name => [name, fs.readFileSync(path.join(directory, name))]);
  const fingerprint = sha256(JSON.stringify(blobs.map(([name, bytes]) => [name, sha256(bytes)])));
  const matches = blobs.filter(([name]) => name.startsWith('matches/')).map(([, bytes]) => {
    const match = validateMatch(JSON.parse(bytes), bank);
    return { ...match, questionFingerprints: match.questionIds.map(id => bank.fingerprints.get(id)) };
  });
  if (new Set(matches.map(match => match.id)).size !== matches.length) throw new Error('源文件存在重复场次 ID，拒绝导入。');
  const learningBytes = blobs.find(([name]) => name === 'learning.json')?.[1];
  const learning = validateLearning(learningBytes ? JSON.parse(learningBytes) : { version: 1, profiles: {}, questions: {} }, bank);
  // Detect a source changing while it is read. The operator must still export a
  // quiescent snapshot; this is not a live replication mechanism.
  for (const [name, bytes] of blobs) if (!fs.readFileSync(path.join(directory, name)).equals(bytes)) throw new Error('源记录正在变化，请先取得停止写入后的备份。');
  const currentFiles = fs.readdirSync(matchesPath).filter(name => name.endsWith('.json')).sort().map(name => `matches/${name}`);
  if (JSON.stringify(currentFiles) !== JSON.stringify(files.filter(name => name.startsWith('matches/')))) throw new Error('源记录列表正在变化，请使用静态备份。');
  return { fingerprint, matches, learning };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.source) throw new Error('请通过 --source=运行数据备份目录 指定来源；默认仅校验，--apply 才写数据库。');
  const config = loadConfig();
  const { bank, resources } = config.resourceDriver === 's3' ? await loadQuestionResources(config) : { bank: new QuestionBank(config.dataPath), resources: null };
  try {
  const snapshot = readLegacy(values.source, bank);
  if (!values.apply) console.log(JSON.stringify({ dryRun: true, fingerprint: snapshot.fingerprint, matches: snapshot.matches.length,
    profiles: Object.keys(snapshot.learning.profiles).length, annotations: Object.values(snapshot.learning.questions).reduce((n, rows) => n + Object.keys(rows).length, 0) }));
  else {
    const store = await PostgresStore.open(config.databaseUrl, bank);
    try { console.log(JSON.stringify({ dryRun: false, ...await store.importLegacy(snapshot) })); }
    finally { await store.close(); }
  }
  } finally { resources?.close(); }
}
