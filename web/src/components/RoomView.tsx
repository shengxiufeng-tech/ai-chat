import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from '../../../shared/types';
import { del, patch, post } from '../api';
import { attempt } from '../toast';
import { useRoom } from '../useRoom';
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { ParticipantPanel } from './ParticipantPanel';
import { RoomSettingsPanel } from './RoomSettingsPanel';

function exportMarkdown(room: Room) {
  const lines = [`# ${room.title}`, ''];
  if (room.scenario.trim()) lines.push(`> ${room.scenario.trim().replace(/\n/g, '\n> ')}`, '');
  lines.push('## 参与者', '');
  for (const p of room.participants) lines.push(`- ${p.avatar} **${p.name}**（${p.model}）${p.bio ? `：${p.bio}` : ''}`);
  lines.push('', '## 对话', '');
  for (const m of room.messages) {
    if (!m.content.trim()) continue;
    const who = m.role === 'human' ? `🧑 ${m.speakerName}` : `${m.avatar ?? '🤖'} ${m.speakerName}`;
    lines.push(`**${who}**${m.status === 'interrupted' ? '（被打断）' : ''}：`, '', m.content.trim(), '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${room.title}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function RoomView({
  roomId,
  onTitleChange,
  onDeleted,
}: {
  roomId: string;
  onTitleChange: () => void;
  onDeleted: () => void;
}) {
  const { room, runner, connected } = useRoom(roomId);
  const [tab, setTab] = useState<'participants' | 'settings'>('participants');
  const [panelOpen, setPanelOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // 房间名变化时通知侧边栏刷新
  const title = room?.title;
  useEffect(() => {
    if (title) onTitleChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  // 新消息自动滚到底部（如果你正在往上翻看历史就不打扰）
  const lastMsg = room?.messages.at(-1);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [room?.messages.length, lastMsg?.content, lastMsg?.reasoning]);

  const base = `/rooms/${roomId}`;
  const onEdit = useCallback((id: string, content: string) => void attempt(() => patch(`${base}/messages/${id}`, { content })), [base]);
  const onDelete = useCallback((id: string) => void attempt(() => del(`${base}/messages/${id}`)), [base]);
  const onRegenerate = useCallback(
    (id: string) => void attempt(() => post(`${base}/messages/${id}/regenerate`)),
    [base],
  );

  if (!room) {
    return <div className="room-loading">{connected ? '加载中…' : '正在连接…'}</div>;
  }

  const generating = runner?.generating;
  const speaker = generating && room.participants.find((p) => p.id === generating.participantId);
  const running = runner?.status === 'running';
  const manual = room.settings.turnMode === 'manual';

  let statusText = running ? '自动对话中' : '已暂停';
  if (runner?.picking) statusText = 'AI 主持人正在选下一位…';
  else if (speaker) statusText = `${speaker.avatar} ${speaker.name} 正在发言…`;

  return (
    <div className={`room ${panelOpen ? 'with-panel' : ''}`}>
      <div className="room-main">
        <header className="room-header">
          <div className="room-title">
            <h1>{room.title}</h1>
            <span className={`status ${running ? 'status-running' : ''} ${generating ? 'status-busy' : ''}`}>
              <span className="dot" />
              {statusText}
              {!connected && '（连接断开，正在重连…）'}
            </span>
          </div>
          <div className="room-controls">
            {!manual &&
              (running ? (
                <button className="btn" onClick={() => attempt(() => post(`${base}/pause`))} title="当前这句说完后暂停">
                  ⏸ 暂停
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => attempt(() => post(`${base}/run`))}
                  title="让 AI 们自动轮流对话"
                >
                  ▶ {room.messages.length ? '继续' : '开始'}自动对话
                </button>
              ))}
            <button
              className="btn"
              onClick={() => attempt(() => post(`${base}/turn`))}
              title="按当前规则让下一位说一句"
              disabled={room.participants.length === 0}
            >
              ⏭ 下一位
            </button>
            {generating && (
              <button className="btn btn-warn" onClick={() => attempt(() => post(`${base}/stop`))} title="立刻打断并暂停">
                ⏹ 停止
              </button>
            )}
            <div className="menu">
              <button className="icon-btn" onClick={() => setMenuOpen((x) => !x)} aria-label="更多">
                ⋯
              </button>
              {menuOpen && (
                <div className="menu-list" onMouseLeave={() => setMenuOpen(false)}>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      exportMarkdown(room);
                    }}
                  >
                    导出为 Markdown
                  </button>
                  <button
                    onClick={async () => {
                      setMenuOpen(false);
                      if (confirm('清空这个房间的所有消息？角色和设置会保留。')) await attempt(() => post(`${base}/clear`));
                    }}
                  >
                    清空对话
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      setMenuOpen(false);
                      if (confirm(`删除房间「${room.title}」？此操作不能撤销。`) && (await attempt(() => del(base)))) {
                        onDeleted();
                      }
                    }}
                  >
                    删除房间
                  </button>
                </div>
              )}
            </div>
            <button
              className="icon-btn"
              onClick={() => setPanelOpen((x) => !x)}
              title={panelOpen ? '收起侧栏' : '展开侧栏'}
            >
              {panelOpen ? '⇥' : '⇤'}
            </button>
          </div>
        </header>

        <div
          className="messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {room.messages.length === 0 && (
            <div className="empty">
              <div className="empty-icon">💬</div>
              <p>
                {room.settings.humanRole === 'host'
                  ? '你是主持人。先在下面说一句开场白、抛出话题，AI 们就会接话。'
                  : '在下面说点什么，或者点「开始自动对话」让 AI 们先聊起来。'}
              </p>
              {room.scenario && <p className="hint">场景：{room.scenario}</p>}
            </div>
          )}
          {room.messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={i === room.messages.length - 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onRegenerate={onRegenerate}
            />
          ))}
        </div>

        <Composer
          room={room}
          runner={runner}
          onSend={async (content, interrupt) => {
            stickToBottom.current = true;
            return !!(await attempt(() => post(`${base}/messages`, { content, interrupt })));
          }}
        />
      </div>

      {panelOpen && (
        <aside className="room-panel">
          <div className="tabs">
            <button className={tab === 'participants' ? 'active' : ''} onClick={() => setTab('participants')}>
              角色（{room.participants.length}）
            </button>
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
              房间设置
            </button>
          </div>
          {tab === 'participants' ? <ParticipantPanel room={room} runner={runner} /> : <RoomSettingsPanel room={room} />}
        </aside>
      )}
    </div>
  );
}
