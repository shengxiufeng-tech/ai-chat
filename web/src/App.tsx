import { useCallback, useEffect, useState } from 'react';
import type { RoomSummary } from '../../shared/types';
import { get } from './api';
import { NewRoomModal } from './components/NewRoomModal';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { useModels } from './models';
import { attempt, Toaster } from './toast';

export default function App() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('ai-chat:room'));
  const [showSettings, setShowSettings] = useState(false);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const models = useModels();

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

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">💬 AI 对话室</div>
        <button className="btn btn-primary btn-block" onClick={() => setShowNewRoom(true)}>
          ＋ 新建房间
        </button>
        <ul className="room-list">
          {rooms.map((r) => (
            <li key={r.id}>
              <button className={r.id === selected ? 'active' : ''} onClick={() => setSelected(r.id)}>
                <span className="room-list-title">{r.title}</span>
                <span className="room-list-meta">{r.participantCount} 位 AI</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <div className={`conn ${models.error ? 'conn-bad' : models.loading ? '' : 'conn-ok'}`}>
            <span className="dot" />
            {models.loading
              ? '正在连接模型服务…'
              : models.error
                ? '模型服务连接失败'
                : `模型服务已连接（${models.models.length} 个模型）`}
          </div>
          <button className="btn btn-block" onClick={() => setShowSettings(true)}>
            ⚙ 设置
          </button>
        </div>
      </nav>

      <main className="main">
        {selected ? (
          <RoomView
            key={selected}
            roomId={selected}
            onTitleChange={loadRooms}
            onDeleted={() => {
              setSelected(null);
              void loadRooms();
            }}
          />
        ) : (
          <div className="welcome">
            <h1>欢迎来到 AI 对话室</h1>
            <p>让多个 AI 角色互相对话，你可以当主持人开场、随时插话、点名谁来回答。</p>
            {models.error && (
              <div className="callout callout-error">
                还连不上模型服务：{models.error}
                <br />
                请确认 Magpie 正在运行，或者在「设置」里修改地址（填 <code>mock</code> 可以先用模拟回复体验）。
              </div>
            )}
            <div className="row">
              <button className="btn btn-primary" onClick={() => setShowNewRoom(true)}>
                ＋ 新建第一个房间
              </button>
              <button className="btn" onClick={() => setShowSettings(true)}>
                ⚙ 设置
              </button>
            </div>
          </div>
        )}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showNewRoom && (
        <NewRoomModal
          onClose={() => setShowNewRoom(false)}
          onCreated={(room) => {
            setShowNewRoom(false);
            setSelected(room.id);
            void loadRooms();
          }}
        />
      )}
      <Toaster />
    </div>
  );
}
