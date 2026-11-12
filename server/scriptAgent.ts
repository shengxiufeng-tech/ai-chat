// 剧本整理助手（agent）：让一个能看图的模型用工具把 PDF 剧本整理成守秘人能用的资料。
//
// 程序先把 PDF 的每一页拆成「文字层 + 整页图片」（在浏览器里完成），这里给模型一组工具：
// 读文字、看页面、放大局部、裁切保存手出物 / 地图、给页面分类、转写图片页、写入结果、录入预设调查员。
// 模型每一步调用工具，程序执行后把结果交回，直到它调用 finish 或者步数用完。
// 看过的图片在之后的步骤里换成一句说明，避免上下文越滚越大。模型不支持工具调用时改用固定流程。

import fs from 'node:fs';
import path from 'node:path';
import { buildSheet, resolveTarget, type CharKey, type Characteristics, type InvestigatorSheet } from '../shared/coc.ts';
import {
  DEFAULT_EXCLUDED,
  PAGE_CATEGORY_LABELS,
  type AssetKind,
  type PageCategory,
  type PreparedScript,
  type ScriptAsset,
  type TokenUsage,
} from '../shared/types.ts';
import { crop, decodeJpeg, encodeJpeg, fit, jpegDataUrl, normalizeBox, type Box } from './images.ts';
import { chatWithTools, completeChat, ToolsUnsupportedError, type AgentMessage, type ChatPart, type ToolCall, type ToolDef } from './llm.ts';
import { classifyEra, parseSections } from './scripts.ts';

// ---------------- 工作区 ----------------

export type Field = 'title' | 'era' | 'intro' | 'player_info' | 'keeper_brief' | 'glossary';
export const FIELD_LABELS: Record<Field, string> = {
  title: '标题',
  era: '时代背景',
  intro: '玩家简介',
  player_info: '开团须知',
  keeper_brief: '守秘人速览',
  glossary: '译名表',
};

export interface PageData {
  page: number;
  text: string;
  chars: number;
  /** 这一页画了几张图片（pdf.js 统计） */
  images: number;
  category?: PageCategory;
  /** 图片页的转写 */
  transcription?: string;
}

export interface AssetRecord extends ScriptAsset {
  file: string;
  box: Box;
}

export interface Workspace {
  /** 导入目录：page-<n>.jpg、asset-<id>.jpg */
  dir: string;
  fileName: string;
  pages: PageData[];
  fields: Partial<Record<Field, string>>;
  assets: AssetRecord[];
  pregens: InvestigatorSheet[];
  /** 看过的页面 */
  seen: number[];
  /** 用了固定流程 */
  fallback?: boolean;
  warning?: string;
}

export const pageFile = (dir: string, page: number) => path.join(dir, `page-${page}.jpg`);
/** 文字很少的页面多半是图片（扫描页、地图、手出物、调查员卡、插图） */
export const isImagePage = (p: PageData) => p.chars < 300 || (p.images > 0 && p.chars < 1500);

// ---------------- 工具 ----------------

