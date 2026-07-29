/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Runtime inputs documented by this file, its public API, and adjacent documentation.
 * [OUTPUT]: The exports or executable behavior implemented by this file.
 * [POS]: src/system/auth.mjs in termux-os-framework.
 * [PROTOCOL]: Keep this English header synchronized with behavior and public contracts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'tos_session';
const SESSION_SCHEMA = 'termux-os.browser-sessions.v1';
const sessions = new Map();
const failures = new Map();

let config = {
  password: '',
  apiToken: '',
  auditPath: null,
  sessionPath: null,
  authFingerprint: '',
  ttlMs: 12 * 60 * 60 * 1000,
};

const equalSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const cookieMap = (header = '') => Object.fromEntries(header.split(';').map((part) => {
  const i = part.indexOf('=');
  if (i < 0) return [part.trim(), ''];
  const raw = part.slice(i + 1).trim();
  try { return [part.slice(0, i).trim(), decodeURIComponent(raw)]; }
  catch { return [part.slice(0, i).trim(), raw]; }
}).filter(([key]) => key));

const auditFailure = (remote, reason) => {
  if (!config.auditPath) return;
  try {
    fs.mkdirSync(path.dirname(config.auditPath), { recursive: true });
    fs.appendFileSync(config.auditPath, `${JSON.stringify({
      schema: 'termux-os.auth-login-failure.v1',
      at: new Date().toISOString(),
      remote: remote || 'unknown',
      reason,
    })}\n`, { mode: 0o600 });
  } catch {
    // 登录仍按认证结果返回；审计存储错误不可以把正确密码变成错误密码。
  }
};

// Cookie values are bearer credentials. The only persistent copy stays in Termux private Home, and a
// password fingerprint makes an administrator password rotation invalidate every restored Session.
const authFingerprint = (password) => crypto.createHash('sha256').update(password).digest('hex');

const validStoredSession = (item, now = Date.now()) => item
  && typeof item.id === 'string' && item.id.length >= 32
  && typeof item.csrf === 'string' && item.csrf.length >= 24
  && Array.isArray(item.permissions) && item.permissions.includes('read') && item.permissions.includes('write')
  && Number.isFinite(item.createdAt) && Number.isFinite(item.lastSeen)
  && now - item.lastSeen <= config.ttlMs;

