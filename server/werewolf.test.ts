// 狼人杀：用模拟模型跑完整对局（各种板子、全员 AI / 有人类玩家），检查流程、信息隔离和中途停止
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BOARDS, isWolf, type WerewolfState } from '../shared/werewolf.ts';
import { RunnerManager } from './runner.ts';
import { Store } from './store.ts';
import { createWerewolfRoom, humanPrompt, parseChoice, parseSpeechActions, playerMessages, type WerewolfCreateOptions } from './werewolf.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(o: WerewolfCreateOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-ww-'));
  const store = new Store(dir);
  store.saveSettings({ baseUrl: 'mock', defaultModel: 'mock/fast' });
  const room = createWerewolfRoom(o, 'mock/fast');
  room.werewolf!.pace = 0;
  store.addRoom(room);
  const runner = new RunnerManager(store).get(room.id);
  const notices: string[] = [];
  runner.subscribe((ev) => ev.type === 'notice' && ev.level === 'error' && notices.push(ev.text));
  const cleanup = async () => {
    runner.dispose();
    await sleep(100);
    store.flushAll();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, room: store.getRoom(room.id)!, runner, notices, cleanup };
}

/** 跑到结束；有人类玩家时自动替 TA 做决定 */
async function playOut(ctx: ReturnType<typeof setup>, ms = 30000) {
  const { room, runner } = ctx;
  const ww = () => room.werewolf as WerewolfState;
  runner.run();
  const start = Date.now();
  let asked = 0;
  let spoke = 0;
  while (ww().phase !== 'end') {
    if (Date.now() - start > ms) throw new Error(`对局超时：第 ${ww().day} 天 ${ww().phase}，当前 ${JSON.stringify(ww().current)}`);
    const p = ww().pending;
    if (p) {
      asked++;
      if (p.kind === 'speech') spoke++;
      const answer =
        p.kind === 'target'
          ? { target: p.options[0] ?? null }
          : p.kind === 'witch'
            ? { action: 'none' as const }
            : p.kind === 'yesno'
              ? { yes: false }
              : { text: '我是好人，大家冷静分析。', target: p.killOptions?.[0] };
      runner.werewolfAnswer(p.id, answer);
    }
    if (runner.state().status === 'paused' && ww().phase !== 'end') throw new Error(`对局停下了：${ctx.notices.join(' / ')}`);
    await sleep(5);
  }
  return { asked, spoke };
}

test('解析 AI 的选择和发言里的动作', () => {
  assert.equal(parseChoice('【选择:5号】\n理由', [3, 5], false), 5);
  assert.equal(parseChoice('选择：3', [3, 5], false), 3);
  assert.equal(parseChoice('【选择:不选】', [3, 5], true), null);
  assert.equal(parseChoice('【选择:9号】', [3, 5], true), undefined, '不在可选范围里');
  assert.equal(parseChoice('<think>【选择:5号】</think>【选择:3号】', [3, 5], false), 3, '忽略思考过程');
  const r = parseSpeechActions('我觉得 3 号是狼。\n【自爆:4号】');
  assert.deepEqual([r.content, r.explode, r.explodeTarget], ['我觉得 3 号是狼。', true, 4]);
  assert.equal(parseSpeechActions('【决斗：6号】').duel, 6);
  assert.equal(parseSpeechActions('刀他\n【刀:2号】').kill, 2);
  assert.equal(parseSpeechActions('【刀:空刀】').kill, null);
});

test('给人类看的提示不带 AI 的格式要求', () => {
  assert.equal(humanPrompt('【任务：狼人夜聊】现在是第 1 夜，商量今晚杀谁。简短说一两句，最后单独一行写【刀:N号】。可选：1号、2号。'), '现在是第 1 夜，商量今晚杀谁。');
  assert.equal(humanPrompt('【任务：发言】轮到你（3号）发言。如果你决定自爆，在发言最后单独写【自爆】，一般不需要自爆。'), '轮到你（3号）发言。');
});

