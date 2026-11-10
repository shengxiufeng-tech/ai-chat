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
