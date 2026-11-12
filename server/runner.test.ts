// 用模拟模型跑真实的调度流程，复现实际跑团记录里出现过的问题

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { quickInvestigator } from '../shared/coc.ts';
import type { Participant, Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { RunnerManager } from './runner.ts';
import { Store } from './store.ts';
import { encodeJpeg } from './images.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-runner-'));
  const store = new Store(dir);
  store.saveSettings({ baseUrl: 'mock', defaultModel: 'mock/fast' });
  const p = (id: string, name: string, role: 'kp' | 'player'): Participant => ({
    id,
    name,
    avatar: '🤖',
    color: '#fff',
    model: 'mock/fast',
    reasoningEffort: '',
    bio: '',
    persona: '',
    temperature: 1,
    enabled: true,
    role,
  });
  const player = quickInvestigator({ name: '凤笙休', occupationId: 'journalist' });
  player.skills['侦查'] = 60;
  const room: Room = {
    id: 'r1',
    mode: 'trpg',
    title: 't',
    scenario: '',
    participants: [p('kp', '守秘人', 'kp'), p('gy', '顾远', 'player')],
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS, turnMode: 'manual' },
    trpg: {
      scenarioId: 'baishui',
      scenarioTitle: 't',
      scenarioIntro: 'i',
      scenarioSecret: 's',
      era: '1920s',
      teachingMode: false,
      autoRoll: false,
      teammatesAct: true,
      sheets: { player, gy: quickInvestigator({ name: '顾远', occupationId: 'writer' }) },
      started: true,
      assistantLog: [],
      notebook: true,
      notes: [],
      memo: true,
      memos: [],
    },
    createdAt: 0,
    updatedAt: 0,
  };
  store.addRoom(room);
  const runner = new RunnerManager(store).get('r1');
  const cleanup = async () => {
    runner.dispose();
    // 等被打断的生成收尾（它还会保存一次房间），再删除临时目录
    for (let i = 0; i < 100 && runner.state().generating; i++) await sleep(20);
    await sleep(300);
    store.flushAll();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, room: store.getRoom('r1')!, runner, cleanup };
}

async function until(fn: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await sleep(20);
  }
}

