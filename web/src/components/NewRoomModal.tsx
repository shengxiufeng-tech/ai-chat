import { Dices, MessagesSquare, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppSettings, Room, RoomMode, RoomPreset, TrpgCreateOptions } from '../../../shared/types';
import { get, post } from '../api';
import { attempt } from '../toast';
import { EffortPicker } from './EffortPicker';
import { EraInput } from './EraInput';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';
import { clearPdfImport, ScriptImport } from './ScriptImport';
import { Field, Segmented, ToggleRow } from './ui';

const PRESET_ICONS: Record<string, string> = {
  roundtable: '🏛️',
  debate: '⚖️',
  brainstorm: '💡',
  humanlike: '🙂',
  blank: '✨',
};

const SCENARIOS = [
  {
    id: 'baishui',
    icon: '🌫️',
    name: '雾锁白水镇',
    badge: '新手推荐',
    desc: '1927 年江南水乡。老友在小镇失踪，信里只说"镇上有一口会唱歌的井"。约 1~2 小时。',
  },
  { id: 'improv', icon: '🎲', name: 'AI 即兴剧本', desc: '给一个主题，守秘人现场编一个短篇调查故事。' },
  { id: 'custom', icon: '📜', name: '我自己的剧本', desc: '导入剧本文件（PDF / Word / txt）或粘贴文字，AI 会帮你挡住剧透。' },
];

