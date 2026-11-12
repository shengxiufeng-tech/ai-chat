// 只和这台设备有关的界面偏好（存在浏览器里）

import { useEffect, useState } from 'react';

const FOLLOW_KEY = 'ai-chat:follow-stream';
const listeners = new Set<(v: boolean) => void>();

/** 回复生成时是否一直滚到最新的文字（默认不滚，方便从头阅读） */
export const getFollowStream = () => localStorage.getItem(FOLLOW_KEY) === '1';

export function setFollowStream(v: boolean) {
  localStorage.setItem(FOLLOW_KEY, v ? '1' : '0');
  listeners.forEach((fn) => fn(v));
}

export function useFollowStream() {
  const [v, setV] = useState(getFollowStream);
  useEffect(() => {
    listeners.add(setV);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
