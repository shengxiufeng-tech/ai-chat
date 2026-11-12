import { Eye, EyeOff, FileText, FileUp, Loader2, Play, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  ASSET_KIND_LABELS,
  DEFAULT_EXCLUDED,
  PAGE_CATEGORY_LABELS,
  type ImportProgress,
  type PageCategory,
  type PreparedScript,
} from '../../../shared/types';
import { get, post } from '../api';
import { askConfirm } from '../confirm';
import { blobToDataUrl, openPdf, readPdfPage } from '../pdf';
import { attempt, toast } from '../toast';
import { EffortPicker } from './EffortPicker';
import { EraInput } from './EraInput';
import { ImportProgressView, type LocalPhase } from './ImportProgress';
import { ModelInput } from './ModelInput';
import { Field } from './ui';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_PDF = 300 * 1024 * 1024;
/** 正在进行或者整理完还没用掉的 PDF 导入任务（关掉窗口再打开时接着显示） */
const IMPORT_KEY = 'ai-chat:pdf-import';

export const clearPdfImport = () => localStorage.removeItem(IMPORT_KEY);

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 页面分类 → 「第 1-17 页」 */
function pagesByCategory(pages: { page: number; category: PageCategory }[]) {
  const map = new Map<PageCategory, number[]>();
  for (const p of pages) map.set(p.category, [...(map.get(p.category) ?? []), p.page]);
  const range = (list: number[]) => {
    const parts: string[] = [];
    for (let i = 0; i < list.length; i++) {
      let j = i;
      while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
      parts.push(i === j ? `${list[i]}` : `${list[i]}-${list[j]}`);
      i = j;
    }
    return parts.join('、');
  };
  return (Object.keys(PAGE_CATEGORY_LABELS) as PageCategory[]).filter((c) => map.has(c)).map((c) => ({ category: c, count: map.get(c)!.length, text: range(map.get(c)!) }));
}

type PdfState =
  | { phase: 'ready'; file: File; doc: PDFDocumentProxy }
  | { phase: 'reading'; file: File; local: LocalPhase }
  | { phase: 'running'; fileName: string; id: string; progress: ImportProgress | null }
  | { phase: 'failed'; fileName: string; message: string };

