import assert from 'node:assert/strict';
import { test } from 'node:test';
import { otherSpeakerNames, stripImpersonation } from '../shared/text.ts';

const NAMES = ['顾远', '凤笙休', '我', '玩家'];

test('去掉守秘人替 AI 队友写的段落（用户报告的真实例子）', () => {
  const kp = `【顾远（AI 队友）】： （我若有所思地望着门外黑沉沉的大雾，指节轻轻敲了敲木桌） "也好，赶了大半天路，雾又这么大，盲目摸去古井太冒险。"
（他压低了声音，嘴角勾起一丝探究的苦笑） "当然，还有第三种可能——趁夜摸去镇西的陆家老宅。你拿主意，咱们今晚落脚在哪？"

窗外的天色已经彻底被黑幕吞噬，浓雾贴着门缝和窗棂缓缓渗进屋里，带来刺骨的潮冷。

周婶在柜台后已经开始收拾碗筷，看样子准备打烊落锁了。

你们今晚打算怎么安顿？`;
  const r = stripImpersonation(kp, NAMES);
  assert.match(r.removed, /^【顾远（AI 队友）】/);
  assert.match(r.removed, /第三种可能/); // 同一段落里紧跟的行一起去掉
  assert.ok(r.text.startsWith('窗外的天色'));
  assert.match(r.text, /你们今晚打算怎么安顿？$/);
  assert.doesNotMatch(r.text, /顾远/);
});

test('正常叙述里提到别人、NPC 的台词、规则小贴士都不受影响', () => {
  const narration = `听到你的顾虑，顾远压低声音笑了笑："人心总是肉长的。"

周婶叹了口气："两位先生，我这茶馆真要打烊了。"

【规则小贴士】在跑团中，你可以用话术或说服打动 NPC。`;
  const r = stripImpersonation(narration, NAMES);
  assert.equal(r.removed, '');
  assert.equal(r.text, narration);
});

test('各种标签写法：粗体、方括号、冒充玩家、段落中间的行', () => {
  assert.equal(stripImpersonation('**【顾远】**：我同意\n\n叙述', NAMES).text, '叙述');
  assert.equal(stripImpersonation('[顾远]: 我同意\n\n叙述', NAMES).text, '叙述');
  assert.equal(stripImpersonation('【凤笙休（玩家）】：我决定去井边\n\n叙述', NAMES).text, '叙述');
  const mid = stripImpersonation('雾越来越浓。\n【顾远（AI 队友）】：我们走吧\n他拉了拉你的袖子\n\n远处传来犬吠。', NAMES);
  assert.equal(mid.text, '雾越来越浓。\n\n远处传来犬吠。');
  // 别的名字不受影响
  assert.equal(stripImpersonation('【陆守义】：两位远道而来', NAMES).removed, '');
});

test('其他人的名单：不含自己，跑团里包含调查员名字', () => {
  const room: any = {
    mode: 'trpg',
    participants: [
      { id: 'kp', name: '守秘人' },
      { id: 'gy', name: '顾远' },
    ],
    settings: { humanName: '小明' },
    trpg: { sheets: { player: { name: '凤笙休' }, gy: { name: '顾远' } } },
  };
  const forKp = otherSpeakerNames(room, 'kp');
  assert.ok(forKp.includes('顾远') && forKp.includes('凤笙休') && forKp.includes('小明'));
  assert.ok(!forKp.includes('守秘人'));
  assert.ok(otherSpeakerNames(room, 'gy').includes('守秘人'));
  assert.ok(!otherSpeakerNames(room, 'gy').includes('顾远'));
});
