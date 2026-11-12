// 跑团（COC 7）：守秘人 / AI 队友 / 规则助手的提示词，守秘人指令的解析和骰子结算

import {
  COMMAND_RE,
  NO_GROWTH,
  applyCheckModifiers,
  parseCheckModifier,
  splitInlineModifier,
  type CheckModifier,
  NOTE_KIND_LABELS,
  type Difficulty,
  type InvestigatorSheet,
  type MemoEntry,
  type NoteEntry,
  type NoteEvent,
  type NoteKind,
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
import { ASSET_KIND_LABELS, type Message, type Participant, type Room, type ScriptAsset } from '../shared/types.ts';
import type { ChatMessage } from './llm.ts';
import { turnBuilder, usableHistory } from './prompt.ts';
import { newId } from './store.ts';

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
- 孤注一掷：普通技能检定失败后，玩家可以说明怎样更努力地尝试，然后重骰一次；如果再次失败，会有严重的后果。理智、幸运、心理学和战斗相关的检定不能孤注一掷。
- 技能成长：模组结束后，可以对这次成功使用过的技能做成长检定：掷 1d100，大于当前技能值（或 96 以上）就成长 1d10 点。
- 理智（SAN）：遇到恐怖的事物要进行理智检定，成功失去较少理智，失败失去较多（写作"成功损失/失败损失"，如 1/1d6）。一次失去 5 点以上可能陷入临时性疯狂，理智归零则永久疯狂。
- 生命值（HP）：受伤会扣除；一次失去最大生命值一半以上是重伤；归零会昏迷或濒死。急救成功可以恢复 1 点。
- 调查员是普通人，不是超级英雄；遇到怪物时逃跑往往是明智的选择。`;

/** 系统提示里的人物介绍：只有名字和职业，不含会变的数值（数值放在【当前状态】里） */
function rosterNames(room: Room) {
  const trpg = room.trpg!;
  const player = trpg.sheets.player;
  const lines = [
    player
      ? `- 人类玩家「${room.settings.humanName}」，扮演调查员「${player.name}」（${player.occupation}）。TA 是第一次玩跑团的新手。`
      : `- 人类玩家「${room.settings.humanName}」（还没有创建调查员），是第一次玩跑团的新手。`,
  ];
  for (const p of teammatesOf(room)) {
    const sheet = trpg.sheets[p.id];
    lines.push(`- AI 队友「${sheet?.name ?? p.name}」${sheet ? `（${sheet.occupation}）` : ''}，由另一个 AI 扮演。`);
  }
  return lines.join('\n');
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

/** 笔记内容（玩家可见） */
export function notesText(notes: NoteEntry[]) {
  if (notes.length === 0) return '（还是空的）';
  const section = (kind: NoteKind, label: string) => {
    const list = notes.filter((n) => n.kind === kind);
    return list.length ? `${label}：\n${list.map((n) => `- ${n.title}：${n.text}`).join('\n')}` : '';
  };
  return [section('npc', 'NPC'), section('clue', '线索')].filter(Boolean).join('\n');
}

/**
 * 会变的状态（调查员数值、物品、笔记）。放在最后一条消息的末尾而不是系统提示里：
 * 这样系统提示和之前的历史在每一轮都保持不变，模型服务的提示缓存才能生效。
 */
export function kpStateBlock(room: Room) {
  const trpg = room.trpg!;
  const lines = ['【当前状态】（程序自动更新，数值以这里为准）'];
  const player = trpg.sheets.player;
  if (player) lines.push(`玩家的调查员：\n${indent(sheetSummary(player, trpg.era))}`);
  for (const p of teammatesOf(room)) {
    const sheet = trpg.sheets[p.id];
    if (sheet) lines.push(`AI 队友：\n${indent(sheetSummary(sheet, trpg.era))}`);
  }
  if (trpg.notebook) lines.push(`守秘人笔记（玩家也能看到）：\n${indent(notesText(trpg.notes))}`);
  if (trpg.memo) {
    const memos = trpg.memos.length ? trpg.memos.map((m) => `- ${m.title}：${m.text}`).join('\n') : '（还是空的）';
    lines.push(`秘密备忘（只有你能看到）：\n${indent(memos)}`);
  }
  return lines.join('\n');
}

const MEMO_RULES = `【秘密备忘】（只有你能看到，玩家、AI 队友和规则助手都看不到）
用来记下你自己临时决定、但剧本里没有写的秘密设定，保证后面的剧情前后一致：比如即兴定下的真相、NPC 的真实身份和动机、埋下的伏笔、还没被发现的线索藏在哪里。
- [备忘:主题:内容]，例如 [备忘:真相:失踪案是管家所为，他把人藏在地窖]。同一个主题会覆盖更新，剧情改变时记得更新。
- 只记会影响后续剧情的重要设定；剧本里已经写明的内容不用重复记。`;

const NOTEBOOK_RULES = `【守秘人笔记】
你有一本笔记，用来记下重要的 NPC 和线索，帮你在很长的游戏里保持前后一致。注意：这本笔记会显示在玩家的界面上，玩家随时可以翻看。
- [NPC:名字:简短描述]：记下一个新登场的重要 NPC，或者更新已有 NPC 的信息（同名会覆盖）。写外貌、身份、态度，以及玩家已经知道的事。
- [线索:简短标题:内容]：记下玩家刚刚发现或确认的关键线索。
笔记规则：
- 只记玩家已经亲眼看到、亲耳听到或者已经推理出来的内容。剧本真相、NPC 的隐藏身份和真实动机、玩家还没发现的秘密，一律不能写进笔记。
- 只在重要 NPC 第一次登场、NPC 有了重要的新信息，或者发现关键线索时记录；一条消息里最多记一两条，不要什么都记。
- 指令写在消息末尾即可。玩家看不到指令本身，只会看到"笔记已更新"的提示。`;

/** 玩家和 AI 队友的调查员名字，用于提醒守秘人不要替他们说话 */
function investigatorNames(room: Room) {
  const trpg = room.trpg!;
  return [trpg.sheets.player?.name ?? room.settings.humanName, ...teammatesOf(room).map((p) => trpg.sheets[p.id]?.name ?? p.name)]
    .map((n) => `「${n}」`)
    .join('、');
}

/** 剧本里的手出物和地图（给守秘人看的说明） */
function assetSection(room: Room) {
  const trpg = room.trpg!;
  const assets = trpg.assets ?? [];
  if (!assets.length) return '';
  const maps = assets.filter((a) => a.kind === 'map');
  const lines = assets.map(
    (a) => `- ${ASSET_KIND_LABELS[a.kind]}「${a.title}」（${a.visibility === 'player' ? '可以展示给玩家' : '守秘人专用，不能展示'}）：${a.description || '（没有说明）'}`,
  );
  return `\n【剧本里的手出物和地图】
下面这些图片来自剧本，玩家现在都看不到。剧情里调查员拿到手出物、或者需要给玩家看可以公开的地图时，在消息里写 [展示:名称]（名称就是下面「」里的），程序会把图片展示给玩家；展示以后不用把上面的文字全文复述，描写调查员拿到它时的情形就行。守秘人专用的不能展示。${
    maps.length && trpg.mapsToKp !== false ? '地图的图片附在对话开头的第一条消息里，描述方位和路线时对照地图。' : ''
  }
${lines.join('\n')}`;
}

/** 找守秘人要展示的图片：先按完整名称，再按包含关系 */
export function findAsset(assets: ScriptAsset[] | undefined, name: string) {
  const n = name.trim().replace(/^[「『《"“]|[」』》"”]$/g, '');
  if (!n || !assets?.length) return undefined;
  return assets.find((a) => a.title === n) ?? assets.find((a) => a.title.includes(n) || n.includes(a.title));
}

export function buildKpSystemPrompt(room: Room, kp: Participant) {
  const trpg = room.trpg!;
  const others = investigatorNames(room);
  const parts = [
    '你是这场《克苏鲁的呼唤》第七版（COC 7th）跑团的守秘人（KP）：负责主持游戏、描述环境、扮演所有 NPC，并按规则裁定结果。',
    kp.persona.trim() ? `\n【你的主持风格】\n${kp.persona.trim()}` : '',
    trpg.eraLabel ? `\n【时代背景】${trpg.eraLabel}。描写科技、社会风貌、人物的衣着和说话方式时要符合这个时代。` : '',
    `\n【玩家】\n${rosterNames(room)}`,
    `每一轮最后一条消息的末尾会附上【当前状态】：调查员最新的数值、技能和物品${trpg.notebook ? '，守秘人笔记' : ''}${trpg.memo ? '，以及你的秘密备忘' : ''}。以那里的内容为准。`,
    `\n${trpg.scenarioSecret}`,
    assetSection(room),
    `\n【主持原则】
- 用第二人称（"你"）生动地描述场景和 NPC 的言行，一般 150~300 字，结尾把选择交还给玩家（比如"你打算怎么做？"）。
- 你的回复只代表守秘人：描述环境、扮演 NPC、裁定结果。${others ? `玩家和 AI 队友（${others}）都会自己发言：` : '玩家会自己发言：'}不要替他们说台词、替他们思考或决定行动，也不要用「【名字】：」的格式写任何人的发言。你可以描述外界对他们的影响（比如冷风让人打了个寒颤），以及他们已经说出的行动带来的结果。
- 让玩家通过调查一步步发现线索，不要一次性给出答案；玩家卡住时，可以通过 NPC 或环境给出提示。
- 节奏要循序渐进：一个场景通常只揭示一两条新线索。愿意帮忙的 NPC 一般在玩家卡住时才出场，而且只给方向或一部分信息，不要一口气把真相全部说出来。
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
- 修正成功线：剧本写了加减成功率时（如"幸运 -1d20""侦查 +10"），把修正写进指令：[检定:幸运:-1d20]、[检定:侦查:+10]，程序会掷修正骰、算出新的成功线并显示给玩家；也可以直接指定成功线：[检定:幸运:=35]。修正必须写在指令里，只在文字里说"成功线是 35"程序不会知道。COC 7 版一般用困难 / 极难和奖惩骰表示难度，剧本另有写法时才用修正。
- 让 AI 队友检定：[检定:侦查:@名字]
- [理智:成功损失/失败损失]：理智检定，如 [理智:0/1d3]、[理智:1/1d6]，让队友检定加 :@名字
- [掷骰:1d6:说明]：你自己需要的随机结果，如 NPC 的反应、伤害
- [HP:-2]、[HP:-1d6]、[MP:-1]、[SAN:-1]、[幸运:-5]：直接修改调查员的数值（不加 @名字 时默认是玩家）。注意 [幸运:-5] 是扣掉幸运值，幸运检定要用 [检定:幸运]
- [SAN:+1d6]、[HP:+1]：恢复理智或生命（比如结局的理智奖励）。注意 [理智:…] 只用于理智检定，奖励理智要用 [SAN:+…]
- [成长]：模组结束时请玩家进行技能成长检定。程序会自动列出这次成功使用过的技能，负责掷骰并更新角色卡，你不需要自己列出技能或描述结果
- [物品:+手电筒]、[物品:-旧钥匙]：调查员获得或失去物品
指令规则：
- 只在结果不确定、而且成败都有意义时才要求检定。一次只要求一个检定（理智检定除外），把指令写在消息末尾，然后停下来等结果，不要提前描述检定的结果。
- 要求检定（包括理智检定）的消息写到需要掷骰的那一刻就停下：不要在同一条消息里问玩家接下来做什么，也不要先写之后的发展。玩家掷完骰你会收到结果，到时再接着写。理智检定紧跟在恐怖的景象之后：写到调查员看清那一幕，就写 [理智:…] 停下。
- 收到【骰子】结果后，从结果直接接着写：先写检定带来的后果或调查员的反应（理智检定失败时可以写一个短暂的本能反应），不要把之前已经描述过的场景再写一遍，最后再把行动交还给玩家。失败也要让剧情推进（付出代价、引来麻烦、浪费时间），不要只说"什么都没发现"。
- 玩家可以对失败的普通技能检定"孤注一掷"重骰一次（理智、幸运、心理学和战斗相关的检定不能）。玩家掷骰失败后会先决定要不要孤注一掷，【骰子】结果里会写明玩家的选择；如果玩家选择孤注一掷，你会先收到 TA 打算怎么更努力，再收到重骰的结果。孤注一掷再失败时，要给出严重的后果。`,
    trpg.notebook ? `\n${NOTEBOOK_RULES}` : '',
    trpg.memo ? `\n${MEMO_RULES}` : '',
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
    } else if (m.kind === 'handout') {
      push('user', `【展示】${m.content.trim()}`);
    }
    // 笔记提示（kind === 'note'）只给界面看，笔记本身在【当前状态】里
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
  // 最后一条消息末尾：当前状态 + 一句提醒（离生成位置最近，最不容易被忽略）
  const mates = teammatesOf(room).map((p) => room.trpg!.sheets[p.id]?.name ?? p.name);
  const boundary = mates.length
    ? `${mates.map((n) => `「${n}」`).join('、')}会在你之后自己发言，不要替${mates.length > 1 ? '他们' : 'TA'}说台词或决定行动。`
    : '不要替玩家说台词或决定行动。';
  // 刚掷完骰子：从结果接着写，不要把场景再描述一遍
  const lastReal = [...history].reverse().find((m) => m.kind !== 'note' && m.status !== 'error');
  const afterRoll = lastReal?.kind === 'roll' && !lastReal.roll?.pending;
  const pacing = afterRoll
    ? '上面是刚掷出的骰子结果：从结果直接接着写，写清它带来的后果或调查员的反应，不要把前面已经描述过的场景再写一遍，然后把行动交还给玩家。'
    : '要求检定时，写到需要掷骰的那一刻就停下，不要在同一条消息里再问玩家打算怎么做。';
  const reminder = `（请以守秘人的身份继续。${boundary}${pacing}）`;
  turns[turns.length - 1].content += `\n\n${kpStateBlock(room)}\n\n${reminder}`;
  return [{ role: 'system', content: buildKpSystemPrompt(room, kp) }, ...turns];
}

export function buildTeammateMessages(room: Room, self: Participant, history: Message[]): ChatMessage[] {
  const trpg = room.trpg!;
  const kp = kpOf(room);
  const sheet = trpg.sheets[self.id];
  const name = sheet?.name ?? self.name;
  const system = [
    `你在一场《克苏鲁的呼唤》（COC 7）跑团中扮演 AI 调查员「${name}」${sheet ? `（${sheet.occupation}）` : ''}，和人类玩家「${room.settings.humanName}」（扮演调查员「${playerName(room)}」）一起调查。守秘人负责描述世界和裁定结果。`,
    trpg.eraLabel ? `\n【时代背景】${trpg.eraLabel}。说话和行动要符合这个时代。` : '',
    self.persona.trim() ? `\n【你的性格】\n${self.persona.trim()}` : '',
    `\n每一轮最后一条消息的末尾会附上你的调查员的最新状态${trpg.notebook ? '和大家共享的调查笔记' : ''}。`,
    `\n【原则】
- 用第一人称说出你的调查员的台词和行动，简短（一般 30~100 字）。
- 只描述你想做什么、说什么，不要描述行动的结果，不要扮演 NPC 或守秘人，也不要编造骰子结果。
- 只说你自己的话，不要用「【名字】：」的格式替别人发言。
- 守秘人叙述里的「你」指的是人类玩家的调查员「${playerName(room)}」，不是你；守秘人提到你时会直接叫你的名字「${name}」。别把发生在玩家身上的事（受伤、看到的东西）当成发生在自己身上。
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
    else if (m.kind === 'handout') push('user', `【展示】${handoutText(room, m)}`);
  }
  if (turns.length === 0 || turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '（游戏开始）' });
  if (turns[turns.length - 1].role === 'assistant') turns.push({ role: 'user', content: '（请继续）' });
  const state = [
    sheet ? `【你的调查员当前状态】\n${sheetSummary(sheet, trpg.era)}` : '',
    trpg.notebook && trpg.notes.length ? `【调查笔记】\n${notesText(trpg.notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  turns[turns.length - 1].content += `${state ? `\n\n${state}` : ''}\n\n（现在轮到你「${name}」，简短说出你的台词或行动）`;
  return [{ role: 'system', content: system.join('\n') }, ...turns];
}

/** 展示过的手出物：调查员都看到了，队友和规则助手也知道内容 */
function handoutText(room: Room, m: Message) {
  const asset = room.trpg?.assets?.find((a) => a.id === m.asset?.id);
  return asset?.description ? `${m.content.trim()}：${asset.description}` : m.content.trim();
}

/** 规则助手：能看到局势、角色卡和笔记（都是玩家可见的），但看不到剧本秘密 */
export function buildAssistantMessages(room: Room, question: string, mode: 'ask' | 'suggest'): ChatMessage[] {
  const trpg = room.trpg!;
  const kp = kpOf(room);
  const transcript = usableHistory(room.messages)
    .filter((m) => m.kind !== 'note')
    .slice(-24)
    .map((m) => {
      if (m.role === 'human') return `${m.ooc ? `玩家（场外）` : playerName(room)}：${m.content.trim()}`;
      if (m.kind === 'roll') return `【骰子】${m.content.trim()}`;
      if (m.kind === 'handout') return `【展示】${handoutText(room, m)}`;
      if (m.participantId === kp?.id) return `守秘人：${stripCommands(m.content)}`;
      return `${m.speakerName}：${m.content.trim()}`;
    })
    .join('\n');
  const system = [
    '你是《克苏鲁的呼唤》第七版跑团的规则助手，陪伴一位完全不懂跑团的新手玩家。用通俗、亲切的中文回答，一般不超过 200 字，必要时举例子。',
    '你能看到游戏记录、玩家的调查员卡和调查笔记，但看不到剧本秘密，也不要猜测或剧透剧情的真相。你不是守秘人，不能替守秘人裁定结果。',
    `\n${RULES_CHEATSHEET}`,
    trpg.sheets.player ? `\n【玩家的调查员】\n${sheetSummary(trpg.sheets.player, trpg.era)}` : '\n（玩家还没有创建调查员）',
    `\n【剧本简介】${trpg.scenarioIntro}`,
    trpg.eraLabel ? `【时代背景】${trpg.eraLabel}` : '',
    trpg.playerInfo ? `【开团须知】\n${trpg.playerInfo}` : '',
    trpg.notebook && trpg.notes.length ? `\n【调查笔记】\n${notesText(trpg.notes)}` : '',
    `\n【最近的游戏记录】\n${transcript || '（游戏还没开始）'}`,
  ]
    .filter(Boolean)
    .join('\n');

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

const UNPUSHABLE = ['幸运', '理智', '心理学', '斗殴', '闪避', '射击'];

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
  /** 新记下或更新的笔记 */
  notes: NoteEvent[];
  /** 秘密备忘有变化 */
  memosChanged: boolean;
  /** 有需要守秘人看到结果再继续的自动掷骰 */
  needContinue: boolean;
  /** 等待人类玩家掷骰的数量 */
  pendingHuman: number;
  sheetsChanged: boolean;
  problems: string[];
  /** 守秘人展示给玩家的手出物 / 地图 */
  shows: ScriptAsset[];
}

/** 解析守秘人消息里的指令，生成骰子记录（会直接修改角色卡） */
export function processKpCommands(room: Room, text: string, rng: Rng = Math.random): ProcessResult {
  const trpg = room.trpg!;
  const result: ProcessResult = {
    rolls: [],
    notes: [],
    memosChanged: false,
    needContinue: false,
    pendingHuman: 0,
    sheetsChanged: false,
    problems: [],
    shows: [],
  };
  const seen = new Set<string>();

  for (const m of text.matchAll(COMMAND_RE)) {
    const raw = m[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const kind = m[1].toUpperCase();
    const args = (m[2] ?? '')
      .split(/[:：]/)
      .map((a) => a.trim())
      .filter(Boolean);
    const mention = args.find((a) => a.startsWith('@'));
    const plain = args.filter((a) => !a.startsWith('@'));
    const key = actorKey(room, mention);
    const sheet = key ? trpg.sheets[key] : undefined;

    if (kind === '备忘') {
      if (!trpg.memo) continue;
      const parts = args.map((a) => a.replace(/^@/, ''));
      const title = parts.length >= 2 ? parts[0] : '备忘';
      const body = parts.length >= 2 ? parts.slice(1).join('：') : (parts[0] ?? '');
      if (upsertMemo(trpg.memos, title, body)) result.memosChanged = true;
      continue;
    }

    if (kind === 'NPC' || kind === '线索') {
      if (!trpg.notebook) continue; // 笔记关闭时忽略（指令仍然会从显示里去掉）
      const parts = args.map((a) => a.replace(/^@/, ''));
      let title: string;
      let body: string;
      if (parts.length >= 2) {
        title = parts[0];
        body = parts.slice(1).join('：');
      } else if (kind === '线索' && parts[0]) {
        body = parts[0];
        title = body.length > 14 ? `${body.slice(0, 14)}…` : body;
      } else {
        continue; // NPC 没有描述
      }
      const ev = upsertNote(trpg.notes, kind === 'NPC' ? 'npc' : 'clue', title, body);
      if (ev) result.notes.push(ev);
      continue;
    }

    if (kind === '展示') {
      const asset = findAsset(trpg.assets, args.join('：').replace(/^@/, ''));
      // 找不到或者是守秘人专用的就不展示（提示里不写名字，免得剧透）
      if (asset && asset.visibility === 'player') {
        asset.shown = true;
        result.shows.push(asset);
      }
      continue;
    }

    if (kind === '成长') {
      const roll = growthRecord(room);
      if (roll) result.rolls.push(roll);
      continue;
    }

    if (kind === '掷骰') {
      if (!plain[0]) continue;
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
      if (!plain[0]) continue;
      // 成功线修正：[检定:幸运:-1d20]、[检定:侦查:+10]、[检定:幸运:=35]，也可以写成 [检定:幸运-1d20]
      // 先试「技能名+修正」的写法（技能名的模糊匹配会把「侦查+10」当成侦查，修正就丢了）
      const inline = splitInlineModifier(plain[0]);
      const useInline = !!inline.modifier && resolveTarget(sheet, inline.skill).found;
      const skill = useInline ? inline.skill : plain[0];
      const mods: CheckModifier[] = [];
      if (useInline && inline.modifier) mods.push(inline.modifier);
      for (const a of plain.slice(1)) {
        const mod = parseCheckModifier(a);
        if (mod) mods.push(mod);
      }
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
      let modified: { target: number; text: string } | undefined;
      try {
        if (mods.length) modified = applyCheckModifiers(t.target, mods, rng);
      } catch (err) {
        result.problems.push(`指令 ${raw} 的修正看不懂：${err instanceof Error ? err.message : String(err)}`);
      }
      const roll: RollRecord = {
        type: 'check',
        actor: key,
        actorName: sheet.name,
        pending: true,
        label: t.name,
        target: modified ? modified.target : t.target,
        ...(modified ? { baseTarget: t.target, modifier: modified.text } : {}),
        difficulty,
        bonus: bonus || undefined,
        note: t.found ? undefined : `角色卡里没有「${skill}」，按 5 计算`,
      };
      if (!isHuman || trpg.autoRoll) {
        resolveCheck(roll, rng);
        // 自动掷骰时守秘人会马上接着描述，不再提供孤注一掷
        if (!roll.success) roll.pushable = false;
        result.needContinue = true;
      } else {
        result.pendingHuman++;
      }
      result.rolls.push(roll);
    } else if (kind === '理智' && /^[+＋]/.test(plain[0] ?? '')) {
      // [理智:+1d6] 是恢复理智（比如结局奖励），不是理智检定
      const ev = statChange(sheet, 'SAN', (plain[0] ?? '').replace('＋', '+'), rng, result);
      if (ev) result.rolls.push({ ...ev, actor: key, actorName: sheet.name });
    } else if (kind === '理智') {
      if (!plain[0]) continue;
      const [succ, fail] = plain[0].split(/[/／]/).map((x) => x.trim());
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
      const ev = statChange(sheet, stat, plain[0] ?? '', rng, result);
      if (ev) result.rolls.push({ ...ev, actor: key, actorName: sheet.name });
    }
  }
  return result;
}

/** 解析「-2」「+1d6」这样的数值变化并作用到角色卡；不写符号时默认是扣除 */
function statChange(
  sheet: InvestigatorSheet,
  stat: StatName,
  rawSpec: string,
  rng: Rng,
  result: ProcessResult,
): Omit<RollRecord, 'actor' | 'actorName'> | undefined {
  const spec = rawSpec.replace(/\s+/g, '').replace('＋', '+').replace('－', '-');
  const sign = spec.startsWith('+') ? 1 : -1;
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
    return undefined;
  }
  if (!Number.isFinite(amount) || amount === 0) return undefined;
  const { before, after, note } = applyStat(sheet, stat, sign * Math.abs(amount));
  result.sheetsChanged = true;
  return { type: 'stat', pending: false, label: stat, stat, before, after, delta: after - before, detail, note };
}

/** 这次（上一次成长检定之后）成功使用过、可以做成长检定的技能 */
export function growthCandidates(room: Room): string[] {
  const sheet = room.trpg?.sheets.player;
  if (!sheet) return [];
  let start = 0;
  room.messages.forEach((m, i) => {
    if (m.roll?.type === 'growth') start = i + 1;
  });
  const skills = new Set<string>();
  for (const m of room.messages.slice(start)) {
    const r = m.roll;
    if (r?.type === 'check' && r.actor === 'player' && r.success && r.label in sheet.skills && !NO_GROWTH.includes(r.label)) {
      skills.add(r.label);
    }
  }
  return [...skills];
}

/** 生成一张待掷的技能成长卡片；没有可以成长的技能、或者已经有一张没掷的卡片时返回 undefined */
export function growthRecord(room: Room): RollRecord | undefined {
  const sheet = room.trpg?.sheets.player;
  if (!sheet) return undefined;
  if (room.messages.some((m) => m.roll?.type === 'growth' && m.roll.pending)) return undefined;
  const skills = growthCandidates(room);
  if (skills.length === 0) return undefined;
  return {
    type: 'growth',
    actor: 'player',
    actorName: sheet.name,
    pending: true,
    label: '技能成长',
    growth: skills.map((skill) => ({ skill, before: sheet.skills[skill] })),
  };
}

/** 记下或更新一条笔记；内容没变化时返回 undefined */
export function upsertNote(notes: NoteEntry[], kind: NoteKind, rawTitle: string, rawText: string): NoteEvent | undefined {
  const title = rawTitle.trim().slice(0, 40);
  const text = rawText.trim().slice(0, 400);
  if (!title || !text) return undefined;
  const now = Date.now();
  const existing = notes.find((n) => n.kind === kind && n.title.toLowerCase() === title.toLowerCase());
  if (existing) {
    if (existing.text === text) return undefined;
    existing.text = text;
    existing.updatedAt = now;
    return { noteId: existing.id, kind, title: existing.title, text, updated: true };
  }
  const entry: NoteEntry = { id: newId(), kind, title, text, createdAt: now, updatedAt: now };
  notes.push(entry);
  return { noteId: entry.id, kind, title, text, updated: false };
}

/** 记下或更新一条秘密备忘；返回是否有变化 */
export function upsertMemo(memos: MemoEntry[], rawTitle: string, rawText: string): boolean {
  const title = rawTitle.trim().slice(0, 40);
  const text = rawText.trim().slice(0, 600);
  if (!title || !text) return false;
  const now = Date.now();
  const existing = memos.find((m) => m.title.toLowerCase() === title.toLowerCase());
  if (existing) {
    if (existing.text === text) return false;
    existing.text = text;
    existing.updatedAt = now;
    return true;
  }
  memos.push({ id: newId(), title, text, createdAt: now, updatedAt: now });
  return true;
}

export function noteText(ev: NoteEvent) {
  return `守秘人${ev.updated ? '更新了' : '记下了'}${NOTE_KIND_LABELS[ev.kind]}「${ev.title}」：${ev.text}`;
}

/** 主对话里「笔记已更新」的提示消息 */
export function noteMessage(id: string, ev: NoteEvent): Message {
  return {
    id,
    role: 'system',
    kind: 'note',
    speakerName: '笔记',
    content: noteText(ev),
    note: ev,
    status: 'done',
    createdAt: Date.now(),
  };
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