const BOX_PROPS = {
  left: { type: 'number', description: '左边，0~1000（相对整页宽度）' },
  top: { type: 'number', description: '上边，0~1000（相对整页高度）' },
  right: { type: 'number', description: '右边，0~1000' },
  bottom: { type: 'number', description: '下边，0~1000' },
};

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOLS: ToolDef[] = [
  tool('read_text', '读取页面的文字层。可以一次读一个范围，例如 "18-25" 或 "3,5,7-9"。', { pages: { type: 'string' } }, ['pages']),
  tool('view_page', '查看一页的整页图片（扫描页、地图、手出物、调查员卡都要看图才知道内容）。', { page: { type: 'integer' } }, ['page']),
  tool('zoom', '放大查看一页里的某个区域（看清地图上的小字、手出物的细节）。', { page: { type: 'integer' }, ...BOX_PROPS }, ['page', 'left', 'top', 'right', 'bottom']),
  tool(
    'save_image',
    '把一页里的某个区域裁下来保存成手出物或地图。保存后会把裁好的图给你确认。',
    {
      page: { type: 'integer' },
      ...BOX_PROPS,
      kind: { type: 'string', enum: ['map', 'handout', 'image'] },
      visibility: { type: 'string', enum: ['keeper', 'player'], description: 'keeper：只有守秘人能看；player：可以展示给玩家' },
      title: { type: 'string', description: '简短的中文名称，守秘人用它来展示，例如「旧报纸剪报」「宅邸一楼平面图」' },
      description: {
        type: 'string',
        description: '给守秘人的中文说明。地图：区域、房间、连通关系、标注文字、比例；手出物：完整的文字内容，以及剧本里说什么情况下交给玩家',
      },
    },
    ['page', 'left', 'top', 'right', 'bottom', 'kind', 'visibility', 'title', 'description'],
  ),
  tool('adjust_image', '重新裁切一张已经保存的图片（边框不完整、切掉了内容时用）。', { id: { type: 'string' }, ...BOX_PROPS }, ['id', 'left', 'top', 'right', 'bottom']),
  tool('delete_image', '删除一张保存错了的图片。', { id: { type: 'string' } }, ['id']),
  tool(
    'set_pages',
    '给页面分类，决定哪些页面交给守秘人。',
    {
      pages: { type: 'string', description: '例如 "1-17" 或 "34,36"' },
      category: { type: 'string', enum: Object.keys(PAGE_CATEGORY_LABELS), description: Object.entries(PAGE_CATEGORY_LABELS).map(([k, v]) => `${k}=${v}`).join('，') },
    },
    ['pages', 'category'],
  ),
  tool('transcribe', '把图片页（扫描版正文、调查员卡、手出物等）上的文字转写下来，交给守秘人。会覆盖这一页之前的转写。', { page: { type: 'integer' }, text: { type: 'string' } }, ['page', 'text']),
  tool(
    'write',
    '写入整理结果的一项（会覆盖之前写的）。',
    { field: { type: 'string', enum: Object.keys(FIELD_LABELS), description: Object.entries(FIELD_LABELS).map(([k, v]) => `${k}=${v}`).join('，') }, content: { type: 'string' } },
    ['field', 'content'],
  ),
  tool(
    'add_pregen',
    '录入一位剧本自带的预设调查员。技能名用中文（侦查、聆听、图书馆使用……），只写比基础值高的技能也可以。',
    {
      name: { type: 'string' },
      occupation: { type: 'string' },
      age: { type: 'integer' },
      gender: { type: 'string' },
      characteristics: {
        type: 'object',
        description: '属性：STR 力量、CON 体质、SIZ 体型、DEX 敏捷、APP 外貌、INT 智力、POW 意志、EDU 教育',
        properties: Object.fromEntries(['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'].map((k) => [k, { type: 'integer' }])),
      },
      luck: { type: 'integer' },
      hp: { type: 'integer' },
      mp: { type: 'integer' },
      san: { type: 'integer' },
      skills: { type: 'object', description: '技能名 → 技能值', additionalProperties: { type: 'integer' } },
      items: { type: 'array', items: { type: 'string' } },
      backstory: { type: 'string' },
    },
    ['name', 'characteristics'],
  ),
  tool('finish', '全部整理完以后调用。', { summary: { type: 'string', description: '一句话说明整理了什么（不会给玩家看）' } }, ['summary']),
];

/** "18-25"、"3,5,7-9"、[1,2]、7 → 页码列表 */
export function parsePages(input: unknown, max: number): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    if (Number.isInteger(n) && n >= 1 && n <= max) out.add(n);
  };
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，、\s]+/);
  for (const part of list) {
    const m = String(part).match(/^(\d+)\s*[-~—–到至]\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (let n = a; n <= Math.min(b, a + 1000); n++) add(n);
    } else if (/^\d+$/.test(String(part).trim())) add(Number(part));
  }
  return [...out].sort((a, b) => a - b);
}

/** 页码列表 → "1-3、5" */
export function rangeText(pages: number[]) {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return parts.join('、');
}

const VIEW_SIDE = 1400;
const ASSET_SIDE = 1800;
const CONFIRM_SIDE = 1000;
const READ_LIMIT = 40_000;
/** 一步最多带几张图片（一次要看很多页时，多出来的下一步再看） */
export const MAX_IMAGES_PER_STEP = 6;

/** 一个可以发给模型的图片 */
interface ImageOut {
  label: string;
  buf: Buffer;
}

export interface ToolResult {
  text: string;
  images?: ImageOut[];
  /** 进度里显示的一句话（不剧透） */
  activity?: string;
  finished?: boolean;
}

