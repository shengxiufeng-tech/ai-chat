// 模型列表：从后端（进而从 Magpie）读取，全局缓存

import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../shared/types';
import { get } from './api';

type State = { models: ModelInfo[]; error: string; loading: boolean };
let state: State = { models: [], error: '', loading: false };
let loaded = false;
const listeners = new Set<(s: State) => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
};

export async function reloadModels() {
  loaded = true;
  set({ loading: true });
  try {
    const { models } = await get<{ models: ModelInfo[] }>('/models');
    set({ models, error: '', loading: false });
  } catch (err) {
    set({ models: [], error: err instanceof Error ? err.message : String(err), loading: false });
  }
  return state;
}

export function useModels() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    if (!loaded) void reloadModels();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
