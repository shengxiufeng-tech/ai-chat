import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOARDS,
  boardSize,
  canSee,
  canShoot,
  checkRoles,
  checkWinner,
  dealRoles,
  resolveNight,
  rolesText,
  speechOrder,
  tallyVotes,
  viewerOf,
  wolfTarget,
  type WerewolfState,
  type WwRole,
  type WwSeat,
} from '../shared/werewolf.ts';

const seats = (roles: WwRole[], dead: number[] = []): WwSeat[] =>
  roles.map((role, i) => ({ seat: i + 1, name: `P${i + 1}`, avatar: '🙂', role, alive: !dead.includes(i + 1) }));

test('板子：人数和角色都合法', () => {
  for (const b of BOARDS) assert.equal(checkRoles(b.roles), '', b.name);
  assert.deepEqual(BOARDS.map((b) => boardSize(b.roles)), [6, 9, 12, 12, 12, 12]);
  assert.match(checkRoles({ werewolf: 1, villager: 2 }), /人数要在/);
  assert.match(checkRoles({ villager: 6 }), /至少要有一名狼人/);
  assert.match(checkRoles({ werewolf: 3, villager: 3 }), /少于总人数的一半/);
  assert.match(checkRoles({ werewolf: 2, seer: 2, villager: 4 }), /预言家最多一名/);
  assert.equal(rolesText({ werewolf: 3, seer: 1, villager: 3 }), '3 狼人、预言家、3 平民');
  const deck = dealRoles(BOARDS[1].roles);
  assert.equal(deck.length, 9);
  assert.equal(deck.filter((r) => r === 'werewolf').length, 3);
});

test('夜晚结算：守卫、女巫、同守同救、毒药', () => {
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 3, deaths: [] }), [{ seat: 3, cause: 'wolf' }]);
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 3, guard: 3, deaths: [] }), [], '守住了');
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 3, saved: true, deaths: [] }), [], '救活了');
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 3, guard: 3, saved: true, deaths: [] }), [{ seat: 3, cause: 'wolf' }], '同守同救仍然出局');
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 3, poison: 5, deaths: [] }), [{ seat: 3, cause: 'wolf' }, { seat: 5, cause: 'poison' }]);
  assert.deepEqual(resolveNight({ day: 1, wolfKill: null, poison: 5, guard: 5, deaths: [] }), [{ seat: 5, cause: 'poison' }], '守卫挡不住毒药');
  assert.deepEqual(resolveNight({ day: 1, wolfKill: 5, poison: 5, deaths: [] }), [{ seat: 5, cause: 'poison' }], '又刀又毒按毒死算（猎人不能开枪）');
  assert.deepEqual(resolveNight({ day: 1, wolfKill: null, deaths: [] }), [], '空刀是平安夜');
});

test('出局技能：猎人和狼王被毒死、自爆时不能开枪', () => {
  const [h] = seats(['hunter']);
  const [k] = seats(['wolfking']);
  assert.ok(canShoot(h, 'wolf'));
  assert.ok(canShoot(h, 'vote'));
  assert.ok(!canShoot(h, 'poison'));
  assert.ok(canShoot(k, 'shot'));
  assert.ok(!canShoot(k, 'explode'));
  assert.ok(!canShoot(seats(['seer'])[0], 'wolf'));
});

test('狼人刀谁：多数决定，平票听第一位提议的', () => {
  assert.equal(wolfTarget([{ seat: 1, target: 5 }, { seat: 2, target: 6 }, { seat: 3, target: 6 }]), 6);
  assert.equal(wolfTarget([{ seat: 1, target: 5 }, { seat: 2, target: 6 }]), 5);
  assert.equal(wolfTarget([{ seat: 1, target: null }, { seat: 2, target: 7 }]), 7);
  assert.equal(wolfTarget([{ seat: 1, target: null }]), null);
});

test('计票：警长 1.5 票、平票、弃票', () => {
  const t = tallyVotes({ 1: 5, 2: 5, 3: 6, 4: 6, 7: null }, 3);
  assert.deepEqual(t.top, [6], '警长投的 6 号 2.5 票');
  assert.deepEqual(t.counts[0], { target: 6, votes: 2.5, voters: [3, 4] });
  assert.deepEqual(t.abstain, [7]);
  assert.deepEqual(tallyVotes({ 1: 5, 2: 6 }, null).top, [5, 6], '平票');
  assert.deepEqual(tallyVotes({ 1: null }, null).top, [], '全部弃票');
});

test('胜负：屠边和屠城', () => {
  const roles: WwRole[] = ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'];
  assert.equal(checkWinner({ seats: seats(roles), winRule: 'edge' }), null);
  assert.equal(checkWinner({ seats: seats(roles, [1, 2]), winRule: 'edge' }), 'village', '狼人死光');
  assert.equal(checkWinner({ seats: seats(roles, [3, 4]), winRule: 'edge' }), 'wolf', '神职死光（屠边）');
  assert.equal(checkWinner({ seats: seats(roles, [5, 6]), winRule: 'edge' }), 'wolf', '平民死光（屠边）');
  assert.equal(checkWinner({ seats: seats(roles, [3, 4]), winRule: 'all' }), null, '屠城还要继续');
  assert.equal(checkWinner({ seats: seats(roles, [3, 4, 5, 6]), winRule: 'all' }), 'wolf');
  // 没有平民的自定义板子：只看神职
  assert.equal(checkWinner({ seats: seats(['werewolf', 'seer', 'witch', 'hunter', 'guard'], [2]), winRule: 'edge' }), null);
});

test('发言顺序：警长最后说；没有警长从昨晚出局的人的下一位开始', () => {
  const s = { seats: seats(['villager', 'villager', 'villager', 'villager', 'villager', 'villager'], [4]), sheriff: null as number | null };
  assert.deepEqual(speechOrder(s, 4), [5, 6, 1, 2, 3]);
  assert.deepEqual(speechOrder(s, null), [1, 2, 3, 5, 6]);
  s.sheriff = 2;
  assert.deepEqual(speechOrder(s, 4), [3, 5, 6, 1, 2]);
});

test('信息隔离：谁能看到哪些消息', () => {
  const wolf = { god: false, seat: 1, wolf: true };
  const seer = { god: false, seat: 3, wolf: false };
  const god = { god: true, wolf: false };
  assert.ok(canSee('public', seer));
  assert.ok(canSee('wolves', wolf));
  assert.ok(!canSee('wolves', seer));
  assert.ok(canSee('seat:3', seer));
  assert.ok(!canSee('seat:3', wolf));
  assert.ok(!canSee('god', wolf));
  assert.ok(canSee('god', god) && canSee('wolves', god) && canSee('seat:3', god));

  const state = { seats: seats(['werewolf', 'seer', 'villager', 'villager', 'witch'], [2]), humanSeat: 2, phase: 'day' } as WerewolfState;
  assert.equal(viewerOf(state).god, true, '出局后变成上帝视角');
  state.humanSeat = 1;
  assert.deepEqual(viewerOf(state), { god: false, seat: 1, wolf: true });
  state.humanSeat = undefined;
  assert.equal(viewerOf(state).god, true, '旁观是上帝视角');
});
