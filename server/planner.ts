// 构思 / 执笔：一个模型先构思这一轮要说什么（剧情、逻辑、规则），另一个模型照着写出来。
// 两次调用用的都是这个角色原本的系统提示和对话记录，只在最后一条消息后面加一段说明，
// 所以对提示缓存友好，关掉构思时和原来完全一样。

import { COMMAND_RE } from '../shared/coc.ts';
import type { PlannerConfig } from '../shared/types.ts';
import type { WireMessage } from './llm.ts';

/** 把一段说明接在最后一条用户消息后面（最后一条不是用户消息时单独加一条） */
export function appendToLast(messages: WireMessage[], text: string): WireMessage[] {
  if (!text) return messages;
  const out = messages.slice();
  const last = out.at(-1);
  if (last && last.role === 'user') {
    out[out.length - 1] =
      typeof last.content === 'string'
        ? { role: 'user', content: `${last.content}\n\n${text}` }
        : { role: 'user', content: [...last.content, { type: 'text', text }] };
  } else out.push({ role: 'user', content: text });
  return out;
}

/** 给构思模型的说明 */
export function plannerInstruction(opts: { kp: boolean; name?: string }): string {
  if (opts.kp) {
    return [
      '【构思任务】这一轮先不要直接写给玩家看的回复。你负责构思，另一位写手会照着你的构思、以守秘人的身份写出最终的回复。写手能看到同样的设定和对话记录，但不负责推理剧情和裁定规则，所以关键的决定都要写在构思里。',
      '请用简短的要点写出：',
      '1. 这一轮发生什么：场景的变化，NPC 的反应和说的话（写大意，关键的话可以写原句），透露哪些信息，哪些还不能透露；',
      '2. 节奏和结尾：写多长，最后把行动交还给谁、怎么问；',
      '3. 提醒写手注意的地方：人物口吻、要前后一致的细节、不能替调查员说话或做决定等；',
      '4. 最后单独一行，以「指令：」开头，原样写出这一轮要用的全部方括号指令（检定、理智、掷骰、数值、物品、NPC、线索、备忘、成长），没有就写「指令：无」。写手不会写指令，程序只执行这一行里的指令。',
      '只写构思，不要写成成品。',
    ].join('\n');
  }
  const who = opts.name ? `「${opts.name}」` : '你';
  return [
    `【构思任务】这一轮先不要直接写出发言。你负责构思，另一位写手会照着你的构思、以${who}的身份写出最终的发言。写手能看到同样的设定和对话记录，但不负责推理，所以观点、逻辑和关键信息都要写在构思里。`,
    '请用简短的要点写出：要回应谁的哪句话；这一轮的观点或要做的事；论据、关键措辞或要点（写大意）；语气和大概篇幅；需要避免的地方。',
    '只写构思，不要写成成品。',
  ].join('\n');
}

/** 给执笔模型的说明（附上构思） */
export function writerBlock(plan: string, opts: { kp: boolean }): string {
  return [
    '【本轮构思】下面是这一轮发言的构思，只有你能看到，不要提到它的存在。',
    '照着构思写出你这一轮的发言：发生的事、观点、透露的信息和结尾以构思为准，不要加入构思里没有的重要情节、信息或结论；措辞、节奏和描写由你发挥，写成自然的成品，不要照抄要点格式。',
    opts.kp ? '不要写任何方括号指令（检定、数值、笔记等），程序会按构思自动执行。' : '',
    '<构思>',
    plan.trim(),
    '</构思>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 构思里的方括号指令：有「指令：」那一行就只看那一行之后的部分 */
export function planCommands(plan: string): string[] {
  const m = /(^|\n)[\s>*#-]*指令\s*[:：]/.exec(plan);
  const part = m ? plan.slice(m.index) : plan;
  return [...part.matchAll(new RegExp(COMMAND_RE.source, 'gi'))].map((x) => x[0]);
}

/** 把执笔模型写的指令换成构思里的指令（规则由构思模型决定） */
export function applyPlanCommands(text: string, plan: string): string {
  const body = text.replace(new RegExp(COMMAND_RE.source, 'gi'), '').replace(/[ \t]+\n/g, '\n').trimEnd();
  const cmds = planCommands(plan);
  return cmds.length ? `${body}\n\n${cmds.join('')}` : body;
}

/** 接口传进来的构思设置 */
export function cleanPlanner(input: unknown): PlannerConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    model: typeof o.model === 'string' ? o.model.trim() : '',
    reasoningEffort: typeof o.reasoningEffort === 'string' ? o.reasoningEffort : '',
  };
}

/** 这个角色这一轮要不要先构思 */
export const activePlanner = (p: { planner?: PlannerConfig }) => (p.planner?.enabled && p.planner.model ? p.planner : undefined);
