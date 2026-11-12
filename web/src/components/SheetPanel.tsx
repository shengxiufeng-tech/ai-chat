import { Brain, Clover, Heart, Minus, Pencil, Plus, Sparkles, TrendingUp, UserRound, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  CHAR_DESC,
  CHAR_KEYS,
  CHAR_NAMES,
  SKILLS,
  skillBase,
  type InvestigatorSheet,
} from '../../../shared/coc';
import type { Room } from '../../../shared/types';
import { post, put } from '../api';
import { attempt } from '../toast';
import { PregenPicker } from './PregenPicker';
import { Segmented } from './ui';

export function SheetPanel({ room, onCreate }: { room: Room; onCreate: () => void }) {
  const trpg = room.trpg!;
  const keys = ['player', ...room.participants.filter((p) => p.role === 'player' && trpg.sheets[p.id]).map((p) => p.id)];
  const [selected, setSelected] = useState('player');
  const key = keys.includes(selected) ? selected : 'player';
  const sheet = trpg.sheets[key];
  const save = (next: InvestigatorSheet) => attempt(() => put(`/rooms/${room.id}/trpg/sheets/${key}`, { sheet: next }));
  const [picking, setPicking] = useState(false);
  const pregens = trpg.pregens ?? [];

  return (
    <div className="panel-section">
      {keys.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <Segmented
            block
            value={key}
            onChange={setSelected}
            options={keys.map((k) => ({
              value: k,
              label: k === 'player' ? (trpg.sheets.player ? `${trpg.sheets.player.name}（你）` : '你') : trpg.sheets[k].name,
            }))}
          />
        </div>
      )}
      {sheet ? (
        <>
          <SheetView sheet={sheet} editable onChange={save} />
          {key === 'player' && (
            <div className="growth-entry">
              <button
                className="btn btn-sm"
                onClick={() => attempt(() => post(`/rooms/${room.id}/trpg/growth`))}
                title="对这次（上一次成长检定之后）成功使用过的技能做成长检定"
              >
                <TrendingUp /> 技能成长检定
              </button>
              <span className="hint">模组结束后，对这次成功使用过的技能做成长检定。守秘人结团时也会提醒你。</span>
            </div>
          )}
          {pregens.length > 0 && (
            <div className="growth-entry">
              <button className="btn btn-sm" onClick={() => setPicking(true)}>
                <Users /> 剧本里的调查员（{pregens.length} 位）
              </button>
              <span className="hint">换成剧本自带的调查员，或者交给 AI 队友扮演。</span>
            </div>
          )}
          {picking && <PregenPicker room={room} onClose={() => setPicking(false)} />}
        </>
      ) : (
        <div className="empty" style={{ marginTop: 40 }}>
          <div className="empty-icon">
            <UserRound />
          </div>
          <p>你还没有调查员。</p>
          <button className="btn btn-primary" onClick={onCreate}>
            创建调查员
          </button>
        </div>
      )}
    </div>
  );
}

