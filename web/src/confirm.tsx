// 确认对话框：代替浏览器自带的 confirm()，用法 `if (await askConfirm({...}))`

import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './components/Modal';

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  danger?: boolean;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<(p: Pending | null) => void>();
const publish = () => listeners.forEach((fn) => fn(pending));

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...opts, resolve };
    publish();
  });
}

function settle(ok: boolean) {
  const p = pending;
  pending = null;
  publish();
  p?.resolve(ok);
}

export function ConfirmHost() {
  const [p, setP] = useState<Pending | null>(pending);
  useEffect(() => {
    listeners.add(setP);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  if (!p) return null;
  return (
    <Modal
      title={p.title}
      icon={p.danger ? <AlertTriangle style={{ color: 'var(--danger)' }} /> : <HelpCircle />}
      size="sm"
      onClose={() => settle(false)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => settle(false)}>
            取消
          </button>
          <button className={`btn ${p.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => settle(true)} autoFocus>
            {p.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      {p.message && <div className="confirm-message">{p.message}</div>}
    </Modal>
  );
}
