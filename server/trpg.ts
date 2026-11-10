// 跑团（COC 7）：守秘人 / AI 队友 / 规则助手的提示词，守秘人指令的解析和骰子结算

import {
  COMMAND_RE,
  type Difficulty,
  type InvestigatorSheet,
  type Rng,
  type RollRecord,
  meetsDifficulty,
  resolveTarget,
  rollD100,
  rollExpression,
  rollText,
  sheetSummary,
  stripCommands,
  successLevel,
} from '../shared/coc.ts';
import type { Message, Participant, Room } from '../shared/types.ts';
import type { ChatMessage } from './llm.ts';
import { turnBuilder, usableHistory } from './prompt.ts';

// ---------------- 角色识别 ----------------

export const kpOf = (room: Room) => room.participants.find((p) => p.role === 'kp');
export const teammatesOf = (room: Room) => room.participants.filter((p) => p.role === 'player');

function playerName(room: Room) {
  return room.trpg?.sheets.player?.name ?? room.settings.humanName;
}

/** 根据 @名字 找到角色卡 key */
export function actorKey(room: Room, name?: string): string | undefined {
  const trpg = room.trpg;
  if (!trpg) return undefined;
  if (!name) return trpg.sheets.player ? 'player' : undefined;
  const n = name.replace(/^@/, '').trim();
  if (!n || n === room.settings.humanName || n === trpg.sheets.player?.name || n === '玩家') return 'player';
  for (const p of teammatesOf(room)) {
    if (p.name === n || trpg.sheets[p.id]?.name === n) return p.id;
  }
  // 模糊：名字包含关系
  for (const [key, sheet] of Object.entries(trpg.sheets)) {
    if (sheet.name.includes(n) || n.includes(sheet.name)) return key;
  }
  return undefined;
}

// ---------------- 提示词 ----------------

const RULES_CHEATSHEET = `COC 7 规则要点：
- 检定：掷 1d100（01~100），结果 ≤ 技能值就成功；≤ 技能值的一半是困难成功；≤ 五分之一是极难成功；01 是大成功；100 是大失败（技能值低于 50 时 96~100 都是大失败）。
- 守秘人可以要求"困难"或"极难"检定，这时必须达到对应的成功等级才算成功。
- 奖励骰 / 惩罚骰：多掷一个十位骰，奖励骰取低的那个，惩罚骰取高的那个。
- 孤注一掷：普通技能检定失败后，玩家可以说明怎样更努力地尝试，然后重骰一次；如果再次失败，会有严重的后果。理智、幸运和战斗相关的检定不能孤注一掷。
- 理智（SAN）：遇到恐怖的事物要进行理智检定，成功失去较少理智，失败失去较多（写作"成功损失/失败损失"，如 1/1d6）。一次失去 5 点以上可能陷入临时性疯狂，理智归零则永久疯狂。
- 生命值（HP）：受伤会扣除；一次失去最大生命值一半以上是重伤；归零会昏迷或濒死。急救成功可以恢复 1 点。
- 调查员是普通人，不是超级英雄；遇到怪物时逃跑往往是明智的选择。`;

