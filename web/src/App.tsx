import { Dices, FileUp, Menu, Monitor, Moon, Plus, Settings, Sparkles, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room, RoomMode, RoomSummary } from '../../shared/types';
import { get, post } from './api';
import { NewRoomModal } from './components/NewRoomModal';
import { RoomList } from './components/RoomList';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { Segmented } from './components/ui';
import { ConfirmHost } from './confirm';
import { useModels } from './models';
import { useTheme } from './theme';
import { attempt, toast, Toaster } from './toast';

export default function App() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('ai-chat:room'));
  const [showSettings, setShowSettings] = useState(false);
  const [newRoom, setNewRoom] = useState<RoomMode | null>(null);
  // 手机上左侧栏是抽屉，默认收起
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const models = useModels();
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RoomSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  const loadRooms = useCallback(async () => {
    const list = await attempt(() => get<RoomSummary[]>('/rooms'));
    if (!list) return;
    setRooms(list);
    setSelected((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  // 搜索：输入停顿 200ms 后再查，避免每个字都请求
  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    const list = await attempt(() => get<RoomSummary[]>(`/rooms?q=${encodeURIComponent(q.trim())}`));
    setResults(list ?? []);
    setSearching(false);
  }, []);
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => void runSearch(query), 200);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const refresh = useCallback(async () => {
    await loadRooms();
    if (query.trim()) await runSearch(query);
  }, [loadRooms, runSearch, query]);

  // Ctrl/⌘ + K 聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onRoomDeleted = (id: string) => {
    if (id === selected) {
      // 删除当前打开的房间后，切换到相邻的房间
      const idx = rooms.findIndex((r) => r.id === id);
      const next = rooms[idx + 1] ?? rooms[idx - 1];
      setSelected(next && next.id !== id ? next.id : null);
    }
    void refresh();
  };

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
    const room = await attempt(() => post<Room>('/rooms/import', { room: data?.room ?? data, assets: data?.assets }));
    if (room) {
      toast(room.mode === 'trpg' && room.trpg?.scenarioId === 'custom' ? `已导入「${room.title}」，剧本也加入了剧本库` : `已导入「${room.title}」`);
      await loadRooms();
      setSelected(room.id);
    }
  };

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
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
          <button
            className="btn btn-primary"
            onClick={() => {
              setNavOpen(false);
              setNewRoom('chat');
            }}
          >
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
        <RoomList
          ref={searchRef}
          rooms={results ?? rooms}
          query={query}
          searching={searching}
          selected={selected}
          onQuery={setQuery}
          onSelect={(id) => {
            setSelected(id);
            setNavOpen(false);
          }}
          onChanged={() => void refresh()}
          onDeleted={onRoomDeleted}
        />
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
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setNavOpen(false);
                setShowSettings(true);
              }}
            >
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
            onMetaChange={refresh}
            onDeleted={() => onRoomDeleted(selected)}
            onOpenNav={() => setNavOpen(true)}
          />
        ) : (
          <div className="welcome">
            <button className="icon-btn mobile-only welcome-nav" onClick={() => setNavOpen(true)} aria-label="房间列表" title="房间列表">
              <Menu />
            </button>
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
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
