// 模型列表：从后端（进而从 Magpie）读取，全局缓存

import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../shared/types';
import { get } from './api';

type State = { models: ModelInfo[]; error: string; loading: boolean };
let state: State = { models: [], error: '', loading: false };
let loaded = false;
let loadedAt = 0;
let inflight: Promise<State> | null = null;
let seq = 0;
const listeners = new Set<(s: State) => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
};

/** 重新读取模型列表。silent：后台刷新，不显示「正在连接」，失败时保留原来的列表 */
export function reloadModels({ silent = false } = {}): Promise<State> {
  // 后台刷新可以共用正在进行的请求；手动刷新（比如刚改了设置）总是重新请求
  if (silent && inflight) return inflight;
  loaded = true;
  const mine = ++seq;
  if (!silent) set({ loading: true });
  const run = (async () => {
    try {
      const { models } = await get<{ models: ModelInfo[] }>('/models');
      // 只用最新一次请求的结果（改设置前发出的请求晚回来也不会覆盖）
      if (mine === seq) set({ models, error: '', loading: false });
    } catch (err) {
      if (mine === seq) {
        if (silent && state.models.length) set({ loading: false });
        else set({ models: [], error: err instanceof Error ? err.message : String(err), loading: false });
      }
    } finally {
      if (mine === seq) {
        loadedAt = Date.now();
        inflight = null;
      }
    }
    return state;
  })();
  inflight = run;
  return run;
}

/** 列表读取超过 maxAge 毫秒就在后台刷新一次（在 Magpie 里改了模型，这边很快就能看到） */
export function refreshModelsIfStale(maxAge: number) {
  if (Date.now() - loadedAt > maxAge) void reloadModels({ silent: true });
}

// 切回这个页面时（比如刚在 Magpie 里改完模型），列表超过 1 分钟就刷新
let watching = false;
function watchFocus() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const onBack = () => {
    if (document.visibilityState === 'visible') refreshModelsIfStale(60_000);
  };
  window.addEventListener('focus', onBack);
  document.addEventListener('visibilitychange', onBack);
}

export function useModels() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!loaded) void reloadModels();
    watchFocus();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

/** 模型 id 太长时只显示 provider/ 之后的部分 */
export const shortModel = (id?: string) => (id ? (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id) : '未选择模型');