export function NewRoomModal({
  initialMode = 'chat',
  onClose,
  onCreated,
}: {
  initialMode?: RoomMode;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const [mode, setMode] = useState<RoomMode>(initialMode);
  const [presets, setPresets] = useState<RoomPreset[]>([]);
  const [presetId, setPresetId] = useState('roundtable');
  const [title, setTitle] = useState('');
  const [scenario, setScenario] = useState('');
  const [model, setModel] = useState('');
  const [creating, setCreating] = useState(false);
  const [t, setT] = useState<TrpgCreateOptions>({
    scenarioId: 'baishui',
    theme: '',
    customScript: '',
    eraLabel: '1920 年代，美国新英格兰',
    kpModel: '',
    kpEffort: '',
    teammateCount: 1,
    teammateModel: '',
    teachingMode: true,
    autoRoll: false,
    notebook: true,
    memo: true,
    humanName: '我',
  });
  const setTrpg = <K extends keyof TrpgCreateOptions>(k: K, v: TrpgCreateOptions[K]) => setT((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    void attempt(() => get<RoomPreset[]>('/presets')).then((list) => {
      if (!list) return;
      setPresets(list);
      const first = list.find((p) => p.id === 'roundtable') ?? list[0];
      setTitle(first.title);
      setScenario(first.scenario);
    });
    void attempt(() => get<AppSettings>('/settings')).then((s) => {
      if (!s) return;
      setModel(s.defaultModel);
      setT((x) => ({ ...x, kpModel: x.kpModel || s.defaultModel, teammateModel: x.teammateModel || s.defaultModel }));
    });
  }, []);

  const choose = (p: RoomPreset) => {
    setPresetId(p.id);
    setTitle(p.title);
    setScenario(p.scenario);
  };

  const create = async () => {
    setCreating(true);
    const room = await attempt(() =>
      mode === 'trpg'
        ? post<Room>('/rooms', { mode: 'trpg', trpg: t })
        : post<Room>('/rooms', { presetId, title, scenario, model }),
    );
    setCreating(false);
    if (room) {
      // PDF 剧本的整理结果已经用掉了，下次打开窗口不再显示
      if (mode === 'trpg' && t.prepared?.importId) clearPdfImport();
      onCreated(room);
    }
  };

  const preset = presets.find((p) => p.id === presetId);
  const invalid = mode === 'trpg' && t.scenarioId === 'custom' && !t.prepared && !t.customScript?.trim();

  return (
    <Modal
      title="新建房间"
      icon={<Plus />}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={create} disabled={creating || invalid}>
            {mode === 'trpg' ? '创建跑团房间' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <Segmented
          block
          value={mode}
          onChange={setMode}
          options={[
            { value: 'chat', label: <><MessagesSquare /> 多人对话</> },
            { value: 'trpg', label: <><Dices /> 跑团（COC 7）</> },
          ]}
        />

        {mode === 'chat' ? (
          <>
            <div className="card-grid">
              {presets.map((p) => (
                <button key={p.id} className={`select-card ${presetId === p.id ? 'active' : ''}`} onClick={() => choose(p)}>
                  <div className="select-card-icon">{PRESET_ICONS[p.id] ?? '💬'}</div>
                  <div className="select-card-title">{p.name}</div>
                  <div className="select-card-desc">{p.description}</div>
                </button>
              ))}
            </div>
            <Field label="房间名">
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            {preset?.settings?.promptMode === 'humanlike' ? (
              <div className="callout callout-info">
                <span>
                  拟人模式下，每个 AI 只会收到一句提示：「你是一个真实的人，正在和另一个真实的人聊天。请像真人一样和对方自然地对话。」没有名字、人设、场景或任何规则。点「开始自动对话」让两个 AI 聊起来，你也可以随时加入。
                </span>
              </div>
            ) : (
              <Field label="场景 / 话题" hint="（所有 AI 都能看到；具体话题也可以等进房间后由你开场说）">
                <textarea rows={3} value={scenario} onChange={(e) => setScenario(e.target.value)} />
              </Field>
            )}
            {presetId !== 'blank' && (
              <Field label="角色默认使用的模型" hint="（创建后可以给每个角色单独换模型和思考强度）">
                <ModelInput value={model} onChange={setModel} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="剧本">
              <div className="card-grid">
                {SCENARIOS.map((s) => (
                  <button key={s.id} className={`select-card ${t.scenarioId === s.id ? 'active' : ''}`} onClick={() => setTrpg('scenarioId', s.id)}>
                    <div className="select-card-icon">{s.icon}</div>
                    <div className="select-card-title">
                      {s.name}
                      {s.badge && <span className="badge badge-accent">{s.badge}</span>}
                    </div>
                    <div className="select-card-desc">{s.desc}</div>
                  </button>
                ))}
              </div>
            </Field>
            {t.scenarioId === 'improv' && (
              <>
                <Field label="主题">
                  <input value={t.theme} onChange={(e) => setTrpg('theme', e.target.value)} placeholder="例如：深夜的大学图书馆、海边灯塔、失踪的考古队" />
                </Field>
                <Field label="时代背景">
                  <EraInput value={t.eraLabel ?? ''} onChange={(v) => setTrpg('eraLabel', v)} />
                </Field>
              </>
            )}
            {t.scenarioId === 'custom' && (
              <ScriptImport
                model={t.kpModel}
                prepared={t.prepared ?? null}
                onPrepared={(p) => setTrpg('prepared', p ?? undefined)}
                pasted={t.customScript ?? ''}
                onPasted={(v) => setTrpg('customScript', v)}
                eraLabel={t.eraLabel ?? ''}
                onEraLabel={(v) => setTrpg('eraLabel', v)}
              />
            )}

            <div className="form-grid">
              <Field label="守秘人的模型" hint="（建议用你最强的模型）">
                <ModelInput value={t.kpModel} onChange={(v) => setTrpg('kpModel', v)} />
              </Field>
              <Field label="守秘人的思考强度">
                <EffortPicker model={t.kpModel} value={t.kpEffort} onChange={(v) => setTrpg('kpEffort', v)} />
              </Field>
              <Field label="AI 队友" hint="（陪你一起调查的 AI 调查员）">
                <Segmented
                  value={t.teammateCount}
                  onChange={(v) => setTrpg('teammateCount', v)}
                  options={[0, 1, 2].map((n) => ({ value: n, label: n === 0 ? '不要' : `${n} 位` }))}
                />
              </Field>
              {t.teammateCount > 0 && (
                <Field label="队友的模型" hint="（可以用便宜一点的）">
                  <ModelInput value={t.teammateModel} onChange={(v) => setTrpg('teammateModel', v)} showStatus={false} />
                </Field>
              )}
              <Field label="你的名字">
                <input value={t.humanName} onChange={(e) => setTrpg('humanName', e.target.value)} />
              </Field>
            </div>
            <ToggleRow label="新手教学模式" hint="规则第一次出现时，守秘人会附上「规则小贴士」" checked={t.teachingMode} onChange={(v) => setTrpg('teachingMode', v)} />
            <ToggleRow
              label="守秘人笔记"
              hint="守秘人自动记下重要的 NPC 和线索，你随时可以翻看"
              checked={t.notebook ?? true}
              onChange={(v) => setTrpg('notebook', v)}
            />
            <ToggleRow
              label="秘密备忘"
              hint="守秘人把临时定下的秘密设定记在只有它能看到的地方，保证前后一致（AI 即兴剧本建议开启）"
              checked={t.memo ?? true}
              onChange={(v) => setTrpg('memo', v)}
            />
            <ToggleRow label="自动替我掷骰" hint="关闭时由你亲手点「掷骰」，更有参与感" checked={t.autoRoll} onChange={(v) => setTrpg('autoRoll', v)} />
          </>
        )}
      </div>
    </Modal>
  );
}
