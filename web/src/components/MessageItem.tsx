import { AlertCircle, Brain, Check, ChevronRight, Copy, Lightbulb, Pencil, RotateCcw, Trash2, User } from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { stripCommands } from '../../../shared/coc';
import { effortLabel, type Message } from '../../../shared/types';
import { shortModel } from '../models';
import { EffortMeter } from './EffortPicker';
import { RollCard } from './RollCard';

function time(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 把守秘人消息里的「【规则小贴士】」单独拿出来 */
export function splitTips(text: string) {
  const tips: string[] = [];
  const body = text
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*[【[]规则小贴士[】\]][:：]?\s*(.*)$/);
      if (m) {
        if (m[1].trim()) tips.push(m[1].trim());
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
  return { body, tips };
}

export function ModelTag({ model, effort }: { model?: string; effort?: string }) {
  if (!model) return null;
  return (
    <span className="msg-model" title={`${model}${effort ? ` · 思考强度 ${effort}` : ''}`}>
      {shortModel(model)}
      {effort && (
        <>
          <span className="sep">·</span>
          <span className="effort">
            <EffortMeter effort={effort} />
            {effortLabel(effort)}
          </span>
        </>
      )}
    </span>
  );
}

export const MessageItem = memo(function MessageItem({
  message: m,
  isLast,
  isKp,
  playerName,
  onEdit,
  onDelete,
  onRegenerate,
  onRoll,
  onPush,
}: {
  message: Message;
  isLast: boolean;
  /** 守秘人的消息：隐藏骰子指令、单独显示规则小贴士 */
  isKp?: boolean;
  /** 跑团里玩家的调查员名字 */
  playerName?: string;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
  onRoll?: (id: string) => Promise<unknown>;
  onPush?: (id: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, setCopied] = useState(false);

  if (m.kind === 'roll' && m.roll) {
    return (
      <RollCard
        roll={m.roll}
        canAct={m.roll.actor === 'player'}
        onRoll={() => onRoll?.(m.id) ?? Promise.resolve()}
        onPush={() => onPush?.(m.id) ?? Promise.resolve()}
      />
    );
  }

  const streaming = m.status === 'streaming';
  const isHuman = m.role === 'human';
  const display = isKp ? stripCommands(m.content) : m.content;
  const { body, tips } = isKp ? splitTips(display) : { body: display, tips: [] };

  const copy = async () => {
    await navigator.clipboard.writeText(display);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className={`msg ${isHuman ? 'msg-human' : 'msg-ai'} ${m.status === 'error' ? 'msg-error' : ''} ${m.ooc ? 'ooc' : ''}`}
      style={{ '--c': m.color || 'var(--text-3)' } as CSSProperties}
    >
      <div className="msg-avatar">{isHuman ? <User /> : m.avatar || '🤖'}</div>
      <div className="msg-main">
        <div className="msg-meta">
          <span className="msg-name">
            {isHuman && playerName && !m.ooc ? `${playerName}` : m.speakerName}
          </span>
          {isHuman && m.ooc && <span className="badge">场外</span>}
          <ModelTag model={m.model} effort={m.reasoningEffort} />
          <span className="msg-time">{time(m.createdAt)}</span>
          {m.status === 'interrupted' && <span className="badge badge-warn">被打断</span>}
          {!streaming && !editing && (
            <div className="msg-toolbar">
              <button className="icon-btn sm" title={copied ? '已复制' : '复制'} onClick={copy}>
                {copied ? <Check /> : <Copy />}
              </button>
              <button
                className="icon-btn sm"
                title="编辑"
                onClick={() => {
                  setDraft(m.content);
                  setEditing(true);
                }}
              >
                <Pencil />
              </button>
              {isLast && m.role === 'ai' && (
                <button className="icon-btn sm" title="重新生成" onClick={() => onRegenerate(m.id)}>
                  <RotateCcw />
                </button>
              )}
              <button className="icon-btn sm" title="删除" onClick={() => onDelete(m.id)}>
                <Trash2 />
              </button>
            </div>
          )}
        </div>

        {m.reasoning && (
          <details className="msg-reasoning" open={streaming && !m.content}>
            <summary>
              <ChevronRight className="chev" />
              <Brain />
              思考过程
            </summary>
            <div className="msg-reasoning-text">{m.reasoning}</div>
          </details>
        )}

        {editing ? (
          <div className="msg-bubble msg-edit">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} autoFocus />
            <div className="row">
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  onEdit(m.id, draft);
                  setEditing(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          (body || streaming || tips.length > 0 || m.status === 'error') && (
            <div className="msg-bubble">
              {body ? (
                <div className={`msg-content markdown ${streaming ? 'streaming' : ''}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
                </div>
              ) : streaming ? (
                <span className="typing-dots" aria-label="正在输入">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
              {tips.map((t, i) => (
                <div key={i} className="tip-block">
                  <Lightbulb />
                  <span>
                    <b>规则小贴士：</b>
                    {t}
                  </span>
                </div>
              ))}
              {m.status === 'error' && (
                <div className="msg-error-text">
                  <AlertCircle />
                  <span className="grow">{m.error}</span>
                  {isLast && (
                    <button className="btn btn-sm" onClick={() => onRegenerate(m.id)}>
                      <RotateCcw /> 重试
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
});
