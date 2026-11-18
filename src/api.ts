export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: number | null) {
    super(message);
  }
}

export async function api<T>(path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError('未能連接伺服器，請檢查網絡連線。', 0, null);
    }
    throw error;
  }
  if (response.ok) {
    return response.json();
  }

  let message = `伺服器出錯（HTTP ${response.status}），請稍後再試。`;
  if (response.headers.get('Content-Type')?.startsWith('application/json')) {
    const data = await response.json();
    if (typeof data?.error === 'string') {
      message = data.error;
    }
  }
  const retryAfter = Number(response.headers.get('Retry-After'));
  throw new ApiError(message, response.status, retryAfter > 0 ? retryAfter : null);
}

export function registerServiceWorker(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js');
  }
}
