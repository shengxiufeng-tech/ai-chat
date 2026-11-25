// 狼人杀：用模拟模型跑完整对局（各种板子、全员 AI / 有人类玩家），检查流程、信息隔离和中途停止
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BOARDS, isWolf, narrationNeedsFacts, revealText, syncSeatFromParticipant, type WerewolfState } from '../shared/werewolf.ts';
import { RunnerManager } from './runner.ts';
import { Store } from './store.ts';
import { createWerewolfRoom, guessKill, humanPrompt, onWerewolfRequest, parseChoice, resetWerewolf, parseSpeechActions, playerMessages, type WerewolfCreateOptions } from './werewolf.ts';

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

test('狼人夜聊没写【刀】时，从正文或思考过程里猜目标', () => {
  const opts = [1, 2, 3, 4, 5];
  assert.equal(guessKill('既然两位哥哥都觉得，那我就听你们的，今晚先刀 5 号吧！', '刀: 4号', opts), 5, '正文优先于思考过程');
  assert.equal(guessKill('我看4号位置居中，先拿4号开刀探路。', '', opts), 4);
  assert.equal(guessKill('那必须跟啊！今晚就拿 2 号祭旗！', '刀:2号', opts), 2, '正文猜不出时看思考过程');
  assert.equal(guessKill('昨晚刀了 9 号没成，今晚刀 3 号', '', opts), 3, '不在可选范围里的不算，取最后提到的');
  assert.equal(guessKill('今晚空刀吧', '', opts), null);
  assert.equal(guessKill('我也不知道', '', opts), undefined);
});

