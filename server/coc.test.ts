import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OCCUPATIONS,
  autoAllocate,
  buildSheet,
  derivedStats,
  meetsDifficulty,
  occupationById,
  quickInvestigator,
  remainingPoints,
  resolveTarget,
  rollD100,
  rollExpression,
  SKILL_CAP,
  skillBase,
  stripCommands,
  successLevel,
  type Characteristics,
} from '../shared/coc.ts';

/** 按顺序返回给定的随机数 */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const C: Characteristics = { STR: 50, CON: 60, SIZ: 65, DEX: 70, APP: 55, INT: 75, POW: 60, EDU: 80 };

test('骰子表达式', () => {
  assert.equal(rollExpression('1d6', seq(0)).total, 1);
  assert.equal(rollExpression('1d6', seq(0.99)).total, 6);
  assert.equal(rollExpression('2d6+3', seq(0.5, 0.5)).total, 4 + 4 + 3);
  assert.equal(rollExpression('1d4-1', seq(0)).total, 0);
  assert.equal(rollExpression('5').total, 5);
  assert.match(rollExpression('1D3', seq(0.4)).detail, /1d3\(2\) = 2/);
  assert.throws(() => rollExpression('abc'));
});

test('d100：00+0 是 100，奖励骰取低、惩罚骰取高', () => {
  // 第一个随机数是个位，后面是十位
  assert.equal(rollD100(0, seq(0, 0)).total, 100);
  assert.equal(rollD100(0, seq(0.5, 0.2)).total, 25);
  assert.equal(rollD100(1, seq(0.5, 0.7, 0.2)).total, 25);
  assert.equal(rollD100(-1, seq(0.5, 0.7, 0.2)).total, 75);
});

test('成功等级与难度', () => {
  assert.equal(successLevel(1, 50), 'critical');
  assert.equal(successLevel(10, 50), 'extreme');
  assert.equal(successLevel(25, 50), 'hard');
  assert.equal(successLevel(50, 50), 'regular');
  assert.equal(successLevel(51, 50), 'fail');
  assert.equal(successLevel(100, 80), 'fumble');
  assert.equal(successLevel(96, 40), 'fumble');
  assert.equal(successLevel(96, 60), 'fail');
  assert.equal(meetsDifficulty('regular', 'hard'), false);
  assert.equal(meetsDifficulty('hard', 'hard'), true);
  assert.equal(meetsDifficulty('critical', 'extreme'), true);
});

test('衍生属性', () => {
  const d = derivedStats(C);
  assert.equal(d.hp, 12);
  assert.equal(d.mp, 12);
  assert.equal(d.san, 60);
  assert.equal(d.mov, 8); // 敏捷 > 体型，但力量 < 体型
  assert.equal(d.damageBonus, '0'); // 力量+体型 = 115
});

test('自动分配技能点不超出点数和上限', () => {
  for (const o of OCCUPATIONS) {
    const alloc = autoAllocate(o, C);
    const rest = remainingPoints(o, C, alloc);
    assert.ok(rest.occ >= 0, `${o.name} 职业点超支`);
    assert.ok(rest.interest >= 0, `${o.name} 兴趣点超支`);
    for (const [name, v] of Object.entries(alloc)) {
      assert.ok(skillBase(name, C) + v <= SKILL_CAP, `${o.name} 的 ${name} 超过上限`);
    }
  }
});

test('车卡：基础值与分配叠加', () => {
  const o = occupationById('journalist')!;
  const sheet = buildSheet({
    name: '测试',
    occupation: o.name,
    age: 30,
    gender: '',
    characteristics: C,
    luck: 50,
    allocation: { 侦查: 30 },
  });
  assert.equal(sheet.skills['侦查'], 55);
  assert.equal(sheet.skills['闪避'], 35);
  assert.equal(sheet.skills['母语'], 80);
  assert.equal(sheet.skills['计算机使用'], undefined); // 1920 年代没有
  assert.equal(sheet.san.max, 99);
  const q = quickInvestigator({ occupationId: 'doctor' });
  assert.equal(q.occupation, '医生');
  assert.ok(q.skills['医学'] > 1);
});

test('检定目标：技能、属性、别名', () => {
  const sheet = quickInvestigator({ occupationId: 'detective' });
  assert.equal(resolveTarget(sheet, '侦查').target, sheet.skills['侦查']);
  assert.equal(resolveTarget(sheet, '力量').target, sheet.characteristics.STR);
  assert.equal(resolveTarget(sheet, '灵感').target, sheet.characteristics.INT);
  assert.equal(resolveTarget(sheet, '幸运').target, sheet.luck);
  assert.equal(resolveTarget(sheet, '手枪').name, '射击(手枪)');
  assert.equal(resolveTarget(sheet, '射击（步枪）').name, '射击(步枪/霰弹枪)');
  assert.equal(resolveTarget(sheet, '不存在的技能').found, false);
});

test('去掉守秘人指令', () => {
  assert.equal(stripCommands('你看到一扇门。[检定:侦查]'), '你看到一扇门。');
  assert.equal(stripCommands('甲\n\n【理智：1/1d6】\n\n\n乙'), '甲\n\n乙');
});

test('自动分配会把点数基本用完', () => {
  const smart: Characteristics = { ...C, INT: 90, EDU: 90 };
  for (const o of OCCUPATIONS) {
    const rest = remainingPoints(o, smart, autoAllocate(o, smart));
    assert.ok(rest.occ + rest.interest < 10, `${o.name} 剩下 ${rest.occ}/${rest.interest} 点没用`);
  }
});
