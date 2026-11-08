// 提示词构建：每个 AI 从自己的视角看对话历史

import type { Message, Participant, Room } from '../shared/types.ts';
import type { ChatMessage } from './llm.ts';

const ROLE_LABEL = {
  host: '主持人',
  participant: '参与者',
  observer: '旁观者',
} as const;

const LENGTH_RULE = {
  short: '每次发言简短，一般在 80 字以内，像真人聊天一样一两句话。',
  medium: '每次发言篇幅适中，一般在 250 字以内。',
  long: '可以充分展开论述，但不要无意义地重复。',
} as const;

export function humanLabel(room: Room) {
  return `${room.settings.humanName}（${ROLE_LABEL[room.settings.humanRole]}）`;
}

function describeHuman(room: Room) {
  const name = room.settings.humanName;
  switch (room.settings.humanRole) {
    case 'host':
      return `「${name}」是人类主持人，负责提出话题和引导对话，TA 的指示优先于其他人。`;
    case 'participant':
      return `「${name}」是一位人类参与者，和大家平等交流。`;
    case 'observer':
      return `「${name}」是一位人类旁观者，一般不发言；如果 TA 发言，请认真回应。`;
  }
}

export function buildSystemPrompt(room: Room, self: Participant) {
  const others = room.participants
    .filter((p) => p.id !== self.id)
    .map((p) => `- 「${p.name}」${p.bio ? `：${p.bio}` : ''}`);
  const lines = [
    '你正在参与一场多人对话，参与者里有多位 AI 角色，也有人类。',
    '',
    `【你的身份】你是「${self.name}」。`,
    self.persona.trim() || '（没有额外设定，自然地做你自己即可。）',
    '',
    '【其他参与者】',
    ...(others.length ? others : ['- （暂时没有其他 AI 角色）']),
    `- ${describeHuman(room)}`,
  ];
  if (room.scenario.trim()) {
    lines.push('', '【场景 / 话题】', room.scenario.trim());
  }
  lines.push(
    '',
    '【发言规则】',
    `- 只以「${self.name}」的身份发言，绝不替其他参与者说话，也不要模拟别人的回复。`,
    `- 直接说出你要说的话，开头不要加「${self.name}：」之类的名字前缀。`,
    '- 对话记录中别人的发言会以「【名字】：内容」的形式出现。',
    '- 接住前面的话题自然回应，可以赞同、补充、追问或反驳，避免重复别人已经说过的内容。',
    `- ${LENGTH_RULE[room.settings.replyLength]}`,
  );
  return lines.join('\n');
}

function speakerTag(room: Room, m: Message) {
  if (m.role === 'human') return `【${humanLabel(room)}】`;
  if (m.role === 'system') return '【系统】';
  return `【${m.speakerName}】`;
}

function bodyOf(m: Message) {
  const text = m.content.trim();
  return m.status === 'interrupted' ? `${text}……（发言被打断）` : text;
}

/** 参与生成上下文的消息：去掉出错和空的 */
export function usableHistory(messages: Message[]) {
  return messages.filter(
    (m) => m.status !== 'error' && m.status !== 'streaming' && m.content.trim() !== '',
  );
}

/** 为某个 AI 构建完整的请求消息 */
export function buildAgentMessages(room: Room, self: Participant, history: Message[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = turns[turns.length - 1];
    // 很多接口要求 user / assistant 交替出现，同一方连续的消息合并成一条
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  };

  for (const m of usableHistory(history)) {
    if (m.role === 'ai' && m.participantId === self.id) push('assistant', bodyOf(m));
    else push('user', `${speakerTag(room, m)}：${bodyOf(m)}`);
  }

  if (turns.length === 0) {
    turns.push({ role: 'user', content: '（对话刚刚开始，请你先开口。）' });
  } else {
    if (turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '（对话开始）' });
    if (turns[turns.length - 1].role === 'assistant') {
      turns.push({ role: 'user', content: '（其他人暂时没有说话，请你继续。）' });
    }
  }
  // 结尾提醒一下现在是谁在说话，减少模型"串台"替别人发言
  turns[turns.length - 1].content += `\n\n（现在轮到你「${self.name}」发言）`;

  return [{ role: 'system', content: buildSystemPrompt(room, self) }, ...turns];
}

