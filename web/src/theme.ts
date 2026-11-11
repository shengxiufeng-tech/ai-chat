// 主题：跟随系统 / 浅色 / 深色

import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'ai-chat:theme';

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // 手机浏览器地址栏 / 状态栏的颜色跟着主题走
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#12151c' : '#ffffff');
}

export function initTheme() {
  apply((localStorage.getItem(KEY) as ThemePref) || 'system');
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem(KEY) as ThemePref) || 'system');
  useEffect(() => {
    localStorage.setItem(KEY, pref);
    apply(pref);
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return [pref, setPref] as const;
}
