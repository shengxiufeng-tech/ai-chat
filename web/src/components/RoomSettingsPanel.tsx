import { useEffect, useState } from 'react';
import type { Room, RoomSettings } from '../../../shared/types';
import { patch } from '../api';
import { attempt, toast } from '../toast';
import { ModelInput } from './ModelInput';
import { Field, Segmented, ToggleRow } from './ui';

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
      <Field label="房间名">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Field label="提示词风格">
        <Segmented
          block
          value={s.promptMode}
          onChange={(v) => set('promptMode', v)}
          options={[
            { value: 'standard', label: '多人对话', title: '告诉 AI 这是多人对话，有名字标签和发言规则' },
            { value: 'humanlike', label: '拟人', title: '只告诉 AI：你是真人，在和另一个真人聊天' },
          ]}
        />
        <span className="hint">
          {s.promptMode === 'humanlike'
            ? '拟人：只告诉每个 AI「你是一个真实的人，正在和另一个真实的人聊天」，没有其他任何设定和规则。'
            : '多人对话：告诉 AI 这是多人对话，谁是谁、场景是什么、只代表自己发言等。'}
        </span>
      </Field>

      {s.promptMode === 'standard' && (
        <Field label="场景 / 话题" hint="（所有 AI 都能看到）">
          <textarea rows={4} value={scenario} onChange={(e) => setScenario(e.target.value)} />
        </Field>
      )}

      <div className="divider" />
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <Field label="你的名字">
            <input value={s.humanName} onChange={(e) => set('humanName', e.target.value)} />
          </Field>
        </div>
      </div>
      {s.promptMode === 'standard' && (
        <Field label="你的身份">
          <Segmented
            block
            value={s.humanRole}
            onChange={(v) => set('humanRole', v)}
            options={[
              { value: 'host', label: '主持人' },
              { value: 'participant', label: '参与者' },
              { value: 'observer', label: '旁观者' },
            ]}
          />
        </Field>
      )}

      <div className="divider" />
      <Field label="谁来说下一句">
        <Segmented
          block
          value={s.turnMode}
          onChange={(v) => set('turnMode', v)}
          options={[
            { value: 'round_robin', label: '轮流', title: '按角色列表的顺序依次发言' },
            { value: 'moderator', label: 'AI 主持', title: '每轮多调用一次模型，挑出最该接话的人' },
            { value: 'manual', label: '手动点名', title: '只有你点「发言」或 @名字 时才说话' },
          ]}
        />
        <span className="hint">
          {s.turnMode === 'round_robin'
            ? '按右侧角色列表的顺序依次发言。'
            : s.turnMode === 'moderator'
              ? '每轮多调用一次模型，根据上下文挑出最该接话的人，对话更自然。'
              : '只有你点角色旁边的「发言」或 @名字 时 AI 才说话。'}
          无论哪种模式，消息里 @名字 都会让那位角色优先接话。
        </span>
      </Field>
      {s.turnMode === 'moderator' && (
        <Field label="AI 主持人用的模型" hint="（留空则用全局默认模型，建议选个便宜快速的）">
          <ModelInput value={s.moderatorModel} onChange={(v) => set('moderatorModel', v)} />
        </Field>
      )}
      <Field label="自动暂停">
        <select value={s.autoPauseAfter} onChange={(e) => set('autoPauseAfter', Number(e.target.value))}>
          {[3, 6, 10, 20, 50].map((n) => (
            <option key={n} value={n}>
              AI 连续发言 {n} 次后暂停
            </option>
          ))}
          <option value={0}>不自动暂停（注意费用）</option>
        </select>
      </Field>
      {s.promptMode === 'standard' && (
        <Field label="回复篇幅">
          <Segmented
            block
            value={s.replyLength}
            onChange={(v) => set('replyLength', v)}
            options={[
              { value: 'short', label: '简短' },
              { value: 'medium', label: '适中' },
              { value: 'long', label: '详细' },
            ]}
          />
        </Field>
      )}
      <Field label={`发言间隔：${(s.turnDelayMs / 1000).toFixed(1)} 秒`}>
        <input
          type="range"
          min={0}
          max={10000}
          step={500}
          value={s.turnDelayMs}
          onChange={(e) => set('turnDelayMs', Number(e.target.value))}
        />
      </Field>
      <ToggleRow
        label="我发言后让 AI 接话"
        hint="暂停状态下你发消息后，让一位 AI 回应"
        checked={s.replyOnHumanMessage}
        onChange={(v) => set('replyOnHumanMessage', v)}
      />
      <button className="btn btn-primary" disabled={!dirty} onClick={save}>
        {dirty ? '保存设置' : '已保存'}
      </button>
    </div>
  );
}
