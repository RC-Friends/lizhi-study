import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { verifyResources } from '../server/resources.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, url: { type: 'string' }, 'token-file': { type: 'string' } } });
try {
  if (!values.source || !values.url) throw new Error('使用 --source=资源包 --url=https://study.example.com；令牌使用 QUESTION_IMPORT_TOKEN 环境变量或 --token-file=本地令牌文件。');
  const url = new URL(values.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--url 只能包含站点协议、主机和端口。');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('非本机 HTTP 连接可能泄露管理令牌，请使用 HTTPS。');
  const token = values['token-file'] ? fs.readFileSync(values['token-file'], 'utf8').trim() : process.env.QUESTION_IMPORT_TOKEN;
  if (!token || token.length < 32) throw new Error('请提供至少 32 字符的 QUESTION_IMPORT_TOKEN；不要使用考生 JWT。');
  const directory = path.resolve(values.source), manifest = verifyResources(directory);
  const root = `${url.origin}/api/admin/question-bank/releases/${manifest.version}`;
  async function request(endpoint, { method = 'GET', body, type = 'application/json' } = {}) {
    // Never forward this privileged credential across redirects.
    const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body, redirect: 'error', signal: AbortSignal.timeout(600000) });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  }
  let cursor = 0, completed = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (cursor < manifest.files.length) {
      const file = manifest.files[cursor++];
      await request(`${root}/files?path=${encodeURIComponent(file.path)}`, { method: 'PUT', body: fs.readFileSync(path.join(directory, file.path)), type: 'application/octet-stream' });
      completed++; if (completed % 100 === 0) console.log(JSON.stringify({ uploaded: completed, total: manifest.files.length }));
    }
  }));
  const failed = outcomes.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  console.log(JSON.stringify(await request(root + '/publish', { method: 'POST', body: JSON.stringify(manifest) }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
