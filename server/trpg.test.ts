import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickInvestigator, type RollRecord, type TrpgState } from '../shared/coc.ts';
import type { Message, Participant, Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { parseModel } from './llm.ts';
import { buildHumanlikeMessages, HUMANLIKE_PROMPT } from './prompt.ts';
import {
  actorKey,
  buildKpMessages,
  buildTeammateMessages,
  parseSuggestions,
  processKpCommands,
  resolveCheck,
  resolveSan,
} from './trpg.ts';

const part = (id: string, name: string, extra: Partial<Participant> = {}): Participant => ({
  id,
  name,
  avatar: '🤖',
  color: '#fff',
  model: 'm',
  reasoningEffort: '',
  bio: '',
  persona: '',
  temperature: 0.8,
  enabled: true,
  ...extra,
});

function trpgRoom(autoRoll = false): Room {
  const player = quickInvestigator({ name: '张三', occupationId: 'journalist' });
  const mate = quickInvestigator({ name: '林薇', occupationId: 'doctor' });
  const trpg: TrpgState = {
    scenarioId: 'baishui',
    scenarioTitle: 't',
    scenarioIntro: '简介',
    scenarioSecret: '【真相】秘密内容',
    era: '1920s',
    teachingMode: true,
    autoRoll,
    teammatesAct: true,
    sheets: { player, mate },
    started: true,
    assistantLog: [],
    notebook: true,
    notes: [],
  };
  return {
    id: 'r',
    mode: 'trpg',
    title: 't',
    scenario: '',
    participants: [part('kp', '守秘人', { role: 'kp' }), part('mate', '林薇', { role: 'player' })],
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS, humanName: '小明' },
    trpg,
    createdAt: 0,
    updatedAt: 0,
  };
}

const msg = (m: Partial<Message>): Message => ({
  id: Math.random().toString(36),
  role: 'human',
  speakerName: '',
  content: '',
  status: 'done',
  createdAt: 0,
  ...m,
});

test('@名字 找到对应的调查员', () => {
  const room = trpgRoom();
  assert.equal(actorKey(room), 'player');
  assert.equal(actorKey(room, '@林薇'), 'mate');
  assert.equal(actorKey(room, '@张三'), 'player');
  assert.equal(actorKey(room, '@小明'), 'player');
  assert.equal(actorKey(room, '@路人'), undefined);
});

test('玩家的检定等待掷骰，队友的检定自动掷', () => {
  const room = trpgRoom();
  const res = processKpCommands(room, '你听到声音。[检定:聆听:困难] [检定:侦查:@林薇]');
  assert.equal(res.rolls.length, 2);
  assert.equal(res.pendingHuman, 1);
  assert.equal(res.rolls[0].pending, true);
  assert.equal(res.rolls[0].difficulty, 'hard');
  assert.equal(res.rolls[0].target, room.trpg!.sheets.player.skills['聆听']);
  assert.equal(res.rolls[1].pending, false);
  assert.equal(res.rolls[1].actor, 'mate');
  assert.ok(res.rolls[1].total! >= 1 && res.rolls[1].total! <= 100);
  assert.equal(res.needContinue, true);
});

test('自动掷骰模式下玩家检定也直接出结果', () => {
  const res = processKpCommands(trpgRoom(true), '[检定:侦查]');
  assert.equal(res.pendingHuman, 0);
  assert.equal(res.rolls[0].pending, false);
});

test('数值和物品变化直接作用到角色卡', () => {
  const room = trpgRoom();
  const sheet = room.trpg!.sheets.player;
  const hp = sheet.hp.current;
  const res = processKpCommands(room, '[HP:-2] [物品:+旧钥匙] 【幸运：-5】 [物品:+旧钥匙]');
  assert.equal(sheet.hp.current, hp - 2);
  assert.ok(sheet.items.includes('旧钥匙'));
  assert.equal(res.rolls.filter((r) => r.stat === '物品').length, 1); // 重复指令只处理一次
  assert.equal(res.sheetsChanged, true);
  assert.equal(res.needContinue, false);
  processKpCommands(room, '[物品:-旧钥匙] [HP:+100]');
  assert.ok(!sheet.items.includes('旧钥匙'));
  assert.equal(sheet.hp.current, sheet.hp.max); // 不会超过上限
});

test('掷骰指令和错误的指令', () => {
  const res = processKpCommands(trpgRoom(), '[掷骰:1d6+1:阿福的伤害] [检定:侦查:@不存在]');
  assert.equal(res.rolls.length, 1);
  assert.equal(res.rolls[0].type, 'dice');
  assert.equal(res.rolls[0].note, '阿福的伤害');
  assert.equal(res.problems.length, 1);
});