for (const board of BOARDS) {
  test(`全员 AI 跑完一局：${board.name}`, async () => {
    const ctx = setup({ boardId: board.id, join: false, sheriff: true });
    try {
      await playOut(ctx);
      const ww = ctx.room.werewolf!;
      assert.ok(ww.winner, '有胜负');
      const living = ww.seats.filter((s) => s.alive);
      if (ww.winner === 'village') assert.ok(!living.some((s) => isWolf(s.role)), '好人赢时没有活着的狼人');
      assert.deepEqual(ctx.notices, []);
      assert.ok(ctx.room.messages.some((m) => m.ww?.type === 'vote' || m.ww?.type === 'end'));
      assert.ok(ctx.room.messages.some((m) => m.visibility === 'wolves'), '有狼队频道的消息');
      assert.equal(ww.current, undefined);
    } finally {
      await ctx.cleanup();
    }
  });
}

test('人类玩家参加：轮到你时等你做决定', async () => {
  const ctx = setup({ boardId: 'nine', join: true, humanName: '小明', sheriff: true });
  try {
    const me = ctx.room.werewolf!.humanSeat!;
    assert.ok(me >= 1 && me <= 9);
    assert.equal(ctx.room.participants.length, 8, '其余 8 个座位是 AI');
    const { asked, spoke } = await playOut(ctx);
    assert.ok(asked > 0, '至少问过你一次（上警）');
    // 你说过几次话，记录里就有几条你座位上的发言（有可能还没轮到你就出局了）
    assert.equal(ctx.room.messages.filter((m) => m.role === 'human' && m.ww?.seat === me).length, spoke);
  } finally {
    await ctx.cleanup();
  }
});

test('信息隔离：好人看不到狼队频道和别人的夜间结果，狼人能看到队友', async () => {
  const ctx = setup({ boardId: 'nine', join: false, sheriff: false });
  try {
    await playOut(ctx);
    const ww = ctx.room.werewolf!;
    const villager = ww.seats.find((s) => s.role === 'villager')!;
    const wolf = ww.seats.find((s) => s.role === 'werewolf')!;
    const seer = ww.seats.find((s) => s.role === 'seer')!;
    const text = (seat: number) => playerMessages(ctx.room, seat).map((m) => m.content).join('\n');
    const v = text(villager.seat);
    assert.doesNotMatch(v, /模拟狼人|狼人今晚决定|你查验了|守卫（|你用解药|你用毒药/, '平民只看得到公开信息');
    assert.doesNotMatch(playerMessages(ctx.room, villager.seat)[0].content, /狼队友/);
    const w = text(wolf.seat);
    assert.match(playerMessages(ctx.room, wolf.seat)[0].content, /你的狼队友：/);
    if (ww.nights.length) assert.match(w, /狼队频道|狼队夜聊|【刀/, '狼人看得到夜聊');
    assert.doesNotMatch(w, /你查验了/);
    if (ww.nights.some((n) => n.check)) assert.match(text(seer.seat), /你查验了/);
  } finally {
    await ctx.cleanup();
  }
});

test('中途停止再继续：从停下的那一步接着来', async () => {
  const ctx = setup({ boardId: 'six', join: false });
  try {
    ctx.runner.run();
    await sleep(150);
    ctx.runner.stop();
    await sleep(100);
    assert.equal(ctx.runner.state().status, 'paused');
    const ww = ctx.room.werewolf!;
    assert.notEqual(ww.phase, 'setup');
    const before = ctx.room.messages.length;
    await playOut(ctx);
    assert.ok(ctx.room.messages.length > before);
    assert.ok(ww.winner);
    // 结束后不能再「继续」
    assert.throws(() => ctx.runner.run(), /已经结束/);
  } finally {
    await ctx.cleanup();
  }
});

