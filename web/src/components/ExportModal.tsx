import { toBlob, toPng } from 'html-to-image';
import { ClipboardCopy, Code2, FileJson, FileText, Image as ImageIcon, Loader2, Share2 } from 'lucide-react';
import { forwardRef, useMemo, useRef, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { effortLabel, type Message, type Room } from '../../../shared/types';
import {
  displayContent,
  download,
  EXPORT_CSS,
  isKpMessage,
  speakerOf,
  toHtml,
  toMarkdown,
  toPlainText,
  type ExportOptions,
} from '../exportDoc';
import { shortModel } from '../models';
import { toast } from '../toast';
import { splitTips } from './MessageItem';
import { Modal } from './Modal';
import { Field, Segmented, ToggleRow } from './ui';

type Range = 'all' | 'recent' | 'custom';

export function ExportModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const total = room.messages.length;
  const [range, setRange] = useState<Range>('all');
  const [recent, setRecent] = useState(Math.min(20, total));
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(total);
  const [o, setO] = useState<ExportOptions>({
    modelInfo: true,
    time: false,
    reasoning: false,
    scenario: true,
    rolls: true,
    theme: 'light',
  });
  const [busy, setBusy] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setO((x) => ({ ...x, [k]: v }));

  const messages = useMemo(() => {
    const list =
      range === 'recent'
        ? room.messages.slice(-Math.max(1, recent))
        : range === 'custom'
          ? room.messages.slice(Math.max(0, from - 1), Math.max(from, to))
          : room.messages;
    return list.filter((m) => m.status !== 'streaming' && m.status !== 'error' && (o.rolls || !m.kind));
  }, [room.messages, range, recent, from, to, o.rolls]);

  const base = room.title || '对话';

  const imageOptions = () => {
    const node = docRef.current!;
    // 浏览器画布高度有上限，太长时自动降低清晰度
    const ratio = Math.max(1, Math.min(2, 30000 / node.scrollHeight));
    return { pixelRatio: ratio, cacheBust: true, backgroundColor: o.theme === 'dark' ? '#12151c' : '#ffffff' };
  };

  const run = async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      toast(`${label}失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const actions = [
    {
      key: 'png',
      icon: <ImageIcon />,
      label: '下载长图',
      primary: true,
      fn: () =>
        run('生成图片', async () => {
          const url = await toPng(docRef.current!, imageOptions());
          const res = await fetch(url);
          download(`${base}.png`, await res.blob());
        }),
    },
    {
      key: 'copy-img',
      icon: <ClipboardCopy />,
      label: '复制图片',
      fn: () =>
        run('复制图片', async () => {
          const blob = await toBlob(docRef.current!, imageOptions());
          if (!blob) throw new Error('生成图片失败');
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('图片已复制，可以直接粘贴到聊天软件里');
        }),
    },
    {
      key: 'html',
      icon: <Code2 />,
      label: '网页文件',
      fn: () =>
        run('导出网页', () => {
          download(`${base}.html`, toHtml(room, docRef.current!.outerHTML, o.theme), 'text/html;charset=utf-8');
        }),
    },
    {
      key: 'md',
      icon: <FileText />,
      label: 'Markdown',
      fn: () => run('导出 Markdown', () => download(`${base}.md`, toMarkdown(room, messages, o), 'text/markdown;charset=utf-8')),
    },
    {
      key: 'text',
      icon: <ClipboardCopy />,
      label: '复制文字',
      fn: () =>
        run('复制文字', async () => {
          await navigator.clipboard.writeText(toPlainText(room, messages, o));
          toast('对话文字已复制');
        }),
    },
    {
      key: 'json',
      icon: <FileJson />,
      label: '备份 JSON',
      fn: () =>
        run('导出 JSON', () =>
          download(
            `${base}.ai-chat.json`,
            JSON.stringify({ format: 'ai-chat-room', version: 2, exportedAt: Date.now(), room }, null, 2),
            'application/json',
          ),
        ),
    },
  ];

  return (
    <Modal
      title="导出与分享"
      icon={<Share2 />}
      description="生成长图或网页文件发给朋友，或者备份成 JSON 以后再导入。"
      size="xl"
      onClose={onClose}
    >
      <style>{EXPORT_CSS}</style>
      <div className="export-layout">
        <div className="export-options">
          <Field label="范围" hint={`（共 ${total} 条，已选 ${messages.length} 条）`}>
            <Segmented
              block
              value={range}
              onChange={setRange}
              options={[
                { value: 'all', label: '全部' },
                { value: 'recent', label: '最近' },
                { value: 'custom', label: '自定义' },
              ]}
            />
            {range === 'recent' && (
              <div className="row">
                最近
                <input type="number" min={1} max={total} value={recent} onChange={(e) => setRecent(Number(e.target.value) || 1)} style={{ width: 80 }} />
                条
              </div>
            )}
            {range === 'custom' && (
              <div className="row">
                第
                <input type="number" min={1} max={total} value={from} onChange={(e) => setFrom(Number(e.target.value) || 1)} style={{ width: 70 }} />
                到
                <input type="number" min={1} max={total} value={to} onChange={(e) => setTo(Number(e.target.value) || total)} style={{ width: 70 }} />
                条
              </div>
            )}
          </Field>
          <Field label="图片 / 网页主题">
            <Segmented block value={o.theme} onChange={(v) => set('theme', v)} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />
          </Field>
          <div className="form-stack" style={{ gap: 10 }}>
            <ToggleRow label="模型和思考强度" checked={o.modelInfo} onChange={(v) => set('modelInfo', v)} />
            <ToggleRow label="时间" checked={o.time} onChange={(v) => set('time', v)} />
            <ToggleRow label="思考过程" checked={o.reasoning} onChange={(v) => set('reasoning', v)} />
            <ToggleRow label={room.mode === 'trpg' ? '剧本简介' : '场景 / 话题'} checked={o.scenario} onChange={(v) => set('scenario', v)} />
            {room.mode === 'trpg' && <ToggleRow label="骰子、数值和笔记提示" checked={o.rolls} onChange={(v) => set('rolls', v)} />}
          </div>
          <div className="divider" />
          <div className="export-actions">
            {actions.map((a) => (
              <button key={a.key} className={`btn ${a.primary ? 'btn-primary' : ''}`} disabled={!!busy || messages.length === 0} onClick={a.fn}>
                {busy && a.primary ? <Loader2 className="spin" /> : a.icon} {a.label}
              </button>
            ))}
          </div>
          <span className="hint">JSON 备份始终包含整个房间（角色、设置、全部消息），可以在左侧栏「导入」恢复，也可以发给别人导入。</span>
        </div>
        <div className="export-preview-wrap">
          <ExportDocView ref={docRef} room={room} messages={messages} o={o} />
        </div>
      </div>
    </Modal>
  );
}

const ExportDocView = forwardRef<HTMLDivElement, { room: Room; messages: Message[]; o: ExportOptions }>(function ExportDocView(
  { room, messages, o },
  ref,
) {
  const date = new Date();
  const dateText = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const visible = messages.filter((m) => m.kind || displayContent(room, m));
  return (
    <div ref={ref} className={`export-doc theme-${o.theme}`}>
      <div className="x-head">
        <div className="x-kicker">{room.mode === 'trpg' ? 'COC 7 跑团记录' : 'AI 对话室'}</div>
        <h1>{room.title}</h1>
        <div className="x-meta">
          {dateText} · {visible.filter((m) => !m.kind).length} 条发言 · {room.participants.length} 位 AI
        </div>
        <div className="x-cast">
          {room.participants.map((p) => (
            <span key={p.id} className="x-pill">
              <span className="a">{p.avatar}</span>
              <b>{p.name}</b>
              {o.modelInfo && p.model && (
                <span className="m">
                  {shortModel(p.model)}
                  {p.reasoningEffort ? ` · ${effortLabel(p.reasoningEffort)}` : ''}
                </span>
              )}
            </span>
          ))}
        </div>
        {o.scenario && room.scenario.trim() && <div className="x-scenario">{room.scenario.trim()}</div>}
      </div>
      <div className="x-msgs">
        {visible.map((m) => {
          if (m.kind) {
            return (
              <div key={m.id} className="x-roll">
                {m.kind === 'note' ? '📒' : '🎲'} {m.content}
              </div>
            );
          }
          const human = m.role === 'human';
          const { body, tips } = isKpMessage(room, m) ? splitTips(displayContent(room, m)) : { body: displayContent(room, m), tips: [] };
          return (
            <div key={m.id} className={`x-msg ${human ? 'h' : 'a'} ${m.ooc ? 'ooc' : ''}`} style={{ '--c': m.color ?? '#999' } as CSSProperties}>
              <div className="x-av">{human ? '🧑' : (m.avatar ?? '🤖')}</div>
              <div className="x-body">
                <div className="x-who">
                  <span className="x-name" style={{ color: human ? undefined : m.color }}>
                    {speakerOf(room, m)}
                    {m.ooc ? '（场外）' : ''}
                  </span>
                  {o.modelInfo && m.model && (
                    <span className="x-model">
                      {shortModel(m.model)}
                      {m.reasoningEffort ? ` · ${effortLabel(m.reasoningEffort)}` : ''}
                    </span>
                  )}
                  {o.time && <span>{new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>}
                </div>
                {o.reasoning && m.reasoning && (
                  <details className="x-think">
                    <summary>思考过程</summary>
                    <div>{m.reasoning}</div>
                  </details>
                )}
                <div className="x-bubble">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
                  {tips.map((t, i) => (
                    <div key={i} className="x-tip">
                      💡 规则小贴士：{t}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="x-foot">
        <span>导出自 AI 对话室</span>
        <span>{dateText}</span>
      </div>
    </div>
  );
});
