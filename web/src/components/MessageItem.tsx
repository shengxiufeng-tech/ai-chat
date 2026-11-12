import {
  AlertCircle,
  BookMarked,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Lightbulb,
  Loader2,
  NotebookPen,
  PenLine,
  Pencil,
  RotateCcw,
  Scissors,
  Trash2,
  TriangleAlert,
  User,
  UserX,
} from 'lucide-react';
import { memo, useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { kpDisplayText } from '../../../shared/coc';
import { stripImpersonation } from '../../../shared/text';
import { effortLabel, type Message } from '../../../shared/types';
import { copyText } from '../clipboard';
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

function OneModel({ model, effort, icon, title }: { model: string; effort?: string; icon?: ReactNode; title: string }) {
  return (
    <span className="msg-model" title={title}>
      {icon}
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

const describe = (model: string, effort?: string) => `${model}${effort ? ` · 思考强度 ${effort}` : ''}`;

/** 模型标签；用了构思 / 执笔时显示「构思模型 → 执笔模型」 */
export function ModelTag({ model, effort, planner }: { model?: string; effort?: string; planner?: { model: string; reasoningEffort?: string } }) {
  if (!model) return null;
  if (!planner) return <OneModel model={model} effort={effort} title={describe(model, effort)} />;
  return (
    <span className="model-pair">
      <OneModel model={planner.model} effort={planner.reasoningEffort} icon={<Lightbulb />} title={`构思：${describe(planner.model, planner.reasoningEffort)}`} />
      <span className="model-pair-arrow">→</span>
      <OneModel model={model} effort={effort} icon={<PenLine />} title={`执笔：${describe(model, effort)}`} />
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
  onAccept,
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
  onPush?: (id: string, how?: string) => Promise<unknown>;
  onAccept?: (id: string) => Promise<unknown>;
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
        onPush={(how) => onPush?.(m.id, how) ?? Promise.resolve()}
        onAccept={() => onAccept?.(m.id) ?? Promise.resolve()}
      />
    );
  }

  const streaming = m.status === 'streaming';
  const isHuman = m.role === 'human';
  // 生成过程中就把替别人写的段落藏起来（生成完后服务端会正式去掉）
  const raw = streaming && hideNames?.length ? stripImpersonation(m.content, hideNames).text : m.content;
  const display = isKp ? kpDisplayText(raw) : raw;
  const { body, tips } = isKp ? splitTips(display) : { body: display, tips: [] };

  const copy = async () => {
    if (!(await copyText(display))) return;
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
          <ModelTag model={m.model} effort={m.reasoningEffort} planner={m.planner} />
          <span className="msg-time">{time(m.createdAt)}</span>
          {m.status === 'interrupted' && <span className="badge badge-warn">被打断</span>}
          {!!m.truncated && !streaming && (
            <span
              className="badge badge-warn"
              title={
                m.truncated === 'length'
                  ? '回复达到了输出长度上限，被截断了。可以点「重新生成」；如果经常这样，试试调低这个 AI 的思考强度（思考过程也占输出长度）'
                  : m.truncated === 'content_filter'
                    ? '回复被服务商的内容审核截断了'
                    : '连接在回复结束前断开了（可能是网络或路由切换），可以点「重新生成」'
              }
            >
              <TriangleAlert /> 回复不完整
            </span>
          )}
          {!!m.filtered && (
            <span className="badge badge-warn" title={`模型替别人写了这些话，已自动去掉：\n\n${m.filtered.slice(0, 400)}`}>
              <UserX /> 已去掉替别人说的话
            </span>
          )}
          {!!m.planError && !streaming && (
            <span className="badge badge-warn" title={`构思模型出错了：${m.planError}\n这一条由执笔模型单独写完。`}>
              <TriangleAlert /> 构思失败
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

        {m.planner && (m.plan || m.planning) && (
          // 守秘人的构思会提到剧本秘密，默认收起
          <details className="msg-reasoning msg-plan" open={!isKp && !!m.planning}>
            <summary>
              <ChevronRight className="chev" />
              {m.planning ? <Loader2 className="spin" /> : <NotebookPen />}
              {m.planning ? (isKp ? '守秘人正在构思…' : '正在构思…') : '构思'}
              {isKp && <span className="msg-plan-warn">可能剧透</span>}
            </summary>
            <div className="msg-reasoning-text">{m.plan || '…'}</div>
          </details>
        )}

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
              {m.status === 'interrupted' && isLast && m.role === 'ai' && (
                <div className="msg-retry">
                  <span className="hint">这条回复被停止了。</span>
                  <button className="btn btn-sm" onClick={() => onRegenerate(m.id)}>
                    <RotateCcw /> 重新生成
                  </button>
                </div>
              )}
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
