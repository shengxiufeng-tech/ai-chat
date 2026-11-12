import { Check, Circle, CircleDashed, Loader2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ImportProgress } from '../../../shared/types';
import { shortModel } from '../models';

/** 浏览器这边的阶段：读取 PDF、上传页面 */
export interface LocalPhase {
  phase: 'reading' | 'starting';
  done: number;
  total: number;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const tokens = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : n.toLocaleString('en-US'));

/** 粗略估计整理完成了多少：页面分类、看图片页、写各项结果 */
export function estimate(p: ImportProgress) {
  if (p.status === 'done') return 100;
  const c = p.checklist;
  const cat = p.pageCount ? c.categorized / p.pageCount : 0;
  const img = c.imagePages ? c.imagePagesSeen / c.imagePages : cat;
  const fields = [c.title, c.era, c.intro, c.brief, c.glossary].filter(Boolean).length / 5;
  const byWork = 0.25 * cat + 0.35 * img + 0.4 * fields;
  const bySteps = p.maxSteps ? p.step / p.maxSteps : 0;
  return Math.min(99, Math.round(100 * Math.max(byWork, bySteps * 0.6)));
}

function Item({ done, partial, children }: { done: boolean; partial?: boolean; children: ReactNode }) {
  return (
    <div className={`ip-item ${done ? 'done' : partial ? 'partial' : ''}`}>
      {done ? <Check /> : partial ? <CircleDashed /> : <Circle />}
      <span>{children}</span>
    </div>
  );
}

/** PDF 剧本整理的进度（只显示不剧透的信息） */
export function ImportProgressView({
  local,
  progress,
  fileName,
  onCancel,
}: {
  local?: LocalPhase | null;
  progress?: ImportProgress | null;
  fileName: string;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [startedLocal] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const running = progress?.status === 'running';
  const phaseIndex = local ? (local.phase === 'reading' ? 0 : 1) : running ? 2 : 3;
  const phases = ['读取 PDF', '上传页面', 'AI 整理', '完成'];
  const pct = local ? Math.round((100 * local.done) / Math.max(1, local.total)) : progress ? estimate(progress) : 0;
  const elapsed = now - (progress?.startedAt ?? startedLocal);
  const c = progress?.checklist;

  return (
    <div className="import-progress">
      <div className="ip-head">
        <Loader2 className="spin" />
        <div className="grow">
          <div className="ip-title">正在整理「{fileName}」</div>
          <div className="hint">
            {local
              ? local.phase === 'reading'
                ? `读取并上传第 ${Math.min(local.total, local.done + 1)} / ${local.total} 页`
                : '准备开始…'
              : progress
                ? `已用 ${mmss(elapsed)} · 第 ${progress.step} 步（最多 ${progress.maxSteps} 步）· ${shortModel(progress.model)}`
                : ''}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onCancel}>
          <X /> 取消
        </button>
      </div>

      <div className="ip-phases">
        {phases.map((name, i) => (
          <div key={name} className={`ip-phase ${i < phaseIndex ? 'done' : i === phaseIndex ? 'current' : ''}`}>
            <span className="num">{i < phaseIndex ? <Check /> : i + 1}</span>
            {name}
          </div>
        ))}
      </div>

      <div className="ip-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%` }} />
      </div>

      {progress && c && !local && (
        <>
          <div className="ip-checklist">
            <Item done={c.categorized >= progress.pageCount} partial={c.categorized > 0}>
              页面分类 {c.categorized}/{progress.pageCount}
            </Item>
            <Item done={c.imagePages > 0 && c.imagePagesSeen >= c.imagePages} partial={c.imagePagesSeen > 0}>
              {c.imagePages ? `查看图片页 ${c.imagePagesSeen}/${c.imagePages}` : '没有图片页'}
            </Item>
            <Item done={c.intro}>玩家简介</Item>
            <Item done={c.era}>时代背景</Item>
            <Item done={c.brief}>守秘人速览</Item>
            <Item done={c.glossary}>译名表</Item>
          </div>
          <div className="hint">
            已找到：手出物 {c.handouts} · 地图 {c.maps} · 预设调查员 {c.pregens}
            {progress.usage.input > 0 && ` · 已用 ${tokens(progress.usage.input)} 输入 token`}
            {progress.fallback && ' · 简化流程（模型不支持工具调用）'}
          </div>
          {progress.activity.length > 0 && (
            <ol className="ip-log">
              {progress.activity
                .slice(-6)
                .reverse()
                .map((a, i) => (
                  <li key={`${a.at}-${i}`} className={i === 0 ? 'latest' : ''}>
                    <span className="ip-time">{mmss(a.at - (progress.startedAt ?? a.at))}</span>
                    {a.text}
                  </li>
                ))}
            </ol>
          )}
        </>
      )}

      <div className="hint">
        {local
          ? '读取和上传都在你的设备上进行，请先别关这个窗口。'
          : '整理通常要几分钟到十几分钟。可以关掉这个窗口，整理会在后台继续，回来再选「我自己的剧本」就能看到进度。进度里只显示页码和数量，不会剧透。'}
      </div>
    </div>
  );
}
