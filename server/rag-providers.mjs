export const ragProviderReady = config => Boolean(config?.enabled && config.baseUrl && config.model && (config.authRequired === false || config.key));

export async function ragRequest(config, endpoint, payload, { signal, fetcher = fetch } = {}) {
  if (!config.baseUrl || !config.model || (config.authRequired !== false && !config.key)) throw new Error('检索模型未配置。');
  const timeout = AbortSignal.timeout(config.timeout || 15000);
  const response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.authRequired !== false ? { Authorization: `Bearer ${config.key}` } : {}) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout, body: JSON.stringify(payload),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`检索模型请求失败（HTTP ${response.status}）。`); }
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 16 * 1024 * 1024) throw new Error('检索模型返回内容过大。');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
