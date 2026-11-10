import { CheckCircle2, AlertCircle, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { get, put } from '../api';
import { reloadModels } from '../models';
import { attempt } from '../toast';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';
import { Field } from './ui';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AppSettings | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void attempt(() => get<AppSettings>('/settings')).then((x) => x && setS(x));
  }, []);

  if (!s) return null;
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS({ ...s, [k]: v });

  const saveAndTest = async () => {
    setTesting(true);
    setTestResult(null);
    const saved = await attempt(() => put<AppSettings>('/settings', s));
    if (saved) {
      const r = await reloadModels();
      const thinking = r.models.filter((m) => m.reasoning).length;
      setTestResult(
        r.error
          ? { ok: false, text: r.error }
          : { ok: true, text: `连接成功，找到 ${r.models.length} 个模型${thinking ? `（其中 ${thinking} 个推理模型可以调节思考强度）` : ''}。` },
      );
    }
    setTesting(false);
  };

  return (
    <Modal
      title="设置"
      icon={<Settings />}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" disabled={testing} onClick={saveAndTest}>
            {testing ? '连接中…' : '保存并测试连接'}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <Field label="模型服务地址" hint="（OpenAI 兼容接口）">
          <input value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} spellCheck={false} />
          <span className="hint">
            Magpie 本地网关默认是 <code>http://127.0.0.1:3425/v1</code>，需要保持 Magpie 运行。填 <code>mock</code> 可以用模拟回复先体验界面。
          </span>
        </Field>
        <Field label="API Key">
          <input type="password" value={s.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
          <span className="hint">
            本机调用 Magpie 时任意值都行；用 <code>magpie-ai-chat</code> 的话，Magpie 的用量统计里会显示为 ai-chat。
          </span>
        </Field>
        <Field label="默认模型" hint="（新建角色时默认使用；AI 主持人没单独设置时也用它）">
          <ModelInput value={s.defaultModel} onChange={(v) => set('defaultModel', v)} />
        </Field>
        {testResult && (
          <div className={`callout ${testResult.ok ? 'callout-ok' : 'callout-error'}`}>
            {testResult.ok ? <CheckCircle2 /> : <AlertCircle />}
            <span>{testResult.text}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
