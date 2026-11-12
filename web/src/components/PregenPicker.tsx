import { UserRound } from 'lucide-react';
import { CHAR_NAMES, type CharKey, type InvestigatorSheet } from '../../../shared/coc';
import type { Room } from '../../../shared/types';
import { put } from '../api';
import { attempt, toast } from '../toast';
import { Modal } from './Modal';

const KEYS: CharKey[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];

/** 选用剧本自带的预设调查员 */
export function PregenPicker({ room, onClose }: { room: Room; onClose: () => void }) {
  const pregens = room.trpg?.pregens ?? [];
  const choose = async (s: InvestigatorSheet) => {
    const ok = await attempt(() => put(`/rooms/${room.id}/trpg/sheets/player`, { sheet: structuredClone(s) }));
    if (ok) {
      toast(`你将扮演「${s.name}」`);
      onClose();
    }
  };
  return (
    <Modal title="选用剧本里的调查员" icon={<UserRound />} onClose={onClose} size="wide">
      <div className="pregen-list">
        {pregens.map((s) => {
          const top = Object.entries(s.skills)
            .filter(([n]) => n !== '母语')
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6);
          return (
            <div key={s.name} className="pregen-card">
              <div className="pregen-head">
                <div className="pregen-avatar">{s.name.slice(0, 1)}</div>
                <div className="grow">
                  <div className="pregen-name">{s.name}</div>
                  <div className="hint">
                    {s.occupation} · {s.age} 岁 · 生命 {s.hp.max} · 理智 {s.san.current} · 幸运 {s.luck}
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => void choose(s)}>
                  选这位
                </button>
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
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
