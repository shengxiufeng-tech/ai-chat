import { Eye, EyeOff, Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ASSET_KIND_LABELS, type Room } from '../../../shared/types';
import { del, patch } from '../api';
import { askConfirm } from '../confirm';
import { attempt } from '../toast';
import { assetUrl } from './HandoutCard';
import { Field, ToggleRow } from './ui';

export function TrpgSettingsPanel({ room }: { room: Room }) {
  const trpg = room.trpg!;
  const [spoiler, setSpoiler] = useState(false);
  const set = (body: Record<string, boolean>) => attempt(() => patch(`/rooms/${room.id}/trpg`, body));

  return (
    <div className="panel-section form-stack">
      <Field label="剧本">
        <div className="scenario-intro">
          <b>{trpg.scenarioTitle}</b>
          <br />
          {trpg.scenarioIntro}
        </div>
        {(trpg.eraLabel || trpg.playerInfo) && (
          <div className="player-info">
            {trpg.eraLabel && <div>时代背景：{trpg.eraLabel}</div>}
            {trpg.playerInfo && <div style={{ whiteSpace: 'pre-wrap' }}>{trpg.playerInfo}</div>}
          </div>
        )}
      </Field>
      <div className="divider" />
      <ToggleRow
        label="新手教学模式"
        hint="规则第一次出现时，守秘人会附上「规则小贴士」"
        checked={trpg.teachingMode}
        onChange={(v) => set({ teachingMode: v })}
      />
      <ToggleRow
        label="自动替我掷骰"
        hint="关闭时由你亲手点「掷骰」，更有参与感"
        checked={trpg.autoRoll}
        onChange={(v) => set({ autoRoll: v })}
      />
      <ToggleRow
        label="守秘人笔记"
        hint="守秘人自动记下重要的 NPC 和线索（你能在「笔记」页看到），长时间游戏不容易前后矛盾"
        checked={trpg.notebook}
        onChange={(v) => set({ notebook: v })}
      />
      <ToggleRow
        label="AI 队友自动行动"
        hint="守秘人说完后，每位队友说一句自己的行动"
        checked={trpg.teammatesAct}
        onChange={(v) => set({ teammatesAct: v })}
      />
      <div className="divider" />
      <ToggleRow
        label="秘密备忘"
        hint="守秘人把自己临时定下的秘密设定（真相、NPC 的真实身份等）记在只有它能看到的备忘里，保证前后一致。AI 即兴剧本强烈建议开启"
        checked={trpg.memo}
        onChange={(v) => set({ memo: v })}
      />
      {!!trpg.assets?.some((a) => a.kind === 'map') && (
        <>
          <div className="divider" />
          <ToggleRow
            label="把剧本地图发给守秘人"
            hint="守秘人每轮都能看到剧本里的地图图片，描述方位和路线更准确（守秘人的模型要能看图；不能看图的模型请关掉）"
            checked={trpg.mapsToKp !== false}
            onChange={(v) => set({ mapsToKp: v })}
          />
        </>
      )}
      <div className="divider" />
      <Field
        label="剧透区"
        hint={`剧本内容${trpg.memo ? `和守秘人的秘密备忘（${trpg.memos.length} 条）` : ''}只有守秘人能看到，玩完之后再看吧`}
      >
        <button className="btn btn-sm" onClick={() => setSpoiler((x) => !x)} style={{ alignSelf: 'flex-start' }}>
          {spoiler ? <EyeOff /> : <Eye />} {spoiler ? '隐藏' : '我确定要看'}
        </button>
        {spoiler && (
          <>
            <div className="section-title" style={{ marginTop: 6 }}>秘密备忘</div>
            {trpg.memos.length === 0 ? (
              <span className="hint">守秘人还没有写下秘密备忘。</span>
            ) : (
              trpg.memos.map((m) => (
                <div key={m.id} className="note-card memo-card">
                  <div className="note-head">
                    <Lock style={{ width: 13, height: 13, color: 'var(--text-3)' }} />
                    <span className="note-title">{m.title}</span>
                    <span className="spacer" />
                    <div className="note-actions">
                      <button
                        className="icon-btn sm"
                        title="删除"
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: '删除秘密备忘',
                            message: `删除备忘「${m.title}」？守秘人之后就不会再看到它，可能导致剧情前后不一致。`,
                            confirmText: '删除',
                            danger: true,
                          });
                          if (ok) await attempt(() => del(`/rooms/${room.id}/memos/${m.id}`));
                        }}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                  <div className="note-text">{m.text}</div>
                </div>
              ))
            )}
            {!!trpg.assets?.length && (
              <>
                <div className="section-title" style={{ marginTop: 6 }}>手出物和地图</div>
                <div className="asset-grid">
                  {trpg.assets.map((a) => (
                    <a key={a.id} className="asset-thumb" href={assetUrl(room.id, a.id)} target="_blank" rel="noreferrer" title={a.description}>
                      <img src={assetUrl(room.id, a.id)} alt={a.title} loading="lazy" />
                      <span>
                        {ASSET_KIND_LABELS[a.kind]}「{a.title}」{a.visibility === 'keeper' ? '（守秘人专用）' : a.shown ? '（已展示）' : ''}
                      </span>
                    </a>
                  ))}
                </div>
              </>
            )}
            <div className="section-title" style={{ marginTop: 6 }}>剧本内容</div>
            <div className="scenario-intro" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>
              {trpg.scenarioSecret}
            </div>
          </>
        )}
      </Field>
    </div>
  );
}
