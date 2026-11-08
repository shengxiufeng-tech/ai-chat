import { useRef, useState } from 'react';
import type { Room, RunnerState } from '../../../shared/types';

const PLACEHOLDER = {
  host: '以主持人身份发言，比如抛出一个话题…',
  participant: '说点什么，加入讨论…',
  observer: '旁观中，也可以随时插一句…',
} as const;

export function Composer({
  room,
  runner,
  onSend,
}: {
  room: Room;
  runner: RunnerState | null;
  onSend: (content: string, interrupt: boolean) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const generating = !!runner?.generating;

  const send = async (interrupt: boolean) => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    const ok = await onSend(content, interrupt);
    setSending(false);
    if (ok) setText('');
    ref.current?.focus();
  };

  const mention = (name: string) => {
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${name} `);
    ref.current?.focus();
  };

  return (
    <div className="composer">
      {room.participants.length > 0 && (
        <div className="mentions">
          <span className="hint">点名：</span>
          {room.participants.map((p) => (
            <button key={p.id} className="chip" onClick={() => mention(p.name)} title={`@${p.name}，让 TA 接话`}>
              {p.avatar} {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder={`${PLACEHOLDER[room.settings.humanRole]}（Enter 发送，Shift+Enter 换行）`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法选词时按的 Enter 不算发送
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void send(false);
            }
          }}
        />
        <div className="composer-buttons">
          <button className="btn btn-primary" disabled={!text.trim() || sending} onClick={() => send(false)}>
            发送
          </button>
          {generating && (
            <button
              className="btn btn-warn"
              disabled={!text.trim() || sending}
              onClick={() => send(true)}
              title="打断正在发言的 AI，立刻插话"
            >
              打断并发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
