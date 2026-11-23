// 只和这台设备有关的界面偏好（存在浏览器里）

import { useEffect, useState } from 'react';

/** 一个存在 localStorage 里的开关，所有用到它的组件一起更新 */
function boolPref(key: string) {
  const listeners = new Set<(v: boolean) => void>();
  const get = () => localStorage.getItem(key) === '1';
  const set = (v: boolean) => {
    localStorage.setItem(key, v ? '1' : '0');
    listeners.forEach((fn) => fn(v));
  };
  const use = () => {
    const [v, setV] = useState(get);
    useEffect(() => {
      listeners.add(setV);
      return () => {
        listeners.delete(setV);
      };
    }, []);
    return v;
  };
  return { get, set, use };
}

const follow = boolPref('ai-chat:follow-stream');
/** 回复生成时是否一直滚到最新的文字（默认不滚，方便从头阅读） */
export const getFollowStream = follow.get;
export const setFollowStream = follow.set;
export const useFollowStream = follow.use;

const collapse = boolPref('ai-chat:collapse-thinking');
/** 思考过程是否始终折叠（默认在思考时展开、开始回答后收起） */
export const setCollapseThinking = collapse.set;
export const useCollapseThinking = collapse.use;
