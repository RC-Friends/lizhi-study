export const SKILL_NAME = 'lizhi-study-observer';
export const SKILL_FILES = ['SKILL.md', 'references/api.md', 'agents/openai.yaml'];
const MARKER = '__LIZHI_SITE_URL__';

export function siteOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('站点地址须为 HTTP 或 HTTPS 地址。');
  return url.origin;
}

export function skillUrl(origin) { return `${siteOrigin(origin)}/skills/${SKILL_NAME}/SKILL.md`; }
export function bindSkill(text, origin) { return text.replaceAll(MARKER, siteOrigin(origin)); }
export function observerPrompt(origin, question) {
  return `请使用栗知学习观察员技能，以游客身份查看学习情况。\n站点：${siteOrigin(origin)}\n先读取技能说明：${skillUrl(origin)}\n只查询公开数据，不需要登录、口令或 API Key。\n\n${question}\n请注明查询时间、统计区间、样本量和来源链接；没有数据时明确说明。`;
}

export async function loadSkillFiles(origin, signal) {
  return Promise.all(SKILL_FILES.map(async name => {
    const response = await fetch(`${siteOrigin(origin)}/skills/${SKILL_NAME}/${name}`, { credentials: 'omit', signal, cache: 'no-cache' });
    if (!response.ok) throw new Error('技能文件暂时无法加载，请重试。');
    const text = await response.text();
    if (/^\s*<!doctype html/i.test(text) || (name === 'SKILL.md' && !text.startsWith('---\n'))) throw new Error('技能文件未正确发布，请稍后重试。');
    return { name: `${SKILL_NAME}/${name}`, text: bindSkill(text, origin) };
  }));
}

// Small, dependency-free ZIP (stored entries). Skills are only a few KB; no
// compression worker or server-generated archive is needed. UTF-8 throughout.
export function skillZip(files) {
  const encoder = new TextEncoder(), local = [], central = [];
  let offset = 0, directorySize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), body = encoder.encode(file.text);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, body.length, true);
    h.setUint32(22, body.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    const entry = new Uint8Array(46 + name.length), e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true);
    e.setUint16(8, 0x800, true); e.setUint16(14, 33, true); e.setUint32(16, crc, true);
    e.setUint32(20, body.length, true); e.setUint32(24, body.length, true); e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true); entry.set(name, 46);
    local.push(header, body); central.push(entry); offset += header.length + body.length; directorySize += entry.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}

export function saveDownload(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
