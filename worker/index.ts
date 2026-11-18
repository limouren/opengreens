import { v1 as uuidV1 } from 'uuid';
import {
  accessTokenExpiry,
  dynamicQr,
  dynamicQrEnabled,
  GreensRejected,
  GreensUnavailable,
  refresh,
  sendSms,
  signIn,
} from './greens';

interface Account {
  greens_id: number;
  mobile: string;
  device_id: string;
  link_id: string;
  refresh_token: string;
  access_token: string;
  access_expires_at: number | null;
  needs_reauth: number;
}

const sessionCookie = '__Host-session';
const sessionLifetime = 400 * 24 * 60 * 60 * 1000;
const refreshMargin = 60 * 1000;
const linkPattern = /^\/s\/([A-Za-z0-9_-]{22})(\/manifest\.webmanifest)?$/;
const contentSecurityPolicy = [
  "default-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: HeadersInit = {}) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function randomId(bytes: number): string {
  const value = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function cookieHeader(value: string, maxAge: number): string {
  return `${sessionCookie}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function readSessionToken(request: Request): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === sessionCookie && value) {
      return value;
    }
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  throw new HttpError(400, '請求格式不正確。');
}

function readMobile(input: Record<string, unknown>): string {
  const mobile = input.mobile;
  if (typeof mobile !== 'string' || !/^[4-9]\d{7}$/.test(mobile)) {
    throw new HttpError(400, '請輸入以 4 至 9 開頭的 8 位數字香港手機號碼。');
  }
  return mobile;
}

/** Turns GREENS failures into messages for the user. */
function greensError(error: unknown, rejectedMessage: (status: number) => string): HttpError {
  if (error instanceof GreensUnavailable) {
    return new HttpError(502, '暫時未能連接綠綠賞，請稍後再試。');
  }
  if (error instanceof GreensRejected) {
    if (error.status === 429 || (error.status === 503 && error.retryAfter !== null)) {
      const seconds = error.retryAfter ?? 60;
      return new HttpError(429, '綠綠賞暫時限制請求，請稍候再試。', { 'Retry-After': String(seconds) });
    }
    return new HttpError(502, rejectedMessage(error.status));
  }
  throw error;
}

async function createSession(env: Env, greensId: number): Promise<string> {
  const token = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, greens_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), greensId, Date.now() + sessionLifetime)
    .run();
  return cookieHeader(token, sessionLifetime / 1000);
}

/** Returns the signed-in account and extends the session, so A stays signed in while using the app. */
async function currentAccount(request: Request, env: Env): Promise<{ account: Account; cookie: string } | null> {
  const token = readSessionToken(request);
  if (!token) {
    return null;
  }
  const idHash = await sha256(token);
  const account = await env.DB.prepare(
    'SELECT accounts.* FROM sessions JOIN accounts USING (greens_id) WHERE id_hash = ? AND expires_at > ?',
  ).bind(idHash, Date.now()).first<Account>();
  if (!account) {
    return null;
  }
  await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?')
    .bind(Date.now() + sessionLifetime, idHash)
    .run();
  return { account, cookie: cookieHeader(token, sessionLifetime / 1000) };
}

function accountView(account: Account, origin: string) {
  return {
    mobile: account.mobile,
    link: `${origin}/s/${account.link_id}`,
    needsReauth: account.needs_reauth === 1,
  };
}

async function handleSms(request: Request): Promise<Response> {
  const mobile = readMobile(await readJson(request));
  try {
    await sendSms(mobile);
  } catch (error) {
    throw greensError(error, status => `綠綠賞未能發送驗證碼（HTTP ${status}）。請檢查手機號碼。`);
  }
  return json({ sent: true });
}

async function handleSignIn(request: Request, env: Env): Promise<Response> {
  const input = await readJson(request);
  const mobile = readMobile(input);
  const code = input.code;
  if (typeof code !== 'string' || !code.trim() || code.length > 128) {
    throw new HttpError(400, '請輸入短訊驗證碼。');
  }

  const known = await env.DB.prepare('SELECT device_id FROM accounts WHERE mobile = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(mobile)
    .first<{ device_id: string }>();
  const deviceId = known?.device_id ?? uuidV1();
  let session;
  try {
    session = await signIn(mobile, code.trim(), deviceId);
  } catch (error) {
    throw greensError(error, status => [400, 401, 422].includes(status)
      ? '驗證碼不正確或已失效。請重新輸入，或重新發送驗證碼。'
      : `綠綠賞未能完成登入（HTTP ${status}）。`);
  }

  const now = Date.now();
  // The link ID is set only when the account is first created, so the share link never changes.
  await env.DB.prepare(`
    INSERT INTO accounts (greens_id, mobile, device_id, link_id, refresh_token, access_token,
      access_expires_at, needs_reauth, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT (greens_id) DO UPDATE SET
      mobile = excluded.mobile,
      device_id = excluded.device_id,
      refresh_token = excluded.refresh_token,
      access_token = excluded.access_token,
      access_expires_at = excluded.access_expires_at,
      needs_reauth = 0,
      updated_at = excluded.updated_at
  `).bind(session.greensId, mobile, deviceId, randomId(16), session.refreshToken, session.accessToken,
    accessTokenExpiry(session.accessToken), now, now).run();

  const cookie = await createSession(env, session.greensId);
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE greens_id = ?')
    .bind(session.greensId)
    .first<Account>();
  return json({ account: accountView(account!, new URL(request.url).origin) }, 200, { 'Set-Cookie': cookie });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const current = await currentAccount(request, env);
  if (!current) {
    return json({ account: null });
  }
  return json({ account: accountView(current.account, new URL(request.url).origin) }, 200,
    { 'Set-Cookie': current.cookie });
}

async function handleSignOut(request: Request, env: Env): Promise<Response> {
  const token = readSessionToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(token)).run();
  }
  return json({ signedOut: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
}

async function findLink(env: Env, linkId: string): Promise<Account> {
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE link_id = ?').bind(linkId).first<Account>();
  if (!account) {
    throw new HttpError(404, '此連結無效。請向賬戶持有人索取正確連結。');
  }
  return account;
}

const reauthMessage = '賬戶持有人的綠綠賞登入已失效。請通知對方重新登入。';

async function renewAccessToken(env: Env, account: Account): Promise<string> {
  let accessToken;
  try {
    accessToken = await refresh(account.access_token, account.refresh_token);
  } catch (error) {
    if (error instanceof GreensRejected && error.status >= 400 && error.status < 500 && error.status !== 429) {
      await env.DB.prepare('UPDATE accounts SET needs_reauth = 1, updated_at = ? WHERE greens_id = ?')
        .bind(Date.now(), account.greens_id)
        .run();
      throw new HttpError(409, reauthMessage);
    }
    throw error;
  }
  await env.DB.prepare('UPDATE accounts SET access_token = ?, access_expires_at = ?, updated_at = ? WHERE greens_id = ?')
    .bind(accessToken, accessTokenExpiry(accessToken), Date.now(), account.greens_id)
    .run();
  return accessToken;
}

async function fetchQr(accessToken: string) {
  if (!(await dynamicQrEnabled(accessToken))) {
    throw new HttpError(409, '綠綠賞未為此賬戶啟用動態二維碼。');
  }
  return dynamicQr(accessToken);
}

async function handleQr(env: Env, linkId: string): Promise<Response> {
  const account = await findLink(env, linkId);
  if (account.needs_reauth) {
    throw new HttpError(409, reauthMessage);
  }
  try {
    let accessToken = account.access_token;
    if (account.access_expires_at !== null && account.access_expires_at - Date.now() < refreshMargin) {
      accessToken = await renewAccessToken(env, account);
    }
    let qr;
    try {
      qr = await fetchQr(accessToken);
    } catch (error) {
      const unauthorized = error instanceof GreensRejected && (error.status === 401 || error.status === 403);
      if (!unauthorized || accessToken !== account.access_token) {
        throw error;
      }
      qr = await fetchQr(await renewAccessToken(env, account));
    }
    return json({ ...qr, mobileSuffix: account.mobile.slice(-4) });
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw greensError(error, status => `綠綠賞未能提供二維碼（HTTP ${status}）。`);
  }
}

async function handleManifest(env: Env, linkId: string): Promise<Response> {
  const account = await findLink(env, linkId);
  const path = `/s/${linkId}`;
  const manifest = {
    id: path,
    name: `綠綠賞二維碼（尾號 ${account.mobile.slice(-4)}）`,
    short_name: '綠綠賞二維碼',
    lang: 'zh-Hant-HK',
    start_url: path,
    scope: path,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#17603e',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  return json(manifest, 200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
}

async function handleSharePage(request: Request, env: Env, linkId: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/share', request.url));
  // Each link has its own manifest, so the installed app opens that link.
  const manifest = `<link rel="manifest" href="/s/${linkId}/manifest.webmanifest">`;
  return new HTMLRewriter()
    .on('head', { element: element => void element.append(manifest, { html: true }) })
    .transform(page);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname.startsWith('/api/')) {
    const origin = request.headers.get('Origin');
    if (method === 'POST' && origin !== null && origin !== url.origin) {
      throw new HttpError(403, '不接受來自其他網站的請求。');
    }
    const qrMatch = /^\/api\/s\/([A-Za-z0-9_-]{22})\/qr$/.exec(pathname);
    if (method === 'GET' && qrMatch) {
      return handleQr(env, qrMatch[1]);
    }
    const handlers: Record<string, [string, () => Promise<Response>]> = {
      '/api/sms': ['POST', () => handleSms(request)],
      '/api/sign-in': ['POST', () => handleSignIn(request, env)],
      '/api/me': ['GET', () => handleMe(request, env)],
      '/api/sign-out': ['POST', () => handleSignOut(request, env)],
    };
    const handler = handlers[pathname];
    if (!handler || handler[0] !== method) {
      throw new HttpError(404, '找不到此功能。');
    }
    return handler[1]();
  }

  const linkMatch = linkPattern.exec(pathname);
  if (linkMatch && method === 'GET') {
    return linkMatch[2] ? handleManifest(env, linkMatch[1]) : handleSharePage(request, env, linkMatch[1]);
  }
  return env.ASSETS.fetch(request);
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  // Share links work like passwords, so never leak them in the Referer header.
  secured.headers.set('Referrer-Policy', 'no-referrer');
  if (!import.meta.env.DEV) {
    secured.headers.set('Content-Security-Policy', contentSecurityPolicy);
  }
  return secured;
}

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      response = json({ error: error.message }, error.status, error.headers);
    }
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
