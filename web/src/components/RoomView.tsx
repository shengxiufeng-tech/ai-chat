import {
  BookUser,
  Eraser,
  GraduationCap,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pencil,
  Play,
  Settings2,
  Share2,
  SkipForward,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { del, patch, post } from '../api';
import { askConfirm } from '../confirm';
import { attempt } from '../toast';
import { useRoom } from '../useRoom';
import { AssistantPanel } from './AssistantPanel';
import { CastBar } from './CastBar';
import { CharacterWizard } from './CharacterWizard';
import { Composer } from './Composer';
import { ExportModal } from './ExportModal';
import { MessageItem } from './MessageItem';
import { ParticipantPanel } from './ParticipantPanel';
import { deleteRoom, renameRoom } from './RoomList';
import { RoomSettingsPanel } from './RoomSettingsPanel';
import { SheetPanel } from './SheetPanel';
import { TrpgSettingsPanel } from './TrpgSettingsPanel';
import { TrpgSetup } from './TrpgSetup';

type Tab = 'participants' | 'settings' | 'sheet' | 'assistant' | 'trpg-settings';

export function RoomView({
  roomId,
  onMetaChange,
  onDeleted,
}: {
  roomId: string;
  onMetaChange: () => void;
  onDeleted: () => void;
}) {
  const { room, runner, connected } = useRoom(roomId);
  const [tab, setTab] = useState<Tab | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 1100);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const saveTitle = async (value: string) => {
    setEditingTitle(false);
    if (room && value.trim() && value.trim() !== room.title) await renameRoom(room.id, value);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const trpg = room?.mode === 'trpg';
  const activeTab: Tab = tab ?? (trpg ? 'sheet' : 'participants');

  // 房间名、角色变化时通知侧边栏刷新
  const metaKey = room ? `${room.title}|${room.participants.map((p) => p.avatar).join('')}` : '';
  useEffect(() => {
    if (metaKey) onMetaChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaKey]);

  // 新消息自动滚到底部（如果你正在往上翻看历史就不打扰）
  const lastMsg = room?.messages.at(-1);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [room?.messages.length, lastMsg?.content, lastMsg?.reasoning, lastMsg?.roll?.pending]);

  // 输入区变高（比如出现行动建议）时，保持停在底部
  const hasRoom = !!room;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRoom]);

  const base = `/rooms/${roomId}`;
  const onEdit = useCallback((id: string, content: string) => void attempt(() => patch(`${base}/messages/${id}`, { content })), [base]);
  const onDelete = useCallback((id: string) => void attempt(() => del(`${base}/messages/${id}`)), [base]);
  const onRegenerate = useCallback((id: string) => void attempt(() => post(`${base}/messages/${id}/regenerate`)), [base]);
  const onRoll = useCallback((id: string) => attempt(() => post(`${base}/rolls/${id}/roll`)), [base]);
  const onPush = useCallback((id: string) => attempt(() => post(`${base}/rolls/${id}/push`)), [base]);

  if (!room) {
    return (
      <div className="room-loading">
        <Loader2 className="spin" style={{ width: 16, height: 16 }} />
        {connected ? '加载中…' : '正在连接…'}
      </div>
    );
  }

  const generating = runner?.generating;
  const speaker = generating && room.participants.find((p) => p.id === generating.participantId);
  const running = runner?.status === 'running';
  const manual = room.settings.turnMode === 'manual';
  const kpId = room.participants.find((p) => p.role === 'kp')?.id;
  const t = room.trpg;
  const needSetup = trpg && t && !t.started && room.messages.length === 0;
  const pendingRoll = room.messages.some((m) => m.roll?.pending && m.roll.actor === 'player');

  let statusText = trpg ? (pendingRoll ? '等你掷骰' : '轮到你行动') : running ? '自动对话中' : '已暂停';
  if (runner?.picking) statusText = 'AI 主持人在选下一位…';
  else if (speaker) statusText = `${speaker.name} 正在${speaker.role === 'kp' ? '描述' : '发言'}…`;

  const tabs: { key: Tab; label: string; icon: ReactNode }[] = trpg
    ? [
        { key: 'sheet', label: '调查员', icon: <BookUser /> },
        { key: 'assistant', label: '规则助手', icon: <GraduationCap /> },
        { key: 'participants', label: 'AI', icon: <Users /> },
        { key: 'trpg-settings', label: '设置', icon: <Settings2 /> },
      ]
    : [
        { key: 'participants', label: `角色 ${room.participants.length}`, icon: <Users /> },
        { key: 'settings', label: '房间设置', icon: <Settings2 /> },
      ];

  return (
    <div className={`room ${panelOpen ? 'with-panel' : ''}`}>
      <div className="room-main">
        <header className="room-header">
          <div className="room-title">
            <div className="room-title-row">
              {editingTitle ? (
                <input
                  className="room-title-input"
                  defaultValue={room.title}
                  autoFocus
                  aria-label="房间名"
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => void saveTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      e.currentTarget.value = room.title;
                      e.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <>
                  <h1 onDoubleClick={() => setEditingTitle(true)} title="双击修改房间名">
                    {room.title}
                  </h1>
                  <button className="icon-btn sm title-edit" title="修改房间名" onClick={() => setEditingTitle(true)}>
                    <Pencil />
                  </button>
                </>
              )}
              <span className={`status-pill ${running ? 'running' : ''} ${generating || runner?.picking ? 'busy' : ''}`}>
                <span className="dot" />
                {statusText}
                {!connected && '（重连中…）'}
              </span>
            </div>
            {room.scenario && room.settings.promptMode !== 'humanlike' && <div className="room-subtitle">{room.scenario}</div>}
          </div>
          <div className="room-controls">
            {!trpg && !manual &&
              (running ? (
                <button className="btn" onClick={() => attempt(() => post(`${base}/pause`))} title="当前这句说完后暂停">
                  <Pause /> 暂停
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => attempt(() => post(`${base}/run`))} title="让 AI 们自动轮流对话">
                  <Play /> {room.messages.length ? '继续' : '开始'}自动对话
                </button>
              ))}
            {!trpg && (
              <button
                className="icon-btn"
                onClick={() => attempt(() => post(`${base}/turn`))}
                title="下一位：按当前规则让一位 AI 说一句"
                disabled={room.participants.length === 0}
              >
                <SkipForward />
              </button>
            )}
            {generating && (
              <button className="btn btn-warn" onClick={() => attempt(() => post(`${base}/stop`))} title="立刻打断并暂停">
                <Square /> 停止
              </button>
            )}
            <span className="toolbar-sep" />
            <button className="icon-btn" title="导出与分享" onClick={() => setExporting(true)} disabled={room.messages.length === 0}>
              <Share2 />
            </button>
            <div className="menu">
              <button className="icon-btn" onClick={() => setMenuOpen((x) => !x)} aria-label="更多" title="更多">
                <MoreHorizontal />
              </button>
              {menuOpen && (
                <div className="menu-list" onMouseLeave={() => setMenuOpen(false)}>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setExporting(true);
                    }}
                  >
                    <Share2 /> 导出与分享
                  </button>
                  <button
                    onClick={async () => {
                      setMenuOpen(false);
                      const ok = await askConfirm({
                        title: trpg ? '重新开始游戏' : '清空对话',
                        message: trpg ? '清空所有消息，从头开始这场游戏？你的调查员会保留。' : '清空这个房间的所有消息？角色和设置会保留。',
                        confirmText: trpg ? '重新开始' : '清空',
                        danger: true,
                      });
                      if (ok) await attempt(() => post(`${base}/clear`));
                    }}
                  >
                    <Eraser /> {trpg ? '重新开始游戏' : '清空对话'}
                  </button>
                  <div className="menu-sep" />
                  <button
                    className="danger"
                    onClick={async () => {
                      setMenuOpen(false);
                      if (await deleteRoom(room)) onDeleted();
                    }}
                  >
                    <Trash2 /> 删除房间
                  </button>
                </div>
              )}
            </div>
            <button className="icon-btn" onClick={() => setPanelOpen((x) => !x)} title={panelOpen ? '收起侧栏' : '展开侧栏'}>
              {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </button>
          </div>
        </header>

        <CastBar room={room} runner={runner} />

        <div
          className="messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {needSetup ? (
            <TrpgSetup room={room} onCreate={() => setWizard(true)} />
          ) : room.messages.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <MessagesSquare />
              </div>
              <p>
                {room.settings.promptMode === 'humanlike'
                  ? '点上方的「开始自动对话」，让 AI 们像真人一样聊起来；你也可以先说第一句。'
                  : room.settings.humanRole === 'host'
                    ? '你是主持人。先在下面说一句开场白、抛出话题，AI 们就会接话。'
                    : '在下面说点什么，或者点「开始自动对话」让 AI 们先聊起来。'}
              </p>
            </div>
          ) : (
            <div className="messages-inner">
              {room.messages.map((m, i) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isLast={i === room.messages.length - 1}
                  isKp={!!kpId && m.participantId === kpId}
                  playerName={trpg ? t?.sheets.player?.name : undefined}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onRegenerate={onRegenerate}
                  onRoll={onRoll}
                  onPush={onPush}
                />
              ))}
            </div>
          )}
        </div>

        <Composer
          room={room}
          runner={runner}
          disabled={needSetup ? '先创建调查员并开始游戏…' : undefined}
          onSend={async (content, opts) => {
            stickToBottom.current = true;
            return !!(await attempt(() => post(`${base}/messages`, { content, ...opts })));
          }}
        />
      </div>

      {panelOpen && (
        <aside className="room-panel">
          <div className="tabs">
            {tabs.map((x) => (
              <button key={x.key} className={activeTab === x.key ? 'active' : ''} onClick={() => setTab(x.key)}>
                {x.icon}
                {x.label}
              </button>
            ))}
          </div>
          {activeTab === 'participants' && <ParticipantPanel room={room} runner={runner} />}
          {activeTab === 'settings' && <RoomSettingsPanel room={room} />}
          {activeTab === 'sheet' && trpg && <SheetPanel room={room} onCreate={() => setWizard(true)} />}
          {activeTab === 'assistant' && trpg && <AssistantPanel room={room} />}
          {activeTab === 'trpg-settings' && trpg && <TrpgSettingsPanel room={room} />}
        </aside>
      )}

      {exporting && <ExportModal room={room} onClose={() => setExporting(false)} />}
      {wizard && <CharacterWizard room={room} onClose={() => setWizard(false)} />}
    </div>
  );
}
