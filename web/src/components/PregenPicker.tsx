import { UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import { CHAR_NAMES, isPlaceholderName, type CharKey, type InvestigatorSheet } from '../../../shared/coc';
import type { Room } from '../../../shared/types';
import { put } from '../api';
import { attempt, toast } from '../toast';
import { Modal } from './Modal';

const KEYS: CharKey[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];

/** 角色卡是不是来自这位预设调查员（看职业和属性，名字可能改过） */
const samePregen = (a: InvestigatorSheet | undefined, b: InvestigatorSheet) =>
  !!a && a.occupation === b.occupation && KEYS.every((k) => a.characteristics[k] === b.characteristics[k]);

/** 预设调查员的初始名字：剧本里没给名字（「姓名自定」）就留空让你起 */
const initialName = (s: InvestigatorSheet) => (isPlaceholderName(s.name) ? '' : s.name);

/** 选用剧本自带的预设调查员：自己扮演，或者交给 AI 队友 */
export function PregenPicker({ room, onClose }: { room: Room; onClose: () => void }) {
  const trpg = room.trpg!;
  const pregens = trpg.pregens ?? [];
  const mates = room.participants.filter((p) => p.role === 'player');
  const humanName = room.settings.humanName && room.settings.humanName !== '我' ? room.settings.humanName : '';
  // 已经有人在用的，显示现在用的名字
  const [names, setNames] = useState<string[]>(() =>
    pregens.map((s) => {
      if (samePregen(trpg.sheets.player, s)) return trpg.sheets.player!.name;
      const mate = mates.find((p) => samePregen(trpg.sheets[p.id], s));
      return mate ? (trpg.sheets[mate.id]?.name ?? mate.name) : initialName(s);
    }),
  );

  /** 这位预设调查员现在由谁扮演 */
  const holder = (s: InvestigatorSheet) => {
    if (samePregen(trpg.sheets.player, s)) return '你';
    const mate = mates.find((p) => samePregen(trpg.sheets[p.id], s));
    return mate ? (trpg.sheets[mate.id]?.name ?? mate.name) : '';
  };

  const assign = async (i: number, key: string) => {
    const s = pregens[i];
    let name = names[i].trim();
    if (!name && key === 'player') {
      // 剧本没给名字：用你在房间里的名字，没有就要先起一个
      name = humanName;
      if (!name) {
        toast('先给这位调查员起个名字', 'error');
        return;
      }
    }
    if (!name) {
      // 交给队友、又没有名字：沿用队友原来的名字
      const mate = mates.find((p) => p.id === key);
      name = trpg.sheets[key]?.name ?? mate?.name ?? '队友';
    }
    const sheet = { ...structuredClone(s), name };
    const ok = await attempt(() => put(`/rooms/${room.id}/trpg/sheets/${key}`, { sheet }));
    if (ok) toast(key === 'player' ? `你将扮演「${name}」` : `AI 队友改为扮演「${name}」（${s.occupation}）`);
    return ok;
  };

  /** 把还没人用的预设调查员依次交给 AI 队友 */
  const autoMates = async () => {
    const free = pregens.map((s, i) => ({ s, i })).filter(({ s }) => !holder(s));
    let n = 0;
    for (const p of mates) {
      if (pregens.some((s) => samePregen(trpg.sheets[p.id], s))) continue;
      const next = free.shift();
      if (!next) break;
      if (await assign(next.i, p.id)) n++;
    }
    if (!n) toast('没有可以分配的预设调查员了');
  };

  return (
    <Modal title="选用剧本里的调查员" icon={<UserRound />} onClose={onClose} size="wide">
      <div className="form-stack" style={{ gap: 12 }}>
        <div className="hint">
          可以自己扮演其中一位，也可以交给 AI 队友。剧本里没有固定姓名的调查员，请先给 TA 起个名字（交给队友时不填就沿用队友原来的名字）。
        </div>
        {mates.length > 0 && pregens.length > 1 && (
          <div className="row">
            <button className="btn btn-sm" onClick={() => void autoMates()}>
              <Users /> AI 队友也用剧本里的调查员
            </button>
            <span className="hint">把剩下的预设调查员依次交给 AI 队友</span>
          </div>
        )}
        <div className="pregen-list">
          {pregens.map((s, i) => {
            const top = Object.entries(s.skills)
              .filter(([n]) => n !== '母语')
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6);
            const who = holder(s);
            const placeholder = isPlaceholderName(s.name);
            return (
              <div key={i} className={`pregen-card ${who ? 'taken' : ''}`}>
                <div className="pregen-head">
                  <div className="pregen-avatar">{(names[i] || s.occupation).slice(0, 1)}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <input
                      className="pregen-name-input"
                      value={names[i]}
                      placeholder={placeholder ? '请起个名字' : '名字'}
                      onChange={(e) => setNames((x) => x.map((v, j) => (j === i ? e.target.value : v)))}
                      aria-label="调查员的名字"
                    />
                    <div className="hint">
                      {s.occupation} · {s.age} 岁 · 生命 {s.hp.max} · 理智 {s.san.current} · 幸运 {s.luck}
                      {placeholder && s.name ? ` · 卡上写的是「${s.name}」` : ''}
                    </div>
                  </div>
                  {who && <span className="badge badge-accent">{who === '你' ? '你在用' : `${who} 在用`}</span>}
                </div>
                <div className="pregen-chars">
                  {KEYS.map((k) => (
                    <span key={k}>
                      {CHAR_NAMES[k]} <b>{s.characteristics[k]}</b>
                    </span>
                  ))}
                </div>
                <div className="pregen-skills">
                  {top.map(([n, v]) => (
                    <span key={n} className="chip">
                      {n} {v}
                    </span>
                  ))}
                </div>
                {s.backstory && <div className="hint pregen-story">{s.backstory}</div>}
                <div className="row wrap" style={{ gap: 6 }}>
                  <button className="btn btn-primary btn-sm" onClick={async () => (await assign(i, 'player')) && onClose()}>
                    我来扮演
                  </button>
                  {mates.map((p) => (
                    <button key={p.id} className="btn btn-sm" onClick={() => void assign(i, p.id)}>
                      交给 AI 队友「{trpg.sheets[p.id]?.name ?? p.name}」
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