/** 用固定的随机数掷骰 */
function withRandom<T>(value: number, fn: () => T): T {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

const kpCount = (room: Room) => room.messages.filter((m) => m.participantId === 'kp' && m.status === 'done').length;
const pendingRoll = (room: Room) => room.messages.find((m) => m.roll?.pending);

test('检定失败后先等玩家决定：守秘人不会提前描述失败的后果', async () => {
  const { room, runner, cleanup } = setup();
  try {
    runner.addHumanMessage('我四处看看');
    await until(() => !!pendingRoll(room));
    const roll = pendingRoll(room)!;
    withRandom(0.75, () => runner.resolveRoll(roll.id)); // 77 > 60 → 失败
    assert.equal(roll.roll!.decision, 'pending');
    const kpBefore = kpCount(room);
    const rollIdx = room.messages.indexOf(roll);
    await sleep(600);
    assert.equal(
      room.messages.slice(rollIdx + 1).filter((m) => m.participantId === 'kp').length,
      0,
      '玩家还没决定，守秘人不应该接着说',
    );

    // 选择孤注一掷，并说明怎么更努力
    withRandom(0.1, () => runner.pushRoll(roll.id, '我趴在地上一寸一寸地摸')); // 11 → 成功
    assert.equal(roll.roll!.decision, 'pushed');
    const said = room.messages.find((m) => m.role === 'human' && m.content.includes('一寸一寸'));
    assert.ok(said, '玩家的说明要发给守秘人');
    await until(() => kpCount(room) > kpBefore);
  } finally {
    await cleanup();
  }
});

test('不做选择、直接输入新行动，视为接受失败', async () => {
  const { room, runner, cleanup } = setup();
  try {
    runner.addHumanMessage('我四处看看');
    await until(() => !!pendingRoll(room));
    const roll = pendingRoll(room)!;
    withRandom(0.75, () => runner.resolveRoll(roll.id));
    assert.equal(roll.roll!.decision, 'pending');
    runner.addHumanMessage('算了，我去茶馆坐坐');
    assert.equal(roll.roll!.decision, 'accepted');
    assert.match(roll.content, /玩家接受了失败/);
  } finally {
    await cleanup();
  }
});

test('守秘人要求掷骰时，已经排队的队友不会抢先说话', async () => {
  const { room, runner, cleanup } = setup();
  try {
    runner.addHumanMessage('我四处看看');
    await until(() => !!pendingRoll(room));
    const first = pendingRoll(room)!;
    withRandom(0.1, () => runner.resolveRoll(first.id)); // 成功 → 守秘人接着描述（这一段没有新的检定）
    await until(() => room.messages.some((m) => m.participantId === 'kp' && m.status === 'streaming'));
    // 守秘人说话期间，又让守秘人说一句（实际中是玩家在这时点了孤注一掷）
    runner.requestTurn('kp');
    // 第一段说完后队友排进队列；第二段守秘人会要求新的检定
    await until(() => room.messages.filter((m) => m.roll?.pending).length === 1 && kpCount(room) >= 3);
    await sleep(800);
    const idx = room.messages.findIndex((m) => m.roll?.pending);
    assert.ok(idx >= 0, '检定还在等玩家');
    const after = room.messages.slice(idx + 1).filter((m) => m.participantId === 'gy');
    assert.equal(after.length, 0, '检定没掷之前队友不应该说话');
    // 掷完之后，守秘人描述结果，然后队友再行动
    withRandom(0.1, () => runner.resolveRoll(room.messages[idx].id));
    await until(() => room.messages.slice(idx + 1).some((m) => m.participantId === 'gy' && m.status === 'done'));
    const order = room.messages.slice(idx + 1).filter((m) => m.role === 'ai').map((m) => m.participantId);
    assert.deepEqual(order.slice(0, 2), ['kp', 'gy']);
  } finally {
    await cleanup();
  }
});

test('构思 / 执笔：构思模型决定内容和指令，执笔模型写成文字', async () => {
  const { room, runner, cleanup } = setup();
  try {
    const kp = room.participants.find((p) => p.id === 'kp')!;
    kp.planner = { enabled: true, model: 'mock/thinker', reasoningEffort: 'high' };
    room.trpg!.started = false;
    runner.startTrpg();
    await until(() => kpCount(room) >= 1);
    const msg = room.messages.find((m) => m.participantId === 'kp')!;
    assert.deepEqual(msg.planner, { model: 'mock/thinker', reasoningEffort: 'high' });
    assert.equal(msg.model, 'mock/fast', '消息的模型是执笔模型');
    assert.match(msg.plan ?? '', /模拟构思/);
    assert.match(msg.content, /^（照构思执笔）/);
    assert.equal(msg.planning, undefined);
    assert.equal(msg.planError, undefined);
    // 执笔模型自己写了 [NPC] 和 [备忘]，但只执行构思里的 [NPC]
    assert.ok(room.trpg!.notes.some((n) => n.title === '老船夫'));
    assert.equal(room.trpg!.memos.length, 0, '执笔模型写的备忘不算');
    assert.doesNotMatch(msg.content, /备忘/);
  } finally {
    await cleanup();
  }
});

test('构思 / 执笔：构思模型出错时，由执笔模型单独写完这一轮', async () => {
  const { room, runner, cleanup } = setup();
  try {
    const kp = room.participants.find((p) => p.id === 'kp')!;
    kp.planner = { enabled: true, model: 'mock/broken', reasoningEffort: '' };
    runner.addHumanMessage('我四处看看');
    await until(() => kpCount(room) >= 1);
    const msg = room.messages.find((m) => m.participantId === 'kp')!;
    assert.match(msg.planError ?? '', /模拟的服务错误/);
    assert.doesNotMatch(msg.content, /照构思/);
    assert.ok(pendingRoll(room), '执笔模型自己的检定指令照常生效');
  } finally {
    await cleanup();
  }
});

test('构思开关关着时，和原来完全一样', async () => {
  const { room, runner, cleanup } = setup();
  try {
    const kp = room.participants.find((p) => p.id === 'kp')!;
    kp.planner = { enabled: false, model: 'mock/thinker', reasoningEffort: '' };
    runner.addHumanMessage('我四处看看');
    await until(() => kpCount(room) >= 1);
    const msg = room.messages.find((m) => m.participantId === 'kp')!;
    assert.equal(msg.planner, undefined);
    assert.equal(msg.plan, undefined);
    assert.doesNotMatch(msg.content, /照构思/);
  } finally {
    await cleanup();
  }
});

test('孤注一掷沿用修正后的成功线，不重新掷修正骰', async () => {
  const { room, runner, cleanup } = setup();
  try {
    runner.addHumanMessage('我四处看看');
    await until(() => !!pendingRoll(room));
    const roll = pendingRoll(room)!;
    // 模拟守秘人按剧本调整了成功线
    roll.roll!.baseTarget = 60;
    roll.roll!.modifier = '-20';
    roll.roll!.target = 40;
    withRandom(0.75, () => runner.resolveRoll(roll.id)); // 77 > 40 → 失败
    assert.equal(roll.roll!.decision, 'pending');
    const pushed = withRandom(0.5, () => runner.pushRoll(roll.id));
    assert.equal(pushed.roll!.target, 40);
    assert.equal(pushed.roll!.baseTarget, 60);
    assert.equal(pushed.roll!.modifier, '-20');
  } finally {
    await cleanup();
  }
});

test('剧本图片：守秘人能看到地图图片，[展示] 把手出物给玩家看', async () => {
  const { store, room, runner, cleanup } = setup();
  try {
    room.trpg!.assets = [
      { id: 'map1', kind: 'map', title: '宅邸一楼', description: '大厅、书房、楼梯', visibility: 'keeper', page: 3, width: 8, height: 8 },
      { id: 'h1', kind: 'handout', title: '旧报纸剪报', description: '1918 年的火灾报道', visibility: 'player', page: 4, width: 8, height: 8 },
    ];
    const file = store.assetPath(room.id, 'map1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeJpeg({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(200) }));
    const kp = room.participants.find((p) => p.role === 'kp')!;
    room.messages.push({ id: 'h', role: 'human', speakerName: '我', content: '我进门', status: 'done', createdAt: 1 });

    // 地图附在第一条消息里；系统提示里有图片清单
    const msgs = (runner as any).buildMessages(room, kp, room.messages);
    assert.match(msgs[0].content, /【剧本里的手出物和地图】[\s\S]*手出物「旧报纸剪报」（可以展示给玩家）/);
    assert.match(msgs[0].content, /地图「宅邸一楼」（守秘人专用，不能展示）/);
    assert.ok(Array.isArray(msgs[1].content), '第一条消息带图片');
    assert.equal(msgs[1].content.filter((p: { type: string }) => p.type === 'image_url').length, 1);
    room.trpg!.mapsToKp = false;
    assert.equal(typeof (runner as any).buildMessages(room, kp, room.messages)[1].content, 'string', '关掉以后不附图片');
    room.messages = [];

    // [展示:旧报纸剪报] → 对话里出现手出物
    runner.addHumanMessage('测试展示');
    await until(() => room.messages.some((m) => m.kind === 'handout'));
    const shown = room.messages.find((m) => m.kind === 'handout')!;
    assert.deepEqual(shown.asset, { id: 'h1', title: '旧报纸剪报', kind: 'handout' });
    assert.equal(room.trpg!.assets![1].shown, true);
    assert.equal(room.trpg!.assets![0].shown, undefined);
  } finally {
    await cleanup();
  }
});
