import { BookMarked, Check, Pencil, ScrollText, Trash2, UserRound, X, Search as SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { NOTE_KIND_LABELS, type NoteEntry, type NoteKind } from '../../../shared/coc';
import { ASSET_KIND_LABELS, type Room } from '../../../shared/types';
import { del, patch } from '../api';
import { askConfirm } from '../confirm';
import { attempt } from '../toast';
import { assetUrl, Lightbox } from './HandoutCard';

function time(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 守秘人笔记：守秘人自动记下的 NPC 和线索，玩家和 AI 队友都能看到 */
/** 守秘人展示过的手出物和地图：随时可以再翻出来看 */
function ShownAssets({ room }: { room: Room }) {
  const [open, setOpen] = useState<{ src: string; title: string } | null>(null);
  const shown = (room.trpg?.assets ?? []).filter((a) => a.shown);
  if (!shown.length) return null;
  return (
    <div className="notes-section">
      <div className="section-title notes-title">
        <ScrollText />
        看过的手出物和地图
        <span className="badge">{shown.length}</span>
      </div>
      <div className="asset-grid">
        {shown.map((a) => (
          <button key={a.id} className="asset-thumb" onClick={() => setOpen({ src: assetUrl(room.id, a.id), title: `${ASSET_KIND_LABELS[a.kind]}「${a.title}」` })}>
            <img src={assetUrl(room.id, a.id)} alt={a.title} loading="lazy" />
            <span>
              {ASSET_KIND_LABELS[a.kind]}「{a.title}」
            </span>
          </button>
        ))}
      </div>
      {open && <Lightbox src={open.src} title={open.title} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function NotesPanel({ room }: { room: Room }) {
  const trpg = room.trpg!;
  const notes = trpg.notes ?? [];

  if (!trpg.notebook) {
    return (
      <div className="panel-section">
        <div className="empty" style={{ marginTop: 40 }}>
          <div className="empty-icon">
            <BookMarked />
          </div>
          <p>守秘人笔记已关闭。</p>
          <p className="hint">开启后，守秘人会把重要的 NPC 和你发现的线索自动记在这里，长时间游戏也不容易前后矛盾。</p>
          <ShownAssets room={room} />
          <button className="btn btn-primary" onClick={() => attempt(() => patch(`/rooms/${room.id}/trpg`, { notebook: true }))}>
            开启笔记
          </button>
        </div>
      </div>
    );
  }

  const section = (kind: NoteKind) => {
    const list = notes.filter((n) => n.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <div className="notes-section">
        <div className="section-title notes-title">
          {kind === 'npc' ? <UserRound /> : <SearchIcon />}
          {NOTE_KIND_LABELS[kind]}
          <span className="badge">{list.length}</span>
        </div>
        {list.length === 0 ? (
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {kind === 'npc' ? '还没有记录 NPC。' : '还没有发现线索。'}
          </p>
        ) : (
          list.map((n) => <NoteCard key={n.id} room={room} note={n} />)
        )}
      </div>
    );
  };

  return (
    <div className="panel-section">
      <div className="callout callout-info" style={{ marginBottom: 16 }}>
        <BookMarked />
        <span>守秘人会把重要的 NPC 和你发现的线索记在这里，你和 AI 队友都能看到。记错了可以直接改或删掉。</span>
      </div>
      <ShownAssets room={room} />
      {section('clue')}
      {section('npc')}
    </div>
  );
}

function NoteCard({ room, note }: { room: Room; note: NoteEntry }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [text, setText] = useState(note.text);
  const fresh = Date.now() - note.updatedAt < 90_000;
  const url = `/rooms/${room.id}/notes/${note.id}`;

  if (editing) {
    return (
      <div className="note-card editing">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="标题" />
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="内容" />
        <div className="row">
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => setEditing(false)}>
            <X /> 取消
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={async () => {
              if (await attempt(() => patch(url, { title, text }))) setEditing(false);
            }}
          >
            <Check /> 保存
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`note-card ${fresh ? 'fresh' : ''}`}>
      <div className="note-head">
        <span className="note-title">{note.title}</span>
        {fresh && <span className="badge badge-accent">{note.createdAt === note.updatedAt ? '新' : '刚更新'}</span>}
        <span className="spacer" />
        <span className="hint">{time(note.updatedAt)}</span>
        <div className="note-actions">
          <button
            className="icon-btn sm"
            title="编辑"
            onClick={() => {
              setTitle(note.title);
              setText(note.text);
              setEditing(true);
            }}
          >
            <Pencil />
          </button>
          <button
            className="icon-btn sm"
            title="删除"
            onClick={async () => {
              const ok = await askConfirm({
                title: '删除笔记',
                message: `删除${NOTE_KIND_LABELS[note.kind]}「${note.title}」？守秘人之后也不会再看到这条笔记。`,
                confirmText: '删除',
                danger: true,
              });
              if (ok) await attempt(() => del(url));
            }}
          >
            <Trash2 />
          </button>
        </div>
      </div>
      <div className="note-text">{note.text}</div>
    </div>
  );
}
