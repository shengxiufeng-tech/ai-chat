// 剧本库：整理过的剧本保存在本地（data/scripts/<id>/），以后新建房间可以直接选用，
// 再次导入同一个文件时也直接拿上次的结果，不用重新整理。
//
// 来源：PDF 整理助手的结果、txt / doc / docx / 粘贴文字的整理结果、导入的房间备份，
// 以及第一次启动这个版本时已有的「我自己的剧本」房间（只补一次）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TrpgState } from '../shared/coc.ts';
import { DEFAULT_EXCLUDED, type LibraryItem, type PageCategory, type PreparedScript, type Room, type ScriptSourceKind } from '../shared/types.ts';
import { assemble, type Workspace } from './scriptAgent.ts';

interface Entry {
  id: string;
  createdAt: number;
  updatedAt: number;
  source: { kind: ScriptSourceKind; fileName?: string; pages?: number; hash?: string };
  /** 守秘人资料的指纹：同样内容的剧本只存一份 */
  contentKey: string;
  prepared: PreparedScript;
  /** PDF：整理助手的工作区（调整交给守秘人的页面时重新生成资料用） */
  ws?: Omit<Workspace, 'dir'>;
}

export interface AddInput {
  prepared: PreparedScript;
  source: Entry['source'];
  ws?: Workspace;
  /** 图片：asset id → 文件路径或内容 */
  images?: Record<string, string | Buffer>;
}

const contentKeyOf = (p: PreparedScript) => crypto.createHash('sha256').update(p.secret ?? '').digest('hex');
const newEntryId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BACKFILL_MARK = '.backfilled';

/** 把房间里的剧本还原成导入资料（房间备份、已有房间进剧本库用） */
export function preparedFromTrpg(trpg: TrpgState): PreparedScript {
  return {
    title: trpg.scenarioTitle,
    eraLabel: trpg.eraLabel ?? '',
    era: trpg.era,
    intro: trpg.scenarioIntro,
    playerInfo: trpg.playerInfo ?? '',
    secret: trpg.scenarioSecret,
    chars: trpg.scenarioSecret.length,
    ...(trpg.assets?.length ? { assets: trpg.assets.map(({ shown: _s, ...a }) => a) } : {}),
    ...(trpg.pregens?.length ? { pregens: trpg.pregens } : {}),
  };
}