test('AI 主持人的播报：座位号对得上就不重复显示准确结果', () => {
  assert.equal(narrationNeedsFacts('竞选结果已出，恭喜9号玩家当选本局警长！', '9号 当选警长。'), false);
  assert.equal(narrationNeedsFacts('天亮了。昨晚是平安夜，场上没有人出局。', '昨晚是平安夜，没有人出局。'), false);
  assert.equal(narrationNeedsFacts('天亮了，昨晚是个不平静的夜晚。', '昨晚 4号、9号 出局。'), true, '漏说座位号');
  assert.equal(narrationNeedsFacts('昨晚 3号 倒下了。', '昨晚是平安夜，没有人出局。'), true, '编出了座位号');
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

test('AI 知道公开的大局：狼人总数、公开的身份、还剩几名狼；狼人知道队友谁还活着', async () => {
  const ctx = setup({ boardId: 'nine', join: false, sheriff: false });
  try {
    const ww = ctx.room.werewolf!;
    Object.assign(ww, { day: 3, phase: 'night' });
    const wolves = ww.seats.filter((s) => isWolf(s.role));
    const villager = ww.seats.find((s) => s.role === 'villager')!;
    const hunter = ww.seats.find((s) => s.role === 'hunter')!;
    // 一只狼自爆（公开），一个猎人开枪（公开），一个平民夜里出局（不公开）
    Object.assign(wolves[0], { alive: false, death: { day: 1, cause: 'explode' }, revealed: 'role' });
    Object.assign(hunter, { alive: false, death: { day: 2, cause: 'wolf' }, revealed: 'role' });
    Object.assign(villager, { alive: false, death: { day: 2, cause: 'vote' } });
    const last = (seat: number) => playerMessages(ctx.room, seat, '【任务：狼人夜聊】').at(-1)!.content;

    const otherVillager = ww.seats.find((s) => s.role === 'villager' && s.alive)!;
    const v = last(otherVillager.seat);
    assert.match(v, /本局狼人阵营一共 3 名/);
    assert.match(v, new RegExp(`${wolves[0].seat}号 是狼人（已出局）`));
    assert.match(v, new RegExp(`${hunter.seat}号 是猎人（已出局）`));
    assert.match(v, new RegExp(`${villager.seat}号 出局时没有公开身份`));
    assert.match(v, /确认出局的狼人 1 名/);
    assert.match(v, /场上还剩 1~2 名狼人/, '出局的平民身份没公开，所以是 1~2 名');
    assert.doesNotMatch(v, /狼队现在/, '好人不知道狼队的情况');
    assert.match(v, /游戏还没结束，说明场上还有狼人，神职和平民也都还有人活着/);

    // AI 主持人播报的消息：AI 玩家读到的是准确结果，不是主持人的渲染
    ctx.room.messages.push({ id: 'n1', role: 'system', kind: 'ww', speakerName: '法官', content: '夜色散去，有人永远睡着了……', status: 'done', createdAt: 0, visibility: 'public', ww: { type: 'announce', facts: `昨晚 ${villager.seat}号 出局。` } });
    const hist = playerMessages(ctx.room, otherVillager.seat, '【任务：狼人夜聊】').map((m) => m.content).join('\n');
    assert.match(hist, new RegExp(`【法官】昨晚 ${villager.seat}号 出局。`));
    assert.doesNotMatch(hist, /永远睡着了/);
    ctx.room.messages.pop();

    const w = last(wolves[1].seat);
    assert.match(w, /狼队现在还活着 2 人/);
    assert.match(w, new RegExp(`已经出局的队友：${wolves[0].seat}号`));
    assert.match(w, /场上一共还有 2 名狼人/);

    const seer = ww.seats.find((s) => s.role === 'seer')!;
    ww.nights = [{ day: 1, check: { target: wolves[1].seat, wolf: true }, deaths: [] }];
    assert.match(last(seer.seat), new RegExp(`你验出的狼人里还活着的：${wolves[1].seat}号`));

    // 你在座位上做的标记只是自己的猜测，AI 看不到；再来一局时清空
    const before = last(otherVillager.seat);
    ww.guesses = { [wolves[1].seat]: 'wolf', [seer.seat]: 'seer' };
    assert.equal(last(otherVillager.seat), before);
    resetWerewolf(ctx.room);
    assert.deepEqual(ctx.room.werewolf!.guesses, {});
    assert.ok(ctx.room.werewolf!.seats.every((s) => !s.revealed), '公开的身份也清空');
  } finally {
    await ctx.cleanup();
  }
});

test('本局规则每次都告诉 AI：没开警长的局明确说没有警长和警徽', async () => {
  const off = setup({ boardId: 'nine', join: false, sheriff: false });
  const on = setup({ boardId: 'nine', join: false, sheriff: true });
  try {
    const msgs = (room: typeof off.room) => playerMessages(room, 1, '【任务：发言】');
    const sys = (room: typeof off.room) => msgs(room)[0].content;
    const tail = (room: typeof off.room) => msgs(room).at(-1)!.content;

    assert.match(sys(off.room), /本局不竞选警长：没有警长，也没有警徽/);
    assert.match(tail(off.room), /【本局规则】9 人局，角色只有：3 狼人、预言家、女巫、猎人、3 平民，没有其他角色/);
    assert.match(tail(off.room), /本局不竞选警长，没有警长也没有警徽，每个人的投票都算 1 票/);
    assert.match(tail(off.room), /屠边/);
    assert.match(tail(off.room), /被开枪带走的玩家有遗言/);

    assert.doesNotMatch(sys(on.room), /不竞选警长/);
    assert.match(tail(on.room), /本局第一天白天竞选警长/);
    on.room.werewolf!.sheriff = 4;
    assert.match(tail(on.room), /现在的警长是 4号/);
    Object.assign(on.room.werewolf!, { sheriff: null, sheriffDone: true });
    assert.match(tail(on.room), /现在没有警长（警徽已经流失或被撕掉）/);
  } finally {
    await off.cleanup();
    await on.cleanup();
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
    for (let i = 0; i < 3000 && !ctx.room.messages.some((m) => m.ww?.type === 'vote') && !exploded(); i++) await sleep(10);
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

test('在「AI」页改了名字和头像：座位和这一局说过的话一起改，读取旧房间时也会补上', async () => {
  const ctx = setup({ boardId: 'six', join: false, sheriff: false });
  try {
    const ww = ctx.room.werewolf!;
    const seat = ww.seats[0];
    const p = ctx.room.participants.find((x) => x.id === seat.participantId)!;
    ctx.room.messages.push({ id: 'm1', role: 'ai', participantId: p.id, speakerName: `${seat.seat}号 ${p.name}`, avatar: p.avatar, color: p.color, content: '我是好人。', status: 'done', createdAt: 0, ww: { type: 'announce', seat: seat.seat, speech: 'speech' } });
    // 旧版本的「身份公开」消息没有 reveal 标记
    ctx.room.messages.push({ id: 'end', role: 'system', kind: 'ww', speakerName: '法官', content: revealText(ww), status: 'done', createdAt: 0, visibility: 'public', ww: { type: 'end' } });
    const oldName = p.name;
    Object.assign(p, { name: 'DeepSeek', avatar: '🐳' });
    const changed = syncSeatFromParticipant(ctx.room, p);
    assert.equal(seat.name, 'DeepSeek');
    assert.equal(seat.avatar, '🐳');
    assert.equal(changed.length, 2, '发言和身份公开都改了');
    const reveal = ctx.room.messages.find((m) => m.id === 'end')!.content;
    assert.match(reveal, new RegExp(`${seat.seat}号 DeepSeek：`));
    assert.doesNotMatch(reveal, new RegExp(oldName));
    assert.equal(ctx.room.messages[0].speakerName, `${seat.seat}号 DeepSeek`);
    assert.match(playerMessages(ctx.room, ww.seats[1].seat).map((m) => m.content).join('\n'), new RegExp(`【${seat.seat}号 DeepSeek】`), 'AI 们看到的也是新名字');
    assert.deepEqual(syncSeatFromParticipant(ctx.room, p), [], '没变化时不重复推送');

    // 旧版本留下的房间：座位名字和 AI 名字对不上，重新读取时补上
    seat.name = '旧名字';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-ww-sync-'));
    const store = new Store(dir);
    store.addRoom(structuredClone(ctx.room));
    store.flushAll();
    const reloaded = new Store(dir).getRoom(ctx.room.id)!;
    assert.equal(reloaded.werewolf!.seats[0].name, 'DeepSeek');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await ctx.cleanup();
  }
});

test('提示缓存：每个座位的每次请求都是上一次请求 + 模型的回复原样不动，再往后追加', async () => {
  for (const boardId of ['nine', 'whitewolf']) {
    const ctx = setup({ boardId, join: false, sheriff: true });
    const sent = new Map<number, { role: string; content: string }[][]>();
    onWerewolfRequest((roomId, seat, messages) => {
      if (roomId !== ctx.room.id) return;
      sent.set(seat, [...(sent.get(seat) ?? []), structuredClone(messages)]);
    });
    try {
      await playOut(ctx);
      const ww = ctx.room.werewolf!;
      let checked = 0;
      for (const [seat, reqs] of sent) {
        for (let k = 1; k < reqs.length; k++) {
          const a = reqs[k - 1];
          const b = reqs[k];
          assert.deepEqual(b[0], a[0], `${seat}号的系统提示词不变`);
          assert.ok(b.length >= a.length + 2, `${seat}号第 ${k + 1} 次请求比上一次长`);
          assert.deepEqual(b.slice(0, a.length), a, `${seat}号第 ${k + 1} 次请求的前缀和上一次一字不差`);
          assert.equal(b[a.length].role, 'assistant', '紧接着是模型上一轮的回复');
          assert.equal(b.at(-1)!.role, 'user');
          checked++;
        }
        // 信息隔离：好人收到的内容里没有狼队夜聊
        const role = ww.seats.find((s) => s.seat === seat)!.role;
        const all = reqs.at(-1)!.map((m) => m.content).join('\n');
        if (!isWolf(role)) assert.doesNotMatch(all, /狼队夜聊|【狼队频道】|模拟狼人/, `${seat}号（${role}）看不到狼队频道`);
        else assert.match(all, /狼队夜聊|【狼队频道】/);
      }
      assert.ok(checked > 20, `检查了 ${checked} 对相邻请求`);
    } finally {
      onWerewolfRequest(undefined);
      await ctx.cleanup();
    }
  }
});

test('再来一局：重新拼一次对话，不会把上一局的内容带进来', async () => {
  const ctx = setup({ boardId: 'six', join: false, sheriff: false });
  const firstLen = new Map<number, number>();
  onWerewolfRequest((roomId, seat, messages) => {
    if (roomId === ctx.room.id && !firstLen.has(seat)) firstLen.set(seat, messages.length);
  });
  try {
    await playOut(ctx);
    resetWerewolf(ctx.room);
    firstLen.clear();
    ctx.room.werewolf!.pace = 0;
    ctx.runner.run();
    for (let i = 0; i < 500 && firstLen.size < 2; i++) await sleep(5);
    ctx.runner.stop();
    await sleep(50);
    assert.ok(firstLen.size > 0);
    for (const [seat, n] of firstLen) assert.equal(n, 2, `${seat}号新一局的第一次请求只有系统提示词和一条消息`);

    // 接着把新的一局打完
    await playOut(ctx);
    assert.ok(ctx.room.werewolf!.winner);
  } finally {
    onWerewolfRequest(undefined);
    await ctx.cleanup();
  }
});