function roster(room: Room) {
  const trpg = room.trpg!;
  const lines: string[] = [];
  const player = trpg.sheets.player;
  lines.push(
    player
      ? `- 人类玩家「${room.settings.humanName}」扮演调查员：\n${indent(sheetSummary(player, trpg.era))}`
      : `- 人类玩家「${room.settings.humanName}」（还没有创建调查员）`,
  );
  for (const p of teammatesOf(room)) {
    const sheet = trpg.sheets[p.id];
    lines.push(
      sheet
        ? `- AI 队友（由另一个 AI 扮演）：\n${indent(sheetSummary(sheet, trpg.era))}`
        : `- AI 队友「${p.name}」`,
    );
  }
  return lines.join('\n');
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

export function buildKpSystemPrompt(room: Room, kp: Participant) {
  const trpg = room.trpg!;
  const parts = [
    '你是这场《克苏鲁的呼唤》第七版（COC 7th）跑团的守秘人（KP）：负责主持游戏、描述环境、扮演所有 NPC，并按规则裁定结果。',
    kp.persona.trim() ? `\n【你的主持风格】\n${kp.persona.trim()}` : '',
    `\n【玩家与调查员】（数值随游戏实时更新）\n${roster(room)}`,
    `人类玩家是第一次玩跑团的新手。`,
    `\n${trpg.scenarioSecret}`,
    `\n【主持原则】
- 用第二人称（"你"）生动地描述场景和 NPC 的言行，一般 150~300 字，结尾把选择交还给玩家（比如"你打算怎么做？"）。
- 绝不替玩家决定调查员的行动、想法或台词；AI 队友的行动由他们自己说，你只描述结果。
- 让玩家通过调查一步步发现线索，不要一次性给出答案；玩家卡住时，可以通过 NPC 或环境给出提示。
- 剧本里的真相只有你知道，绝不能直接透露；不要提到"剧本""真相"这些词。
- 标记为"场外"的发言是玩家本人在提问（比如问规则），用一两句话以守秘人的身份回答，不推进剧情。
- 保持神秘紧张的氛围，恐怖靠暗示而不是血腥描写。${
      trpg.teachingMode
        ? '\n- 新手教学：当某个规则第一次出现（检定、困难等级、理智检定、孤注一掷、幸运等）时，在消息最后另起一行用「【规则小贴士】……」一两句话解释。'
        : ''
    }`,
    `\n【骰子指令】骰子由程序来掷，你绝不能自己编造骰子结果。需要掷骰时，在消息里写下指令，程序会把它变成骰子卡片：
- [检定:技能名]：让玩家进行技能检定，如 [检定:侦查]、[检定:图书馆使用]；属性检定用 力量 / 体质 / 体型 / 敏捷 / 外貌 / 智力 / 意志 / 教育 / 幸运。
- 难度和奖惩骰：[检定:聆听:困难]、[检定:潜行:极难]、[检定:说服:奖励1]、[检定:攀爬:惩罚1]
- 让 AI 队友检定：[检定:侦查:@名字]
- [理智:成功损失/失败损失]：理智检定，如 [理智:0/1d3]、[理智:1/1d6]，让队友检定加 :@名字
- [掷骰:1d6:说明]：你自己需要的随机结果，如 NPC 的反应、伤害
- [HP:-2]、[HP:-1d6]、[MP:-1]、[SAN:-1]、[幸运:-5]：直接修改调查员的数值（不加 @名字 时默认是玩家）
- [物品:+手电筒]、[物品:-旧钥匙]：调查员获得或失去物品
指令规则：
- 只在结果不确定、而且成败都有意义时才要求检定。一次只要求一个检定（理智检定除外），把指令写在消息末尾，然后停下来等结果，不要提前描述检定的结果。
- 收到【骰子】结果后，根据成功等级描述后果。失败也要让剧情推进（付出代价、引来麻烦、浪费时间），不要只说"什么都没发现"。
- 玩家可以对失败的普通技能检定"孤注一掷"重骰一次；孤注一掷再失败时，要给出严重的后果。`,
  ];
  return parts.filter(Boolean).join('\n');
}

export function buildKpMessages(room: Room, kp: Participant, history: Message[]): ChatMessage[] {
  const { turns, push } = turnBuilder();
  const teammates = new Map(teammatesOf(room).map((p) => [p.id, p]));
  for (const m of usableHistory(history)) {
    if (m.role === 'ai' && m.participantId === kp.id) {
      push('assistant', m.content.trim());
    } else if (m.role === 'ai') {
      const tm = teammates.get(m.participantId ?? '');
      push('user', `【${m.speakerName}（${tm ? 'AI 队友' : '其他'}）】：${m.content.trim()}`);
    } else if (m.role === 'human') {
      push(
        'user',
        m.ooc
          ? `【玩家 ${room.settings.humanName}（场外）】：${m.content.trim()}`
          : `【${playerName(room)}（玩家）】：${m.content.trim()}`,
      );
    } else if (m.kind === 'roll') {
      push('user', `【骰子】：${m.content.trim()}`);
    }
  }
  if (turns.length === 0) {
    turns.push({
      role: 'user',
      content: '（玩家已经准备好了。请开场：交代时间、地点和调查员为什么会来到这里，营造氛围，最后问玩家打算做什么。）',
    });
  } else {
    if (turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '（游戏开始）' });
    if (turns[turns.length - 1].role === 'assistant') turns.push({ role: 'user', content: '（请继续主持）' });
  }
  return [{ role: 'system', content: buildKpSystemPrompt(room, kp) }, ...turns];
}

