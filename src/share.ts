import './style.css';
import QRCode from 'qrcode';
import { api, ApiError, registerServiceWorker } from './api';

interface QrResponse {
  token: string;
  ttl: number;
  mobileSuffix: string;
}

const byId = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
const qrButton = byId<HTMLButtonElement>('qr-button');
const canvas = byId<HTMLCanvasElement>('qr');
const spinner = byId<HTMLSpanElement>('spinner');
const retryIcon = byId<SVGElement>('retry');
const countdown = byId<HTMLProgressElement>('countdown');
const status = byId<HTMLParagraphElement>('status');
const linkId = location.pathname.split('/')[2];

let deadline: number | undefined;
let hasQr = false;
let busy = false;
let timer: number | undefined;
let wakeLock: WakeLockSentinel | undefined;

function render(): void {
  const live = deadline !== undefined;
  canvas.hidden = !hasQr;
  canvas.classList.toggle('opacity-20', busy || !live);
  canvas.classList.toggle('blur-sm', busy || !live);
  spinner.hidden = !busy;
  retryIcon.toggleAttribute('hidden', busy || live);
  qrButton.disabled = busy;
  countdown.classList.toggle('invisible', !live && !busy);
  if (busy) {
    // Without a value, the progress bar shows its loading animation.
    countdown.removeAttribute('value');
  }
}

async function keepScreenOn(): Promise<void> {
  if (!('wakeLock' in navigator) || document.hidden || deadline === undefined || (wakeLock && !wakeLock.released)) {
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
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    deadline = undefined;
    render();
    if (!document.hidden) {
      void load();
    }
    return;
  }
  countdown.value = remaining;
  timer = window.setTimeout(tick, remaining % 1000 || 1000);
}

async function load(): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  clearTimeout(timer);
  status.textContent = '';
  render();
  try {
    const qr = await api<QrResponse>(`/api/s/${linkId}/qr`);
    const receivedAt = Date.now();
    // Byte mode keeps the exact UTF-8 bytes of the token that GREENS issued.
    await QRCode.toCanvas(canvas, [{ data: new TextEncoder().encode(qr.token), mode: 'byte' }], { width: 640 });
    deadline = receivedAt + qr.ttl * 1000;
    countdown.max = qr.ttl * 1000;
    byId('owner').textContent = `•••• ${qr.mobileSuffix}`;
    hasQr = true;
    void keepScreenOn();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    deadline = undefined;
    hasQr = false;
    status.textContent = error.message;
  } finally {
    busy = false;
    render();
    tick();
  }
}

qrButton.addEventListener('click', () => void load());
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
