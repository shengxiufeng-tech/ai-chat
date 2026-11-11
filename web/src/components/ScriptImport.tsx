import { Eye, EyeOff, FileUp, Loader2, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { PreparedScript } from '../../../shared/types';
import { post } from '../api';
import { attempt, toast } from '../toast';
import { EraInput } from './EraInput';
import { Field } from './ui';

const MAX_FILE = 20 * 1024 * 1024;

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 导入自己的剧本：上传文件或粘贴文字 → AI 整理 → 只显示玩家能看的部分（标题、时代、简介、开团须知），
 * 只有守秘人能看的内容默认隐藏。
 */
export function ScriptImport({
  model,
  prepared,
  onPrepared,
  pasted,
  onPasted,
  eraLabel,
  onEraLabel,
}: {
  model: string;
  prepared: PreparedScript | null;
  onPrepared: (p: PreparedScript | null) => void;
  pasted: string;
  onPasted: (v: string) => void;
  eraLabel: string;
  onEraLabel: (v: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const prepare = async (body: Record<string, unknown>) => {
    setBusy(true);
    setShowSecret(false);
    const r = await attempt(() => post<PreparedScript>('/scripts/prepare', { ...body, model }));
    setBusy(false);
    if (r) onPrepared(r);
  };

  const onFile = async (file: File) => {
    if (file.size > MAX_FILE) {
      toast('文件太大了（超过 20MB）', 'error');
      return;
    }
    setFileName(file.name);
    onPrepared(null);
    await prepare({ name: file.name, data: await readAsBase64(file) });
  };

  const set = <K extends keyof PreparedScript>(k: K, v: PreparedScript[K]) => prepared && onPrepared({ ...prepared, [k]: v });

  return (
    <div className="form-stack" style={{ gap: 12 }}>
      <div className="callout callout-info">
        <ShieldCheck />
        <span>
          不用打开剧本文件：导入后 AI 会把内容分成「你可以看的」（标题、时代、开场简介、开团须知）和「只有守秘人能看的」两部分，后者默认隐藏。
        </span>
      </div>

      <div className="row wrap">
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          <FileUp /> {fileName ? '换一个文件' : '选择剧本文件'}
        </button>
        <span className="hint">{fileName || '支持 .txt .md .doc .docx'}</span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setPasteMode((x) => !x)} disabled={busy}>
          {pasteMode ? '收起' : '改为粘贴文字'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.markdown,.doc,.docx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {pasteMode && (
        <Field label="粘贴剧本" hint="（粘贴的内容你已经看过了，整理一下可以得到开场简介和守秘人速览）">
          <textarea rows={6} value={pasted} onChange={(e) => onPasted(e.target.value)} placeholder="把剧本、大纲或者你的构想粘贴到这里…" />
          <div className="row">
            <button className="btn btn-sm" disabled={busy || !pasted.trim()} onClick={() => prepare({ text: pasted })}>
              <Sparkles /> 整理
            </button>
            <span className="hint">不整理也可以直接创建，这时需要自己填时代背景。</span>
          </div>
        </Field>
      )}

      {busy && (
        <div className="callout callout-info">
          <Loader2 className="spin" />
          <span>正在整理剧本……AI 会把只有守秘人能看的内容藏起来，大约需要半分钟到两分钟。</span>
        </div>
      )}

      {prepared && !busy && (
        <div className="prepared-card">
          <div className="form-grid">
            <Field label="标题">
              <input value={prepared.title} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label="时代背景">
              <input value={prepared.eraLabel} onChange={(e) => set('eraLabel', e.target.value)} placeholder="例如：1920 年代，美国新英格兰" />
            </Field>
          </div>
          <Field label="开场简介" hint="（AI 写的无剧透版本，开场前会给你看）">
            <textarea rows={3} value={prepared.intro} onChange={(e) => set('intro', e.target.value)} />
          </Field>
          {prepared.playerInfo && (
            <Field label="开团须知" hint="（推荐人数、时长、推荐技能、车卡限制等，可以放心看）">
              <div className="player-info">
                {prepared.playerInfo.split('\n').map((l, i) => (
                  <div key={i}>{l.replace(/^[-•·\s]+/, '')}</div>
                ))}
              </div>
            </Field>
          )}
          <div className="hint">
            已导入原文 {prepared.chars.toLocaleString('en-US')} 字{prepared.truncated ? '（太长了，只保留了前面的部分）' : ''}，文件里的图片不会导入。
            守秘人会拿到 AI 整理的速览和完整原文。
          </div>
          {prepared.warning && (
            <div className="callout callout-error">
              <TriangleAlert />
              <span>{prepared.warning}</span>
            </div>
          )}
          <div>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowSecret((x) => !x)}>
              {showSecret ? <EyeOff /> : <Eye />} {showSecret ? '隐藏守秘人资料' : '查看守秘人资料（剧透）'}
            </button>
          </div>
          {showSecret && <div className="scenario-intro secret-view">{prepared.secret}</div>}
        </div>
      )}

      {!prepared && !busy && pasteMode && pasted.trim() && (
        <Field label="时代背景">
          <EraInput value={eraLabel} onChange={onEraLabel} />
        </Field>
      )}
    </div>
  );
}
