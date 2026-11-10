import { Brain } from 'lucide-react';
import { EFFORT_ORDER, effortLabel } from '../../../shared/types';
import { useModels } from '../models';
import { Segmented } from './ui';

const FALLBACK = ['low', 'medium', 'high'];

/** 思考强度的小柱状图标 */
export function EffortMeter({ effort }: { effort?: string }) {
  const idx = effort ? EFFORT_ORDER.indexOf(effort) : -1;
  // none/minimal → 1 格，low → 2，medium → 3，high → 4，xhigh/max → 5
  const level = idx < 0 ? 0 : [1, 1, 2, 3, 4, 5, 5][idx];
  return (
    <span className="effort-meter" aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} className={n <= level ? 'on' : ''} style={{ height: 3 + n * 1.6 }} />
      ))}
    </span>
  );
}

/** 某个模型支持的思考强度档位（undefined 表示不知道） */
export function useEffortLevels(model: string) {
  const { models } = useModels();
  const info = models.find((m) => m.id === model);
  if (!info) return { known: false, levels: FALLBACK };
  const levels = [...(info.reasoningLevels ?? [])].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (info.reasoningLevels === undefined) {
    return { known: false, levels: info.reasoning === false ? [] : FALLBACK };
  }
  return { known: true, levels };
}

/** 像 Codex 那样的思考强度选择器：只列出模型支持的档位 */
export function EffortPicker({
  model,
  value,
  onChange,
}: {
  model: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { known, levels } = useEffortLevels(model);
  const options = [
    { value: '', label: '默认', title: '不发送 reasoning_effort，由模型 / Magpie 决定' },
    ...levels.map((l) => ({ value: l, label: effortLabel(l), title: l })),
  ];
  // 当前值不在列表里（比如换了模型），也显示出来，方便看到并改掉
  if (value && !levels.includes(value)) options.push({ value, label: `${effortLabel(value)}（不支持？）`, title: value });
  return (
    <div className="effort-picker">
      <Segmented value={value} options={options} onChange={onChange} />
      <span className="hint">
        <Brain style={{ width: 12, height: 12, verticalAlign: -2 }} />{' '}
        {!model
          ? '先选择模型'
          : levels.length === 0
            ? '这个模型不支持调节思考强度'
            : known
              ? `Magpie 报告这个模型支持 ${levels.map(effortLabel).join(' / ')}`
              : '模型列表里没有这个模型的档位信息，以下是常见档位'}
      </span>
    </div>
  );
}