export function buildTeammateMessages(room: Room, self: Participant, history: Message[]): ChatMessage[] {
  const trpg = room.trpg!;
  const kp = kpOf(room);
  const sheet = trpg.sheets[self.id];
  const system = [
    `你在一场《克苏鲁的呼唤》（COC 7）跑团中扮演 AI 调查员「${sheet?.name ?? self.name}」，和人类玩家「${room.settings.humanName}」（扮演调查员「${playerName(room)}」）一起调查。守秘人负责描述世界和裁定结果。`,
    self.persona.trim() ? `\n【你的性格】\n${self.persona.trim()}` : '',
    sheet ? `\n【你的调查员】\n${sheetSummary(sheet, trpg.era)}` : '',
    `\n【原则】
- 用第一人称说出你的调查员的台词和行动，简短（一般 30~100 字）。
- 只描述你想做什么、说什么，不要描述行动的结果，不要扮演 NPC 或守秘人，也不要编造骰子结果。
- 你是配角：配合和支持人类玩家，可以提出建议或分头行动，但重大决定留给人类玩家，不要抢戏。
- 人类玩家是跑团新手，必要时可以用角色的口吻给一点提示。`,
  ].filter(Boolean);

  const { turns, push } = turnBuilder();
  for (const m of usableHistory(history)) {
    if (m.role === 'ai' && m.participantId === self.id) push('assistant', m.content.trim());
    else if (m.role === 'ai' && m.participantId === kp?.id) push('user', `【守秘人】：${stripCommands(m.content)}`);
    else if (m.role === 'ai') push('user', `【${m.speakerName}】：${m.content.trim()}`);
    else if (m.role === 'human' && !m.ooc) push('user', `【${playerName(room)}（玩家）】：${m.content.trim()}`);
    else if (m.kind === 'roll') push('user', `【骰子】：${m.content.trim()}`);
  }
  if (turns.length === 0 || turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '（游戏开始）' });
  if (turns[turns.length - 1].role === 'assistant') turns.push({ role: 'user', content: '（请继续）' });
  turns[turns.length - 1].content += `\n\n（现在轮到你「${sheet?.name ?? self.name}」，简短说出你的台词或行动）`;
  return [{ role: 'system', content: system.join('\n') }, ...turns];
}

/** 规则助手：能看到局势和角色卡，但看不到剧本秘密 */
export function buildAssistantMessages(room: Room, question: string, mode: 'ask' | 'suggest'): ChatMessage[] {
  const trpg = room.trpg!;
  const kp = kpOf(room);
  const transcript = usableHistory(room.messages)
    .slice(-24)
    .map((m) => {
      if (m.role === 'human') return `${m.ooc ? `玩家（场外）` : playerName(room)}：${m.content.trim()}`;
      if (m.kind === 'roll') return `【骰子】${m.content.trim()}`;
      if (m.participantId === kp?.id) return `守秘人：${stripCommands(m.content)}`;
      return `${m.speakerName}：${m.content.trim()}`;
    })
    .join('\n');
  const system = [
    '你是《克苏鲁的呼唤》第七版跑团的规则助手，陪伴一位完全不懂跑团的新手玩家。用通俗、亲切的中文回答，一般不超过 200 字，必要时举例子。',
    '你能看到游戏记录和玩家的调查员卡，但看不到剧本秘密，也不要猜测或剧透剧情的真相。你不是守秘人，不能替守秘人裁定结果。',
    `\n${RULES_CHEATSHEET}`,
    trpg.sheets.player ? `\n【玩家的调查员】\n${sheetSummary(trpg.sheets.player, trpg.era)}` : '\n（玩家还没有创建调查员）',
    `\n【剧本简介】${trpg.scenarioIntro}`,
    `\n【最近的游戏记录】\n${transcript || '（游戏还没开始）'}`,
  ].join('\n');

  if (mode === 'suggest') {
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          '根据目前的局势，给出 3 个适合新手尝试的具体行动，每行一个，用调查员第一人称的口吻（例如"我仔细检查书桌的抽屉"），每个不超过 30 字。只输出这 3 行，不要编号以外的任何内容。',
      },
    ];
  }
  const log = trpg.assistantLog.slice(-8).map((e) => ({ role: e.role, content: e.content }) as ChatMessage);
  return [{ role: 'system', content: system }, ...log, { role: 'user', content: question }];
}

export function parseSuggestions(text: string): string[] {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)]|[（(]?\d+[)）])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter((l) => l.length > 1)
    .slice(0, 3);
}

// ---------------- 骰子结算 ----------------

const UNPUSHABLE = ['幸运', '理智', '斗殴', '闪避', '射击'];

