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

/** A single learner account; visitors never receive a learner token. */
export function createAuth(config, { now = Date.now } = {}) {
  const password = config.sitePassword;
  const secret = config.jwtSecret;
  const ttl = config.jwtTtlSeconds ?? 30 * 86400;
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
  const signature = input => crypto.createHmac('sha256', secret).update(input).digest('base64url');
  const publicSession = claims => claims ? {
    authenticated: true, role: 'learner', profile, expiresAt: new Date(claims.exp * 1000).toISOString(),
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
      if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.sub !== profile.id || claims.role !== 'learner') return null;
      if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
      if (claims.iat > seconds + 30 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > ttl) return null;
      if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) return null;
      if (typeof claims.ver !== 'string' || !same(claims.ver, version)) return null;
      if (typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.jti)) return null;
      return claims;
    } catch { return null; }
  }

  function login(candidate) {
    if (typeof candidate !== 'string' || candidate.length > 512 || !same(candidate, password)) {
      throw new HttpError(401, '口令不正确，请再试一次。', 'invalid_password');
    }
    const seconds = Math.floor(now() / 1000);
    const claims = { iss: ISSUER, aud: AUDIENCE, sub: profile.id, role: 'learner',
      iat: seconds, exp: seconds + ttl, jti: crypto.randomUUID(), ver: version };
    const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
    return { token: `${input}.${signature(input)}`, ...publicSession(claims) };
  }

  function requireToken(token) {
    const claims = verify(token);
    if (!claims) throw new HttpError(401, '请用考生口令登录后继续。', 'login_required');
    return claims;
  }
  return { enabled: true, profile, login, verify, requireToken, publicSession };
}
