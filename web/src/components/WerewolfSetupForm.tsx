import { Minus, Plus } from 'lucide-react';
import { BOARDS, ROLE_INFO, ROLE_ORDER, boardSize, checkRoles, rolesText, type RoleCounts, type WerewolfCreateOptions } from '../../../shared/werewolf';
import { EffortPicker } from './EffortPicker';
import { ModelInput } from './ModelInput';
import { Field, Segmented, ToggleRow } from './ui';

export type WwForm = Required<Pick<WerewolfCreateOptions, 'boardId' | 'join' | 'humanName' | 'model' | 'effort' | 'sheriff' | 'narration' | 'narratorModel' | 'winRule'>> & { roles: RoleCounts };

export const defaultWwForm = (model: string): WwForm => ({
  boardId: 'nine',
  roles: { ...BOARDS[1].roles },
  join: true,
  humanName: '我',
  model,
  effort: '',
  sheriff: true,
  narration: 'fixed',
  narratorModel: model,
  winRule: 'edge',
});

/** 提交给后端的参数（自定义板子时带上角色数量） */
export const wwPayload = (f: WwForm): WerewolfCreateOptions => ({ ...f, boardId: f.boardId === 'custom' ? undefined : f.boardId, roles: f.boardId === 'custom' ? f.roles : undefined });

export const wwFormProblem = (f: WwForm) => (f.boardId === 'custom' ? checkRoles(f.roles) : '');

/** 新建房间：狼人杀的设置 */
export function WerewolfSetupForm({ value: f, onChange }: { value: WwForm; onChange: (f: WwForm) => void }) {
  const set = <K extends keyof WwForm>(k: K, v: WwForm[K]) => onChange({ ...f, [k]: v });
  const n = f.boardId === 'custom' ? boardSize(f.roles) : boardSize(BOARDS.find((b) => b.id === f.boardId)!.roles);
  const problem = wwFormProblem(f);
  const step = (r: keyof RoleCounts, d: number) => {
    const max = r === 'werewolf' || r === 'villager' ? 8 : 1;
    const next = Math.max(0, Math.min(max, (f.roles[r] ?? 0) + d));
    onChange({ ...f, roles: { ...f.roles, [r]: next } });
  };

  return (
    <>
      <Field label="板子">
        <div className="card-grid">
          {BOARDS.map((b) => (
            <button key={b.id} className={`select-card ${f.boardId === b.id ? 'active' : ''}`} onClick={() => onChange({ ...f, boardId: b.id, sheriff: boardSize(b.roles) >= 9 })}>
              <div className="select-card-icon">🐺</div>
              <div className="select-card-title">{b.name}</div>
              <div className="select-card-desc">{b.desc}</div>
            </button>
          ))}
          <button className={`select-card ${f.boardId === 'custom' ? 'active' : ''}`} onClick={() => set('boardId', 'custom')}>
            <div className="select-card-icon">🛠️</div>
            <div className="select-card-title">自定义</div>
            <div className="select-card-desc">自己决定每种角色有几个（5~16 人）</div>
          </button>
        </div>
      </Field>

      {f.boardId === 'custom' && (
        <Field label={`角色（共 ${n} 人）`} hint={problem ? undefined : `（${rolesText(f.roles)}）`}>
          <div className="role-steppers">
            {ROLE_ORDER.map((r) => (
              <div key={r} className="role-stepper" title={ROLE_INFO[r].desc}>
                <span>
                  {ROLE_INFO[r].icon} {ROLE_INFO[r].name}
                </span>
                <button className="icon-btn sm" onClick={() => step(r, -1)} aria-label={`减少${ROLE_INFO[r].name}`}>
                  <Minus />
                </button>
                <b>{f.roles[r] ?? 0}</b>
                <button className="icon-btn sm" onClick={() => step(r, 1)} aria-label={`增加${ROLE_INFO[r].name}`}>
                  <Plus />
                </button>
              </div>
            ))}
          </div>
          {problem && <span className="hint" style={{ color: 'var(--danger)' }}>{problem}</span>}
        </Field>
      )}

      <div className="form-grid">
        <Field label="你怎么玩">
          <Segmented
            value={f.join ? 'join' : 'watch'}
            onChange={(v) => set('join', v === 'join')}
            options={[
              { value: 'join', label: '我也参加' },
              { value: 'watch', label: '旁观 AI 对局' },
            ]}
          />
          <span className="hint">{f.join ? '随机分到一个座位和身份，出局后转为上帝视角' : `${n} 个座位都是 AI，你能看到所有人的身份`}</span>
        </Field>
        {f.join && (
          <Field label="你的名字">
            <input value={f.humanName} onChange={(e) => set('humanName', e.target.value)} />
          </Field>
        )}
        <Field label="AI 玩家的模型" hint="（创建后可以在「AI」页给每个人换）">
          <ModelInput value={f.model} onChange={(v) => set('model', v)} showStatus={false} />
        </Field>
        <Field label="思考强度">
          <EffortPicker model={f.model} value={f.effort} onChange={(v) => set('effort', v)} />
        </Field>
        <Field label="胜利条件">
          <Segmented
            value={f.winRule}
            onChange={(v) => set('winRule', v)}
            options={[
              { value: 'edge', label: '屠边' },
              { value: 'all', label: '屠城' },
            ]}
          />
          <span className="hint">{f.winRule === 'edge' ? '狼人杀光所有神职或所有平民就赢' : '狼人要杀光所有好人才赢'}</span>
        </Field>
        <Field label="播报">
          <Segmented
            value={f.narration}
            onChange={(v) => set('narration', v)}
            options={[
              { value: 'fixed', label: '固定文字' },
              { value: 'ai', label: 'AI 主持人' },
            ]}
          />
          <span className="hint">{f.narration === 'fixed' ? '「昨晚 3 号出局」这样简洁的公告' : '另一个 AI 把公告说得更有氛围（结算仍由程序完成）'}</span>
        </Field>
        {f.narration === 'ai' && (
          <Field label="主持人的模型">
            <ModelInput value={f.narratorModel} onChange={(v) => set('narratorModel', v)} showStatus={false} />
          </Field>
        )}
      </div>
      <ToggleRow label="警长竞选" hint="第一天先竞选警长：警长投票算 1.5 票，白天最后发言，出局时移交警徽" checked={f.sheriff} onChange={(v) => set('sheriff', v)} />
    </>
  );
}