/**
 * 导入自己的剧本：上传文件或粘贴文字 → AI 整理 → 只显示玩家能看的部分（标题、时代、简介、开团须知），
 * 只有守秘人能看的内容默认隐藏。PDF 由「整理助手」处理：会看图片页、裁下手出物和地图、录入预设调查员。
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
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [organizer, setOrganizer] = useState(model);
  const [organizerEffort, setOrganizerEffort] = useState('');
  const cancelRead = useRef(false);

  useEffect(() => {
    if (!organizer && model) setOrganizer(model);
  }, [model, organizer]);

  const prepare = async (body: Record<string, unknown>) => {
    setBusy(true);
    setShowSecret(false);
    const r = await attempt(() => post<PreparedScript>('/scripts/prepare', { ...body, model }));
    setBusy(false);
    if (r) onPrepared(r);
  };

  // ---- PDF：轮询整理进度 ----
  const running = pdf?.phase === 'running' ? pdf.id : null;
  const runningName = pdf?.phase === 'running' ? pdf.fileName : '';
  const finishJob = useCallback(
    (p: ImportProgress) => {
      if (p.status === 'done' && p.result) {
        setPdf(null);
        setFileName(p.fileName);
        onPrepared(p.result);
        toast('剧本整理好了');
      } else if (p.status === 'error' || p.status === 'cancelled') {
        clearPdfImport();
        setPdf(p.status === 'error' ? { phase: 'failed', fileName: p.fileName, message: p.error || '整理失败' } : null);
      }
    },
    [onPrepared],
  );
  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      try {
        const p = await get<ImportProgress>(`/imports/${running}`);
        if (stop) return;
        if (p.status === 'running' || p.status === 'uploading') setPdf({ phase: 'running', fileName: runningName, id: running, progress: p });
        else finishJob(p);
      } catch (err) {
        if (!stop && /不存在/.test(errText(err))) {
          clearPdfImport();
          setPdf({ phase: 'failed', fileName: runningName, message: errText(err) });
        }
      }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [running, runningName, finishJob]);

  // 打开窗口时：接着显示之前还没完成（或者完成了还没用掉）的整理
  useEffect(() => {
    if (prepared) return;
    let saved: { id: string; fileName: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(IMPORT_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    if (!saved?.id) return;
    void get<ImportProgress>(`/imports/${saved.id}`)
      .then((p) => {
        if (p.status === 'running') setPdf({ phase: 'running', fileName: p.fileName, id: p.id, progress: p });
        else if (p.status === 'done' && p.result) finishJob(p);
        else clearPdfImport();
      })
      .catch(() => clearPdfImport());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPdf = async (file: File, doc: PDFDocumentProxy) => {
    if (!organizer.trim()) {
      toast('请先选择整理用的模型', 'error');
      return;
    }
    cancelRead.current = false;
    const total = doc.numPages;
    setPdf({ phase: 'reading', file, local: { phase: 'reading', done: 0, total } });
    try {
      const job = await post<ImportProgress>('/imports', { fileName: file.name, pageCount: total });
      for (let n = 1; n <= total; n++) {
        if (cancelRead.current) {
          await post(`/imports/${job.id}/cancel`).catch(() => {});
          setPdf(null);
          return;
        }
        const page = await readPdfPage(doc, n);
        await post(`/imports/${job.id}/pages/${n}`, { text: page.text, images: page.images, jpeg: await blobToDataUrl(page.jpeg) });
        setPdf({ phase: 'reading', file, local: { phase: 'reading', done: n, total } });
      }
      setPdf({ phase: 'reading', file, local: { phase: 'starting', done: total, total } });
      const p = await post<ImportProgress>(`/imports/${job.id}/start`, { model: organizer, reasoningEffort: organizerEffort });
      localStorage.setItem(IMPORT_KEY, JSON.stringify({ id: job.id, fileName: file.name }));
      setPdf({ phase: 'running', fileName: file.name, id: job.id, progress: p });
    } catch (err) {
      setPdf({ phase: 'failed', fileName: file.name, message: errText(err) });
    } finally {
      void doc.loadingTask.destroy();
    }
  };

  const cancelPdf = async () => {
    if (!pdf) return;
    if (pdf.phase === 'reading') {
      cancelRead.current = true;
      return;
    }
    if (pdf.phase === 'running') {
      const ok = await askConfirm({ title: '取消整理', message: '取消以后已经整理的部分不会保留，需要重新开始。确定取消吗？', confirmText: '取消整理', danger: true });
      if (!ok) return;
      await attempt(() => post(`/imports/${pdf.id}/cancel`));
      clearPdfImport();
      setPdf(null);
    }
  };

  const onFile = async (file: File) => {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (file.size > (isPdf ? MAX_PDF : MAX_FILE)) {
      toast(`文件太大了（超过 ${isPdf ? 300 : 20}MB）`, 'error');
      return;
    }
    setFileName(file.name);
    onPrepared(null);
    clearPdfImport();
    if (isPdf) {
      try {
        const doc = await openPdf(file);
        setPdf({ phase: 'ready', file, doc });
      } catch (err) {
        setPdf({ phase: 'failed', fileName: file.name, message: errText(err) });
      }
      return;
    }
    setPdf(null);
    await prepare({ name: file.name, data: await readAsBase64(file) });
  };

  const set = <K extends keyof PreparedScript>(k: K, v: PreparedScript[K]) => prepared && onPrepared({ ...prepared, [k]: v });

  // 调整哪些页面交给守秘人
  const toggleCategory = async (c: PageCategory) => {
    if (!prepared?.importId) return;
    const excluded = prepared.excluded ?? DEFAULT_EXCLUDED;
    const next = excluded.includes(c) ? excluded.filter((x) => x !== c) : [...excluded, c];
    const r = await attempt(() => post<PreparedScript>(`/imports/${prepared.importId}/assemble`, { excluded: next }));
    // 保留你改过的标题、时代和简介
    if (r) onPrepared({ ...r, title: prepared.title, eraLabel: prepared.eraLabel, intro: prepared.intro });
  };

  const working = busy || pdf?.phase === 'reading' || pdf?.phase === 'running';

  return (
    <div className="form-stack" style={{ gap: 12 }}>
      <div className="callout callout-info">
        <ShieldCheck />
        <span>
          不用打开剧本文件：导入后 AI 会把内容分成「你可以看的」（标题、时代、开场简介、开团须知）和「只有守秘人能看的」两部分，后者默认隐藏。
        </span>
      </div>

      <div className="row wrap">
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={working}>
          <FileUp /> {fileName ? '换一个文件' : '选择剧本文件'}
        </button>
        <span className="hint">{fileName || '支持 .pdf .txt .md .doc .docx'}</span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setPasteMode((x) => !x)} disabled={working}>
          {pasteMode ? '收起' : '改为粘贴文字'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf,.txt,.md,.markdown,.doc,.docx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {pdf?.phase === 'ready' && (
        <div className="prepared-card">
          <div className="row" style={{ gap: 10 }}>
            <FileText style={{ width: 20, height: 20, color: 'var(--accent-text)', flex: 'none' }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pdf.file.name}</div>
              <div className="hint">
                {pdf.doc.numPages} 页 · {(pdf.file.size / 1024 / 1024).toFixed(1)} MB
              </div>
            </div>
          </div>
          <div className="hint">
            PDF 由「整理助手」处理：它会读文字、查看图片页（扫描页、地图、手出物、调查员卡），裁下手出物和地图，录入预设调查员，再写出无剧透的简介和守秘人速览。
            需要能看图的模型，会调用模型几十次，通常要几分钟到十几分钟。
          </div>
          <div className="form-grid">
            <Field label="整理用的模型" hint="（要能看图，比如 Gemini、GPT）">
              <ModelInput value={organizer} onChange={setOrganizer} showStatus={false} />
            </Field>
            <Field label="思考强度">
              <EffortPicker model={organizer} value={organizerEffort} onChange={setOrganizerEffort} />
            </Field>
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn btn-primary" onClick={() => void startPdf(pdf.file, pdf.doc)} disabled={!organizer.trim()}>
              <Play /> 开始整理
            </button>
          </div>
        </div>
      )}

      {pdf?.phase === 'reading' && <ImportProgressView fileName={pdf.file.name} local={pdf.local} onCancel={() => void cancelPdf()} />}
      {pdf?.phase === 'running' && <ImportProgressView fileName={pdf.fileName} progress={pdf.progress} onCancel={() => void cancelPdf()} />}
      {pdf?.phase === 'failed' && (
        <div className="callout callout-error">
          <TriangleAlert />
          <span>
            「{pdf.fileName}」整理失败：{pdf.message}
            <br />
            可以换一个模型再选一次文件重试。
          </span>
        </div>
      )}

      {pasteMode && (
        <Field label="粘贴剧本" hint="（粘贴的内容你已经看过了，整理一下可以得到开场简介和守秘人速览）">
          <textarea rows={6} value={pasted} onChange={(e) => onPasted(e.target.value)} placeholder="把剧本、大纲或者你的构想粘贴到这里…" />
          <div className="row">
            <button className="btn btn-sm" disabled={working || !pasted.trim()} onClick={() => prepare({ text: pasted })}>
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

      {prepared && !working && (
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

          {prepared.pages && (
            <Field label="交给守秘人的页面" hint="（只显示页码和分类；点一下可以切换要不要交给守秘人）">
              <div className="page-cats">
                {pagesByCategory(prepared.pages).map((g) => {
                  const off = (prepared.excluded ?? DEFAULT_EXCLUDED).includes(g.category);
                  return (
                    <button key={g.category} type="button" className={`page-cat ${off ? 'off' : ''}`} onClick={() => void toggleCategory(g.category)}>
                      <span className="page-cat-name">{PAGE_CATEGORY_LABELS[g.category]}</span>
                      <span className="page-cat-pages">第 {g.text} 页</span>
                      <span className={`badge ${off ? '' : 'badge-accent'}`}>{off ? '不交给守秘人' : '交给守秘人'}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          {(prepared.assets?.length || prepared.pregens?.length) ? (
            <div className="hint">
              {(['handout', 'map', 'image'] as const)
                .map((k) => [k, prepared.assets?.filter((a) => a.kind === k).length ?? 0] as const)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${ASSET_KIND_LABELS[k]} ${n} 张`)
                .join(' · ')}
              {prepared.assets?.length ? '（图片先不给你看，守秘人会在剧情里展示）' : ''}
              {prepared.pregens?.length ? `${prepared.assets?.length ? '；' : ''}预设调查员：${prepared.pregens.map((s) => `${s.name}（${s.occupation}）`).join('、')}，创建调查员时可以直接选用` : ''}
            </div>
          ) : null}

          <div className="hint">
            {prepared.importId
              ? `交给守秘人的原文约 ${prepared.chars.toLocaleString('en-US')} 字，另外还有整理助手写的速览${prepared.assets?.some((a) => a.kind === 'map') ? '和地图图片' : ''}。`
              : `已导入原文 ${prepared.chars.toLocaleString('en-US')} 字${prepared.truncated ? '（太长了，只保留了前面的部分）' : ''}，文件里的图片不会导入。守秘人会拿到 AI 整理的速览和完整原文。`}
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

      {!prepared && !working && !pdf && pasteMode && pasted.trim() && (
        <Field label="时代背景">
          <EraInput value={eraLabel} onChange={onEraLabel} />
        </Field>
      )}
    </div>
  );
}
