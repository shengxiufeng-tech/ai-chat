import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../shared/types.ts';
import { chatTokens, estimateTokens, fitToContext, inputBudget, prependToFirst, stepFit, TRIM_LOW_WATER } from './context.ts';
import type { ChatMessage } from './llm.ts';

test('估算 token：中文按字、英文按 3.5 个字符', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('hello world!!'), 4); // 13 / 3.5 ≈ 3.7
  assert.equal(estimateTokens('你好，world'), 3 + 2);
});

test('输入预算：给回复留出空间', () => {
  assert.equal(inputBudget(128_000), Math.floor((128_000 - 25_600) * 0.95));
  assert.equal(inputBudget(256_000), Math.floor((256_000 - 32_000) * 0.95));
  assert.equal(inputBudget(8_000), Math.floor((8_000 - 4_096) * 0.95));
});

const msgs = (n: number, len: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'human' as const,
    speakerName: '我',
    content: `${i}号${'字'.repeat(len)}`,
    status: 'done' as const,
    createdAt: i,
  }));

const build = (h: Message[]): ChatMessage[] => [
  { role: 'system', content: '系统提示'.repeat(50) },
  ...h.map((m) => ({ role: 'user' as const, content: m.content })),
];

test('放得下时不裁剪', () => {
  const r = fitToContext(build, msgs(10, 100), 128_000);
  assert.equal(r.dropped, 0);
  assert.equal(r.messages.length, 11);
});

test('放不下时从最早的开始丢，保留系统提示和最近的消息，并说明省略了多少', () => {
  const history = msgs(100, 200); // 约 2 万 token
  const window = 12_000;
  const r = fitToContext(build, history, window);
  assert.ok(r.dropped > 0);
  assert.ok(r.tokens <= inputBudget(window), `${r.tokens} > ${inputBudget(window)}`);
  assert.equal(r.tokens, chatTokens(r.messages));
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[1].content, new RegExp(`更早的 ${r.dropped} 条消息已省略`));
  assert.match(r.messages[1].content, new RegExp(`${r.dropped}号`)); // 第一条保留的是紧接着被丢弃部分之后的那条
  assert.match(r.messages.at(-1)!.content, /^99号/); // 最新的一定在
});

test('就算最后一条本身超长也不会把它丢掉', () => {
  const r = fitToContext(build, msgs(3, 20_000), 8_000);
  assert.equal(r.dropped, 2);
  assert.equal(r.messages.length, 2);
  assert.match(r.messages.at(-1)!.content, /已省略。）\n\n2号/);
});

test('阶梯式裁剪：涨满了才裁，一次裁到上限的 70%；之后裁剪点不动，直到再次涨满', () => {
  const window = 20_000;
  const budget = inputBudget(window);
  const all = msgs(200, 300);
  let start = 0;
  let moves = 0;
  let lastDropped = -1;
  const firsts = new Set<number>();
  for (let n = 1; n <= all.length; n++) {
    const r = stepFit((h) => build(h), all.slice(0, n), window, start);
    assert.ok(r.tokens <= budget, `第 ${n} 轮放得下`);
    if (r.moved) {
      moves++;
      assert.ok(r.tokens <= budget * TRIM_LOW_WATER + 400, `挪动后降到上限的 70% 左右（${r.tokens} / ${budget}）`);
      assert.ok(r.dropped > lastDropped, '裁剪点只往后挪');
    } else {
      assert.equal(r.dropped, start, '没涨满就不动');
    }
    lastDropped = r.dropped;
    start = r.dropped;
    firsts.add(r.dropped);
  }
  // 每条约 300 token：上限 1.5 万左右，每次挪动后要再涨约 30% 才会再挪
  assert.ok(moves > 3 && moves < 30, `200 轮里挪了 ${moves} 次`);
  assert.equal(firsts.size, moves + 1);
});

test('在第一条非系统消息开头加说明（文字或带图片的消息都行）', () => {
  const out = prependToFirst(
    [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: '地图' }] },
    ],
    '【前情提要】',
  );
  assert.deepEqual(out[1].content, [{ type: 'text', text: '【前情提要】' }, { type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: '地图' }]);
  assert.equal(prependToFirst([{ role: 'system', content: 's' }, { role: 'user', content: '你好' }], '说明')[1].content, '说明\n\n你好');
});