const pageImageCache = new Map<string, ReturnType<typeof decodeJpeg>>();
function loadPage(ws: Workspace, page: number) {
  const file = pageFile(ws.dir, page);
  let img = pageImageCache.get(file);
  if (!img) {
    if (!fs.existsSync(file)) throw new Error(`第 ${page} 页没有图片`);
    img = decodeJpeg(fs.readFileSync(file));
    // 只缓存最近几页，避免占太多内存
    if (pageImageCache.size >= 3) pageImageCache.delete(pageImageCache.keys().next().value!);
    pageImageCache.set(file, img);
  }
  return img;
}

let assetSeq = 0;
const newAssetId = () => `a${Date.now().toString(36)}${(assetSeq++).toString(36)}`;

function toCharacteristics(input: unknown): Characteristics {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const keys: CharKey[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];
  return Object.fromEntries(keys.map((k) => [k, Math.max(1, Math.min(200, Math.round(Number(o[k]) || 50)))])) as Characteristics;
}

/** 把模型录入的预设调查员变成完整的角色卡（没写的技能用基础值） */
export function pregenSheet(a: Record<string, unknown>, era: '1920s' | 'modern'): InvestigatorSheet {
  const characteristics = toCharacteristics(a.characteristics);
  const sheet = buildSheet({
    name: String(a.name ?? '').trim() || '预设调查员',
    occupation: String(a.occupation ?? '').trim() || '调查员',
    age: Math.round(Number(a.age)) || 30,
    gender: String(a.gender ?? ''),
    backstory: String(a.backstory ?? ''),
    characteristics,
    luck: Math.round(Number(a.luck)) || 50,
    allocation: {},
    items: Array.isArray(a.items) ? a.items.map(String).filter(Boolean) : [],
    era,
  });
  const skills = a.skills && typeof a.skills === 'object' ? (a.skills as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(skills)) {
    const value = Math.round(Number(v));
    if (!Number.isFinite(value) || value <= 0) continue;
    const t = resolveTarget(sheet, name);
    sheet.skills[t.found ? t.name : name.trim()] = Math.min(99, value);
  }
  const pool = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined);
  const hp = pool(a.hp);
  const mp = pool(a.mp);
  const san = pool(a.san);
  if (hp) sheet.hp = { current: hp, max: hp };
  if (mp) sheet.mp = { current: mp, max: mp };
  if (san) sheet.san = { ...sheet.san, current: san, start: san };
  return sheet;
}

