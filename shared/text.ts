// 文本处理：前后端共用

import type { Room } from './types.ts';

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 除了自己以外，对话里其他人的名字（AI 角色、调查员、人类玩家） */
export function otherSpeakerNames(room: Room, selfId: string): string[] {
  const names = new Set<string>();
  for (const p of room.participants) {
    if (p.id === selfId) continue;
    names.add(p.name);
    const sheet = room.trpg?.sheets[p.id];
    if (sheet) names.add(sheet.name);
  }
  names.add(room.settings.humanName);
  const player = room.trpg?.sheets.player;
  if (player) names.add(player.name);
  if (room.mode === 'trpg') names.add('玩家');
  return [...names].map((n) => n.trim()).filter(Boolean);
}

/**
 * 去掉 AI 替别人写的发言：以「【某人】：」「【某人（AI 队友）】：」这类标签开头的行，
 * 连同同一段落里紧跟着的行一起去掉（某人是其他参与者）。
 * 只认这种带括号标签的格式（也就是对话记录里别人发言的格式），正常叙述里提到别人不受影响。
 */
export function stripImpersonation(text: string, names: string[]): { text: string; removed: string } {
  const valid = names.filter((n) => n.length > 0);
  if (valid.length === 0 || !/[【[]/.test(text)) return { text, removed: '' };
  const alt = valid
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const tag = new RegExp(`^\\s*(?:\\*\\*)?[【\\[]\\s*(?:${alt})\\s*(?:[（(][^）)\\n]*[）)])?\\s*[】\\]](?:\\*\\*)?\\s*[:：]`);
  const kept: string[] = [];
  const removed: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (tag.test(line)) {
      skipping = true;
      removed.push(line);
    } else if (skipping && line.trim() !== '') {
      removed.push(line);
    } else {
      skipping = false;
      kept.push(line);
    }
  }
  if (removed.length === 0) return { text, removed: '' };
  return {
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removed: removed.join('\n').trim(),
  };
}
