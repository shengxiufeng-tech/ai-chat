import { Brain, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { effortLabel, type Participant, type Room, type RunnerState } from '../../../shared/types';
import { patch } from '../api';
import { shortModel } from '../models';
import { attempt } from '../toast';
import { EffortMeter, EffortPicker } from './EffortPicker';
import { ModelInput } from './ModelInput';
import { Field } from './ui';

/** 对话主界面顶部：每个 AI 用的模型和思考强度，点击可以快速切换 */
export function CastBar({ room, runner }: { room: Room; runner: RunnerState | null }) {
  const [open, setOpen] = useState<{ id: string; x: number; y: number } | null>(null);
  if (room.participants.length === 0) return null;
  const current = open && room.participants.find((p) => p.id === open.id);
  return (
    <div className="cast-bar">
      {room.participants.map((p) => (
        <button
          key={p.id}
          className={`cast-pill ${open?.id === p.id ? 'open' : ''} ${runner?.generating?.participantId === p.id ? 'speaking' : ''} ${p.enabled ? '' : 'off'}`}
          style={{ '--c': p.color } as CSSProperties}
          title={`${p.name}：${p.model || '未选择模型'}${p.reasoningEffort ? `，思考强度 ${p.reasoningEffort}` : ''}（点击切换）`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen(open?.id === p.id ? null : { id: p.id, x: rect.left, y: rect.bottom + 6 });
          }}
        >
          <span className="cast-avatar">{p.avatar}</span>
          <span className="cast-name">{p.name}</span>
          <span className="cast-model">{shortModel(p.model)}</span>
          {p.reasoningEffort && (
            <span className="cast-effort">
              <EffortMeter effort={p.reasoningEffort} />
              {effortLabel(p.reasoningEffort)}
            </span>
          )}
        </button>
      ))}
      {current && open && <ModelPopover room={room} p={current} x={open.x} y={open.y} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ModelPopover({
  room,
  p,
  x,
  y,
  onClose,
}: {
  room: Room;
  p: Participant;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState(p.model);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cast-pill')) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const save = (body: Partial<Participant>) => attempt(() => patch(`/rooms/${room.id}/participants/${p.id}`, body));
  const left = Math.max(8, Math.min(x, window.innerWidth - 352));

  return (
    <div ref={ref} className="popover" style={{ left, top: y }}>
      <div className="popover-header" style={{ '--c': p.color } as CSSProperties}>
        <span className="cast-avatar">{p.avatar}</span>
        <div className="grow">
          <div style={{ fontWeight: 650 }}>{p.name}</div>
          <div className="hint">修改会从 TA 的下一句话开始生效</div>
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="关闭">
          <X />
        </button>
      </div>
      <Field label="模型">
        <ModelInput
          value={model}
          showStatus={false}
          onChange={(v) => {
            setModel(v);
          }}
        />
        {model !== p.model && (
          <div className="row">
            <span className="spacer" />
            <button className="btn btn-sm" onClick={() => setModel(p.model)}>
              取消
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => save({ model })}>
              使用这个模型
            </button>
          </div>
        )}
      </Field>
      <Field label={<><Brain style={{ width: 14, height: 14, verticalAlign: -2 }} /> 思考强度</>}>
        <EffortPicker model={p.model} value={p.reasoningEffort} onChange={(v) => save({ reasoningEffort: v })} />
      </Field>
    </div>
  );
}
