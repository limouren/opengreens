import './style.css';
import QRCode from 'qrcode';
import { api, ApiError, registerServiceWorker } from './api';

interface QrResponse {
  token: string;
  ttl: number;
  mobileSuffix: string;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = byId<HTMLCanvasElement>('qr');
const placeholder = byId<HTMLParagraphElement>('placeholder');
const countdown = byId<HTMLParagraphElement>('countdown');
const refreshButton = byId<HTMLButtonElement>('refresh');
const status = byId<HTMLParagraphElement>('status');
const linkId = location.pathname.split('/')[2];

let deadline: number | undefined;
let busy = false;
let timer: number | undefined;
let wakeLock: WakeLockSentinel | undefined;

function showQr(visible: boolean, message = ''): void {
  canvas.hidden = !visible;
  placeholder.hidden = visible;
  placeholder.textContent = message;
}

async function keepScreenOn(): Promise<void> {
  if (!('wakeLock' in navigator) || document.hidden || canvas.hidden || (wakeLock && !wakeLock.released)) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (error) {
    // The browser may refuse, for example in battery saver mode. The QR code still works.
    if (!(error instanceof DOMException)) {
      throw error;
    }
  }
}

function tick(): void {
  clearTimeout(timer);
  if (deadline === undefined) {
    countdown.textContent = '';
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    deadline = undefined;
    showQr(false, '二維碼已過期。');
    countdown.textContent = '';
    if (!document.hidden) {
      void load();
    }
    return;
  }
  countdown.textContent = `${Math.ceil(remaining / 1000)} 秒後自動更新`;
  timer = window.setTimeout(tick, remaining % 1000 || 1000);
}

async function load(): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  refreshButton.disabled = true;
  status.textContent = '正在載入二維碼…';
  try {
    const qr = await api<QrResponse>(`/api/s/${linkId}/qr`);
    const receivedAt = Date.now();
    // Byte mode keeps the exact UTF-8 bytes of the token that GREENS issued.
    await QRCode.toCanvas(canvas, [{ data: new TextEncoder().encode(qr.token), mode: 'byte' }], { width: 640 });
    deadline = receivedAt + qr.ttl * 1000;
    byId('owner').textContent = `賬戶尾號 ${qr.mobileSuffix}`;
    showQr(true);
    status.textContent = '';
    void keepScreenOn();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    deadline = undefined;
    showQr(false, '沒有可顯示的二維碼。');
    status.textContent = error.message;
  } finally {
    busy = false;
    refreshButton.disabled = false;
    tick();
  }
}

refreshButton.addEventListener('click', () => void load());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    return;
  }
  if (deadline === undefined) {
    void load();
  } else {
    tick();
    void keepScreenOn();
  }
});

void load();
registerServiceWorker();
