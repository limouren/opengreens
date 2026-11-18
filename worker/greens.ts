const base = 'https://app.greenycoins.gov.hk/customer/api/v1/';
// GREENS' CDN blocks requests without a User-Agent. These headers match the official app.
const appHeaders = {
  'User-Agent': 'Dart/3.7 (dart:io)',
  'Accept-Encoding': 'gzip',
  'Content-Type': 'application/json',
  'Accept-Language': 'en',
};

/** GREENS answered with an HTTP error. */
export class GreensRejected extends Error {
  constructor(readonly status: number, readonly retryAfter: number | null) {
    super(`GREENS rejected the request (HTTP ${status}).`);
  }
}

/** GREENS could not be reached, or its reply was not in the expected format. */
export class GreensUnavailable extends Error {}

function retryDelay(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 60;
}

async function call(path: string, { token, body }: { token?: string; body?: object } = {}): Promise<unknown> {
  const headers: Record<string, string> = { ...appHeaders };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body && JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new GreensUnavailable('Could not reach GREENS.', { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GreensRejected(response.status, retryDelay(response.headers.get('Retry-After')));
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new GreensUnavailable('GREENS did not return JSON.', { cause: error });
    }
    throw error;
  }
}

function field<T>(data: unknown, key: string, check: (value: unknown) => value is T): T {
  const value = (data as Record<string, unknown> | null)?.[key];
  if (!check(value)) {
    throw new GreensUnavailable(`GREENS returned an unusable "${key}".`);
  }
  return value;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isId = (value: unknown): value is number => Number.isSafeInteger(value);
const isTtl = (value: unknown): value is number => typeof value === 'number' && value > 0 && Number.isFinite(value);

export async function sendSms(mobile: string): Promise<void> {
  await call('verify_code', { body: { mobile, zone: '852' } });
}

export async function signIn(mobile: string, code: string, deviceId: string) {
  const data = await call('sessions', { body: { mobile, verify_code: code, device_id: deviceId } });
  return {
    greensId: field(data, 'id', isId),
    accessToken: field(data, 'access_token', isText),
    refreshToken: field(data, 'refresh_token', isText),
  };
}

/** GREENS checks only the refresh token, so an expired access token is fine here. */
export async function refresh(accessToken: string, refreshToken: string): Promise<string> {
  const data = await call('sessions/refresh', { token: accessToken, body: { refresh_token: refreshToken } });
  return field(data, 'access_token', isText);
}

export async function dynamicQrEnabled(accessToken: string): Promise<boolean> {
  const data = await call('dynamic_qrcode/setting', { token: accessToken });
  return (data as { enabled?: unknown } | null)?.enabled === true;
}

export async function dynamicQr(accessToken: string) {
  const data = await call('dynamic_qrcode', { token: accessToken });
  return { token: field(data, 'token', isText), ttl: field(data, 'ttl', isTtl) };
}

/** Returns the JWT expiry in Unix milliseconds, or null if the token does not state one. */
export function accessTokenExpiry(accessToken: string): number | null {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof DOMException) {
      return null;
    }
    throw error;
  }
}