for (const narration of ['fixed', 'ai'] as const) {
  test(`AI 说到一半时暂停：不报错，去掉没说完的话（播报：${narration}）`, async () => {
    const ctx = setup({ boardId: 'six', join: false, narration });
    try {
      ctx.runner.run();
      // 等到有一条正在生成的消息（AI 发言或主持人播报）
      const streaming = () => ctx.room.messages.find((m) => m.status === 'streaming' && (narration === 'ai' ? m.kind === 'ww' : m.role === 'ai'));
      for (let i = 0; i < 1000 && !streaming(); i++) await sleep(2);
      assert.ok(streaming(), '等到了正在生成的消息');
      ctx.runner.stop();
      await sleep(100);
      assert.equal(ctx.runner.state().status, 'paused');
      assert.deepEqual(ctx.notices, [], '暂停不是出错');
      assert.ok(!ctx.room.messages.some((m) => m.status === 'streaming'), '没说完的话被去掉了');
      assert.ok(ctx.room.werewolf!.current, '记得停在哪一步');
      await playOut(ctx);
      assert.ok(ctx.room.werewolf!.winner);
      assert.deepEqual(ctx.notices, []);
    } finally {
      await ctx.cleanup();
    }
  });
}

test('推理模型的发言：记录思考过程和用时，写正文时把用时推给前端', async () => {
  const ctx = setup({ boardId: 'six', join: false, sheriff: false, model: 'mock/thinker' });
  const deltas: number[] = [];
  ctx.runner.subscribe((ev) => ev.type === 'message_delta' && ev.thinkMs !== undefined && deltas.push(ev.thinkMs));
  try {
    ctx.runner.run();
    const spoken = () => ctx.room.messages.find((m) => m.role === 'ai' && m.status === 'done');
    for (let i = 0; i < 1000 && !spoken(); i++) await sleep(5);
    const m = spoken();
    assert.ok(m, '有一条说完的发言');
    assert.match(m!.reasoning ?? '', /模拟思考/);
    assert.ok((m!.thinkMs ?? 0) >= 1000, `思考用时 ${m!.thinkMs}`);
    assert.ok(deltas.includes(m!.thinkMs!), '用时随增量发给了前端');
  } finally {
    await ctx.cleanup();
  }
});

test('白痴被投票放逐：翻牌免死，之后不能投票', async () => {
  const ctx = setup({ boardId: 'twelve-idiot', join: false, sheriff: false });
  try {
    const ww = ctx.room.werewolf!;
    const idiot = ww.seats.find((s) => s.role === 'idiot')!;
    // 直接从「放逐白痴」这一步开始
    Object.assign(ww, { day: 1, phase: 'day', tasks: [{ t: 'exile', seat: idiot.seat }, { t: 'speechOrder' }] });
    ww.nights.push({ day: 1, deaths: [] });
    ctx.runner.run();
    // 模拟模型偶尔会让狼人自爆：那样白天直接结束、没有投票，夜里白痴也可能被刀
    const exploded = () => ctx.room.messages.some((m) => m.ww?.type === 'skill' && m.content.includes('自爆'));
    for (let i = 0; i < 800 && !ctx.room.messages.some((m) => m.ww?.type === 'vote') && !exploded(); i++) await sleep(10);
    ctx.runner.stop();
    await sleep(50);
    assert.equal(idiot.idiotRevealed, true);
    assert.notEqual(idiot.death?.cause, 'vote', '白痴不会因为放逐出局');
    assert.ok(ctx.room.messages.some((m) => m.content.includes('翻牌：白痴')));
    const vote = ctx.room.messages.find((m) => m.ww?.type === 'vote');
    if (!exploded()) {
      assert.equal(idiot.alive, true);
      assert.ok(vote, '之后有一轮投票');
    }
    if (vote) assert.ok(!vote.ww!.votes!.some((v) => v.voter === idiot.seat), '翻牌的白痴不在投票名单里');
  } finally {
    await ctx.cleanup();
  }
});