function Bar({
  icon,
  label,
  current,
  max,
  color,
  onAdjust,
}: {
  icon: ReactNode;
  label: string;
  current: number;
  max: number;
  color: string;
  onAdjust?: (delta: number) => void;
}) {
  return (
    <div className="bar">
      <div className="bar-head">
        {icon}
        <span>{label}</span>
        <b>
          {current}
          <small> / {max}</small>
        </b>
        {onAdjust && (
          <span className="bar-adjust">
            <button className="icon-btn sm" title={`${label} -1`} onClick={() => onAdjust(-1)}>
              <Minus />
            </button>
            <button className="icon-btn sm" title={`${label} +1`} onClick={() => onAdjust(1)}>
              <Plus />
            </button>
          </span>
        )}
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, (current / Math.max(1, max)) * 100))}%`, background: color }} />
      </div>
    </div>
  );
}

export function SheetView({
  sheet,
  editable,
  onChange,
}: {
  sheet: InvestigatorSheet;
  editable?: boolean;
  onChange?: (s: InvestigatorSheet) => void;
}) {
  const [newItem, setNewItem] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rename = (value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (name && name !== sheet.name) onChange?.({ ...structuredClone(sheet), name });
  };
  const c = sheet.characteristics;
  const clone = () => structuredClone(sheet);
  const adjust = (k: 'hp' | 'mp' | 'san', delta: number) => {
    const s = clone();
    s[k].current = Math.max(0, Math.min(s[k].max, s[k].current + delta));
    onChange?.(s);
  };
  const skills = Object.entries(sheet.skills)
    .filter(([name, v]) => showAll || v > skillBase(name, c) || v >= 40)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div className="sheet-portrait">{sheet.name.slice(0, 1)}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          {renaming ? (
            <input
              className="sheet-name-input"
              defaultValue={sheet.name}
              autoFocus
              aria-label="调查员的名字"
              onFocus={(e) => e.target.select()}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = sheet.name;
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <div className="sheet-name">
              {sheet.name || '（还没有名字）'}
              {editable && (
                <button className="icon-btn sm" title="改名" aria-label="改名" onClick={() => setRenaming(true)}>
                  <Pencil />
                </button>
              )}
            </div>
          )}
          <div className="sheet-occ">
            {sheet.occupation} · {sheet.age} 岁{sheet.gender ? ` · ${sheet.gender}` : ''}
          </div>
        </div>
      </div>

      <div className="bars">
        <Bar icon={<Heart />} label="生命" current={sheet.hp.current} max={sheet.hp.max} color="#f87171" onAdjust={editable ? (d) => adjust('hp', d) : undefined} />
        <Bar icon={<Brain />} label="理智" current={sheet.san.current} max={sheet.san.max} color="#a78bfa" onAdjust={editable ? (d) => adjust('san', d) : undefined} />
        <Bar icon={<Sparkles />} label="魔法" current={sheet.mp.current} max={sheet.mp.max} color="#38bdf8" onAdjust={editable ? (d) => adjust('mp', d) : undefined} />
        <Bar icon={<Clover />} label="幸运" current={sheet.luck} max={99} color="#34d399" />
      </div>

      <div>
        <div className="section-title" style={{ marginBottom: 10 }}>属性</div>
        <div className="chars">
          {CHAR_KEYS.map((k) => (
            <div key={k} className="char" title={CHAR_DESC[k]}>
              <span>{CHAR_NAMES[k]}</span>
              <b>{c[k]}</b>
              <small>
                {Math.floor(c[k] / 2)} / {Math.floor(c[k] / 5)}
              </small>
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          移动力 {sheet.mov} · 伤害加值 {sheet.damageBonus} · 体格 {sheet.build}。小字是困难 / 极难成功需要的数字。
        </div>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>技能</div>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={() => setShowAll((x) => !x)}>
            {showAll ? '只看擅长的' : '显示全部'}
          </button>
        </div>
        <div className="skill-list">
          {skills.map(([name, v]) => (
            <div
              key={name}
              className={`skill-item ${v >= 50 ? 'high' : ''}`}
              title={`${SKILLS.find((s) => s.name === name)?.desc ?? ''}（困难 ${Math.floor(v / 2)}，极难 ${Math.floor(v / 5)}）`}
            >
              <span className="name">{name}</span>
              <span className="val">{v}</span>
              <span className="sub">
                {Math.floor(v / 2)}/{Math.floor(v / 5)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="section-title" style={{ marginBottom: 8 }}>物品</div>
        <div className="items">
          {sheet.items.map((item, i) => (
            <span key={`${item}-${i}`} className="item-tag">
              {item}
              {editable && (
                <button
                  title="移除"
                  onClick={() => {
                    const s = clone();
                    s.items.splice(i, 1);
                    onChange?.(s);
                  }}
                >
                  <X />
                </button>
              )}
            </span>
          ))}
          {sheet.items.length === 0 && <span className="hint">（空）</span>}
        </div>
        {editable && (
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!newItem.trim()) return;
              const s = clone();
              s.items.push(newItem.trim());
              onChange?.(s);
              setNewItem('');
            }}
          >
            <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="添加物品" style={{ height: 30 }} />
            <button className="btn btn-sm" type="submit">
              添加
            </button>
          </form>
        )}
      </div>

      {(sheet.appearance || sheet.backstory) && (
        <div>
          <div className="section-title" style={{ marginBottom: 8 }}>背景</div>
          {sheet.appearance && <p className="hint" style={{ margin: '0 0 6px', color: 'var(--text-2)' }}>形象：{sheet.appearance}</p>}
          {sheet.backstory && <p className="hint" style={{ margin: 0, color: 'var(--text-2)' }}>{sheet.backstory}</p>}
        </div>
      )}
    </div>
  );
}
