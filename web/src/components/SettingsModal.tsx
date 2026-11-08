import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { get, put } from '../api';
import { reloadModels } from '../models';
import { attempt } from '../toast';
import { Modal } from './Modal';
import { ModelInput } from './ModelInput';

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
      setTestResult(
        r.error
          ? { ok: false, text: r.error }
          : { ok: true, text: `连接成功，找到 ${r.models.length} 个模型。` },
      );
    }
    setTesting(false);
  };

  return (
    <Modal
      title="设置"
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
        <label>
          <span className="label-text">模型服务地址 <span className="hint">（OpenAI 兼容接口）</span></span>
          <input value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
          <span className="hint">
            Magpie 本地网关默认是 <code>http://127.0.0.1:3425/v1</code>，需要保持 Magpie 运行。填{' '}
            <code>mock</code> 可以用模拟回复先体验界面。
          </span>
        </label>
        <label>
          API Key
          <input type="password" value={s.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
          <span className="hint">
            本机调用 Magpie 时任意值都行；用 <code>magpie-ai-chat</code> 的话，Magpie 的用量统计里会显示为
            ai-chat。
          </span>
        </label>
        <label>
          <span className="label-text">默认模型 <span className="hint">（新建角色时默认使用；AI 主持人没单独设置时也用它）</span></span>
          <ModelInput value={s.defaultModel} onChange={(v) => set('defaultModel', v)} />
        </label>
        {testResult && (
          <div className={`callout ${testResult.ok ? 'callout-ok' : 'callout-error'}`}>{testResult.text}</div>
        )}
      </div>
    </Modal>
  );
}
