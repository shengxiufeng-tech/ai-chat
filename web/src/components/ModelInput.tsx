import { useId } from 'react';
import { useModels } from '../models';

/** 模型选择：可以从 Magpie 的模型列表里选，也可以直接输入 */
export function ModelInput({
  value,
  onChange,
  placeholder = '从列表选择，或直接输入模型 id',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  const { models, error, loading } = useModels();
  return (
    <>
      <input list={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name && m.name !== m.id ? m.name : ''}
          </option>
        ))}
      </datalist>
      <div className="hint">
        {loading
          ? '正在读取模型列表…'
          : error
            ? `读取模型列表失败：${error}`
            : `共 ${models.length} 个可用模型（来自模型服务的 /models 接口）`}
      </div>
    </>
  );
}
