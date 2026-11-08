import { useEffect, useState } from 'react';
import type { Room, RoomSettings } from '../../../shared/types';
import { patch } from '../api';
import { attempt, toast } from '../toast';
import { ModelInput } from './ModelInput';

export function RoomSettingsPanel({ room }: { room: Room }) {
  const [title, setTitle] = useState(room.title);
  const [scenario, setScenario] = useState(room.scenario);
  const [s, setS] = useState<RoomSettings>(room.settings);

  // 切换房间时重置草稿
  useEffect(() => {
    setTitle(room.title);
    setScenario(room.scenario);
    setS(room.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const dirty =
    title !== room.title || scenario !== room.scenario || JSON.stringify(s) !== JSON.stringify(room.settings);
  const set = <K extends keyof RoomSettings>(k: K, v: RoomSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const ok = await attempt(() => patch(`/rooms/${room.id}`, { title, scenario, settings: s }));
    if (ok) toast('房间设置已保存');
  };

  return (
    <div className="panel-section form-stack">
      <label>
        房间名
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span className="label-text">场景 / 话题 <span className="hint">（所有 AI 都能看到）</span></span>
        <textarea rows={5} value={scenario} onChange={(e) => setScenario(e.target.value)} />
      </label>
      <div className="row">
        <label className="grow">
          你的名字
          <input value={s.humanName} onChange={(e) => set('humanName', e.target.value)} />
        </label>
        <label className="grow">
          你的身份
          <select value={s.humanRole} onChange={(e) => set('humanRole', e.target.value as RoomSettings['humanRole'])}>
            <option value="host">主持人</option>
            <option value="participant">参与者</option>
            <option value="observer">旁观者</option>
          </select>
        </label>
      </div>
      <label>
        谁来说下一句
        <select value={s.turnMode} onChange={(e) => set('turnMode', e.target.value as RoomSettings['turnMode'])}>
          <option value="round_robin">轮流发言（按角色列表顺序）</option>
          <option value="moderator">AI 主持人决定（更自然，多一次模型调用）</option>
          <option value="manual">手动点名（只有你点「发言」才说话）</option>
        </select>
        <span className="hint">无论哪种模式，你在消息里 @名字 都会让那位角色优先接话。</span>
      </label>
      {s.turnMode === 'moderator' && (
        <label>
          <span className="label-text">AI 主持人用的模型 <span className="hint">（留空则用全局默认模型，建议选个便宜快速的）</span></span>
          <ModelInput value={s.moderatorModel} onChange={(v) => set('moderatorModel', v)} />
        </label>
      )}
      <div className="row">
        <label className="grow">
          自动暂停
          <select value={s.autoPauseAfter} onChange={(e) => set('autoPauseAfter', Number(e.target.value))}>
            {[3, 6, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                AI 连续发言 {n} 次后
              </option>
            ))}
            <option value={0}>不自动暂停（注意费用）</option>
          </select>
        </label>
        <label className="grow">
          回复篇幅
          <select value={s.replyLength} onChange={(e) => set('replyLength', e.target.value as RoomSettings['replyLength'])}>
            <option value="short">简短（聊天感）</option>
            <option value="medium">适中</option>
            <option value="long">详细</option>
          </select>
        </label>
      </div>
      <label>
        发言间隔：{(s.turnDelayMs / 1000).toFixed(1)} 秒
        <input
          type="range"
          min={0}
          max={10000}
          step={500}
          value={s.turnDelayMs}
          onChange={(e) => set('turnDelayMs', Number(e.target.value))}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={s.replyOnHumanMessage}
          onChange={(e) => set('replyOnHumanMessage', e.target.checked)}
        />
        暂停时我发言后，让一位 AI 接话
      </label>
      <button className="btn btn-primary" disabled={!dirty} onClick={save}>
        {dirty ? '保存设置' : '已保存'}
      </button>
    </div>
  );
}