export function resolveCheck(r: RollRecord, rng: Rng = Math.random) {
  const d = rollD100(r.bonus ?? 0, rng);
  r.tens = d.tens;
  r.units = d.units;
  r.total = d.total;
  r.level = successLevel(d.total, r.target ?? 0);
  r.success = meetsDifficulty(r.level, r.difficulty);
  r.pending = false;
  r.pushable = !r.success && !r.pushed && r.level !== 'fumble' && !UNPUSHABLE.some((n) => r.label.startsWith(n));
}

/** 骰子表达式的最大值（大失败的理智检定要失去最大值） */
function maxOf(expr: string) {
  return rollExpression(expr, () => 0.999999).total;
}

export function resolveSan(r: RollRecord, sheet: InvestigatorSheet, rng: Rng = Math.random) {
  const d = rollD100(0, rng);
  r.before = sheet.san.current;
  r.target = sheet.san.current;
  r.tens = d.tens;
  r.units = d.units;
  r.total = d.total;
  r.level = successLevel(d.total, sheet.san.current);
  r.success = r.level !== 'fail' && r.level !== 'fumble';
  const expr = (r.success ? r.sanSuccess : r.sanFail) || '0';
  if (r.level === 'fumble') {
    r.loss = maxOf(expr);
    r.lossDetail = `大失败，失去最大值 ${expr}=${r.loss}`;
  } else {
    const loss = rollExpression(expr, rng);
    r.loss = Math.max(0, loss.total);
    r.lossDetail = loss.detail;
  }
  sheet.san.current = Math.max(0, sheet.san.current - r.loss);
  r.after = sheet.san.current;
  r.pending = false;
  const notes: string[] = [];
  if (r.loss >= 5) notes.push('单次失去 5 点以上理智：请让调查员进行智力检定，成功则因为理解了所见之物而陷入临时性疯狂');
  if (r.after === 0) notes.push('理智归零，调查员陷入永久疯狂');
  r.note = notes.join('；') || undefined;
}

type StatName = 'HP' | 'MP' | 'SAN' | '幸运';

function applyStat(sheet: InvestigatorSheet, stat: StatName, delta: number) {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  let before: number;
  let after: number;
  if (stat === 'HP') {
    before = sheet.hp.current;
    after = sheet.hp.current = clamp(before + delta, sheet.hp.max);
  } else if (stat === 'MP') {
    before = sheet.mp.current;
    after = sheet.mp.current = clamp(before + delta, sheet.mp.max);
  } else if (stat === 'SAN') {
    before = sheet.san.current;
    after = sheet.san.current = clamp(before + delta, sheet.san.max);
  } else {
    before = sheet.luck;
    after = sheet.luck = clamp(before + delta, 99);
  }
  const notes: string[] = [];
  if (stat === 'HP' && delta < 0) {
    if (-delta >= Math.ceil(sheet.hp.max / 2)) notes.push('重伤！');
    if (after === 0) notes.push('生命值归零，调查员倒地昏迷或濒死');
  }
  if (stat === 'SAN' && delta <= -5) notes.push('单次失去 5 点以上理智，可能陷入临时性疯狂');
  if (stat === 'SAN' && after === 0) notes.push('理智归零，调查员陷入永久疯狂');
  return { before, after, note: notes.join('') || undefined };
}

export interface ProcessResult {
  rolls: RollRecord[];
  /** 有需要守秘人看到结果再继续的自动掷骰 */
  needContinue: boolean;
  /** 等待人类玩家掷骰的数量 */
  pendingHuman: number;
  sheetsChanged: boolean;
  problems: string[];
}

