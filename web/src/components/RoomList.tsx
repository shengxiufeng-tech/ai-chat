import { MoreHorizontal, Pencil, Search, Trash2, X } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RoomSummary } from '../../../shared/types';
import { del, patch } from '../api';
import { askConfirm } from '../confirm';
import { attempt, toast } from '../toast';

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** 把搜索词高亮出来 */
function highlight(text: string, q: string): ReactNode {
  const query = q.trim();
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  for (let idx = lower.indexOf(needle); idx >= 0; idx = lower.indexOf(needle, i)) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + query.length)}</mark>);
    i = idx + query.length;
  }
  parts.push(text.slice(i));
  return parts;
}

/** 修改房间名 */
export async function renameRoom(id: string, title: string) {
  const t = title.trim();
  if (!t) return false;
  return !!(await attempt(() => patch(`/rooms/${id}`, { title: t })));
}

/** 删除房间（会先确认） */
export async function deleteRoom(room: { id: string; title: string }) {
  const ok = await askConfirm({
    title: '删除房间',
    message: (
      <>
        确定要删除「<b>{room.title}</b>」吗？房间里的角色和全部消息都会被删除，不能撤销。
        <br />
        <span className="hint">想留着的话，可以先用「导出与分享」备份成 JSON。</span>
      </>
    ),
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return false;
  const done = !!(await attempt(() => del(`/rooms/${room.id}`)));
  if (done) toast(`已删除「${room.title}」`);
  return done;
}

export const RoomList = forwardRef<
  HTMLInputElement,
  {
    rooms: RoomSummary[];
    query: string;
    searching: boolean;
    selected: string | null;
    onQuery: (q: string) => void;
    onSelect: (id: string) => void;
    onChanged: () => void;
    onDeleted: (id: string) => void;
  }
>(function RoomList({ rooms, query, searching, selected, onQuery, onSelect, onChanged, onDeleted }, ref) {
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const startRename = (id: string) => {
    setMenu(null);
    setEditing(id);
  };

  return (
    <>
      <div className="room-search">
        <Search />
        <input
          ref={ref}
          value={query}
          placeholder="搜索房间和对话内容…"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQuery('');
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {query ? (
          <button className="icon-btn sm" title="清除搜索" onClick={() => onQuery('')}>
            <X />
          </button>
        ) : (
          <kbd title="快捷键">{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
        )}
      </div>

      <ul className="room-list">
        {rooms.length > 0 && (
          <li className="room-list-label">{query ? `${searching ? '搜索中…' : `找到 ${rooms.length} 个房间`}` : '房间'}</li>
        )}
        {query && !searching && rooms.length === 0 && (
          <li className="room-list-empty">没有找到包含「{query}」的房间或对话</li>
        )}
        {rooms.map((r) => (
          <li key={r.id} className={`room-li ${menu?.id === r.id ? 'menu-open' : ''}`}>
            {editing === r.id ? (
              <RenameInput
                initial={r.title}
                onDone={async (title) => {
                  setEditing(null);
                  if (title !== null && title.trim() && title.trim() !== r.title && (await renameRoom(r.id, title))) onChanged();
                }}
              />
            ) : (
              <button
                className={`room-item ${r.id === selected ? 'active' : ''}`}
                onClick={() => onSelect(r.id)}
                onDoubleClick={() => startRename(r.id)}
                title="双击修改房间名"
              >
                <span className="room-item-icon">{r.mode === 'trpg' ? '🎲' : (r.avatars[0] ?? '💬')}</span>
                <span className="room-item-body">
                  <span className="room-item-title">{query && r.match?.where === 'title' ? highlight(r.title, query) : r.title}</span>
                  <span className="room-item-meta">
                    {query && r.match && r.match.where !== 'title' ? (
                      <span className="room-item-snippet">
                        {r.match.where === 'message' ? `${r.match.speaker}：` : r.match.where === 'participant' ? 'AI：' : '场景：'}
                        {highlight(r.match.text, query)}
                      </span>
                    ) : (
                      <>
                        {r.mode === 'trpg' ? '跑团' : `${r.participantCount} 位 AI`} · {ago(r.updatedAt)}
                      </>
                    )}
                  </span>
                </span>
              </button>
            )}
            {editing !== r.id && (
              <button
                className="icon-btn sm room-more"
                title="更多操作"
                aria-label={`「${r.title}」的更多操作`}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu(menu?.id === r.id ? null : { id: r.id, x: rect.right, y: rect.bottom + 4 });
                }}
              >
                <MoreHorizontal />
              </button>
            )}
          </li>
        ))}
      </ul>

      {menu && (
        <RoomMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => startRename(menu.id)}
          onDelete={async () => {
            const room = rooms.find((r) => r.id === menu.id);
            setMenu(null);
            if (room && (await deleteRoom(room))) onDeleted(room.id);
          }}
        />
      )}
    </>
  );
});

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="room-rename"
      value={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) finish(value);
        if (e.key === 'Escape') finish(null);
      }}
      aria-label="房间名"
    />
  );
}

function RoomMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.room-more')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  // 靠近窗口底部时向上弹出
  const top = Math.min(y, window.innerHeight - 100);
  return (
    <div ref={ref} className="menu-list room-menu" style={{ left: Math.max(8, x - 180), top }} role="menu">
      <button onClick={onRename}>
        <Pencil /> 重命名
      </button>
      <div className="menu-sep" />
      <button className="danger" onClick={onDelete}>
        <Trash2 /> 删除房间
      </button>
    </div>
  );
}
