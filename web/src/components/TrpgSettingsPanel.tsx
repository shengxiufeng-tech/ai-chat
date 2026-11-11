import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { Room } from '../../../shared/types';
import { patch } from '../api';
import { attempt } from '../toast';
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
      <Field label="剧本内容（剧透）" hint="只有守秘人能看到。玩完之后再看吧">
        <button className="btn btn-sm" onClick={() => setSpoiler((x) => !x)} style={{ alignSelf: 'flex-start' }}>
          {spoiler ? <EyeOff /> : <Eye />} {spoiler ? '隐藏' : '我确定要看'}
        </button>
        {spoiler && (
          <div className="scenario-intro" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflowY: 'auto' }}>
            {trpg.scenarioSecret}
          </div>
        )}
      </Field>
    </div>
  );
}
