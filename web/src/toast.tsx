// 右下角的提示消息

import { AlertCircle, Info } from 'lucide-react';
import { useEffect, useState } from 'react';

type Toast = { id: number; text: string; level: 'info' | 'error' };
type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<Listener>();
const publish = () => listeners.forEach((fn) => fn(toasts));

export function toast(text: string, level: 'info' | 'error' = 'info') {
  const id = ++seq;
  toasts = [...toasts, { id, text, level }].slice(-4);
  publish();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id);
      publish();
    },
    level === 'error' ? 8000 : 4000,
  );
}

/** 把异步操作的错误显示成提示 */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return undefined;
  }
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toaster" role="status">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          {t.level === 'error' ? <AlertCircle /> : <Info />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
