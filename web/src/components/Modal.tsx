import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

export function Modal({
  title,
  icon,
  description,
  onClose,
  children,
  footer,
  size,
  header,
}: {
  title: string;
  icon?: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'wide' | 'xl';
  /** 标题下方的额外内容（如步骤条） */
  header?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ? `modal-${size}` : ''}`} role="dialog" aria-label={title}>
        <div className="modal-header">
          <h2>
            {icon}
            {title}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        {description && <div className="modal-desc">{description}</div>}
        {header}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