/** 解析守秘人消息里的指令，生成骰子记录（会直接修改角色卡） */
export function processKpCommands(room: Room, text: string, rng: Rng = Math.random): ProcessResult {
  const trpg = room.trpg!;
  const result: ProcessResult = { rolls: [], needContinue: false, pendingHuman: 0, sheetsChanged: false, problems: [] };
  const seen = new Set<string>();

  for (const m of text.matchAll(COMMAND_RE)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const kind = m[1].toUpperCase();
    const args = m[2]
      .split(/[:：]/)
      .map((a) => a.trim())
      .filter(Boolean);
    const mention = args.find((a) => a.startsWith('@'));
    const plain = args.filter((a) => !a.startsWith('@'));
    const key = actorKey(room, mention);
    const sheet = key ? trpg.sheets[key] : undefined;

    if (kind === '掷骰') {
      try {
        const r = rollExpression(plain[0] ?? '1d6', rng);
        result.rolls.push({
          type: 'dice',
          actor: '',
          actorName: '守秘人',
          pending: false,
          label: plain[0] ?? '1d6',
          expression: plain[0] ?? '1d6',
          total: r.total,
          detail: r.detail,
          note: plain.slice(1).join('：') || undefined,
        });
        result.needContinue = true;
      } catch (err) {
        result.problems.push(err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    if (!key || !sheet) {
      result.problems.push(`指令 ${raw} 找不到对应的调查员`);
      continue;
    }
    const isHuman = key === 'player';

    if (kind === '检定') {
      const skill = plain[0];
      if (!skill) continue;
      const difficulty: Difficulty = plain.some((a) => a.includes('极难'))
        ? 'extreme'
        : plain.some((a) => a.includes('困难'))
          ? 'hard'
          : 'regular';
      let bonus = 0;
      for (const a of plain) {
        const b = a.match(/奖励\s*(\d)?/);
        const p = a.match(/惩罚\s*(\d)?/);
        if (b) bonus = Number(b[1] ?? 1);
        if (p) bonus = -Number(p[1] ?? 1);
      }
      const t = resolveTarget(sheet, skill);
      const roll: RollRecord = {
        type: 'check',
        actor: key,
        actorName: sheet.name,
        pending: true,
        label: t.name,
        target: t.target,
        difficulty,
        bonus: bonus || undefined,
        note: t.found ? undefined : `角色卡里没有「${skill}」，按 5 计算`,
      };
      if (!isHuman || trpg.autoRoll) {
        resolveCheck(roll, rng);
        result.needContinue = true;
      } else {
        result.pendingHuman++;
      }
      result.rolls.push(roll);
    } else if (kind === '理智') {
      const [succ, fail] = (plain[0] ?? '0/1').split(/[/／]/).map((x) => x.trim());
      const roll: RollRecord = {
        type: 'san',
        actor: key,
        actorName: sheet.name,
        pending: true,
        label: '理智',
        target: sheet.san.current,
        sanSuccess: succ || '0',
        sanFail: fail || '1',
      };
      if (!isHuman || trpg.autoRoll) {
        resolveSan(roll, sheet, rng);
        result.sheetsChanged = true;
        result.needContinue = true;
      } else {
        result.pendingHuman++;
      }
      result.rolls.push(roll);
    } else if (kind === '物品') {
      const spec = plain.join('：');
      const removing = spec.startsWith('-') || spec.startsWith('－');
      const item = spec.replace(/^[+＋\-－]/, '').trim();
      if (!item) continue;
      if (removing) {
        const idx = sheet.items.findIndex((i) => i === item || i.includes(item));
        if (idx >= 0) sheet.items.splice(idx, 1);
      } else if (!sheet.items.includes(item)) {
        sheet.items.push(item);
      }
      result.sheetsChanged = true;
      result.rolls.push({
        type: 'stat',
        actor: key,
        actorName: sheet.name,
        pending: false,
        label: '物品',
        stat: '物品',
        item,
        itemAdded: !removing,
      });
    } else {
      const stat = (kind === '幸运' ? '幸运' : kind) as StatName;
      const spec = (plain[0] ?? '').replace(/\s+/g, '').replace('＋', '+').replace('－', '-');
      const sign = spec.startsWith('+') ? 1 : -1; // 不写符号时默认是扣除
      const magnitude = spec.replace(/^[+-]/, '');
      let amount: number;
      let detail: string | undefined;
      try {
        if (/d/i.test(magnitude)) {
          const r = rollExpression(magnitude, rng);
          amount = r.total;
          detail = r.detail;
        } else {
          amount = Number(magnitude);
        }
      } catch (err) {
        result.problems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!Number.isFinite(amount) || amount === 0) continue;
      const delta = sign * Math.abs(amount);
      const { before, after, note } = applyStat(sheet, stat, delta);
      result.sheetsChanged = true;
      result.rolls.push({
        type: 'stat',
        actor: key,
        actorName: sheet.name,
        pending: false,
        label: stat,
        stat,
        before,
        after,
        delta: after - before,
        detail,
        note,
      });
    }
  }
  return result;
}

/** 生成一条骰子消息 */
export function rollMessage(id: string, roll: RollRecord): Message {
  return {
    id,
    role: 'system',
    kind: 'roll',
    speakerName: '骰子',
    content: rollText(roll),
    roll,
    status: 'done',
    createdAt: Date.now(),
  };
}

export { rollText, stripCommands };
