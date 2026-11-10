import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, Participant, Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import {
  buildAgentMessages,
  findMention,
  parseModeratorChoice,
  pickByMention,
  pickRoundRobin,
  stripNamePrefix,
} from './prompt.ts';

const p = (id: string, name: string, extra: Partial<Participant> = {}): Participant => ({
  id,
  name,
  avatar: '🤖',
  color: '#fff',
  model: 'm',
  bio: '',
  persona: '',
  temperature: 0.8,
  enabled: true,
  reasoningEffort: '',
  ...extra,
} as Participant);

let seq = 0;
const ai = (who: Participant, content: string, extra: Partial<Message> = {}): Message => ({
  id: `m${seq++}`,
  role: 'ai',
  participantId: who.id,
  speakerName: who.name,
  content,
  status: 'done',
  createdAt: 0,
  ...extra,
});
const human = (content: string): Message => ({
  id: `m${seq++}`,
  role: 'human',
  speakerName: '我',
  content,
  status: 'done',
  createdAt: 0,
});

const A = p('a', '苏格拉');
const B = p('b', '居里');
const C = p('c', '马克');

const makeRoom = (messages: Message[], participants = [A, B, C]): Room => ({
  id: 'r',
  mode: 'chat',
  title: 't',
  scenario: '讨论 AI',
  participants,
  messages,
  settings: { ...DEFAULT_ROOM_SETTINGS },
  createdAt: 0,
  updatedAt: 0,
});

test('自己的发言是 assistant，别人的发言带名字作为 user，并合并连续的同一方', () => {
  const msgs = [human('大家好'), ai(A, '你好'), ai(B, '我同意'), ai(C, '我反对')];
  const room = makeRoom(msgs);
  const out = buildAgentMessages(room, A, msgs);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /你是「苏格拉」/);
  assert.deepEqual(
    out.slice(1).map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(out[1].content, '【我（主持人）】：大家好');
  assert.equal(out[2].content, '你好');
  assert.match(out[3].content, /^【居里】：我同意\n\n【马克】：我反对/);
  assert.match(out[3].content, /现在轮到你「苏格拉」发言/);
});

test('历史以自己开头或结尾时补上 user 消息', () => {
  const msgs = [ai(A, '我先说'), ai(A, '再补充一句')];
  const out = buildAgentMessages(makeRoom(msgs), A, msgs);
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
});

test('空历史时让模型先开口；出错和空消息不进入上下文；被打断的消息带标记', () => {
  const empty = buildAgentMessages(makeRoom([]), A, []);
  assert.equal(empty.length, 2);
  assert.match(empty[1].content, /请你先开口/);

  const msgs = [
    ai(B, '', { status: 'error', error: 'x' }),
    ai(B, '说到一半', { status: 'interrupted' }),
  ];
  const out = buildAgentMessages(makeRoom(msgs), A, msgs);
  assert.equal(out.length, 2);
  assert.match(out[1].content, /说到一半……（发言被打断）/);
});

test('去掉名字前缀', () => {
  assert.equal(stripNamePrefix('苏格拉：你好', '苏格拉'), '你好');
  assert.equal(stripNamePrefix('【苏格拉】: 你好', '苏格拉'), '你好');
  assert.equal(stripNamePrefix('**苏格拉**：你好', '苏格拉'), '你好');
  assert.equal(stripNamePrefix('苏格拉底说过：你好', '苏格拉'), '苏格拉底说过：你好');
});

test('@ 点名：名字长的优先、按出现顺序', () => {
  const x = p('x', '小王');
  const y = p('y', '小王子');
  assert.equal(findMention('@小王子 你怎么看', [x, y])?.id, 'y');
  assert.equal(findMention('@小王 你怎么看', [x, y])?.id, 'x');
  assert.equal(findMention('@居里 和 @苏格拉', [A, B])?.id, 'b');
  assert.equal(findMention('没有点名', [A, B]), undefined);

  assert.equal(pickByMention(makeRoom([human('@马克 你说')]))?.id, 'c');
  assert.equal(pickByMention(makeRoom([human('@马克 你说'), ai(A, '...')])), undefined);
});

test('轮流发言跳过被关闭的角色', () => {
  const B2 = { ...B, enabled: false };
  assert.equal(pickRoundRobin(makeRoom([], [A, B2, C]))?.id, 'a');
  assert.equal(pickRoundRobin(makeRoom([ai(A, 'x')], [A, B2, C]))?.id, 'c');
  assert.equal(pickRoundRobin(makeRoom([ai(C, 'x')], [A, B2, C]))?.id, 'a');
});

test('解析 AI 主持人的选择', () => {
  const room = makeRoom([]);
  assert.equal(parseModeratorChoice('居里', room)?.id, 'b');
  assert.equal(parseModeratorChoice('「马克」。', room)?.id, 'c');
  assert.equal(parseModeratorChoice('<think>苏格拉刚说过</think>下一位是居里', room)?.id, 'b');
  assert.equal(parseModeratorChoice('不知道', room), undefined);
});