test('检定结算和孤注一掷资格', () => {
  const r: RollRecord = { type: 'check', actor: 'player', actorName: '张三', pending: true, label: '侦查', target: 50 };
  resolveCheck(r, () => 0.99); // 99 → 失败
  assert.equal(r.success, false);
  assert.equal(r.pushable, true);
  const fight: RollRecord = { ...r, label: '斗殴', pending: true };
  resolveCheck(fight, () => 0.99);
  assert.equal(fight.pushable, false);
});

test('理智检定：成功和大失败', () => {
  const sheet = quickInvestigator({ occupationId: 'writer' });
  sheet.san.current = 60;
  const ok: RollRecord = { type: 'san', actor: 'player', actorName: 'x', pending: true, label: '理智', sanSuccess: '1', sanFail: '1d6' };
  resolveSan(ok, sheet, () => 0.1); // 11 → 成功
  assert.equal(ok.success, true);
  assert.equal(ok.loss, 1);
  assert.equal(sheet.san.current, 59);
  const bad: RollRecord = { ...ok, pending: true };
  resolveSan(bad, sheet, () => 0); // 00+0 = 100 → 大失败，失去最大值
  assert.equal(bad.level, 'fumble');
  assert.equal(bad.loss, 6);
  assert.match(bad.note!, /5 点以上/);
});

test('守秘人看得到剧本和玩家行动，队友看不到剧本和指令', () => {
  const room = trpgRoom();
  room.messages = [
    msg({ role: 'ai', participantId: 'kp', speakerName: '守秘人', content: '门开了。[检定:侦查]' }),
    msg({ role: 'system', kind: 'roll', content: '张三 进行「侦查」检定：掷出 20 → 成功' }),
    msg({ role: 'human', content: '我走进去', speakerName: '小明' }),
    msg({ role: 'human', content: '规则是什么？', ooc: true, speakerName: '小明' }),
  ];
  const kp = buildKpMessages(room, room.participants[0], room.messages);
  assert.match(kp[0].content, /秘密内容/);
  assert.match(kp[0].content, /\[检定:技能名\]/);
  assert.equal(kp[1].role, 'user'); // 以守秘人开头时补一条（游戏开始）
  assert.equal(kp[2].role, 'assistant');
  assert.match(kp[2].content, /\[检定:侦查\]/);
  assert.match(kp[3].content, /【骰子】/);
  assert.match(kp[3].content, /【张三（玩家）】：我走进去/);
  assert.match(kp[3].content, /（场外）】：规则是什么/);

  const mate = buildTeammateMessages(room, room.participants[1], room.messages);
  assert.doesNotMatch(mate[0].content, /秘密内容/);
  const all = mate.map((m) => m.content).join('\n');
  assert.doesNotMatch(all, /\[检定/);
  assert.doesNotMatch(all, /规则是什么/); // 场外发言不给队友看
});

test('解析行动建议', () => {
  assert.deepEqual(parseSuggestions('1. 我去茶馆\n2、我检查井口\n- 我问船夫\n多余的'), ['我去茶馆', '我检查井口', '我问船夫']);
});

test('解析 Magpie 的思考强度档位', () => {
  assert.deepEqual(
    parseModel({ id: 'a', reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }),
    { id: 'a', reasoning: true, reasoningLevels: ['low', 'high'] },
  );
  assert.deepEqual(parseModel({ id: 'b', reasoning_levels: [] }), { id: 'b', reasoningLevels: [] });
  assert.deepEqual(parseModel({ id: 'c', display_name: 'C', context_window: 1000 }), {
    id: 'c',
    name: 'C',
    contextWindow: 1000,
  });
});

test('拟人模式只有一句提示词，两人对话不加名字', () => {
  const room = { ...trpgRoom(), mode: 'chat' as const, trpg: undefined };
  const a = part('a', '甲');
  const b = part('b', '乙');
  room.participants = [a, b];
  const history = [
    msg({ role: 'ai', participantId: 'b', speakerName: '乙', content: '你好呀' }),
    msg({ role: 'ai', participantId: 'a', speakerName: '甲', content: '嗨' }),
    msg({ role: 'ai', participantId: 'b', speakerName: '乙', content: '最近怎么样' }),
  ];
  const out = buildHumanlikeMessages(room, a, history);
  assert.deepEqual(out, [
    { role: 'system', content: HUMANLIKE_PROMPT },
    { role: 'user', content: '你好呀' },
    { role: 'assistant', content: '嗨' },
    { role: 'user', content: '最近怎么样' },
  ]);
  // 有第三个人（人类）加入后才带名字
  history.push(msg({ role: 'human', speakerName: '小明', content: '我也来' }));
  const out2 = buildHumanlikeMessages(room, a, history);
  assert.match(out2.at(-1)!.content, /乙：最近怎么样\n\n小明：我也来/);
});

test('笔记：记下、更新、重复不提示、关闭时忽略', () => {
  const room = trpgRoom();
  const notes = room.trpg!.notes;
  let res = processKpCommands(room, '周婶抬头看了你一眼。[NPC:周婶:茶馆老板娘，热心但胆小] [线索:沈怀瑾住在陆家老宅的厢房]');
  assert.equal(res.notes.length, 2);
  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((n) => [n.kind, n.title]),
    [
      ['npc', '周婶'],
      ['clue', '沈怀瑾住在陆家老宅的厢房'],
    ],
  );
  assert.equal(res.rolls.length, 0);
  assert.equal(res.needContinue, false);

  res = processKpCommands(room, '[NPC:周婶:茶馆老板娘，热心但胆小，知道七月十五要祭井]');
  assert.equal(res.notes[0].updated, true);
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /祭井/);

  res = processKpCommands(room, '[NPC:周婶:茶馆老板娘，热心但胆小，知道七月十五要祭井]');
  assert.equal(res.notes.length, 0); // 内容没变不重复提示

  res = processKpCommands(room, '[线索:这是一条很长很长的线索内容，标题会被截断成十四个字]');
  assert.match(res.notes[0].title, /…$/);

  room.trpg!.notebook = false;
  res = processKpCommands(room, '[NPC:阿青:族长的孙女]');
  assert.equal(res.notes.length, 0);
  assert.equal(notes.length, 3);
});