export function execTool(ws: Workspace, call: ToolCall): ToolResult {
  let a: Record<string, unknown>;
  try {
    a = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { text: '参数不是合法的 JSON，请重新调用。' };
  }
  const max = ws.pages.length;
  const pageOf = (v: unknown) => {
    const n = Math.round(Number(v));
    if (!(n >= 1 && n <= max)) throw new Error(`页码 ${v} 不存在（共 ${max} 页）`);
    return n;
  };
  const boxOf = (o: Record<string, unknown>) => normalizeBox(o as Partial<Box>);

  try {
    switch (call.name) {
      case 'read_text': {
        const pages = parsePages(a.pages, max);
        if (!pages.length) return { text: `没有找到这些页：${a.pages}（共 ${max} 页）` };
        let out = '';
        const done: number[] = [];
        for (const n of pages) {
          const p = ws.pages[n - 1];
          const body = p.text.trim() || '（这一页没有文字层，可能是图片，用 view_page 查看）';
          if (out.length + body.length > READ_LIMIT && done.length) break;
          out += `【第 ${n} 页】\n${body}\n\n`;
          done.push(n);
        }
        const rest = pages.filter((n) => !done.includes(n));
        if (rest.length) out += `（一次读太多了，第 ${rangeText(rest)} 页还没读，请再调用一次）`;
        return { text: out.trim(), activity: `读取第 ${rangeText(done)} 页的文字` };
      }
      case 'view_page': {
        const n = pageOf(a.page);
        const img = fit(loadPage(ws, n), VIEW_SIDE);
        if (!ws.seen.includes(n)) ws.seen.push(n);
        const p = ws.pages[n - 1];
        return {
          text: `第 ${n} 页的图片在下一条消息里（这一页的文字层有 ${p.chars} 字）。`,
          images: [{ label: `第 ${n} 页：`, buf: encodeJpeg(img, 80) }],
          activity: `查看第 ${n} 页`,
        };
      }
      case 'zoom': {
        const n = pageOf(a.page);
        const img = fit(crop(loadPage(ws, n), boxOf(a)), VIEW_SIDE);
        return { text: `第 ${n} 页放大后的区域在下一条消息里。`, images: [{ label: `第 ${n} 页（局部）：`, buf: encodeJpeg(img, 85) }], activity: `放大查看第 ${n} 页的局部` };
      }
      case 'save_image': {
        const n = pageOf(a.page);
        const box = boxOf(a);
        const kind = (['map', 'handout', 'image'].includes(String(a.kind)) ? a.kind : 'image') as AssetKind;
        const img = fit(crop(loadPage(ws, n), box), ASSET_SIDE);
        const id = newAssetId();
        const file = path.join(ws.dir, `asset-${id}.jpg`);
        fs.writeFileSync(file, encodeJpeg(img, 88));
        ws.assets.push({
          id,
          kind,
          title: String(a.title ?? '').trim() || (kind === 'map' ? '地图' : kind === 'handout' ? '手出物' : '图片'),
          description: String(a.description ?? '').trim(),
          visibility: a.visibility === 'player' ? 'player' : 'keeper',
          page: n,
          width: img.width,
          height: img.height,
          file,
          box,
        });
        return {
          text: `已保存为 ${id}。裁好的图在下一条消息里：请确认四边完整、没有切掉文字或图例；不对就用 adjust_image 调整，保存错了用 delete_image。`,
          images: [{ label: `裁好的 ${id}：`, buf: encodeJpeg(fit(img, CONFIRM_SIDE), 80) }],
          activity: kind === 'map' ? '保存了一张地图' : kind === 'handout' ? '保存了一份手出物' : '保存了一张图片',
        };
      }
      case 'adjust_image': {
        const asset = ws.assets.find((x) => x.id === a.id);
        if (!asset) return { text: `没有 id 为 ${a.id} 的图片` };
        const box = boxOf(a);
        const img = fit(crop(loadPage(ws, asset.page), box), ASSET_SIDE);
        fs.writeFileSync(asset.file, encodeJpeg(img, 88));
        Object.assign(asset, { box, width: img.width, height: img.height });
        return {
          text: `已重新裁切 ${asset.id}，新的图在下一条消息里，请再确认一次。`,
          images: [{ label: `重新裁好的 ${asset.id}：`, buf: encodeJpeg(fit(img, CONFIRM_SIDE), 80) }],
          activity: '调整了一张图片的裁切',
        };
      }
      case 'delete_image': {
        const i = ws.assets.findIndex((x) => x.id === a.id);
        if (i < 0) return { text: `没有 id 为 ${a.id} 的图片` };
        fs.rmSync(ws.assets[i].file, { force: true });
        ws.assets.splice(i, 1);
        return { text: `已删除 ${a.id}。`, activity: '删掉了一张裁错的图片' };
      }
      case 'set_pages': {
        const pages = parsePages(a.pages, max);
        const category = String(a.category) as PageCategory;
        if (!(category in PAGE_CATEGORY_LABELS)) return { text: `没有这个分类：${a.category}` };
        for (const n of pages) ws.pages[n - 1].category = category;
        return { text: `第 ${rangeText(pages)} 页 → ${PAGE_CATEGORY_LABELS[category]}`, activity: `给第 ${rangeText(pages)} 页分类` };
      }
      case 'transcribe': {
        const n = pageOf(a.page);
        const text = String(a.text ?? '').trim();
        ws.pages[n - 1].transcription = text || undefined;
        return { text: `已记下第 ${n} 页的转写（${text.length} 字）。`, activity: `转写第 ${n} 页` };
      }
      case 'write': {
        const field = String(a.field) as Field;
        if (!(field in FIELD_LABELS)) return { text: `没有这一项：${a.field}` };
        ws.fields[field] = String(a.content ?? '').trim();
        return { text: `已写入${FIELD_LABELS[field]}。`, activity: `写入${FIELD_LABELS[field]}` };
      }
      case 'add_pregen': {
        const era = classifyEra(ws.fields.era ?? '');
        const sheet = pregenSheet(a, era);
        const i = ws.pregens.findIndex((x) => x.name === sheet.name);
        if (i >= 0) ws.pregens[i] = sheet;
        else ws.pregens.push(sheet);
        return { text: `已录入预设调查员「${sheet.name}」（${sheet.occupation}）。`, activity: '录入了一位预设调查员' };
      }
      case 'finish':
        return { text: '好的。', finished: true, activity: '整理完成' };
      default:
        return { text: `没有这个工具：${call.name}` };
    }
  } catch (err) {
    return { text: `出错了：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------- 提示词 ----------------

export const AGENT_PROMPT = `你是「剧本整理助手」，帮一个跑团应用把一份《克苏鲁的呼唤》（COC）剧本 PDF 整理成守秘人（由 AI 扮演）能用的资料。玩家不想被剧透：只有「标题」「时代背景」「玩家简介」「开团须知」会给玩家看，其他一切只给守秘人。

你可以调用工具，一次可以调用多个（比如一次查看几页）。建议的步骤：
1. 看下面的页面目录，用 read_text 读文字多的页面（一次读一个范围），弄清楚哪些是剧本、哪些是规则介绍、版权、广告、目录等。
2. 用 set_pages 给每一页分类。规则介绍、版权页、广告、目录、空白页不需要交给守秘人；剧本正文、手出物、地图、预设调查员要交给守秘人。
3. 文字很少或者带图片的页面，用 view_page 看一眼：
   - 扫描版的正文、表格：用 transcribe 完整转写，保留标题层级。
   - 地图：用 save_image 裁下来（kind=map），description 里写清楚区域、房间、连通关系、标注文字、比例和重要地点；给守秘人的写 keeper，剧本说可以给玩家看的写 player。
   - 手出物（剧本里要交给玩家的信件、剪报、日记、照片、图纸等）：用 save_image 裁下来（kind=handout，visibility=player），description 里写完整的文字内容，以及剧本里说在什么情况下交给玩家。
   - 预设调查员（角色卡）：用 add_pregen 录入；卡片上的文字也可以 transcribe。
   - 纯装饰的插图不用保存，分类成 art。
   看不清可以先用 zoom 放大。save_image 之后会把裁好的图给你看，确认四边完整；不对就用 adjust_image 调整，保存错了用 delete_image。
4. 用 write 写下所有字段（要求见下面）。
5. 全部完成后调用 finish。

坐标：区域用 0~1000 的相对坐标，left/top 是左上角，right/bottom 是右下角，相对于整页的宽和高。裁切时四周稍微留一点余量。

各字段的要求：
- title：剧本名称，原文是外文时写中文译名（可以在括号里附原名）。
- era：故事发生的时代和地点，一句话，例如「1920 年代，美国波士顿」。
- intro（玩家简介）：100~250 字的中文，只写开场时调查员已经知道、或者剧本明确写着可以读给玩家听的内容：故事从哪里开始、调查员为什么卷入、第一个目标是什么。绝对不能提到真相、幕后黑手、怪物、NPC 的秘密、关键线索、转折和结局。拿不准的就不要写。
- player_info（开团须知）：开始前可以告诉玩家的非剧透信息，每行一条：推荐人数、游玩时长、难度、推荐的职业或技能、车卡要求、有没有预设调查员。原文没写的就省略。
- keeper_brief（守秘人速览）：给守秘人的中文提纲，1500~5000 字：真相和背景、关键 NPC（动机、秘密、数值要点）、主要地点、线索链（在哪里、怎么获得、指向什么）、场景流程、可能的结局和条件、重要的检定、理智损失和奖励。注明重要信息在原文第几页。
- glossary（译名表）：原文是外文时必须写。人名、地名、组织、物品的原文和中文译名，每行一个，例如「Corbitt → 科比特」。以后守秘人主持时会统一使用这些译名。原文是中文就写「无」。

注意：
- 守秘人会拿到你分类为剧本的页面原文（外文也没关系），所以速览只要写清楚脉络，不用照抄原文。
- 用工具记录结果，不要在回复里复述大段原文。
- view_page 和 zoom 的图片只在接下来几步里保留，看完马上用工具记下需要的信息。`;

export function pageIndex(ws: Workspace) {
  return ws.pages
    .map((p) => {
      const first = p.text.split('\n').map((l) => l.trim()).find((l) => l.length > 1) ?? '';
      return `第 ${p.page} 页：${p.chars} 字${p.images ? `，${p.images} 张图片` : ''}${first ? ` · ${first.slice(0, 40)}` : ''}`;
    })
    .join('\n');
}

// ---------------- 主循环 ----------------

export interface AgentHooks {
  activity: (text: string) => void;
  step: (step: number, maxSteps: number) => void;
  usage: (u: TokenUsage) => void;
  /** 工作区有变化（更新进度里的清单） */
  changed: () => void;
}

export interface AgentOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  sessionId?: string;
  signal: AbortSignal;
  hooks: AgentHooks;
}

export function stepBudget(ws: Workspace) {
  const imagePages = ws.pages.filter(isImagePage).length;
  const textPages = ws.pages.length - imagePages;
  return Math.min(200, 30 + imagePages * 3 + Math.ceil(textPages / 6));
}

/** 只保留最近 keep 条带图片的消息，更早的图片换成一句说明 */
export function compactImages(messages: AgentMessage[], keep = 2) {
  const withImages = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  if (withImages.length <= keep + 3) return; // 攒几条再一起压缩，减少对提示缓存的破坏
  for (const { m, i } of withImages.slice(0, withImages.length - keep)) {
    const parts = (m.content as ChatPart[]).map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: '（这张图片已省略，需要的话可以重新查看）' } : p));
    messages[i] = { role: 'user', content: parts.map((p) => (p as { text: string }).text).join('\n') };
  }
}

const missingFields = (ws: Workspace) => (['intro', 'keeper_brief'] as Field[]).filter((f) => !ws.fields[f]?.trim());

/** 运行整理助手。模型不支持工具调用时自动改用固定流程 */
export function runScriptAgent(ws: Workspace, opts: AgentOptions): Promise<void> {
  return runScriptAgentWith(chatWithTools, ws, opts);
}

/** 同上，可以换掉调用模型的函数（测试用） */
export async function runScriptAgentWith(chat: typeof chatWithTools, ws: Workspace, opts: AgentOptions): Promise<void> {
  const maxSteps = stepBudget(ws);
  const messages: AgentMessage[] = [
    { role: 'system', content: AGENT_PROMPT },
    {
      role: 'user',
      content: `剧本文件：${ws.fileName}，共 ${ws.pages.length} 页。页面目录（字数是文字层的字数；字很少的页面多半是图片，需要 view_page 查看）：\n${pageIndex(ws)}\n\n请开始整理。`,
    },
  ];
  let nudges = 0;
  let finishRejected = 0;
  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal.aborted) throw new DOMException('已取消', 'AbortError');
    opts.hooks.step(step, maxSteps);
    compactImages(messages);
    if (step === maxSteps - 3) {
      messages.push({ role: 'user', content: '（步数快用完了：请马上写完还缺的字段，然后调用 finish。）' });
    }
    let reply;
    try {
      reply = await chat({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        messages,
        tools: TOOLS,
        reasoningEffort: opts.reasoningEffort,
        sessionId: opts.sessionId,
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof ToolsUnsupportedError && step === 1) {
        await runFallback(ws, opts);
        return;
      }
      throw err;
    }
    if (reply.usage) opts.hooks.usage(reply.usage);
    messages.push(reply.message);

    if (!reply.toolCalls.length) {
      // 一开始就不调用工具：多半是不支持工具调用
      if (step <= 2 && !ws.pages.some((p) => p.category) && nudges >= 1) {
        await runFallback(ws, opts);
        return;
      }
      if (++nudges > 3) break;
      messages.push({ role: 'user', content: '请用工具继续整理（可以一次调用多个），全部完成后调用 finish。' });
      continue;
    }

    const images: ImageOut[] = [];
    let finished = false;
    for (const call of reply.toolCalls) {
      let result = execTool(ws, call);
      if (result.images && images.length + result.images.length > MAX_IMAGES_PER_STEP) {
        // 图片太多：这一次不算看过，请它下一步再看
        const page = Number((JSON.parse(call.arguments || '{}') as { page?: unknown }).page);
        if (call.name === 'view_page') ws.seen = ws.seen.filter((n) => n !== page);
        result = { text: `一步最多看 ${MAX_IMAGES_PER_STEP} 张图片，这个请在下一步再调用一次。` };
      }
      if (result.finished) {
        const missing = missingFields(ws);
        if (missing.length && finishRejected < 2) {
          finishRejected++;
          result = { text: `还不能结束：还缺 ${missing.map((f) => FIELD_LABELS[f]).join('、')}，请先用 write 写好。` };
        } else finished = true;
      }
      if (result.activity) opts.hooks.activity(result.activity);
      if (result.images) images.push(...result.images);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
    opts.hooks.changed();
    if (images.length) {
      messages.push({
        role: 'user',
        content: images.flatMap((img) => [
          { type: 'text' as const, text: img.label },
          { type: 'image_url' as const, image_url: { url: jpegDataUrl(img.buf) } },
        ]),
      });
    }
    if (finished) break;
  }
  if (missingFields(ws).length) ws.warning = `整理助手没有写完：缺少${missingFields(ws).map((f) => FIELD_LABELS[f]).join('、')}。守秘人仍然会拿到剧本原文。`;
}

// ---------------- 固定流程（模型不支持工具调用时） ----------------

const PAGE_PROMPT = `你在帮一个跑团应用整理《克苏鲁的呼唤》剧本 PDF。下面是其中一页的图片（以及这一页的文字层，可能为空）。请只输出一个 JSON 对象，不要其他文字：
{
  "category": "scenario | handout | map | pregen | rules | art | other 之一",
  "transcription": "这一页上的文字（扫描页、调查员卡、手出物要完整转写；纯插图写空字符串）",
  "items": [ { "kind": "map 或 handout", "title": "简短中文名", "visibility": "keeper 或 player", "description": "给守秘人的中文说明（地图写区域和标注，手出物写完整内容和什么时候给玩家）", "left": 0, "top": 0, "right": 1000, "bottom": 1000 } ],
  "pregen": null 或 { "name": "", "occupation": "", "age": 30, "characteristics": { "STR": 50, "CON": 50, "SIZ": 50, "DEX": 50, "APP": 50, "INT": 50, "POW": 50, "EDU": 50 }, "luck": 50, "skills": { "侦查": 60 } }
}
坐标是 0~1000 的相对坐标（相对整页宽高）。没有地图和手出物时 items 是空数组。`;

const SUMMARY_PROMPT = `你在帮一个跑团应用整理《克苏鲁的呼唤》剧本。下面是剧本按页整理出的文字。玩家不想被剧透。请严格按下面的格式输出各段（不要其他内容）：

【标题】
剧本名称（外文剧本写中文译名，可附原名）
【时代背景】
一句话，例如「1920 年代，美国波士顿」
【玩家简介】
100~250 字中文，只写开场时调查员已经知道的内容，不能提真相、怪物、NPC 秘密、线索、转折和结局
【开团须知】
推荐人数、时长、推荐职业等非剧透信息，每行一条；没有就写「无」
【守秘人速览】
1500~5000 字中文提纲：真相、关键 NPC、地点、线索链、场景流程、结局、重要检定和理智损失，注明页码
【译名表】
外文剧本的人名地名译名，每行一个「原文 → 译名」；中文剧本写「无」
【跳过的页】
规则介绍、版权、广告、目录等不需要交给守秘人的页码，例如「1-17、50」；没有就写「无」`;

function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function runFallback(ws: Workspace, opts: AgentOptions) {
  ws.fallback = true;
  opts.hooks.activity('这个模型不支持工具调用，改用逐页识别');
  const targets = ws.pages.filter(isImagePage).slice(0, 80);
  const total = targets.length + 1;
  let step = 0;
  for (const p of targets) {
    if (opts.signal.aborted) throw new DOMException('已取消', 'AbortError');
    opts.hooks.step(++step, total);
    opts.hooks.activity(`识别第 ${p.page} 页`);
    const img = encodeJpeg(fit(loadPage(ws, p.page), VIEW_SIDE), 80);
    const text = await completeChat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0.2,
      reasoningEffort: opts.reasoningEffort,
      signal: opts.signal,
      messages: [
        { role: 'system', content: PAGE_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `第 ${p.page} 页。文字层：${p.text.trim() ? p.text.slice(0, 3000) : '（空）'}` },
            { type: 'image_url', image_url: { url: jpegDataUrl(img) } },
          ],
        },
      ],
    });
    if (!ws.seen.includes(p.page)) ws.seen.push(p.page);
    const j = parseJsonObject(text);
    if (!j) continue;
    const cat = String(j.category ?? '');
    if (cat in PAGE_CATEGORY_LABELS) p.category = cat as PageCategory;
    if (typeof j.transcription === 'string' && j.transcription.trim()) p.transcription = j.transcription.trim();
    for (const item of Array.isArray(j.items) ? j.items : []) {
      const r = execTool(ws, { id: 'fallback', name: 'save_image', arguments: JSON.stringify({ ...(item as object), page: p.page }) });
      if (r.activity) opts.hooks.activity(r.activity);
    }
    if (j.pregen && typeof j.pregen === 'object') {
      const r = execTool(ws, { id: 'fallback', name: 'add_pregen', arguments: JSON.stringify(j.pregen) });
      if (r.activity) opts.hooks.activity(r.activity);
    }
    opts.hooks.changed();
  }

  opts.hooks.step(++step, total);
  opts.hooks.activity('汇总整理');
  const body = ws.pages
    .map((p) => {
      const t = (p.transcription ?? p.text).trim();
      return t ? `【第 ${p.page} 页】\n${t}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  const answer = await completeChat({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.2,
    reasoningEffort: opts.reasoningEffort,
    signal: opts.signal,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: body },
    ],
  });
  const sec: Partial<Record<string, string>> = parseSections(answer.replace(/<think>[\s\S]*?<\/think>/g, ''), [
    '标题',
    '时代背景',
    '玩家简介',
    '开团须知',
    '守秘人速览',
    '译名表',
    '跳过的页',
  ]);
  const set = (field: Field, key: string) => {
    const v = (sec[key] ?? '').trim();
    if (v && v !== '无') ws.fields[field] = field === 'title' || field === 'era' ? v.split('\n')[0].trim() : v;
  };
  set('title', '标题');
  set('era', '时代背景');
  set('intro', '玩家简介');
  set('player_info', '开团须知');
  set('keeper_brief', '守秘人速览');
  set('glossary', '译名表');
  const skip = parsePages((sec['跳过的页'] ?? '').replace(/、/g, ','), ws.pages.length);
  for (const n of skip) if (!ws.pages[n - 1].category) ws.pages[n - 1].category = 'rules';
  opts.hooks.changed();
}

