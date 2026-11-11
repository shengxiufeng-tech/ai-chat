// 导入剧本：从文件里提取文字，再用 AI 把「玩家可以看的」和「只有守秘人能看的」分开，玩家全程不会被剧透

import WordExtractor from 'word-extractor';
import type { Era } from '../shared/coc.ts';
import type { PreparedScript } from '../shared/types.ts';
import { completeChat } from './llm.ts';

/** 原文太长时只取前面这么多字（约 8 万 token），避免超出模型上下文 */
export const MAX_SCRIPT_CHARS = 120_000;

/** 解码文本文件：先试 UTF-8，乱码多的话按 GB18030（GBK）解码，中文 txt 很常见 */
export function decodeText(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0 || bad < utf8.length / 1000) return utf8;
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return utf8;
  }
}

/** 整理提取出来的文字：统一换行、去掉控制字符和多余空行 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\f\v\u0000-\u0008\u000E-\u001F]/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t　]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从上传的文件里提取文字：支持 .txt .md .doc .docx */
export async function extractScriptText(name: string, data: Buffer): Promise<string> {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').trim();
  if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === '') return cleanText(decodeText(data));
  if (ext === 'doc' || ext === 'docx') {
    const doc = await new WordExtractor().extract(data);
    const parts = [doc.getBody(), doc.getFootnotes?.(), doc.getEndnotes?.()].filter((x): x is string => !!x && !!x.trim());
    return cleanText(parts.join('\n\n'));
  }
  if (ext === 'pdf') throw new Error('暂时不支持 PDF：可以用 WPS / Word 另存为 .docx 或 .txt 后再导入');
  throw new Error(`不支持 .${ext} 文件，请用 .txt、.md、.doc 或 .docx`);
}

/** 根据时代描述判断用哪套技能（现代有「计算机使用」「电子学」） */
export function classifyEra(label: string): Era {
  const t = label.trim();
  if (!t) return '1920s';
  if (/现代|当代|近未来|未来|网络|互联网|手机|智能|21\s*世纪|20[0-9]{2}|19[6-9][0-9]/.test(t)) return 'modern';
  return '1920s';
}

const SECTION_NAMES = ['标题', '时代背景', '玩家简介', '开团须知', '守秘人速览'] as const;
type Section = (typeof SECTION_NAMES)[number];

/** 解析 AI 按【标题】【时代背景】…… 分段的回答 */
export function parseSections(text: string): Partial<Record<Section, string>> {
  const out: Partial<Record<Section, string>> = {};
  const re = new RegExp(`【(${SECTION_NAMES.join('|')})】`, 'g');
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body) out[m[1] as Section] = body;
  });
  return out;
}

const ORGANIZER_PROMPT = `你是 COC（克苏鲁的呼唤）跑团的剧本整理助手。用户是要扮演调查员的玩家，绝对不能被剧透。
你会收到一份剧本的原始文字，里面可能夹杂着封面、作者和译者信息、改动说明、规则说明、配图说明、给守秘人的提示、游玩记录、通关流程等。
请把内容分成「玩家可以看的」和「只有守秘人能看的」两部分，严格按下面的格式输出，不要输出其他内容：

【标题】
剧本的名字（只写名字）
【时代背景】
一句话写清故事发生的年代和地点，例如「1920 年代，美国马萨诸塞州的海边小镇」「现代日本，深夜的东京地铁」
【玩家简介】
给玩家看的开场简介，2~4 句、150 字以内，用「你」称呼玩家，只写调查员一开始就知道的事（比如为什么来到这里、受谁委托）。绝不能透露真相、怪物、幕后黑手、关键线索、结局或任何会让玩家提前知道剧情走向的内容；拿不准的就不写。
【开团须知】
开始前可以告诉玩家的非剧透信息，每行一条，比如推荐人数、游玩时长、难度、推荐的技能或职业、车卡要求和限制。原文没写的就省略这一项，写「无」。
【守秘人速览】
给守秘人的简明提纲（300~800 字）：真相与幕后、主要场景和顺序、关键线索、重要 NPC、理智检定、结局与达成条件，以及原文里给守秘人的重要提示。`;

/** 用 AI 整理剧本；失败时退回到原文（标题取第一行） */
export async function prepareScript(
  text: string,
  opts: { baseUrl: string; apiKey: string; model: string; fileName?: string },
): Promise<PreparedScript> {
  const source = text.length > MAX_SCRIPT_CHARS ? text.slice(0, MAX_SCRIPT_CHARS) : text;
  const fallbackTitle =
    opts.fileName?.replace(/\.[^.]+$/, '').trim() ||
    source.split('\n')[0]?.replace(/^[#\s【]+|[】\s]+$/g, '').slice(0, 24) ||
    '自定义剧本';
  const base: PreparedScript = {
    title: fallbackTitle,
    eraLabel: '',
    era: '1920s',
    intro: '使用你导入的剧本。',
    playerInfo: '',
    secret: `【剧本原文（由玩家导入，按照这个剧本主持）】\n${source}`,
    chars: text.length,
    truncated: text.length > MAX_SCRIPT_CHARS,
  };
  if (!opts.model) return { ...base, warning: '没有可用的模型，未能自动整理，已直接使用原文。' };
  let answer: string;
  try {
    answer = await completeChat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0.2,
      sessionId: `ai-chat-script-${Date.now()}`,
      messages: [
        { role: 'system', content: ORGANIZER_PROMPT },
        { role: 'user', content: `剧本原文如下：\n\n${source}` },
      ],
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    return { ...base, warning: `自动整理失败（${err instanceof Error ? err.message : String(err)}），已直接使用原文。` };
  }
  const sec = parseSections(answer.replace(/<think>[\s\S]*?<\/think>/g, ''));
  if (!sec['守秘人速览'] && !sec['玩家简介']) {
    return { ...base, warning: '自动整理的结果格式不对，已直接使用原文。' };
  }
  const eraLabel = (sec['时代背景'] ?? '').split('\n')[0].trim();
  const info = (sec['开团须知'] ?? '').trim();
  return {
    ...base,
    title: (sec['标题'] ?? '').split('\n')[0].replace(/^[《「『"“]|[》」』"”]$/g, '').trim() || fallbackTitle,
    eraLabel,
    era: classifyEra(eraLabel),
    intro: sec['玩家简介']?.trim() || base.intro,
    playerInfo: info === '无' ? '' : info,
    secret: [
      sec['守秘人速览'] ? `【守秘人速览（AI 根据原文整理，细节以原文为准）】\n${sec['守秘人速览']}` : '',
      `【剧本原文（由玩家导入，按照这个剧本主持）】\n${source}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
