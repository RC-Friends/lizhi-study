import crypto from 'node:crypto';
import { HttpError } from './bank.mjs';

const ISSUER = 'xingce-duel';
const AUDIENCE = 'xingce-duel:learner';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function decode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new Error('Non-canonical encoding');
  const object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Invalid object');
  return object;
}

/** Two fixed identities: one learner and one optional site administrator. */
export function createAuth(config, { now = Date.now } = {}) {
  const password = config.sitePassword;
  const secret = config.jwtSecret;
  const ttl = config.jwtTtlSeconds ?? 30 * 86400;
  const adminPassword = config.adminPassword || '';
  if (adminPassword && (typeof adminPassword !== 'string' || adminPassword.trim().length < 12 || adminPassword === password || adminPassword === secret)) {
    throw new Error('SUPERADMIN_PASSWORD 须为独立的至少 12 个字符的口令，不能复用考生口令或 JWT 密钥。');
  }
  if (typeof password !== 'string' || password.trim().length < 8) {
    throw new Error('请在 .env 配置至少 8 个字符的 SITE_PASSWORD。游客访问不会绕过考生登录。');
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('请在 .env 配置至少 32 字节的独立随机 JWT_SECRET。');
  }
  if (!Number.isSafeInteger(ttl) || ttl < 3600 || ttl > 90 * 86400) {
    throw new Error('JWT_TTL_DAYS 必须对应 1 小时至 90 天的有效期。');
  }
  const profile = Object.freeze({ id: 'primary', name: config.profileName || '备考同学' });
  const version = crypto.createHmac('sha256', secret).update(`account-version:${password}`).digest('base64url');
  const adminVersion = crypto.createHmac('sha256', secret).update(`admin-version:${adminPassword}`).digest('base64url');
  const adminProfile = Object.freeze({ id: 'superadmin', name: '超级管理员' });
  const signature = input => crypto.createHmac('sha256', secret).update(input).digest('base64url');
  const publicSession = claims => claims ? {
    authenticated: true, role: claims.role, profile: claims.role === 'admin' ? adminProfile : profile, expiresAt: new Date(claims.exp * 1000).toISOString(),
  } : { authenticated: false, role: 'visitor', profile };

  function verify(token) {
    try {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [head, body, signed] = parts;
      // Always use our configured HS256 key. Never resolve algorithms or keys
      // from an untrusted header (including alg=none, jku, jwk, and crit).
      const header = decode(head);
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || Object.keys(header).length !== 2) return null;
      if (!/^[A-Za-z0-9_-]{43}$/.test(signed) || !same(signed, signature(`${head}.${body}`))) return null;
      const claims = decode(body), seconds = Math.floor(now() / 1000);
      if (!['learner', 'admin'].includes(claims.role)) return null;
      const admin = claims.role === 'admin';
      if (admin && !adminPassword) return null;
      if (claims.iss !== ISSUER || claims.aud !== (admin ? 'xingce-duel:admin' : AUDIENCE) || claims.sub !== (admin ? adminProfile.id : profile.id)) return null;
      if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
      if (claims.iat > seconds + 30 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > ttl) return null;
      if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) return null;
      if (typeof claims.ver !== 'string' || !same(claims.ver, admin ? adminVersion : version)) return null;
      if (typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.jti)) return null;
      return claims;
    } catch { return null; }
  }

  function login(candidate, role = 'learner') {
    if (!['learner', 'admin'].includes(role)) throw new HttpError(400, '登录身份无效。', 'invalid_role');
    if (role === 'admin' && !adminPassword) throw new HttpError(403, '站点尚未启用管理员登录。', 'admin_disabled');
    if (typeof candidate !== 'string' || candidate.length > 512 || !same(candidate, role === 'admin' ? adminPassword : password)) {
      throw new HttpError(401, '口令不正确，请再试一次。', 'invalid_password');
    }
    const seconds = Math.floor(now() / 1000);
    const claims = { iss: ISSUER, aud: role === 'admin' ? 'xingce-duel:admin' : AUDIENCE, sub: role === 'admin' ? adminProfile.id : profile.id, role,
      iat: seconds, exp: seconds + ttl, jti: crypto.randomUUID(), ver: role === 'admin' ? adminVersion : version };
    const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
    return { token: `${input}.${signature(input)}`, ...publicSession(claims) };
  }

  function requireToken(token) {
    const claims = verify(token);
    if (!claims) throw new HttpError(401, '请用考生口令登录后继续。', 'login_required');
    return claims;
  }
  function requireAdmin(token) {
    const claims = requireToken(token);
    if (claims.role !== 'admin') throw new HttpError(403, '此操作需要超级管理员身份。', 'admin_required');
    return claims;
  }
  return { enabled: true, adminEnabled: Boolean(adminPassword), profile, login, verify, requireToken, requireAdmin, publicSession };
}
