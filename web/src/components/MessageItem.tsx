import { AlertCircle, BookMarked, Brain, Check, ChevronRight, Copy, Lightbulb, Pencil, RotateCcw, Scissors, Trash2, User, UserX, Zap } from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { stripCommands } from '../../../shared/coc';
import { stripImpersonation } from '../../../shared/text';
import { effortLabel, type Message, type TokenUsage } from '../../../shared/types';
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

const fmtTokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));

/** 这次请求的 token 用量和缓存命中率 */
export function UsageTag({ usage }: { usage: TokenUsage }) {
  const pct = usage.cached !== undefined && usage.input > 0 ? Math.round((usage.cached / usage.input) * 100) : undefined;
  const title = [
    `输入 ${usage.input.toLocaleString('en-US')} tokens`,
    usage.cached !== undefined
      ? `其中命中缓存 ${usage.cached.toLocaleString('en-US')}（${pct ?? 0}%）`
      : '服务商没有报告缓存信息',
    `输出 ${usage.output.toLocaleString('en-US')} tokens${usage.reasoning ? `（思考 ${usage.reasoning.toLocaleString('en-US')}）` : ''}`,
  ].join('\n');
  return (
    <span className={`badge ${usage.cached ? 'badge-ok' : ''}`} title={title}>
      <Zap /> {pct !== undefined ? `缓存 ${pct}%` : `${fmtTokens(usage.input)} tokens`}
    </span>
  );
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
  onOpenNotes,
  hideNames,
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
  onOpenNotes?: () => void;
  /** 其他人的名字：生成过程中隐藏以「【名字】：」开头的冒充段落 */
  hideNames?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, setCopied] = useState(false);

  if (m.kind === 'note' && m.note) {
    return (
      <div className="roll-row">
        <button className="note-chip" onClick={onOpenNotes} title="打开守秘人笔记">
          <BookMarked />
          <span>
            守秘人{m.note.updated ? '更新了' : '记下了'}{m.note.kind === 'npc' ? ' NPC ' : '线索'}
            <b>「{m.note.title}」</b>
          </span>
          <span className="note-chip-link">查看笔记</span>
        </button>
      </div>
    );
  }

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
  // 生成过程中就把替别人写的段落藏起来（生成完后服务端会正式去掉）
  const raw = streaming && hideNames?.length ? stripImpersonation(m.content, hideNames).text : m.content;
  const display = isKp ? stripCommands(raw) : raw;
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
          {m.usage && !streaming && <UsageTag usage={m.usage} />}
          <span className="msg-time">{time(m.createdAt)}</span>
          {m.status === 'interrupted' && <span className="badge badge-warn">被打断</span>}
          {!!m.filtered && (
            <span className="badge badge-warn" title={`模型替别人写了这些话，已自动去掉：\n\n${m.filtered.slice(0, 400)}`}>
              <UserX /> 已去掉替别人说的话
            </span>
          )}
          {!!m.trimmed && (
            <span className="badge" title={`生成这条消息时对话太长，最早的 ${m.trimmed} 条消息没有发给模型`}>
              <Scissors /> 省略了 {m.trimmed} 条早期消息
            </span>
          )}
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
