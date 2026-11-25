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

export function speakerTag(room: Room, m: Message) {
  if (m.role === 'human') return `【${humanLabel(room)}】`;
  if (m.role === 'system') return m.kind === 'roll' ? '【骰子】' : '【系统】';
  return `【${m.speakerName}】`;
}

export function bodyOf(m: Message) {
  const text = m.content.trim();
  return m.status === 'interrupted' ? `${text}……（发言被打断）` : text;
}

/** 参与生成上下文的消息：去掉出错和空的 */
export function usableHistory(messages: Message[]) {
  return messages.filter(
    (m) => m.status !== 'error' && m.status !== 'streaming' && m.content.trim() !== '',
  );
}

/**
 * 提示缓存：一个 AI 生成某条消息时，最后一条消息的原文、模型的原话和当时附上的状态。
 * 拼历史时把它们原样放回去，这一轮的请求就是「上一轮的请求 + 模型的回复 + 新内容」。
 * Magpie 发现历史和上一轮对不上时会新开会话、重放上下文，缓存就全部失效。
 */
export interface SentTurn {
  /** 当时最后一条 user 消息的全文（那段历史 + 附在末尾的状态和提醒） */
  prompt: string;
  /** 模型的原话（还没去掉名字前缀、替别人说的话等） */
  reply: string;
  /** 处理完存进消息的正文；之后被编辑过就改用编辑后的内容 */
  content: string;
  /** 当时附上的状态（每一部分的全文），以及附的是完整状态还是只有变化的部分 */
  state?: Record<string, string>;
  full?: boolean;
}

export interface PromptCache {
  sentFor(m: Message): SentTurn | undefined;
}

/** 构建请求时顺便记下：最后一条消息的原文、这次附上的状态 */
export interface BuildOut {
  prompt?: string;
  state?: Record<string, string>;
  full?: boolean;
}

/** 很多接口要求 user / assistant 交替出现，同一方连续的消息合并成一条 */
export function turnBuilder(cache?: PromptCache) {
  const turns: ChatMessage[] = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  };
  // 状态链：从最近一次完整状态开始，之后每一轮的状态更新都原样留在历史里，才能只发变化的部分
  let chain: Record<string, string> | undefined;
  /** 自己说过的话：把生成它时最后那条消息的原文和模型的原话放回去 */
  const own = (m: Message, content: string) => {
    const sent = cache?.sentFor(m);
    if (!sent) {
      chain = undefined;
      push('assistant', content);
      return;
    }
    const last = turns[turns.length - 1];
    let restored = false;
    if (last?.role === 'user' && sent.prompt.startsWith(last.content)) {
      last.content = sent.prompt;
      restored = true;
    } else if (!last || last.role === 'assistant') {
      // 当时插了一句「（请继续）」之类的
      turns.push({ role: 'user', content: sent.prompt });
      restored = true;
    }
    // 对不上（中间的消息被编辑或删除过）：这一轮的状态更新不在历史里了，下一次发完整状态
    chain = restored && sent.state && (sent.full || chain) ? sent.state : undefined;
    push('assistant', m.content === sent.content ? sent.reply : content);
  };
  return { turns, push, own, baseline: () => chain };
}

/**
 * 附在最后的状态：第一次（或者历史里的状态链断了）发完整的，之后只发有变化的部分。
 * sections 是 [key, 带标题的全文]；返回要附上的文字和这次的状态。
 */
export function stateTail(
  sections: [string, string][],
  baseline: Record<string, string> | undefined,
  labels: { full: string; diff: string; same: string },
  sep = '\n',
) {
  const state = Object.fromEntries(sections);
  const join = (parts: string[]) => parts.filter(Boolean).join(sep);
  if (!sections.length) return { text: '', state, full: true };
  if (!baseline) return { text: join([labels.full, ...sections.map(([, t]) => t)]), state, full: true };
  const changed = sections.filter(([k, t]) => baseline[k] !== t).map(([, t]) => t);
  const removed = Object.keys(baseline).filter((k) => !(k in state));
  if (!changed.length && !removed.length) return { text: labels.same, state, full: false };
  const gone = removed.map((k) => `${baseline[k].split('\n')[0].replace(/[：:]$/, '')}：已经没有了`);
  return { text: join([labels.diff, ...changed, ...gone]), state, full: false };
}

/** 拟人模式唯一的提示词 */
export const HUMANLIKE_PROMPT = '你是一个真实的人，正在和另一个真实的人聊天。请像真人一样和对方自然地对话。';

/**
 * 拟人模式：只告诉模型它是真人、在和真人聊天，不加任何多人对话规则、名字标签或提醒。
 * 只有当对方不止一个人时，才在消息前加上说话人的名字，否则模型分不清谁在说话。
 * 名字从第二个人第一次开口时开始加，之前的消息不回头改（历史保持不变，提示缓存才能命中）。
 */
export function buildHumanlikeMessages(room: Room, self: Participant, history: Message[], cache?: PromptCache, out?: BuildOut): ChatMessage[] {
  const usable = usableHistory(history).filter((m) => m.role !== 'system');
  const isSelf = (m: Message) => m.role === 'ai' && m.participantId === self.id;
  // 第二个人开口以后，从那条消息起都带名字；之前的消息保持原样（不回头补名字，历史不变，提示缓存才能命中）
  const seen = new Set<string>();
  const { turns, push, own } = turnBuilder(cache);
  for (const m of usable) {
    const text = m.status === 'interrupted' ? `${m.content.trim()}……` : m.content.trim();
    if (isSelf(m)) {
      own(m, text);
      continue;
    }
    seen.add(m.role === 'human' ? '#human' : (m.participantId ?? m.speakerName));
    push('user', seen.size > 1 ? `${m.role === 'human' ? room.settings.humanName : m.speakerName}：${text}` : text);
  }
  if (turns.length === 0 || turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '（对话开始）' });
  if (turns[turns.length - 1].role === 'assistant') turns.push({ role: 'user', content: '（继续）' });
  if (out) out.prompt = turns[turns.length - 1].content;
  const system = self.persona.trim() ? `${HUMANLIKE_PROMPT}\n\n${self.persona.trim()}` : HUMANLIKE_PROMPT;
  return [{ role: 'system', content: system }, ...turns];
}

/** 为某个 AI 构建完整的请求消息 */
export function buildAgentMessages(room: Room, self: Participant, history: Message[], cache?: PromptCache, out?: BuildOut): ChatMessage[] {
  if (room.settings.promptMode === 'humanlike') return buildHumanlikeMessages(room, self, history, cache, out);
  const { turns, push, own } = turnBuilder(cache);

  for (const m of usableHistory(history)) {
    if (m.role === 'ai' && m.participantId === self.id) own(m, bodyOf(m));
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
  if (out) out.prompt = turns[turns.length - 1].content;

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
