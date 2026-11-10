import { Dices, FileUp, Monitor, Moon, Plus, Settings, Sparkles, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room, RoomMode, RoomSummary } from '../../shared/types';
import { get, post } from './api';
import { NewRoomModal } from './components/NewRoomModal';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { Segmented } from './components/ui';
import { useModels } from './models';
import { useTheme } from './theme';
import { attempt, toast, Toaster } from './toast';

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export default function App() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('ai-chat:room'));
  const [showSettings, setShowSettings] = useState(false);
  const [newRoom, setNewRoom] = useState<RoomMode | null>(null);
  const [theme, setTheme] = useTheme();
  const models = useModels();
  const fileRef = useRef<HTMLInputElement>(null);

  const loadRooms = useCallback(async () => {
    const list = await attempt(() => get<RoomSummary[]>('/rooms'));
    if (!list) return;
    setRooms(list);
    setSelected((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    if (selected) localStorage.setItem('ai-chat:room', selected);
  }, [selected]);

  const importFile = async (file: File) => {
    let data: any;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('这个文件不是有效的 JSON', 'error');
      return;
    }
    const room = await attempt(() => post<Room>('/rooms/import', { room: data?.room ?? data }));
    if (room) {
      toast(`已导入「${room.title}」`);
      await loadRooms();
      setSelected(room.id);
    }
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Sparkles />
          </div>
          <div>
            <div className="brand-name">AI 对话室</div>
            <div className="brand-sub">多人对话 · 跑团</div>
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="btn btn-primary" onClick={() => setNewRoom('chat')}>
            <Plus /> 新建房间
          </button>
          <button className="icon-btn" title="导入房间（JSON 备份）" onClick={() => fileRef.current?.click()}>
            <FileUp />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <ul className="room-list">
          {rooms.length > 0 && <li className="room-list-label">房间</li>}
          {rooms.map((r) => (
            <li key={r.id}>
              <button className={`room-item ${r.id === selected ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
                <span className="room-item-icon">{r.mode === 'trpg' ? '🎲' : (r.avatars[0] ?? '💬')}</span>
                <span className="room-item-body">
                  <span className="room-item-title">{r.title}</span>
                  <span className="room-item-meta">
                    {r.mode === 'trpg' ? '跑团' : `${r.participantCount} 位 AI`} · {ago(r.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <div className={`conn ${models.error ? 'conn-bad' : models.loading ? '' : 'conn-ok'}`} title={models.error || undefined}>
            <span className="dot" />
            {models.loading ? '正在连接模型服务…' : models.error ? '模型服务连接失败' : `模型服务已连接 · ${models.models.length} 个模型`}
          </div>
          <div className="sidebar-footer-row">
            <Segmented
              size="sm"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: <Monitor />, title: '跟随系统' },
                { value: 'light', label: <Sun />, title: '浅色' },
                { value: 'dark', label: <Moon />, title: '深色' },
              ]}
            />
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setShowSettings(true)}>
              <Settings /> 设置
            </button>
          </div>
        </div>
      </nav>

      <main className="main">
        {selected ? (
          <RoomView
            key={selected}
            roomId={selected}
            onMetaChange={loadRooms}
            onDeleted={() => {
              setSelected(null);
              void loadRooms();
            }}
          />
        ) : (
          <div className="welcome">
            <div className="welcome-logo">
              <Sparkles />
            </div>
            <h1>欢迎来到 AI 对话室</h1>
            <p>让多个 AI 互相对话，你可以主持、插话或旁观；也可以让 AI 当守秘人，带你玩第一场跑团。</p>
            {models.error && (
              <div className="callout callout-error" style={{ textAlign: 'left' }}>
                <span>
                  还连不上模型服务：{models.error}
                  <br />
                  请确认 Magpie 正在运行，或者在「设置」里修改地址（填 <code>mock</code> 可以先用模拟回复体验）。
                </span>
              </div>
            )}
            <div className="welcome-cards">
              <button className="welcome-card" onClick={() => setNewRoom('chat')}>
                <div className="welcome-card-icon">
                  <Sparkles />
                </div>
                <h3>多人对话</h3>
                <p>圆桌闲聊、辩论赛、头脑风暴、拟人对话……每个 AI 可以用不同的模型和思考强度。</p>
              </button>
              <button className="welcome-card" onClick={() => setNewRoom('trpg')}>
                <div className="welcome-card-icon">
                  <Dices />
                </div>
                <h3>跑团（COC 7）</h3>
                <p>AI 当守秘人，程序掷骰，带角色卡和规则助手，适合完全没玩过的新手。</p>
              </button>
            </div>
            <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>
              <Settings /> 设置模型服务
            </button>
          </div>
        )}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {newRoom && (
        <NewRoomModal
          initialMode={newRoom}
          onClose={() => setNewRoom(null)}
          onCreated={(room) => {
            setNewRoom(null);
            setSelected(room.id);
            void loadRooms();
          }}
        />
      )}
      <Toaster />
    </div>
  );
}
