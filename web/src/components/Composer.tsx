import { ArrowUp, AtSign, Drama, HelpCircle, Loader2, MessageCircleQuestion, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Room, RunnerState } from '../../../shared/types';
import { post } from '../api';
import { attempt } from '../toast';
import { Segmented } from './ui';

const PLACEHOLDER = {
  host: '以主持人身份发言，比如抛出一个话题…',
  participant: '说点什么，加入对话…',
  observer: '旁观中，也可以随时插一句…',
} as const;

export function Composer({
  room,
  runner,
  onSend,
  disabled,
}: {
  room: Room;
  runner: RunnerState | null;
  onSend: (content: string, opts: { interrupt: boolean; ooc: boolean }) => Promise<boolean>;
  disabled?: string;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [ooc, setOoc] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const generating = !!runner?.generating;
  const trpg = room.mode === 'trpg';

  // 输入框高度跟随内容
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = async (interrupt: boolean) => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    const ok = await onSend(content, { interrupt, ooc: trpg && ooc });
    setSending(false);
    if (ok) {
      setText('');
      setSuggestions(null);
    }
    ref.current?.focus();
  };

  const insert = (s: string) => {
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${s}`);
    ref.current?.focus();
  };

  const suggest = async () => {
    setSuggesting(true);
    const res = await attempt(() => post<{ suggestions: string[] }>(`/rooms/${room.id}/assistant`, { mode: 'suggest' }));
    setSuggesting(false);
    if (res) setSuggestions(res.suggestions);
  };

  const mentionable = trpg ? room.participants.filter((p) => p.role === 'player') : room.participants;
  const placeholder = disabled
    ? disabled
    : trpg
      ? ooc
        ? '场外提问：问守秘人规则或确认情况，不会推进剧情…'
        : '描述你的调查员要做什么、说什么…'
      : PLACEHOLDER[room.settings.humanRole];

  return (
    <div className="composer">
      <div className="composer-inner">
        {suggestions && suggestions.length > 0 && (
          <div className="suggestions">
            <span className="hint">试试：</span>
            {suggestions.map((s) => (
              <button key={s} className="suggestion" onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className={`composer-box ${trpg && ooc ? 'ooc' : ''}`}>
          <textarea
            ref={ref}
            value={text}
            rows={1}
            enterKeyHint="send"
            disabled={!!disabled}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法选词时按的 Enter 不算发送
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void send(false);
              }
            }}
          />
          <div className="composer-bar">
            {trpg && (
              <Segmented
                size="sm"
                value={ooc ? 'ooc' : 'ic'}
                onChange={(v) => setOoc(v === 'ooc')}
                options={[
                  { value: 'ic', label: <><Drama /> <span><span className="hide-mobile">角色</span>行动</span></>, title: '以调查员的身份行动或说话' },
                  { value: 'ooc', label: <><MessageCircleQuestion /> 场外</>, title: '玩家本人提问，不推进剧情' },
                ]}
              />
            )}
            <div className="composer-mentions">
              {mentionable.length > 0 && <AtSign style={{ width: 14, height: 14, color: 'var(--text-3)', flex: 'none' }} />}
              {mentionable.map((p) => (
                <button key={p.id} className="chip" onClick={() => insert(`@${p.name} `)} title={`@${p.name}，让 TA 接话`}>
                  {p.avatar} {p.name}
                </button>
              ))}
            </div>
            <span className="spacer" />
            {trpg && (
              <button className="btn btn-sm btn-ghost" onClick={suggest} disabled={suggesting} title="让规则助手给出几个可以尝试的行动">
                {suggesting ? <Loader2 className="spin" /> : <HelpCircle />}
                <span className="hide-mobile">我该做什么？</span>
                <span className="mobile-only">建议</span>
              </button>
            )}
            {generating && (
              <button
                className="btn btn-sm btn-warn"
                disabled={!text.trim() || sending}
                onClick={() => send(true)}
                title="打断正在发言的 AI，立刻插话"
              >
                <Zap />
                <span>
                  打断<span className="hide-mobile">并发送</span>
                </span>
              </button>
            )}
            <button
              className="btn btn-primary composer-send"
              disabled={!text.trim() || sending || !!disabled}
              onClick={() => send(false)}
              title="发送（Enter）"
              aria-label="发送"
            >
              {sending ? <Loader2 className="spin" /> : <ArrowUp />}
            </button>
          </div>
        </div>
        <div className="composer-hint">Enter 发送 · Shift + Enter 换行{!trpg && ' · @名字 点名让 TA 接话'}</div>
      </div>
    </div>
  );
}
