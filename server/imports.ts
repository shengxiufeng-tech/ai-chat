// PDF 剧本的导入任务：保存浏览器传来的页面，在后台运行整理助手，记录进度（只记不剧透的信息）。
// 关掉新建房间的窗口也不会中断；整理完的结果保存在磁盘上，服务重启后还能用来创建房间。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDED, PAGE_CATEGORY_LABELS, type ImportProgress, type PageCategory, type PreparedScript, type ScriptAsset } from '../shared/types.ts';
import { assemble, categoryOf, isImagePage, pageFile, runScriptAgent, type PageData, type Workspace } from './scriptAgent.ts';

interface Job {
  progress: ImportProgress;
  ws: Workspace;
  controller?: AbortController;
}

const ACTIVITY_KEEP = 40;
const KEEP_DAYS = 3;

const newJobId = () => `imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class ImportManager {
  private jobs = new Map<string, Job>();

  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.cleanup();
  }

  private dirOf(id: string) {
    if (!/^imp[a-z0-9]+$/.test(id)) throw new Error('导入任务不存在');
    return path.join(this.root, id);
  }

  /** 删掉几天前的导入任务 */
  private cleanup() {
    const limit = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, name);
      try {
        if (fs.statSync(dir).mtimeMs < limit) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
  }

  create(fileName: string, pageCount: number): ImportProgress {
    if (!(pageCount >= 1 && pageCount <= 600)) throw new Error('页数不对（最多 600 页）');
    const id = newJobId();
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const progress: ImportProgress = {
      id,
      fileName: fileName || '剧本.pdf',
      pageCount,
      uploaded: 0,
      status: 'uploading',
      model: '',
      step: 0,
      maxSteps: 0,
      activity: [],
      checklist: { categorized: 0, imagePages: 0, imagePagesSeen: 0, title: false, era: false, intro: false, brief: false, glossary: false, handouts: 0, maps: 0, pregens: 0 },
      usage: { input: 0, output: 0, cached: 0 },
    };
    const ws: Workspace = {
      dir,
      fileName: progress.fileName,
      pages: Array.from({ length: pageCount }, (_, i) => ({ page: i + 1, text: '', chars: 0, images: 0 })),
      fields: {},
      assets: [],
      pregens: [],
      seen: [],
    };
    this.jobs.set(id, { progress, ws });
    return progress;
  }

  private job(id: string): Job {
    const job = this.jobs.get(id) ?? this.load(id);
    if (!job) throw new Error('导入任务不存在（可能已经过期），请重新选择文件');
    return job;
  }

  /** 服务重启后从磁盘读回已经完成的任务 */
  private load(id: string): Job | undefined {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'job.json'), 'utf8')) as { progress: ImportProgress; ws: Workspace };
      const job = { progress: saved.progress, ws: { ...saved.ws, dir: this.dirOf(id) } };
      // 重启时还在运行的任务已经中断了
      if (job.progress.status === 'running' || job.progress.status === 'uploading') {
        job.progress.status = 'error';
        job.progress.error = '整理被中断了（服务重启过），请重新开始。';
      }
      this.jobs.set(id, job);
      return job;
    } catch {
      return undefined;
    }
  }

  private save(job: Job) {
    const { dir: _dir, ...ws } = job.ws;
    fs.writeFileSync(path.join(job.ws.dir, 'job.json'), JSON.stringify({ progress: job.progress, ws }));
  }

  savePage(id: string, page: number, text: string, images: number, jpeg: Buffer) {
    const job = this.job(id);
    if (job.progress.status !== 'uploading') throw new Error('这个导入任务已经开始整理了');
    const p = job.ws.pages[page - 1];
    if (!p) throw new Error(`页码 ${page} 不对`);
    const clean = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    Object.assign(p, { text: clean, chars: clean.replace(/\s/g, '').length, images: Math.max(0, images | 0) } satisfies Partial<PageData>);
    if (jpeg.length) fs.writeFileSync(pageFile(job.ws.dir, page), jpeg);
    job.progress.uploaded = job.ws.pages.filter((x) => x.chars > 0 || fs.existsSync(pageFile(job.ws.dir, x.page))).length;
  }

  private activity(job: Job, text: string) {
    job.progress.activity.push({ at: Date.now(), text });
    if (job.progress.activity.length > ACTIVITY_KEEP) job.progress.activity.splice(0, job.progress.activity.length - ACTIVITY_KEEP);
  }

  private refreshChecklist(job: Job) {
    const { ws } = job;
    const imagePages = ws.pages.filter(isImagePage).map((p) => p.page);
    job.progress.checklist = {
      categorized: ws.pages.filter((p) => p.category).length,
      imagePages: imagePages.length,
      imagePagesSeen: imagePages.filter((n) => ws.seen.includes(n)).length,
      title: !!ws.fields.title,
      era: !!ws.fields.era,
      intro: !!ws.fields.intro,
      brief: !!ws.fields.keeper_brief,
      glossary: !!ws.fields.glossary,
      handouts: ws.assets.filter((a) => a.kind === 'handout').length,
      maps: ws.assets.filter((a) => a.kind === 'map').length,
      pregens: ws.pregens.length,
    };
  }

  /** 开始整理（在后台运行） */
  start(id: string, opts: { baseUrl: string; apiKey: string; model: string; reasoningEffort?: string }) {
    const job = this.job(id);
    if (job.progress.status !== 'uploading') throw new Error('这个导入任务已经开始过了');
    if (!opts.model) throw new Error('请选择整理用的模型');
    const missing = job.ws.pages.filter((p) => !fs.existsSync(pageFile(job.ws.dir, p.page))).map((p) => p.page);
    if (missing.length) throw new Error(`还有 ${missing.length} 页没有上传完`);
    const controller = new AbortController();
    job.controller = controller;
    Object.assign(job.progress, { status: 'running', model: opts.model, startedAt: Date.now() });
    this.refreshChecklist(job);
    this.activity(job, '开始整理');
    void runScriptAgent(job.ws, {
      ...opts,
      sessionId: `ai-chat-import-${id}`,
      signal: controller.signal,
      hooks: {
        activity: (text) => this.activity(job, text),
        step: (step, maxSteps) => Object.assign(job.progress, { step, maxSteps }),
        usage: (u) => {
          job.progress.usage.input += u.input;
          job.progress.usage.output += u.output;
          job.progress.usage.cached += u.cached ?? 0;
        },
        changed: () => {
          this.refreshChecklist(job);
          job.progress.fallback = job.ws.fallback;
        },
      },
    })
      .then(() => {
        this.refreshChecklist(job);
        Object.assign(job.progress, { status: 'done', finishedAt: Date.now(), fallback: job.ws.fallback, result: this.result(job) });
        this.activity(job, '整理完成');
      })
      .catch((err) => {
        const cancelled = controller.signal.aborted;
        Object.assign(job.progress, {
          status: cancelled ? 'cancelled' : 'error',
          finishedAt: Date.now(),
          error: cancelled ? undefined : err instanceof Error ? err.message : String(err),
        });
        this.activity(job, cancelled ? '已取消' : '出错了');
      })
      .finally(() => {
        job.controller = undefined;
        this.save(job);
      });
    return job.progress;
  }

  cancel(id: string) {
    const job = this.job(id);
    job.controller?.abort();
    if (job.progress.status === 'uploading') {
      Object.assign(job.progress, { status: 'cancelled', finishedAt: Date.now() });
      this.save(job);
    }
    return job.progress;
  }

  get(id: string): ImportProgress {
    return this.job(id).progress;
  }

  private result(job: Job, excluded?: PageCategory[]): PreparedScript {
    return { ...assemble(job.ws, excluded), importId: job.progress.id, organizer: job.progress.model };
  }

  /** 调整哪些页面交给守秘人以后重新生成资料 */
  assemble(id: string, excluded: unknown): PreparedScript {
    const job = this.job(id);
    if (job.progress.status !== 'done') throw new Error('还没有整理完');
    const list = Array.isArray(excluded) ? excluded.filter((x): x is PageCategory => typeof x === 'string' && x in PAGE_CATEGORY_LABELS) : DEFAULT_EXCLUDED;
    job.progress.result = this.result(job, list);
    this.save(job);
    return job.progress.result;
  }

  /** 创建房间时：把手出物和地图拷贝到房间的目录，返回图片信息和预设调查员 */
  takeAssets(id: string, destDir: string): { assets: ScriptAsset[]; pregens: PreparedScript['pregens'] } {
    const job = this.job(id);
    fs.mkdirSync(destDir, { recursive: true });
    const assets: ScriptAsset[] = [];
    for (const a of job.ws.assets) {
      if (!fs.existsSync(a.file)) continue;
      fs.copyFileSync(a.file, path.join(destDir, `${a.id}.jpg`));
      const { file: _f, box: _b, ...rest } = a;
      assets.push(rest);
    }
    return { assets, pregens: job.ws.pregens };
  }

  /** 页面分类统计（调试和测试用） */
  categories(id: string) {
    return this.job(id).ws.pages.map(categoryOf);
  }
}
