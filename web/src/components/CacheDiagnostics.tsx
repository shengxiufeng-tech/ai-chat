import { AlertCircle, CheckCircle2, ClipboardCopy, Info, Loader2, Zap } from 'lucide-react';
import { useState } from 'react';
import type { TokenUsage } from '../../../shared/types';
import { post } from '../api';
import { toast } from '../toast';
import { ModelInput } from './ModelInput';
import { Field } from './ui';

interface Attempt {
  ok: boolean;
  usage?: TokenUsage | null;
  error?: string;
  ms: number;
}

interface Result {
  model: string;
  first: Attempt;
  second: Attempt | null;
  promptTokens?: number;
}

function describe(a: Attempt | null) {
  if (!a) return '没有执行';
  if (!a.ok) return `出错：${a.error}`;
  if (!a.usage) return `用时 ${(a.ms / 1000).toFixed(1)} 秒，服务没有返回用量信息`;
  const u = a.usage;
  const cache =
    u.cached === undefined
      ? '没有缓存字段'
      : `命中缓存 ${u.cached.toLocaleString('en-US')}（${u.input ? Math.round((u.cached / u.input) * 100) : 0}%）`;
  return `输入 ${u.input.toLocaleString('en-US')} tokens · ${cache} · 用时 ${(a.ms / 1000).toFixed(1)} 秒`;
}

function verdict(r: Result): { level: 'ok' | 'error' | 'info'; text: string } {
  if (!r.first.ok) return { level: 'error', text: '第一次请求就出错了，先确认这个模型能正常对话。' };
  if (!r.second?.ok) return { level: 'error', text: '第二次请求出错了。' };
  const u = r.second.usage;
  if (!u) {
    return {
      level: 'info',
      text: '模型服务没有返回用量信息（usage），所以看不出有没有命中缓存。Magpie 的用量统计里显示 0 也可能是这个原因。',
    };
  }
  if (u.cached === undefined) {
    return { level: 'info', text: '服务商返回了 token 数，但没有报告缓存命中的字段，无法判断。' };
  }
  if (u.cached > 0) {
    return {
      level: 'ok',
      text: `缓存正常：第二次请求有 ${Math.round((u.cached / Math.max(1, u.input)) * 100)}% 的输入命中了缓存。如果实际对话里还是 0，把消息旁边的「缓存」标签和这段结果一起发给我。`,
    };
  }
  return {
    level: 'error',
    text: '两次完全相同的请求，第二次也没有命中缓存。可能是：这个服务商 / 账号不支持自动缓存；Magpie 把两次请求分给了不同的账号；或者服务商要求更长的提示才会缓存。把这段结果复制给我，我来进一步排查。',
  };
}

/** 缓存诊断：用同一个会话连续发两次相同的长提示，看第二次有没有命中缓存 */
export function CacheDiagnostics({ defaultModel }: { defaultModel: string }) {
  const [model, setModel] = useState(defaultModel);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      setResult(await post<Result>('/diagnostics/cache', { model }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const v = result && verdict(result);
  const summary = result
    ? [
        `缓存诊断 · 模型 ${result.model}${result.promptTokens ? ` · 提示约 ${result.promptTokens.toLocaleString('en-US')} tokens` : ''}`,
        `第 1 次：${describe(result.first)}`,
        `第 2 次：${describe(result.second)}`,
        `结论：${v?.text ?? ''}`,
      ].join('\n')
    : '';

  return (
    <Field label="缓存诊断" hint="（用同一个会话连续发两次相同的长提示，看第二次有没有命中缓存；大约消耗 1 万输入 token）">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <ModelInput value={model} onChange={setModel} showStatus={false} placeholder="要测试的模型" />
        </div>
        <button className="btn" onClick={run} disabled={running || !model.trim()}>
          {running ? <Loader2 className="spin" /> : <Zap />} {running ? '测试中（约 10 秒）…' : '开始测试'}
        </button>
      </div>
      {error && (
        <div className="callout callout-error">
          <AlertCircle />
          <span>{error}</span>
        </div>
      )}
      {result && v && (
        <div className="diag-result">
          <div className="diag-row">
            <span className="diag-label">第 1 次</span>
            <span>{describe(result.first)}</span>
          </div>
          <div className="diag-row">
            <span className="diag-label">第 2 次</span>
            <span>{describe(result.second)}</span>
          </div>
          <div className={`callout callout-${v.level}`}>
            {v.level === 'ok' ? <CheckCircle2 /> : v.level === 'error' ? <AlertCircle /> : <Info />}
            <span>{v.text}</span>
          </div>
          <button
            className="btn btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              await navigator.clipboard.writeText(summary);
              toast('诊断结果已复制');
            }}
          >
            <ClipboardCopy /> 复制结果
          </button>
        </div>
      )}
    </Field>
  );
}
