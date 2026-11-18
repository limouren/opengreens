import './style.css';
import { api, ApiError, registerServiceWorker } from './api';

interface AccountView {
  mobile: string;
  link: string;
  needsReauth: boolean;
}

type Action = 'me' | 'sms' | 'sign-in' | 'sign-out';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const part = <T extends Element>(parent: HTMLElement, selector: string) => parent.querySelector(selector) as T;
const smsForm = byId<HTMLFormElement>('sms-form');
const codeForm = byId<HTMLFormElement>('code-form');
const mobileInput = byId<HTMLInputElement>('mobile');
const codeInput = byId<HTMLInputElement>('code');
const sendButton = byId<HTMLButtonElement>('send');
const resendButton = byId<HTMLButtonElement>('resend');
const changeNumberButton = byId<HTMLButtonElement>('change-number');
const shareButton = byId<HTMLButtonElement>('share');
const signOutButton = byId<HTMLButtonElement>('sign-out');
const linkInput = byId<HTMLInputElement>('link');
const status = byId<HTMLParagraphElement>('status');
const canShare = 'share' in navigator;

let loaded = false;
let account: AccountView | null = null;
let pendingMobile = '';
let busy: Action | null = null;
let showLink = false;
let flash: 'copied' | 'resent' | null = null;
let timer: number | undefined;
let flashTimer: number | undefined;
const retryAt = new Map<Action, number>();

function waitFor(action: Action): number {
  return Math.max(0, Math.ceil(((retryAt.get(action) ?? 0) - Date.now()) / 1000));
}

function formatMobile(mobile: string): string {
  return `+852 ${mobile.slice(0, 4)} ${mobile.slice(4)}`;
}

function digitsOnly(input: HTMLInputElement, length: number): void {
  input.value = input.value.replace(/\D/g, '').slice(0, length);
}

function render(): void {
  clearTimeout(timer);
  const smsWait = waitFor('sms');
  const signInWait = waitFor('sign-in');
  const signedIn = Boolean(account && !account.needsReauth);

  byId('loading').hidden = loaded;
  byId('sign-in').hidden = !loaded || signedIn;
  byId('reauth-note').hidden = !account?.needsReauth;
  smsForm.hidden = Boolean(pendingMobile);
  codeForm.hidden = !pendingMobile;

  mobileInput.disabled = busy !== null;
  sendButton.disabled = busy !== null || smsWait > 0 || !mobileInput.validity.valid;
  part<HTMLElement>(sendButton, '.loading').hidden = busy !== 'sms';
  part<SVGElement>(sendButton, '[data-icon]').toggleAttribute('hidden', busy === 'sms' || smsWait > 0);
  part<HTMLElement>(sendButton, '[data-wait]').textContent = smsWait && busy !== 'sms' ? String(smsWait) : '';

  byId('pending-mobile').textContent = pendingMobile && formatMobile(pendingMobile);
  changeNumberButton.disabled = busy !== null;
  codeInput.disabled = busy !== null || signInWait > 0;
  part<HTMLElement>(codeForm, '.loading').hidden = busy !== 'sign-in';
  resendButton.disabled = busy !== null || smsWait > 0;
  part<HTMLElement>(resendButton, '.loading').hidden = busy !== 'sms';
  part<HTMLElement>(resendButton, '[data-label]').textContent =
    flash === 'resent' ? '已發送' : smsWait ? `重新發送（${smsWait}）` : '重新發送';

  byId('account').hidden = !signedIn;
  const shareIcon = flash === 'copied' ? 'done' : canShare ? 'share' : 'copy';
  for (const icon of shareButton.querySelectorAll('[data-icon]')) {
    icon.toggleAttribute('hidden', icon.getAttribute('data-icon') !== shareIcon);
  }
  part<HTMLElement>(shareButton, '[data-label]').textContent =
    flash === 'copied' ? '已複製' : canShare ? '分享' : '複製連結';
  linkInput.hidden = !showLink;
  linkInput.value = account?.link ?? '';

  byId('account-footer').hidden = !account;
  byId('account-mobile').textContent = account ? formatMobile(account.mobile) : '';
  signOutButton.disabled = busy !== null;

  if (smsWait || signInWait) {
    timer = window.setTimeout(render, 1000);
  }
}

function showFlash(kind: NonNullable<typeof flash>): void {
  clearTimeout(flashTimer);
  flash = kind;
  render();
  flashTimer = window.setTimeout(() => {
    flash = null;
    render();
  }, 2000);
}

async function run(action: Action, task: () => Promise<void>): Promise<void> {
  if (busy || waitFor(action)) {
    return;
  }
  busy = action;
  status.textContent = '';
  render();
  try {
    await task();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    if (error.retryAfter) {
      retryAt.set(action, Date.now() + error.retryAfter * 1000);
    }
    status.textContent = error.message;
  } finally {
    busy = null;
    render();
  }
}

async function sendSms(mobile: string): Promise<void> {
  const resending = Boolean(pendingMobile);
  await run('sms', async () => {
    await api('/api/sms', { mobile });
    pendingMobile = mobile;
    codeInput.value = '';
    if (resending) {
      showFlash('resent');
    }
  });
  if (pendingMobile) {
    codeInput.focus();
  }
}

mobileInput.addEventListener('input', () => {
  digitsOnly(mobileInput, 8);
  render();
});
smsForm.addEventListener('submit', event => {
  event.preventDefault();
  void sendSms(mobileInput.value);
});
resendButton.addEventListener('click', () => void sendSms(pendingMobile));
changeNumberButton.addEventListener('click', () => {
  pendingMobile = '';
  status.textContent = '';
  render();
  mobileInput.focus();
});

codeInput.addEventListener('input', () => {
  digitsOnly(codeInput, 6);
  if (codeInput.validity.valid) {
    codeForm.requestSubmit();
  }
});
codeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const code = codeInput.value;
  await run('sign-in', async () => {
    ({ account } = await api<{ account: AccountView }>('/api/sign-in', { mobile: pendingMobile, code }));
    pendingMobile = '';
    codeInput.value = '';
  });
  if (pendingMobile) {
    codeInput.select();
  } else {
    shareButton.focus();
  }
});

shareButton.addEventListener('click', async () => {
  const link = account!.link;
  if (canShare) {
    try {
      await navigator.share({ title: '綠綠賞二維碼', url: link });
    } catch (error) {
      // AbortError means the user closed the share sheet.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    showFlash('copied');
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
    showLink = true;
    render();
    linkInput.select();
  }
});

signOutButton.addEventListener('click', () => void run('sign-out', async () => {
  await api('/api/sign-out', {});
  account = null;
  showLink = false;
  mobileInput.value = '';
}));

async function start(): Promise<void> {
  await run('me', async () => {
    ({ account } = await api<{ account: AccountView | null }>('/api/me'));
    if (account?.needsReauth) {
      mobileInput.value = account.mobile;
    }
  });
  loaded = true;
  render();
}

void start();
registerServiceWorker();
