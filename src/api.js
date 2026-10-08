const STORAGE_KEY = 'xingce-duel.match.v1';
const SESSION_KEY = 'xingce-study.session.v1';
const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const write = (key, value) => value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key);
export const savedMatch = () => read(STORAGE_KEY);
export const saveMatch = value => write(STORAGE_KEY, value);
export const savedSession = () => read(SESSION_KEY);
export const saveSession = value => write(SESSION_KEY, value);
const headers = (token, json = false) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(savedSession()?.token ? { Authorization: `Bearer ${savedSession().token}` } : {}), ...(token ? { 'X-Match-Token': token } : {}) });
async function failure(response, login = false) {
  const data = await response.json().catch(() => ({}));
  const error = new Error(data.error?.message || '请求暂时失败，请稍后重试。');
  error.code = data.error?.code; error.status = response.status;
  if (response.status === 401 && !login && savedSession()) window.dispatchEvent(new Event('learner-session-expired'));
  throw error;
}
export async function api(url, { method = 'GET', body, token, signal } = {}) {
  let response;
  try {
    const timeout = AbortSignal.timeout(20000);
    response = await fetch(url, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: headers(token, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('网络响应有点慢，请稍后重试。');
    if (error.name === 'TypeError') throw new Error('暂时连不上自习室，请检查网络后重试。');
    throw error;
  }
  if (!response.ok) return failure(response, url === '/api/login');
  return response.json();
}
async function events(response, signal, onEvent) {
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read(); if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const lines = block.split('\n'), type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (type && data) onEvent(type, JSON.parse(data));
      }
    }
  } finally { reader.releaseLock(); }
}
export async function streamMatch(credentials, signal, onEvent) {
  const response = await fetch(`/api/matches/${credentials.id}/events`, { signal, headers: headers(credentials.token) });
  if (!response.ok) return failure(response);
  await events(response, signal, onEvent);
  if (!signal.aborted) throw new Error('练习连接已断开');
}
export async function streamCoach(id, index, message, signal, onEvent) {
  const response = await fetch(`/api/matches/${id}/coach`, { method: 'POST', signal, headers: headers(null, true), body: JSON.stringify({ index, message }) });
  if (!response.ok) return failure(response);
  let complete = false;
  await events(response, signal, (type, data) => {
    if (type === 'error') throw new Error(data.message);
    if (type === 'complete') complete = true;
    onEvent(type, data);
  });
  if (!complete && !signal.aborted) throw new Error('回复连接中断，已完成的聊天仍会保留。');
}
