import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendToLast, applyPlanCommands, cleanPlanner, planCommands, plannerInstruction, writerBlock } from './planner.ts';

test('说明接在最后一条用户消息后面；最后一条不是用户消息时单独加一条', () => {
  const base = [
    { role: 'system' as const, content: 's' },
    { role: 'user' as const, content: 'u' },
  ];
  assert.equal(appendToLast(base, 'X').at(-1)!.content, 'u\n\nX');
  assert.equal(base[1].content, 'u', '不改动原数组');
  const endsWithAssistant = [...base, { role: 'assistant' as const, content: 'a' }];
  const out = appendToLast(endsWithAssistant, 'X');
  assert.deepEqual(out.at(-1), { role: 'user', content: 'X' });
  assert.equal(appendToLast(base, ''), base);
});

test('构思里的指令：只认「指令：」那一行之后的', () => {
  const plan = '- 要点：让玩家做个侦查，比如 [检定:聆听] 也行\n- 注意口吻\n指令：[检定:侦查:困难][NPC:周婶:茶馆老板娘]';
  assert.deepEqual(planCommands(plan), ['[检定:侦查:困难]', '[NPC:周婶:茶馆老板娘]']);
  assert.deepEqual(planCommands('**指令：** 无'), []);
  // 没有「指令：」这一行时，用构思里出现的所有指令
  assert.deepEqual(planCommands('然后 [理智:0/1d3]'), ['[理智:0/1d3]']);
});

test('守秘人：执笔模型写的指令换成构思里的', () => {
  const text = '雾更浓了。[检定:图书馆使用]\n你要怎么做？ [备忘:乱写:x]';
  const out = applyPlanCommands(text, '要点\n指令：[检定:侦查]');
  assert.equal(out, '雾更浓了。\n你要怎么做？\n\n[检定:侦查]');
  assert.equal(applyPlanCommands('你要怎么做？[检定:侦查]', '指令：无'), '你要怎么做？');
});

test('构思和执笔的说明', () => {
  assert.match(plannerInstruction({ kp: true }), /指令：/);
  assert.match(plannerInstruction({ kp: false, name: '苏格拉' }), /「苏格拉」/);
  assert.doesNotMatch(plannerInstruction({ kp: false }), /「/);
  const w = writerBlock('  要点一  ', { kp: true });
  assert.match(w, /<构思>\n要点一\n<\/构思>/);
  assert.match(w, /不要写任何方括号指令/);
  assert.doesNotMatch(writerBlock('x', { kp: false }), /方括号/);
});

test('接口传进来的构思设置', () => {
  assert.deepEqual(cleanPlanner({ enabled: true, model: ' a/b ', reasoningEffort: 'high', extra: 1 }), { enabled: true, model: 'a/b', reasoningEffort: 'high' });
  assert.deepEqual(cleanPlanner({ enabled: 'yes' }), { enabled: false, model: '', reasoningEffort: '' });
  assert.equal(cleanPlanner(null), undefined);
});
