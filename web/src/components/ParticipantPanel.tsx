import { useEffect, useState } from 'react';
import type { CharacterTemplate, Participant, Room, RunnerState } from '../../../shared/types';
import { del, get, patch, post } from '../api';
import { attempt, toast } from '../toast';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';

export function ParticipantPanel({ room, runner }: { room: Room; runner: RunnerState | null }) {
  const [editing, setEditing] = useState<Participant | null>(null);
  const [adding, setAdding] = useState(false);
  const base = `/rooms/${room.id}/participants`;

  return (
    <div className="panel-section">
      {room.participants.length === 0 && <p className="hint">还没有 AI 角色，点下面的按钮添加。</p>}
      <ul className="participants">
        {room.participants.map((p, i) => {
          const speaking = runner?.generating?.participantId === p.id;
          return (
            <li key={p.id} className={`participant ${p.enabled ? '' : 'disabled'} ${speaking ? 'speaking' : ''}`}>
              <div className="participant-color" style={{ background: p.color }} />
              <div className="participant-avatar">{p.avatar}</div>
              <div className="participant-info">
                <div className="participant-name">
                  {p.name}
                  {speaking && <span className="typing">发言中…</span>}
                </div>
                <div className="participant-model" title={p.model}>
                  {p.model || '⚠️ 未选择模型'}
                </div>
              </div>
              <div className="participant-actions">
                <button
                  className="btn btn-sm"
                  title="让 TA 现在说一句"
                  onClick={() => attempt(() => post(`/rooms/${room.id}/turn`, { participantId: p.id }))}
                >
                  发言
                </button>
                <button className="icon-btn" title="编辑" onClick={() => setEditing(p)}>
                  ✎
                </button>
                <label className="switch" title={p.enabled ? '参与自动轮换（点击关闭）' : '不参与自动轮换（点击开启）'}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => attempt(() => patch(`${base}/${p.id}`, { enabled: e.target.checked }))}
                  />
                  <span />
                </label>
                <div className="reorder">
                  <button
                    disabled={i === 0}
                    title="上移"
                    onClick={() => attempt(() => patch(`${base}/${p.id}`, { index: i - 1 }))}
                  >
                    ▲
                  </button>
                  <button
                    disabled={i === room.participants.length - 1}
                    title="下移"
                    onClick={() => attempt(() => patch(`${base}/${p.id}`, { index: i + 1 }))}
                  >
                    ▼
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <button className="btn btn-block" onClick={() => setAdding(true)}>
        ＋ 添加 AI 角色
      </button>

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
    if (!confirm(`删除模板「${t.name}」？`)) return;
    await attempt(() => del(`/templates/${t.id}`));
    setTemplates((list) => list?.filter((x) => x.id !== t.id) ?? null);
  };
  return (
    <Modal title="添加 AI 角色" onClose={onClose} wide>
      <div className="template-grid">
        <button className="template-card" onClick={() => add()}>
          <div className="template-avatar">➕</div>
          <div className="template-name">空白角色</div>
          <div className="template-bio">从零开始写人设</div>
        </button>
        {templates?.map((t) => (
          <div key={t.id} className="template-card" role="button" tabIndex={0} onClick={() => add(t.id)}>
            <div className="template-avatar">{t.avatar}</div>
            <div className="template-name">
              {t.name}
              {!t.builtin && <span className="badge">我的</span>}
            </div>
            <div className="template-bio">{t.bio}</div>
            {!t.builtin && (
              <button
                className="template-delete"
                title="删除模板"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(t);
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="hint">添加后可以修改名字、人设和模型，不会影响模板本身。</p>
    </Modal>
  );
}

const AVATARS = ['🤖', '🧙', '🦊', '🐱', '🐼', '🦉', '👽', '🧛', '🧚', '🕵️', '👩‍🔬', '👨‍🏫', '🧑‍🎤', '🐉', '🌸', '⚡'];

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

  const save = async () => {
    const ok = await attempt(() =>
      patch(url, {
        name: d.name,
        avatar: d.avatar,
        color: d.color,
        model: d.model,
        bio: d.bio,
        persona: d.persona,
        temperature: d.temperature,
      }),
    );
    if (ok) onClose();
  };
  const remove = async () => {
    if (!confirm(`把「${participant.name}」移出房间？`)) return;
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

  return (
    <Modal
      title={`编辑角色：${participant.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-danger" onClick={remove}>
            移出房间
          </button>
          <button className="btn" onClick={saveTemplate}>
            存为模板
          </button>
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
        <label>
          名字
          <input value={d.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          头像
          <div className="row">
            <input className="avatar-input" value={d.avatar} onChange={(e) => set('avatar', e.target.value)} />
            <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} title="主题色" />
          </div>
          <div className="avatar-picks">
            {AVATARS.map((a) => (
              <button key={a} onClick={() => set('avatar', a)}>
                {a}
              </button>
            ))}
          </div>
        </label>
        <label className="span-2">
          模型
          <ModelInput value={d.model} onChange={(v) => set('model', v)} />
        </label>
        <label className="span-2">
          <span className="label-text">一句话简介 <span className="hint">（其他角色能看到，让大家知道 TA 是谁）</span></span>
          <input value={d.bio} onChange={(e) => set('bio', e.target.value)} placeholder="例如：爱追问的哲学家" />
        </label>
        <label className="span-2">
          <span className="label-text">人设 <span className="hint">（只有 TA 自己能看到：性格、立场、说话风格、背景故事…）</span></span>
          <textarea
            rows={7}
            value={d.persona}
            onChange={(e) => set('persona', e.target.value)}
            placeholder="例如：你是一位温和但喜欢追问的哲学家，习惯用提问引导别人思考…"
          />
        </label>
        <label className="span-2">
          <span className="label-text">
            温度 {d.temperature.toFixed(1)} <span className="hint">（越高越有创意、越随机；越低越稳定、越保守）</span>
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={d.temperature}
            onChange={(e) => set('temperature', Number(e.target.value))}
          />
        </label>
      </div>
    </Modal>
  );
}