const persistSessions = () => {
  if (!config.sessionPath) return;
  try {
    fs.mkdirSync(path.dirname(config.sessionPath), { recursive: true, mode: 0o700 });
    const tmp = `${config.sessionPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({
      schema: SESSION_SCHEMA,
      auth_fingerprint: config.authFingerprint,
      sessions: [...sessions.values()].map(({ id, csrf, permissions, createdAt, lastSeen }) => ({
        id, csrf, permissions, createdAt, lastSeen,
      })),
      saved_at: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, config.sessionPath);
    fs.chmodSync(config.sessionPath, 0o600);
  } catch {
    // Session persistence cannot make a correct Login fail. The in-process Session remains usable.
  }
};

const restoreSessions = () => {
  if (!config.sessionPath) return;
  try {
    const stored = JSON.parse(fs.readFileSync(config.sessionPath, 'utf8'));
    if (stored?.schema !== SESSION_SCHEMA) return;
    if (stored.auth_fingerprint !== config.authFingerprint) {
      persistSessions(); // password rotation must not permit an old Session to revive if it later rotates back
      return;
    }
    for (const item of stored.sessions ?? []) {
      if (validStoredSession(item)) sessions.set(item.id, {
        id: item.id,
        csrf: item.csrf,
        permissions: [...item.permissions],
        createdAt: item.createdAt,
        lastSeen: item.lastSeen,
        lastPersistedAt: item.lastSeen,
      });
    }
  } catch {
    // Missing/corrupt/private-store-unavailable means a fresh Login, never a startup failure.
  }
};

const prune = (now = Date.now()) => {
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > config.ttlMs) sessions.delete(id);
  }
  for (const [remote, times] of failures) {
    const live = times.filter((t) => now - t < 60_000);
    if (live.length) failures.set(remote, live);
    else failures.delete(remote);
  }
};

export function configureBrowserAuth(opts = {}) {
  config = {
    password: String(opts.password ?? ''),
    apiToken: String(opts.apiToken ?? opts.password ?? ''),
    auditPath: opts.auditPath ?? null,
    sessionPath: opts.sessionPath ?? null,
    authFingerprint: authFingerprint(String(opts.password ?? '')),
    ttlMs: Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 12 * 60 * 60 * 1000,
  };
  sessions.clear();
  failures.clear();
  restoreSessions();
}

/** Rotate credentials in-process after the private credential store is updated. */
export function updateBrowserAuth({ password = config.password, apiToken = config.apiToken,
  invalidateSessions = false } = {}) {
  config = {
    ...config,
    password: String(password ?? ''),
    apiToken: String(apiToken ?? ''),
    authFingerprint: authFingerprint(String(password ?? '')),
  };
  failures.clear();
  if (invalidateSessions) sessions.clear();
  persistSessions();
  return { ok: true, sessions: sessions.size };
}

/** Check a password supplied for a sensitive in-session action without creating a new Session. */
export const verifyBrowserPassword = (password) => equalSecret(password, config.password);

export function loginBrowser(password, remote = 'unknown') {
  const now = Date.now();
  prune(now);
  const recent = failures.get(remote) ?? [];
  if (recent.length >= 5) {
    auditFailure(remote, 'rate_limited');
    return { ok: false, status: 429, error: 'too_many_attempts' };
  }
  if (!equalSecret(password, config.password)) {
    failures.set(remote, [...recent, now]);
    auditFailure(remote, 'bad_password');
    return { ok: false, status: 401, error: 'invalid_credentials' };
  }
  failures.delete(remote);
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const session = {
    id, csrf, permissions: ['read', 'write'], createdAt: now, lastSeen: now, lastPersistedAt: now,
  };
  sessions.set(id, session);
  persistSessions();
  return { ok: true, status: 200, session };
}

/**
 * Mint a session without a password, for a request that came from this device.
 *
 * The administrator password exists to keep other machines out. On the phone itself there is
 * nobody else to keep out, and demanding it there only sends the user looking for a password they
 * were never shown. This is still a real session rather than a bypass, so CSRF continues to apply
 * to writes: another page on the device can send a request to loopback, but it cannot read the
 * token needed to make that request count.
 */
export function openLocalSession() {
  const now = Date.now();
  prune(now);
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const session = {
    id, csrf, permissions: ['read', 'write'], createdAt: now, lastSeen: now, lastPersistedAt: now, local: true,
  };
  sessions.set(id, session);
  persistSessions();
  return session;
}

export function authenticateRequest(req) {
  prune();
  const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  if (bearer && equalSecret(bearer, config.apiToken)) {
    return { kind: 'token', permissions: ['read', 'write'] };
  }
  const id = cookieMap(req.headers.cookie)[COOKIE];
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  session.lastSeen = Date.now();
  if (session.lastSeen - (session.lastPersistedAt ?? 0) >= 60_000) {
    session.lastPersistedAt = session.lastSeen;
    persistSessions();
  }
  return { kind: 'session', permissions: session.permissions, session };
}

export const hasPermission = (context, permission = 'read') =>
  Boolean(context?.permissions?.includes(permission));

export const csrfValid = (req, context) =>
  context?.kind !== 'session' || equalSecret(req.headers['x-csrf-token'], context.session.csrf);

export const browserSessionInfo = (context) => context?.kind === 'session' ? {
  ok: true,
  schema: 'termux-os.browser-session.v1',
  permissions: [...context.permissions],
  csrf_token: context.session.csrf,
  expires_in_seconds: Math.max(0, Math.round((config.ttlMs - (Date.now() - context.session.lastSeen)) / 1000)),
} : null;

export function logoutBrowser(context) {
  if (context?.kind !== 'session') return false;
  const removed = sessions.delete(context.session.id);
  if (removed) persistSessions();
  return removed;
}

export const sessionCookie = (session) =>
  `${COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(config.ttlMs / 1000)}`;

export const clearSessionCookie = () =>
  `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// node src/system/auth.mjs --self-test
if (process.argv.includes('--self-test')) {
  const os = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let fails = 0;
    const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fails++; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-selftest-'));
    const sessionPath = path.join(dir, 'browser-sessions.v1.json');
    configureBrowserAuth({ password: 'correct horse', apiToken: 'api-token', auditPath: path.join(dir, 'fail.jsonl'), sessionPath });
    t('current password verification accepts the current password', verifyBrowserPassword('correct horse'));
    t('current password verification rejects a different password', !verifyBrowserPassword('wrong horse'));
    t('bad password rejected', loginBrowser('wrong', 'test').status === 401);
    t('failure audited without password', fs.readFileSync(path.join(dir, 'fail.jsonl'), 'utf8').includes('bad_password')
      && !fs.readFileSync(path.join(dir, 'fail.jsonl'), 'utf8').includes('wrong'));
    const good = loginBrowser('correct horse', 'test');
    t('login creates opaque session', good.ok && good.session.id.length > 32);
    const req = { headers: { cookie: `${COOKIE}=${good.session.id}` } };
    const ctx = authenticateRequest(req);
    t('cookie authenticates read/write', ctx?.kind === 'session' && hasPermission(ctx, 'write'));
    configureBrowserAuth({ password: 'correct horse', apiToken: 'api-token', auditPath: path.join(dir, 'fail.jsonl'), sessionPath });
    t('private Session survives Framework process restart', authenticateRequest(req)?.kind === 'session');
    configureBrowserAuth({ password: 'rotated password', apiToken: 'api-token', auditPath: path.join(dir, 'fail.jsonl'), sessionPath });
    t('password rotation invalidates persisted Session', authenticateRequest(req) === null);
    configureBrowserAuth({ password: 'correct horse', apiToken: 'api-token', auditPath: path.join(dir, 'fail.jsonl'), sessionPath });
    const fresh = loginBrowser('correct horse', 'test');
    const restored = authenticateRequest({ headers: { cookie: `${COOKIE}=${fresh.session.id}` } });
    t('malformed cookie is rejected without throwing', authenticateRequest({ headers: { cookie: `${COOKIE}=%` } }) === null);
    t('csrf required and accepted', !csrfValid({ headers: {} }, restored)
      && csrfValid({ headers: { 'x-csrf-token': fresh.session.csrf } }, restored));
    t('bearer remains independent', authenticateRequest({ headers: { authorization: 'Bearer api-token' } })?.kind === 'token');
    t('logout invalidates session', logoutBrowser(restored)
      && authenticateRequest({ headers: { cookie: `${COOKIE}=${fresh.session.id}` } }) === null);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(fails ? 1 : 0);
  }
}