export class ScriptLibrary {
  private entries = new Map<string, Entry>();

  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(root, name, 'entry.json'), 'utf8')) as Entry;
        if (e?.id === name) this.entries.set(e.id, e);
      } catch {
        // 不是剧本目录
      }
    }
  }

  private dirOf(id: string) {
    if (!/^s[a-z0-9]+$/.test(id)) throw new Error('剧本不存在');
    return path.join(this.root, id);
  }

  private entry(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error('剧本库里没有这个剧本（可能已经删除）');
    return e;
  }

  private save(e: Entry) {
    fs.mkdirSync(this.dirOf(e.id), { recursive: true });
    fs.writeFileSync(path.join(this.dirOf(e.id), 'entry.json'), JSON.stringify(e));
  }

  list(): LibraryItem[] {
    return [...this.entries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((e) => ({
        id: e.id,
        title: e.prepared.title,
        eraLabel: e.prepared.eraLabel,
        source: { kind: e.source.kind, fileName: e.source.fileName, pages: e.source.pages },
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        handouts: e.prepared.assets?.filter((a) => a.kind === 'handout').length ?? 0,
        maps: e.prepared.assets?.filter((a) => a.kind === 'map').length ?? 0,
        pregens: e.prepared.pregens?.length ?? 0,
        organizer: e.prepared.organizer,
        warning: !!e.prepared.warning,
      }));
  }

  /** 选用剧本库里的剧本：返回创建房间用的资料 */
  get(id: string): PreparedScript {
    const e = this.entry(id);
    return { ...structuredClone(e.prepared), libraryId: e.id, importId: undefined };
  }

  findByHash(hash: string | undefined) {
    if (!hash) return undefined;
    return [...this.entries.values()].find((e) => e.source.hash === hash)?.id;
  }

  /** 加入剧本库；同一个文件（或者内容完全相同的剧本）只保留一份，返回条目 id */
  add(input: AddInput): string {
    const contentKey = contentKeyOf(input.prepared);
    const now = Date.now();
    const same =
      (input.source.hash && [...this.entries.values()].find((e) => e.source.hash === input.source.hash)) ||
      [...this.entries.values()].find((e) => e.contentKey === contentKey);
    if (same && same.contentKey === contentKey && !input.source.hash) {
      // 完全一样的内容（比如同一个备份导入两次）：只更新时间，顺便补上缺的图片
      this.copyImages(same.id, same.prepared, input.images, false);
      same.updatedAt = now;
      this.save(same);
      return same.id;
    }
    const id = same?.id ?? newEntryId();
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const { libraryId: _l, importId: _i, reused: _r, ...prepared } = input.prepared;
    this.copyImages(id, prepared, input.images, true);
    let ws: Entry['ws'];
    if (input.ws) {
      const { dir: _d, ...rest } = input.ws;
      ws = structuredClone(rest);
    }
    const entry: Entry = { id, createdAt: same?.createdAt ?? now, updatedAt: now, source: input.source, contentKey, prepared, ws };
    this.entries.set(id, entry);
    this.save(entry);
    return id;
  }

  /** 把图片写进剧本目录（overwrite = false 时只补缺的） */
  private copyImages(id: string, prepared: PreparedScript, images: AddInput['images'], overwrite: boolean) {
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const a of prepared.assets ?? []) {
      const img = images?.[a.id];
      const dest = path.join(dir, `${a.id}.jpg`);
      if (!overwrite && fs.existsSync(dest)) continue;
      if (Buffer.isBuffer(img)) fs.writeFileSync(dest, img);
      else if (typeof img === 'string' && fs.existsSync(img)) fs.copyFileSync(img, dest);
    }
  }

  remove(id: string) {
    this.entry(id);
    this.entries.delete(id);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  /** PDF 剧本：调整哪些页面交给守秘人以后重新生成资料 */
  assemble(id: string, excluded: unknown): PreparedScript {
    const e = this.entry(id);
    if (!e.ws) throw new Error('这个剧本不是 PDF 整理的，不能调整页面');
    const list = Array.isArray(excluded) ? excluded.filter((x): x is PageCategory => typeof x === 'string') : DEFAULT_EXCLUDED;
    const fresh = assemble({ ...e.ws, dir: this.dirOf(id) } as Workspace, list);
    e.prepared = { ...e.prepared, secret: fresh.secret, chars: fresh.chars, excluded: list };
    e.contentKey = contentKeyOf(e.prepared);
    e.updatedAt = Date.now();
    this.save(e);
    return this.get(id);
  }

  /** 创建房间时：把手出物和地图拷贝到房间目录 */
  takeAssets(id: string, destDir: string) {
    const e = this.entry(id);
    const assets = (e.prepared.assets ?? []).filter((a) => {
      const src = path.join(this.dirOf(id), `${a.id}.jpg`);
      if (!fs.existsSync(src)) return false;
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, `${a.id}.jpg`));
      return true;
    });
    e.updatedAt = Date.now();
    this.save(e);
    return { assets, pregens: e.prepared.pregens };
  }

  /** 第一次运行这个版本时，把已有的「我自己的剧本」房间加进剧本库（只做一次） */
  backfillOnce(rooms: Room[], assetPath: (roomId: string, assetId: string) => string) {
    const mark = path.join(this.root, BACKFILL_MARK);
    if (fs.existsSync(mark)) return 0;
    let n = 0;
    for (const room of rooms) {
      const t = room.trpg;
      if (room.mode !== 'trpg' || !t || t.scenarioId !== 'custom' || !t.scenarioSecret?.trim()) continue;
      const images = Object.fromEntries((t.assets ?? []).map((a) => [a.id, assetPath(room.id, a.id)]));
      this.add({ prepared: preparedFromTrpg(t), source: { kind: 'room', fileName: room.title }, images });
      n++;
    }
    fs.writeFileSync(mark, String(Date.now()));
    return n;
  }
}