test('提示词：系统提示不含会变的数值，状态和笔记在最后一条消息里', () => {
  const room = trpgRoom();
  room.trpg!.notes.push({ id: 'n1', kind: 'clue', title: '井里的歌声', text: '子时能听到歌声', createdAt: 0, updatedAt: 0 });
  room.messages = [
    msg({ role: 'ai', participantId: 'kp', speakerName: '守秘人', content: '你来到茶馆。' }),
    msg({ role: 'human', content: '我找老板娘聊天', speakerName: '小明' }),
    msg({ role: 'system', kind: 'note', content: '守秘人记下了线索「井里的歌声」：子时能听到歌声' }),
  ];
  const kp = buildKpMessages(room, room.participants[0], room.messages);
  const system = kp[0].content;
  assert.match(system, /玩家随时可以翻看/); // 告诉守秘人玩家能看到笔记
  assert.match(system, /剧本真相.*一律不能写进笔记/);
  assert.doesNotMatch(system, /HP \d+\/\d+/); // 数值不在系统提示里
  const last = kp.at(-1)!.content;
  assert.match(last, /【当前状态】/);
  assert.match(last, /HP \d+\/\d+/);
  assert.match(last, /井里的歌声：子时能听到歌声/);
  // 笔记提示消息不会进入历史
  assert.doesNotMatch(kp.map((m) => m.content).join('\n'), /守秘人记下了/);

  // 扣血之后：系统提示和之前的历史完全不变（提示缓存可以命中），只有最后一条变化
  processKpCommands(room, '[HP:-2]');
  const after = buildKpMessages(room, room.participants[0], room.messages);
  assert.equal(after[0].content, system);
  assert.deepEqual(after.slice(0, -1), kp.slice(0, -1));
  assert.notEqual(after.at(-1)!.content, last);

  // 关闭笔记后，系统提示里没有笔记说明
  room.trpg!.notebook = false;
  assert.doesNotMatch(buildKpMessages(room, room.participants[0], room.messages)[0].content, /守秘人笔记】/);
});

test('队友：自己的数值和共享笔记在最后一条消息里', () => {
  const room = trpgRoom();
  room.trpg!.notes.push({ id: 'n1', kind: 'npc', title: '周婶', text: '茶馆老板娘', createdAt: 0, updatedAt: 0 });
  room.messages = [msg({ role: 'ai', participantId: 'kp', speakerName: '守秘人', content: '你们走进茶馆。[NPC:周婶:茶馆老板娘]' })];
  const out = buildTeammateMessages(room, room.participants[1], room.messages);
  assert.doesNotMatch(out[0].content, /HP \d+\/\d+/);
  assert.match(out.at(-1)!.content, /【你的调查员当前状态】[\s\S]*HP \d+\/\d+/);
  assert.match(out.at(-1)!.content, /【调查笔记】[\s\S]*周婶：茶馆老板娘/);
  assert.doesNotMatch(out.map((m) => m.content).join('\n'), /\[NPC/);
});

test('提醒守秘人不要替调查员说话：系统提示写明边界，最后一条消息再提醒一次', () => {
  const room = trpgRoom();
  room.messages = [msg({ role: 'human', content: '我准备先住下', speakerName: '小明' })];
  const kp = buildKpMessages(room, room.participants[0], room.messages);
  assert.match(kp[0].content, /玩家和 AI 队友（「张三」、「林薇」）都会自己发言/);
  assert.match(kp[0].content, /可以描述外界对他们的影响/); // 允许描写影响和结果，不过度限制
  assert.match(kp.at(-1)!.content, /「林薇」会在你之后自己发言，不要替TA说台词或决定行动。）$/);
});
