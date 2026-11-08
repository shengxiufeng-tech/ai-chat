import { memo, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../../../shared/types';

function time(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const MessageItem = memo(function MessageItem({
  message: m,
  isLast,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  message: Message;
  isLast: boolean;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const streaming = m.status === 'streaming';
  const isHuman = m.role === 'human';

  return (
    <div
      className={`msg ${isHuman ? 'msg-human' : 'msg-ai'} ${m.status === 'error' ? 'msg-error' : ''}`}
      style={{ '--c': m.color || '#64748b' } as CSSProperties}
    >
      <div className="msg-avatar">{isHuman ? '🧑' : m.avatar || '🤖'}</div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="msg-name">{m.speakerName}</span>
          {m.model && <span className="msg-model">{m.model}</span>}
          <span className="msg-time">{time(m.createdAt)}</span>
          {m.status === 'interrupted' && <span className="badge">被打断</span>}
        </div>

        {m.reasoning && (
          <details className="msg-reasoning" open={streaming && !m.content}>
            <summary>思考过程</summary>
            <div className="msg-reasoning-text">{m.reasoning}</div>
          </details>
        )}

        {editing ? (
          <div className="msg-edit">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus />
            <div className="row">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  onEdit(m.id, draft);
                  setEditing(false);
                }}
              >
                保存
              </button>
              <button className="btn btn-sm" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          (m.content || streaming) && (
            <div className={`msg-content markdown ${streaming ? 'streaming' : ''}`}>
              {m.content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              ) : (
                <span className="cursor" />
              )}
            </div>
          )
        )}

        {m.status === 'error' && (
          <div className="msg-error-text">
            ⚠️ {m.error}
            {isLast && (
              <button className="btn btn-sm" onClick={() => onRegenerate(m.id)}>
                重试
              </button>
            )}
          </div>
        )}

        {!streaming && !editing && (
          <div className="msg-actions">
            <button
              onClick={() => {
                setDraft(m.content);
                setEditing(true);
              }}
            >
              编辑
            </button>
            <button onClick={() => onDelete(m.id)}>删除</button>
            {isLast && m.role === 'ai' && m.status !== 'error' && (
              <button onClick={() => onRegenerate(m.id)}>重新生成</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
