// 用模拟模型跑真实的调度流程，复现实际跑团记录里出现过的问题

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { quickInvestigator } from '../shared/coc.ts';
import type { Participant, Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { onModelRequest, RunnerManager } from './runner.ts';
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

test('多人对话里的推理模型：记录思考用时、服务商报告的输出 token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-think-'));
  const store = new Store(dir);
  store.saveSettings({ baseUrl: 'mock', defaultModel: 'mock/fast' });
  const room: Room = {
    id: 'c1',
    mode: 'chat',
    title: 't',
    scenario: '聊聊天',
    participants: [
      { id: 'a', name: '阿青', avatar: '🤖', color: '#fff', model: 'mock/thinker', reasoningEffort: 'high', bio: '', persona: '', temperature: 1, enabled: true },
    ],
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS, turnMode: 'manual' },
    createdAt: 0,
    updatedAt: 0,
  };
  store.addRoom(room);
  const runner = new RunnerManager(store).get('c1');
  const deltas: number[] = [];
  runner.subscribe((ev) => ev.type === 'message_delta' && ev.thinkMs !== undefined && deltas.push(ev.thinkMs));
  try {
    const r = store.getRoom('c1')!;
    runner.requestTurn('a');
    await until(() => r.messages.some((m) => m.status === 'done'));
    const m = r.messages[0];
    assert.match(m.reasoning ?? '', /模拟思考/);
    assert.ok((m.thinkMs ?? 0) >= 1000, `思考用时 ${m.thinkMs}`);
    assert.deepEqual(deltas, [m.thinkMs]);
    assert.ok((m.outputTokens ?? 0) > 0, '记下了服务商报告的输出 token');
    assert.equal(m.reasoningTokens, 60);
  } finally {
    runner.dispose();
    await sleep(100);
    store.flushAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 相邻两次请求：后一次 = 前一次（最后那条消息也一字不差）+ 模型的回复 + 新内容 */
function assertAppendOnly(label: string, reqs: { role: string; content: unknown }[][]) {
  for (let k = 1; k < reqs.length; k++) {
    const a = reqs[k - 1];
    const b = reqs[k];
    assert.ok(b.length >= a.length + 2, `${label}第 ${k + 1} 次请求比上一次长`);
    assert.deepEqual(b.slice(0, a.length), a, `${label}第 ${k + 1} 次请求的前缀和上一次一字不差`);
    assert.equal(b[a.length].role, 'assistant', `${label}紧接着是模型上一轮的回复`);
  }
}

test('提示缓存（跑团）：守秘人和 AI 队友每次请求都是上一次请求 + 回复原样不动；状态只发变化的部分', async () => {
  const { room, runner, cleanup } = setup();
  const sent = new Map<string, { role: string; content: unknown }[][]>();
  onModelRequest((roomId, pid, messages) => {
    if (roomId === room.id) sent.set(pid, [...(sent.get(pid) ?? []), structuredClone(messages)]);
  });
  const lastOf = (r: { content: unknown }[]) => String(r.at(-1)!.content);
  try {
    for (let round = 0; round < 3; round++) {
      const gyBefore = room.messages.filter((m) => m.participantId === 'gy' && m.status === 'done').length;
      runner.addHumanMessage(`我沿着码头往前走（第 ${round + 1} 次）`);
      await until(() => !!pendingRoll(room));
      withRandom(0.1, () => runner.resolveRoll(pendingRoll(room)!.id));
      await until(() => room.messages.filter((m) => m.participantId === 'gy' && m.status === 'done').length > gyBefore);
      await until(() => !runner.state().generating);
    }
    const kp = sent.get('kp')!;
    const gy = sent.get('gy')!;
    assert.ok(kp.length >= 6 && gy.length >= 3, `守秘人 ${kp.length} 次、队友 ${gy.length} 次请求`);
    assertAppendOnly('守秘人', kp);
    assertAppendOnly('队友', gy);

    // 状态：第一次完整，之后只发有变化的部分；记了线索以后笔记那一部分重新发
    assert.match(lastOf(kp[0]), /【当前状态】（程序自动更新，数值以这里为准）/);
    assert.ok(kp.slice(1).every((r) => !lastOf(r).includes('【当前状态】（程序自动更新')), '之后不再附完整状态');
    assert.ok(kp.slice(1).some((r) => /【当前状态更新】[\s\S]*守秘人笔记[\s\S]*雾中的歌声/.test(lastOf(r))), '笔记变了就重新发笔记');
    assert.ok(kp.slice(1).some((r) => lastOf(r).includes('（角色卡、笔记和备忘和上一轮一样，没有变化）')), '没变化时只说一句');
    assert.ok(kp.every((r) => /【关键数值】（以这里为准）「凤笙休」HP \d+\/\d+/.test(lastOf(r))), '每一轮都附关键数值');

    // 改了一条已经发过的消息：那一轮对不上，状态链断了，下一次重新附完整状态
    room.messages.find((m) => m.role === 'human')!.content += '（改过）';
    const n = kp.length;
    runner.addHumanMessage('我回头看看');
    await until(() => (sent.get('kp')?.length ?? 0) > n);
    const after = sent.get('kp')![n];
    assert.match(lastOf(after), /【当前状态】（程序自动更新，数值以这里为准）/);
    assert.ok(after.some((m) => String(m.content).includes('（改过）')), '编辑后的内容发给了模型');
  } finally {
    onModelRequest(undefined);
    await cleanup();
  }
});

test('提示缓存（多人对话、拟人模式）：每个 AI 的每次请求都是上一次请求 + 回复原样不动', async () => {
  for (const promptMode of ['standard', 'humanlike'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-prefix-'));
    const store = new Store(dir);
    store.saveSettings({ baseUrl: 'mock', defaultModel: 'mock/fast' });
    const ai = (id: string, name: string): Participant => ({ id, name, avatar: '🤖', color: '#fff', model: 'mock/fast', reasoningEffort: '', bio: '', persona: '', temperature: 1, enabled: true });
    store.addRoom({
      id: 'p1',
      mode: 'chat',
      title: 't',
      scenario: '聊聊天',
      participants: [ai('a', '阿青'), ai('b', '白石')],
      messages: [],
      settings: { ...DEFAULT_ROOM_SETTINGS, turnMode: 'manual', promptMode },
      createdAt: 0,
      updatedAt: 0,
    });
    const runner = new RunnerManager(store).get('p1');
    const r = store.getRoom('p1')!;
    const sent = new Map<string, { role: string; content: unknown }[][]>();
    onModelRequest((roomId, pid, messages) => {
      if (roomId === 'p1') sent.set(pid, [...(sent.get(pid) ?? []), structuredClone(messages)]);
    });
    try {
      const done = () => r.messages.filter((m) => m.status === 'done' && m.role === 'ai').length;
      for (const [i, who] of ['a', 'a', 'b', 'a', 'b', 'b', 'a'].entries()) {
        if (i === 3) runner.addHumanMessage('你们俩怎么看？');
        const n = done();
        runner.requestTurn(who);
        await until(() => done() > n && !runner.state().generating);
      }
      assertAppendOnly(`${promptMode} 阿青`, sent.get('a')!);
      assertAppendOnly(`${promptMode} 白石`, sent.get('b')!);
    } finally {
      onModelRequest(undefined);
      runner.dispose();
      await sleep(100);
      store.flushAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('阶梯式裁剪 + 前情提要：涨满才裁、写一次提要；两次裁剪之间每次请求都是上一次 + 回复，提要不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-cut-'));
  const store = new Store(dir);
  store.saveSettings({ baseUrl: 'mock', defaultModel: 'mock/fast' });
  store.addRoom({
    id: 'c2',
    mode: 'chat',
    title: 't',
    scenario: '聊聊天',
    participants: [{ id: 'a', name: '阿青', avatar: '🤖', color: '#fff', model: 'mock/tiny', reasoningEffort: '', bio: '', persona: '', temperature: 1, enabled: true }],
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS, turnMode: 'manual' },
    createdAt: 0,
    updatedAt: 0,
  });
  const runner = new RunnerManager(store).get('c2');
  const r = store.getRoom('c2')!;
  const reqs: { role: string; content: unknown }[][] = [];
  onModelRequest((roomId, _pid, messages) => roomId === 'c2' && reqs.push(structuredClone(messages)));
  const notices: string[] = [];
  runner.subscribe((ev) => ev.type === 'notice' && notices.push(ev.text));
  try {
    for (let i = 0; i < 14; i++) {
      runner.addHumanMessage(`第 ${i + 1} 段：${'今天天气不错，我们聊聊最近读的书和看过的电影吧。'.repeat(5)}`);
      const n = r.messages.filter((m) => m.role === 'ai' && m.status === 'done').length;
      runner.requestTurn('a');
      await until(() => r.messages.filter((m) => m.role === 'ai' && m.status === 'done').length > n && !runner.state().generating);
    }
    const first = (q: { role: string; content: unknown }[]) => String(q.find((m) => m.role !== 'system')!.content);
    const preface = (q: { role: string; content: unknown }[]) => first(q).match(/^（为了控制上下文长度[\s\S]*?(?:【前情提要结束】|已省略。）)/)?.[0] ?? '';
    const cuts = new Set(reqs.map(preface));
    assert.ok(cuts.size >= 2, '裁剪过');
    // 这个模拟模型的上下文只有 6k，每轮涨约 250 token，挪一次能撑两三轮；真实的 256k 模型一次能撑几十轮
    assert.ok(cuts.size - 1 <= 8, `14 轮里裁剪了 ${cuts.size - 1} 次，不是每轮都裁`);
    assert.ok(reqs.some((q) => /【前情提要】\n（模拟前情提要）/.test(first(q))), '裁掉的部分写成了前情提要');
    assert.match(r.contextCuts?.a?.summary ?? '', /模拟前情提要/);
    assert.ok(notices.some((t) => t.includes('整理成前情提要')));
    // 后面的提要接着前面的写
    assert.ok(reqs.some((q) => /接着更早的提要/.test(first(q))), '第二次裁剪时把之前的提要一起整理');
    // 两次裁剪之间：每次请求都是上一次 + 回复，原样不动
    let pairs = 0;
    for (let k = 1; k < reqs.length; k++) {
      if (preface(reqs[k]) !== preface(reqs[k - 1])) continue;
      assertAppendOnly(`第 ${k + 1} 次`, [reqs[k - 1], reqs[k]]);
      pairs++;
    }
    assert.ok(pairs >= 5, `${pairs} 对相邻请求在同一个裁剪点`);
    // 裁剪点存在房间里：重启后（新的 runner）接着用
    store.flushAll();
    const reloaded = new Store(dir).getRoom('c2')!;
    assert.deepEqual(reloaded.contextCuts, r.contextCuts);
  } finally {
    onModelRequest(undefined);
    runner.dispose();
    await sleep(100);
    store.flushAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
