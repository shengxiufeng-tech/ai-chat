import { useEffect, useState } from 'react';
import type { AppSettings, Room, RoomPreset } from '../../../shared/types';
import { get, post } from '../api';
import { attempt } from '../toast';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';

export function NewRoomModal({ onClose, onCreated }: { onClose: () => void; onCreated: (room: Room) => void }) {
  const [presets, setPresets] = useState<RoomPreset[]>([]);
  const [presetId, setPresetId] = useState('roundtable');
  const [title, setTitle] = useState('');
  const [scenario, setScenario] = useState('');
  const [model, setModel] = useState('');

  useEffect(() => {
    void attempt(() => get<RoomPreset[]>('/presets')).then((list) => {
      if (!list) return;
      setPresets(list);
      const first = list.find((p) => p.id === 'roundtable') ?? list[0];
      setTitle(first.title);
      setScenario(first.scenario);
    });
    void attempt(() => get<AppSettings>('/settings')).then((s) => s && setModel(s.defaultModel));
  }, []);

  const choose = (p: RoomPreset) => {
    setPresetId(p.id);
    setTitle(p.title);
    setScenario(p.scenario);
  };

  const create = async () => {
    const room = await attempt(() => post<Room>('/rooms', { presetId, title, scenario, model }));
    if (room) onCreated(room);
  };

  return (
    <Modal
      title="新建对话房间"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={create}>
            创建
          </button>
        </>
      }
    >
      <div className="preset-grid">
        {presets.map((p) => (
          <button
            key={p.id}
            className={`preset-card ${presetId === p.id ? 'active' : ''}`}
            onClick={() => choose(p)}
          >
            <div className="preset-name">{p.name}</div>
            <div className="preset-desc">{p.description}</div>
          </button>
        ))}
      </div>
      <div className="form-stack">
        <label>
          房间名
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span className="label-text">场景 / 话题 <span className="hint">（所有 AI 都能看到；具体话题也可以等进房间后由你开场说）</span></span>
          <textarea rows={4} value={scenario} onChange={(e) => setScenario(e.target.value)} />
        </label>
        {presetId !== 'blank' && (
          <label>
            <span className="label-text">角色默认使用的模型 <span className="hint">（创建后可以给每个角色单独换模型）</span></span>
            <ModelInput value={model} onChange={setModel} />
          </label>
        )}
      </div>
    </Modal>
  );
}
