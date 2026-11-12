import { BookOpen, Dices, Play, UserRound, Users, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { quickInvestigator } from '../../../shared/coc';
import type { Room } from '../../../shared/types';
import { post, put } from '../api';
import { attempt } from '../toast';
import { PregenPicker } from './PregenPicker';

/** 跑团开场前的引导卡片：创建调查员 → 开始游戏 */
export function TrpgSetup({ room, onCreate }: { room: Room; onCreate: () => void }) {
  const trpg = room.trpg!;
  const sheet = trpg.sheets.player;
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const pregens = trpg.pregens ?? [];
  const teammates = room.participants.filter((p) => p.role === 'player');

  const quick = () => {
    // 随机名字别和 AI 队友撞名
    const taken = new Set(teammates.map((p) => trpg.sheets[p.id]?.name ?? p.name));
    const name = room.settings.humanName === '我' ? undefined : room.settings.humanName;
    let sheet = quickInvestigator({ occupationId: 'journalist', era: trpg.era, name });
    for (let i = 0; i < 20 && !name && taken.has(sheet.name); i++) {
      sheet = quickInvestigator({ occupationId: 'journalist', era: trpg.era });
    }
    return attempt(() => put(`/rooms/${room.id}/trpg/sheets/player`, { sheet }));
  };

  const start = async () => {
    setStarting(true);
    await attempt(() => post(`/rooms/${room.id}/trpg/start`));
    setStarting(false);
  };

  return (
    <div className="setup-card">
      <h2>
        <BookOpen style={{ width: 20, height: 20, color: '#a78bfa' }} /> {trpg.scenarioTitle}
      </h2>
      <div className="scenario-intro">{trpg.scenarioIntro}</div>
      {(trpg.eraLabel || trpg.playerInfo) && (
        <div className="player-info">
          {trpg.eraLabel && (
            <div>
              <b>时代背景：</b>
              {trpg.eraLabel}
            </div>
          )}
          {trpg.playerInfo && (
            <>
              <b>开团须知：</b>
              {trpg.playerInfo.split('\n').map((l, i) => (
                <div key={i}>{l.replace(/^[-•·\s]+/, '')}</div>
              ))}
            </>
          )}
        </div>
      )}
      <p className="hint" style={{ fontSize: 13 }}>
        <b style={{ color: 'var(--text)' }}>跑团怎么玩？</b> 守秘人（AI）描述场景、扮演故事里的所有人物；你决定你的调查员做什么、说什么。
        结果不确定的时候掷骰子决定成败。不懂的随时问侧栏里的「规则助手」。
        {teammates.length > 0 && ` 这次还有 ${teammates.map((p) => p.name).join('、')} 作为 AI 队友陪你一起调查。`}
      </p>
      <div className="setup-steps">
        <div className={`setup-step ${sheet ? 'done' : 'current'}`}>
          <span className="num">1</span>
          {sheet ? `调查员：${sheet.name}（${sheet.occupation}）` : '创建你的调查员'}
        </div>
        <div className={`setup-step ${sheet ? 'current' : ''}`}>
          <span className="num">2</span>开始游戏，守秘人开场
        </div>
      </div>
      {!sheet ? (
        <div className="row wrap">
          <button className="btn btn-primary btn-lg" onClick={onCreate}>
            <UserRound /> 一步步创建调查员
          </button>
          {pregens.length > 0 && (
            <button className="btn btn-lg" onClick={() => setPicking(true)} title="剧本自带的预设调查员">
              <Users /> 从剧本里选（{pregens.length} 位）
            </button>
          )}
          <button className="btn btn-lg" onClick={quick} title="随机生成一位记者调查员，之后可以在右侧修改">
            <Wand2 /> 直接随机一个
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn btn-primary btn-lg" onClick={start} disabled={starting}>
            <Play /> 开始游戏
          </button>
          <button className="btn btn-lg" onClick={onCreate}>
            <Dices /> 重新创建调查员
          </button>
          {pregens.length > 0 && (
            <button className="btn btn-lg" onClick={() => setPicking(true)}>
              <Users /> 换成剧本里的调查员
            </button>
          )}
        </div>
      )}
      {picking && <PregenPicker room={room} onClose={() => setPicking(false)} />}
    </div>
  );
}
