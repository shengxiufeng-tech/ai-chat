// 上下文长度管理：估算 token，按模型的上下文窗口裁掉最早的对话

import type { Message } from '../shared/types.ts';
import type { ChatPart, WireMessage } from './llm.ts';

/** 模型列表里查不到上下文窗口时的默认值 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

function isWide(code: number) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 中日韩文字和标点
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) // 全角符号
  );
}

/**
 * 粗略估算 token 数（没有各家的分词器，宁可估多一点）：
 * 中日韩字符每个算 1 个 token，其他字符每 3.5 个算 1 个。
 */
export function estimateTokens(text: string) {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (isWide(text.charCodeAt(i))) wide++;
  return Math.ceil(wide + (text.length - wide) / 3.5);
}

const PER_MESSAGE = 6;

/** 一张图片大约占多少 token（各家算法不同，按常见的 1600 像素页面估一个偏大的值） */
export const IMAGE_TOKENS = 1600;

const contentTokens = (c: string | ChatPart[]) =>
  typeof c === 'string' ? estimateTokens(c) : c.reduce((n, p) => n + (p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS), 0);

export function chatTokens(messages: WireMessage[]) {
  return messages.reduce((sum, m) => sum + contentTokens(m.content) + PER_MESSAGE, 0);
}

/** 输入能用多少 token：给回复（含思考过程）留出 20%（4k~32k），再留 5% 余量 */
export function inputBudget(contextWindow: number) {
  const reserve = Math.min(32_000, Math.max(4_096, Math.round(contextWindow * 0.2)));
  return Math.max(1_024, Math.floor((contextWindow - reserve) * 0.95));
}

export const omissionNote = (n: number) => `（为了控制上下文长度，更早的 ${n} 条消息已省略。）`;

/**
 * 让请求放进模型的上下文窗口：先完整构建，超了就从最早的消息开始丢，再重新构建。
 * 系统提示和最近的消息总是保留；返回丢掉了多少条。
 */
export function fitToContext<M extends WireMessage>(
  build: (history: Message[]) => M[],
  history: Message[],
  contextWindow: number,
): { messages: M[]; dropped: number; tokens: number } {
  const budget = inputBudget(contextWindow);
  let messages = build(history);
  let tokens = chatTokens(messages);
  if (tokens <= budget) return { messages, dropped: 0, tokens };

  let dropped = 0;
  // 估算可能和合并后的实际长度有出入，最多调整几次
  for (let attempt = 0; attempt < 6 && tokens > budget && dropped < history.length - 1; attempt++) {
    let excess = tokens - budget;
    while (excess > 0 && dropped < history.length - 1) {
      excess -= estimateTokens(history[dropped].content) + PER_MESSAGE;
      dropped++;
    }
    messages = build(history.slice(dropped));
    // 告诉模型前面省略了内容（加在系统提示之后的第一条消息开头）
    const first = messages.findIndex((m) => m.role !== 'system');
    if (first >= 0) {
      const m = messages[first];
      const note = omissionNote(dropped);
      messages[first] = (
        typeof m.content === 'string'
          ? { ...m, content: `${note}\n\n${m.content}` }
          : { ...m, content: [{ type: 'text', text: note }, ...m.content] }
      ) as M;
    }
    tokens = chatTokens(messages);
  }
  return { messages, dropped, tokens };
}