/** 去掉模型自己加上的名字前缀，如「【苏格拉】：」「苏格拉：」「**苏格拉**:」 */
export function stripNamePrefix(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:\\*\\*)?[【\\[]?${escaped}[】\\]]?(?:\\*\\*)?\\s*[:：]\\s*`);
  return text.replace(re, '').trim();
}

/** 最近一条人类消息里 @ 到的参与者（按出现顺序取第一个） */
export function findMention(text: string, participants: Participant[]): Participant | undefined {
  let best: { p: Participant; index: number } | undefined;
  // 名字长的优先匹配，避免「小王」抢走「小王子」
  const sorted = [...participants].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    const index = text.indexOf(`@${p.name}`);
    if (index >= 0 && (!best || index < best.index)) best = { p, index };
  }
  return best?.p;
}

/** 轮流发言：上一位 AI 发言者的下一位 */
export function pickRoundRobin(room: Room): Participant | undefined {
  const active = room.participants.filter((p) => p.enabled);
  if (active.length === 0) return undefined;
  const lastAi = [...room.messages]
    .reverse()
    .find((m) => m.role === 'ai' && active.some((p) => p.id === m.participantId));
  if (!lastAi) return active[0];
  const idx = active.findIndex((p) => p.id === lastAi.participantId);
  return active[(idx + 1) % active.length];
}

/** 如果最新一条消息是人类发的并且 @ 了某人，就让那个人接话 */
export function pickByMention(room: Room): Participant | undefined {
  const last = usableHistory(room.messages).at(-1);
  if (!last || last.role !== 'human') return undefined;
  return findMention(last.content, room.participants);
}

/** AI 主持人挑选下一位发言者的提示词 */
export function buildModeratorMessages(room: Room): ChatMessage[] {
  const active = room.participants.filter((p) => p.enabled);
  const recent = usableHistory(room.messages)
    .slice(-16)
    .map((m) => {
      const text = bodyOf(m).replace(/\s+/g, ' ');
      return `${speakerTag(room, m)}：${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    });
  const lastAi = [...room.messages].reverse().find((m) => m.role === 'ai');
  const system = [
    '你是一场多人对话的幕后调度员，负责决定下一位发言者，让对话自然、有来有回。',
    '原则：',
    '- 如果有人被点名、被提问或被反驳，优先让 TA 回应。',
    '- 避免同一个人连续发言，也不要让某个人长期沉默。',
    '- 人类的问题指向谁，就让谁回答。',
    '只输出下一位发言者的名字，不要输出任何其他内容。',
  ].join('\n');
  const user = [
    room.scenario.trim() ? `场景：${room.scenario.trim()}\n` : '',
    '候选发言者：',
    ...active.map((p) => `- 「${p.name}」${p.bio ? `：${p.bio}` : ''}`),
    '',
    lastAi ? `上一位 AI 发言者：${lastAi.speakerName}` : '还没有 AI 发言过。',
    '',
    '最近的对话：',
    ...(recent.length ? recent : ['（暂无）']),
    '',
    '下一位发言者是谁？只输出名字。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 从主持人的回答中解析出参与者 */
export function parseModeratorChoice(output: string, room: Room): Participant | undefined {
  const active = room.participants.filter((p) => p.enabled);
  const text = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const exact = active.find((p) => text.replace(/[「」"'“”*\s。.]/g, '') === p.name);
  if (exact) return exact;
  let best: { p: Participant; index: number } | undefined;
  for (const p of [...active].sort((a, b) => b.name.length - a.name.length)) {
    const index = text.indexOf(p.name);
    if (index >= 0 && (!best || index < best.index)) best = { p, index };
  }
  return best?.p;
}
