// 计时：用服务器时间算「已经过了多久」（手机和电脑的时钟可能差几秒甚至几分钟）

import { useEffect, useState } from 'react';

let offset = 0;

/** 收到服务器时间时校正一次 */
export function syncServerTime(serverNow: number) {
  offset = serverNow - Date.now();
}

export const serverNow = () => Date.now() + offset;

/** active 时每秒刷新一次，返回当前的服务器时间 */
export function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return serverNow();
}

/** 12 秒、1 分 05 秒 */
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/** 850 tokens、1.2k tokens */
export function fmtTokens(n: number) {
  return n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k tokens`;
}
