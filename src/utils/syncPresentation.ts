import { APP_DATA_EXPECTED_KEY, APP_DATA_FALLBACK_META_KEY } from '../storage';

export function getSyncLocalSavedAt(): string {
  try {
    for (const key of [APP_DATA_EXPECTED_KEY, APP_DATA_FALLBACK_META_KEY]) {
      const value = localStorage.getItem(key);
      if (value && Number.isFinite(Date.parse(value))) return value;
    }
  } catch { /* A display timestamp is optional; sync still validates the full snapshot. */ }
  return '';
}

export function getSyncDeviceName(): string {
  if (typeof navigator === 'undefined') return 'この端末';
  const agent = navigator.userAgent;
  if (/iPad/i.test(agent) || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1)) return 'このiPad';
  if (/iPhone|Android.*Mobile/i.test(agent)) return 'このスマホ';
  if (/Android/i.test(agent)) return 'このタブレット';
  if (/Windows|Macintosh|Linux/i.test(agent)) return 'このPC';
  return 'この端末';
}

export function formatSyncTime(value: string, relative = true): string {
  if (!value) return '未実行';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日時不明';
  const now = new Date();
  const time = date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (relative && date.toDateString() === now.toDateString()) return `今日 ${time}`;
  const day = date.toLocaleDateString('ja-JP', {
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
    month: 'long', day: 'numeric',
  });
  return `${day} ${time}`;
}
