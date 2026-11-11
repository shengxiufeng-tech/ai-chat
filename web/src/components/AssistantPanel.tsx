import { ArrowUp, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Room } from '../../../shared/types';
import { del, post } from '../api';
import { attempt } from '../toast';

const QUICK = [
  '跑团到底是怎么玩的？',
  '现在发生了什么？帮我理一理线索',
  '检定和成功等级是什么意思？',
  '理智值掉了会怎样？',
  '什么时候可以孤注一掷？',
];

/** 规则助手：随时问规则，看不到剧本秘密 */
export function AssistantPanel({ room }: { room: Room }) {
  const log = room.trpg?.assistantLog ?? [];
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [log.length, pending]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || pending) return;
    setPending(question);
    setText('');
    await attempt(() => post(`/rooms/${room.id}/assistant`, { mode: 'ask', question }));
    setPending(null);
  };

  return (
    <div className="assistant-panel">
      <div className="assistant-log" ref={ref}>
        <div className="callout callout-info">
          <GraduationCap />
          <span>我是规则助手，随时可以问我规则或者"现在该干嘛"。我看不到剧本的秘密，也不会剧透；守秘人也看不到我们的对话。</span>
        </div>
        {log.map((e, i) => (
          <div key={i} className={`assistant-msg is-${e.role}`}>
            {e.role === 'assistant' ? (
              <div className="markdown">
                <ReactMarkdown>{e.content}</ReactMarkdown>
              </div>
            ) : (
              e.content
            )}
          </div>
        ))}
        {pending && (
          <>
            <div className="assistant-msg is-user">{pending}</div>
            <div className="assistant-msg is-assistant">
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </>
        )}
        {log.length === 0 && !pending && (
          <div className="assistant-quick">
            {QUICK.map((q) => (
              <button key={q} className="chip" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="assistant-input">
        {log.length > 0 && (
          <button
            className="icon-btn"
            title="清空对话"
            onClick={() => confirm('清空和规则助手的对话？') && attempt(() => del(`/rooms/${room.id}/assistant`))}
          >
            <Trash2 />
          </button>
        )}
        <textarea
          rows={1}
          value={text}
          placeholder="问点什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void ask(text);
            }
          }}
        />
        <button className="btn btn-primary composer-send" disabled={!text.trim() || !!pending} onClick={() => ask(text)} aria-label="发送">
          {pending ? <Loader2 className="spin" /> : <ArrowUp />}
        </button>
      </div>
    </div>
  );
}
