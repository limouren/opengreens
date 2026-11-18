import './style.css';
import { api, ApiError, registerServiceWorker } from './api';

interface AccountView {
  mobile: string;
  link: string;
  needsReauth: boolean;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const smsForm = byId<HTMLFormElement>('sms-form');
const codeForm = byId<HTMLFormElement>('code-form');
const mobileInput = byId<HTMLInputElement>('mobile');
const codeInput = byId<HTMLInputElement>('code');
const linkInput = byId<HTMLInputElement>('link');
const status = byId<HTMLParagraphElement>('status');

let account: AccountView | null = null;
let pendingMobile = '';
let busy = false;
let timer: number | undefined;
const retryAt = new Map<string, number>();

function waitFor(action: string): number {
  return Math.max(0, Math.ceil(((retryAt.get(action) ?? 0) - Date.now()) / 1000));
}

function setButton(id: string, label: string, wait: number): void {
  const button = byId<HTMLButtonElement>(id);
  button.textContent = wait ? `${label}（${wait} 秒）` : label;
  button.disabled = busy || wait > 0;
}

function render(): void {
  clearTimeout(timer);
  const smsWait = waitFor('sms');
  const signInWait = waitFor('sign-in');

  byId('sign-in').hidden = Boolean(account && !account.needsReauth);
  byId('reauth-note').hidden = !account?.needsReauth;
  byId('account').hidden = !account;
  smsForm.hidden = Boolean(pendingMobile);
  codeForm.hidden = !pendingMobile;
  mobileInput.disabled = busy;
  codeInput.disabled = busy;
  byId<HTMLButtonElement>('change-number').disabled = busy;
  byId<HTMLButtonElement>('sign-out').disabled = busy;
  setButton('send', '發送驗證碼', smsWait);
  setButton('resend', '重新發送', smsWait);
  setButton('submit-code', '登入', signInWait);

  if (account) {
    linkInput.value = account.link;
    byId<HTMLAnchorElement>('open').href = account.link;
    byId('account-mobile').textContent = `綠綠賞賬戶：+852 ${account.mobile}`;
    byId('share').hidden = !('share' in navigator);
  }
  if (smsWait || signInWait) {
    timer = window.setTimeout(render, 1000);
  }
}

async function run(message: string, action: string, task: () => Promise<void>): Promise<void> {
  if (busy || waitFor(action)) {
    return;
  }
  busy = true;
  status.textContent = message;
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
    busy = false;
    render();
  }
}

async function sendSms(mobile: string): Promise<void> {
  await run('正在發送驗證碼…', 'sms', async () => {
    await api('/api/sms', { mobile });
    pendingMobile = mobile;
    codeInput.value = '';
    byId('code-hint').textContent = `請輸入發送至 +852 ${mobile} 的驗證碼。`;
    status.textContent = '綠綠賞已接受發送驗證碼的請求。';
  });
  if (pendingMobile) {
    codeInput.focus();
  }
}

smsForm.addEventListener('submit', event => {
  event.preventDefault();
  void sendSms(mobileInput.value);
});
byId('resend').addEventListener('click', () => void sendSms(pendingMobile));
byId('change-number').addEventListener('click', () => {
  pendingMobile = '';
  status.textContent = '';
  render();
  mobileInput.focus();
});
codeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const code = codeInput.value;
  await run('正在登入…', 'sign-in', async () => {
    ({ account } = await api<{ account: AccountView }>('/api/sign-in', { mobile: pendingMobile, code }));
    pendingMobile = '';
    codeInput.value = '';
    status.textContent = '登入成功。';
  });
  if (!pendingMobile) {
    byId('account-title').focus();
  }
});

byId('share').addEventListener('click', async () => {
  try {
    await navigator.share({ title: '綠綠賞二維碼', url: account!.link });
  } catch (error) {
    // AbortError means the user closed the share sheet.
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
  }
});
byId('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(account!.link);
    status.textContent = '已複製連結。';
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
    linkInput.select();
    status.textContent = '未能自動複製，請手動複製連結。';
  }
});
byId('sign-out').addEventListener('click', () => void run('正在登出…', 'sign-out', async () => {
  await api('/api/sign-out', {});
  account = null;
  mobileInput.value = '';
  status.textContent = '已登出。分享連結仍然有效。';
}));

void run('正在載入…', 'me', async () => {
  ({ account } = await api<{ account: AccountView | null }>('/api/me'));
  if (account?.needsReauth) {
    mobileInput.value = account.mobile;
  }
  status.textContent = '';
});
registerServiceWorker();
