import { ChevronDown, ChevronUp, Megaphone, Pencil, Plus, Save, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { CharacterTemplate, Participant, Room, RunnerState } from '../../../shared/types';
import { del, get, patch, post } from '../api';
import { askConfirm } from '../confirm';
import { attempt, toast } from '../toast';
import { EffortPicker } from './EffortPicker';
import { ModelTag } from './MessageItem';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';
import { Field, Switch } from './ui';

export function ParticipantPanel({ room, runner }: { room: Room; runner: RunnerState | null }) {
  const [editing, setEditing] = useState<Participant | null>(null);
  const [adding, setAdding] = useState(false);
  const base = `/rooms/${room.id}/participants`;
  const trpg = room.mode === 'trpg';

  return (
    <div className="panel-section">
      {room.participants.length === 0 && <p className="hint">还没有 AI 角色，点下面的按钮添加。</p>}
      <ul className="participants">
        {room.participants.map((p, i) => {
          const speaking = runner?.generating?.participantId === p.id;
          return (
            <li
              key={p.id}
              className={`participant ${p.enabled ? '' : 'disabled'} ${speaking ? 'speaking' : ''}`}
              style={{ '--c': p.color } as CSSProperties}
            >
              <div className="participant-avatar">{p.avatar}</div>
              <div className="participant-info">
                <div className="participant-name">
                  {p.name}
                  {p.role === 'kp' && <span className="badge badge-accent">守秘人</span>}
                  {p.role === 'player' && <span className="badge">AI 队友</span>}
                  {speaking && <span className="badge badge-accent">发言中</span>}
                </div>
                <div className="participant-model">
                  {p.model ? <ModelTag model={p.model} effort={p.reasoningEffort} /> : '⚠️ 未选择模型'}
                </div>
              </div>
              <div className="participant-actions">
                <button
                  className="icon-btn sm"
                  title="让 TA 现在说一句"
                  onClick={() => attempt(() => post(`/rooms/${room.id}/turn`, { participantId: p.id }))}
                >
                  <Megaphone />
                </button>
                <button className="icon-btn sm" title="编辑" onClick={() => setEditing(p)}>
                  <Pencil />
                </button>
                {!trpg && (
                  <>
                    <Switch
                      checked={p.enabled}
                      label={p.enabled ? '参与自动轮换（点击关闭）' : '不参与自动轮换（点击开启）'}
                      onChange={(v) => attempt(() => patch(`${base}/${p.id}`, { enabled: v }))}
                    />
                    <div className="reorder">
                      <button
                        disabled={i === 0}
                        title="上移"
                        onClick={() => attempt(() => patch(`${base}/${p.id}`, { index: i - 1 }))}
                      >
                        <ChevronUp />
                      </button>
                      <button
                        disabled={i === room.participants.length - 1}
                        title="下移"
                        onClick={() => attempt(() => patch(`${base}/${p.id}`, { index: i + 1 }))}
                      >
                        <ChevronDown />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!trpg && (
        <button className="add-btn" onClick={() => setAdding(true)}>
          <UserPlus /> 添加 AI 角色
        </button>
      )}
      {trpg && <p className="hint">守秘人和 AI 队友的模型、思考强度、性格都可以在这里修改。</p>}

      {adding && (
        <AddParticipantModal
          room={room}
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setAdding(false);
            setEditing(p);
          }}
        />
      )}
      {editing && (
        <ParticipantEditor
          room={room}
          participant={room.participants.find((p) => p.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AddParticipantModal({
  room,
  onClose,
  onAdded,
}: {
  room: Room;
  onClose: () => void;
  onAdded: (p: Participant) => void;
}) {
  const [templates, setTemplates] = useState<CharacterTemplate[] | null>(null);
  useEffect(() => {
    void attempt(() => get<CharacterTemplate[]>('/templates')).then((t) => setTemplates(t ?? []));
  }, []);
  const add = async (templateId?: string) => {
    const p = await attempt(() =>
      post<Participant>(`/rooms/${room.id}/participants`, templateId ? { templateId } : { participant: {} }),
    );
    if (p) onAdded(p);
  };
  const remove = async (t: CharacterTemplate) => {
    if (!(await askConfirm({ title: '删除模板', message: `删除角色模板「${t.name}」？已经加进房间的角色不受影响。`, confirmText: '删除', danger: true }))) return;
    await attempt(() => del(`/templates/${t.id}`));
    setTemplates((list) => list?.filter((x) => x.id !== t.id) ?? null);
  };
  return (
    <Modal title="添加 AI 角色" icon={<UserPlus />} description="添加后可以修改名字、人设和模型，不会影响模板本身。" onClose={onClose} size="wide">
      <div className="card-grid">
        <button className="select-card" onClick={() => add()}>
          <div className="select-card-icon">
            <Plus style={{ width: 22, height: 22 }} />
          </div>
          <div className="select-card-title">空白角色</div>
          <div className="select-card-desc">从零开始写人设</div>
        </button>
        {templates?.map((t) => (
          <div key={t.id} className="select-card" role="button" tabIndex={0} onClick={() => add(t.id)}>
            <div className="select-card-icon">{t.avatar}</div>
            <div className="select-card-title">
              {t.name}
              {!t.builtin && <span className="badge badge-accent">我的</span>}
            </div>
            <div className="select-card-desc">{t.bio}</div>
            {!t.builtin && (
              <button
                className="icon-btn sm select-card-corner"
                title="删除模板"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(t);
                }}
              >
                <X />
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

const AVATARS = ['🤖', '🧙', '🦊', '🐱', '🐼', '🦉', '👽', '🧛', '🧚', '🕵️', '👩‍🔬', '👨‍🏫', '🧑‍🎤', '🐉', '🌸', '⚡', '🕯️', '🧭'];

function ParticipantEditor({
  room,
  participant,
  onClose,
}: {
  room: Room;
  participant: Participant;
  onClose: () => void;
}) {
  const [d, setD] = useState(participant);
  const set = <K extends keyof Participant>(k: K, v: Participant[K]) => setD((x) => ({ ...x, [k]: v }));
  const url = `/rooms/${room.id}/participants/${participant.id}`;
  const trpg = room.mode === 'trpg';
  const humanlike = room.settings.promptMode === 'humanlike';

  const save = async () => {
    const ok = await attempt(() =>
      patch(url, {
        name: d.name,
        avatar: d.avatar,
        color: d.color,
        model: d.model,
        reasoningEffort: d.reasoningEffort,
        bio: d.bio,
        persona: d.persona,
        temperature: d.temperature,
      }),
    );
    if (ok) onClose();
  };
  const remove = async () => {
    if (!(await askConfirm({ title: '移出房间', message: `把「${participant.name}」移出房间？TA 已经说过的话会保留。`, confirmText: '移出', danger: true }))) return;
    if (await attempt(() => del(url))) onClose();
  };
  const saveTemplate = async () => {
    const ok = await attempt(() =>
      post('/templates', {
        name: d.name,
        avatar: d.avatar,
        color: d.color,
        bio: d.bio,
        persona: d.persona,
        temperature: d.temperature,
      }),
    );
    if (ok) toast(`已把「${d.name}」存为模板，以后可以在其他房间直接添加`);
  };

  const personaHint =
    participant.role === 'kp'
      ? '（可选：主持风格，例如"节奏紧凑、多用感官描写"）'
      : participant.role === 'player'
        ? '（队友的性格和说话方式）'
        : humanlike
          ? '（拟人模式下默认留空；写了的话会接在"你是一个真实的人……"后面）'
          : '（只有 TA 自己能看到：性格、立场、说话风格、背景故事…）';

  return (
    <Modal
      title={`编辑：${participant.name}`}
      icon={<Pencil />}
      onClose={onClose}
      size="wide"
      footer={
        <>
          {!trpg && (
            <>
              <button className="btn btn-danger" onClick={remove}>
                <Trash2 /> 移出房间
              </button>
              <button className="btn" onClick={saveTemplate}>
                <Save /> 存为模板
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="名字">
          <input value={d.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="头像和颜色">
          <div className="row">
            <input className="avatar-input" value={d.avatar} onChange={(e) => set('avatar', e.target.value)} />
            <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} title="主题色" />
            <div className="avatar-picks grow">
              {AVATARS.slice(0, 9).map((a) => (
                <button key={a} onClick={() => set('avatar', a)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        </Field>
        <div className="span-2">
          <Field label="模型">
            <ModelInput value={d.model} onChange={(v) => set('model', v)} />
          </Field>
        </div>
        <div className="span-2">
          <Field label="思考强度" hint="（推理模型思考得越久，回答通常越好，但更慢更贵）">
            <EffortPicker model={d.model} value={d.reasoningEffort} onChange={(v) => set('reasoningEffort', v)} />
          </Field>
        </div>
        {!humanlike && participant.role !== 'kp' && (
          <div className="span-2">
            <Field label="一句话简介" hint="（其他角色能看到，让大家知道 TA 是谁）">
              <input value={d.bio} onChange={(e) => set('bio', e.target.value)} placeholder="例如：爱追问的哲学家" />
            </Field>
          </div>
        )}
        <div className="span-2">
          <Field label={participant.role === 'kp' ? '主持风格' : participant.role === 'player' ? '性格' : '人设'} hint={personaHint}>
            <textarea
              rows={6}
              value={d.persona}
              onChange={(e) => set('persona', e.target.value)}
              placeholder={humanlike ? '' : '例如：你是一位温和但喜欢追问的哲学家，习惯用提问引导别人思考…'}
            />
          </Field>
        </div>
        <div className="span-2">
          <Field label={`温度 ${d.temperature.toFixed(1)}`} hint="（越高越有创意、越随机；越低越稳定。部分推理模型会忽略这个参数）">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={d.temperature}
              onChange={(e) => set('temperature', Number(e.target.value))}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