// ---------------- 结果 ----------------

/** 没分类的页面：有文字的算剧本正文，没文字的算插图 */
export function categoryOf(p: PageData): PageCategory {
  return p.category ?? (p.chars >= 300 || p.transcription ? 'scenario' : 'art');
}

const stripFile = ({ file: _f, box: _b, ...rest }: AssetRecord): ScriptAsset => rest;

/** 把工作区整理成创建房间用的资料 */
export function assemble(ws: Workspace, excluded: PageCategory[] = DEFAULT_EXCLUDED): PreparedScript {
  const f = ws.fields;
  const eraLabel = (f.era ?? '').trim();
  const included = ws.pages.filter((p) => !excluded.includes(categoryOf(p)));
  const pageTexts = included
    .map((p) => {
      const parts = [p.transcription ? `（图片页转写）\n${p.transcription}` : '', p.text.trim() && !p.transcription ? p.text.trim() : ''];
      if (p.transcription && p.text.trim().length > 200) parts.push(`（文字层）\n${p.text.trim()}`);
      const body = parts.filter(Boolean).join('\n');
      return body ? `【第 ${p.page} 页】\n${body}` : '';
    })
    .filter(Boolean);
  const glossary = f.glossary && f.glossary !== '无' ? f.glossary : '';
  const secret = [
    f.keeper_brief ? `【守秘人速览（整理助手根据原文整理，细节以原文为准）】\n${f.keeper_brief}` : '',
    glossary ? `【译名表（主持时统一使用这些译名）】\n${glossary}` : '',
    `【剧本原文（由玩家导入的 PDF，按页整理；照着这个剧本主持）】\n${pageTexts.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const fallbackTitle = ws.fileName.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{6,}-/, '') || '导入的剧本';
  const missing = missingFields(ws);
  const warning =
    [ws.warning, !ws.warning && missing.length ? `整理结果缺少${missing.map((x) => FIELD_LABELS[x]).join('、')}。` : '', ws.fallback ? '这个模型不支持工具调用，用的是逐页识别的简化流程，手出物和地图可能裁得不准。' : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    title: (f.title ?? '').replace(/^[《「『"“]|[》」』"”]$/g, '').trim() || fallbackTitle,
    eraLabel,
    era: classifyEra(eraLabel),
    intro: f.intro?.trim() || '使用你导入的剧本。',
    playerInfo: f.player_info && f.player_info !== '无' ? f.player_info : '',
    secret,
    chars: pageTexts.join('').length,
    warning,
    assets: ws.assets.map(stripFile),
    pregens: ws.pregens,
    pages: ws.pages.map((p) => ({ page: p.page, category: categoryOf(p) })),
    excluded,
  };
}
