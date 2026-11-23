// 狼人杀规则引擎（前后端共用）：角色、板子、发身份、夜晚结算、投票计票、胜负判定。
// 这里只有纯函数和数据，不调用模型；流程由 server/werewolf.ts 驱动。

import type { Message, Participant, Room } from './types.ts';

export type WwRole = 'werewolf' | 'wolfking' | 'whitewolf' | 'seer' | 'witch' | 'hunter' | 'guard' | 'idiot' | 'knight' | 'villager';
export type WwTeam = 'wolf' | 'god' | 'villager';

export interface RoleInfo {
  name: string;
  team: WwTeam;
  icon: string;
  /** 一句话说明（给玩家看） */
  desc: string;
}

export const ROLE_INFO: Record<WwRole, RoleInfo> = {
  werewolf: { name: '狼人', team: 'wolf', icon: '🐺', desc: '每晚和狼队友一起选一名玩家杀害。白天可以自爆，直接进入黑夜。' },
  wolfking: { name: '狼王', team: 'wolf', icon: '👑', desc: '狼人阵营。出局时可以开枪带走一名玩家（被女巫毒死不能开枪）。' },
  whitewolf: { name: '白狼王', team: 'wolf', icon: '🤍', desc: '狼人阵营。白天可以自爆，并带走一名玩家。' },
  seer: { name: '预言家', team: 'god', icon: '🔮', desc: '每晚查验一名玩家是好人还是狼人。' },
  witch: { name: '女巫', team: 'god', icon: '🧪', desc: '有一瓶解药和一瓶毒药，各用一次；同一晚只能用一瓶，不能自救。' },
  hunter: { name: '猎人', team: 'god', icon: '🏹', desc: '出局时可以开枪带走一名玩家（被女巫毒死不能开枪）。' },
  guard: { name: '守卫', team: 'god', icon: '🛡️', desc: '每晚守护一名玩家（可以守自己），不能连续两晚守同一个人。同守同救也会死。' },
  idiot: { name: '白痴', team: 'god', icon: '🃏', desc: '白天被投票放逐时翻牌免死，之后还能发言，但不能再投票。' },
  knight: { name: '骑士', team: 'god', icon: '⚔️', desc: '白天发言时可以和一名玩家决斗（一局一次）：对方是狼人则对方出局，否则骑士出局。' },
  villager: { name: '平民', team: 'villager', icon: '🧑‍🌾', desc: '没有技能，靠发言和投票找出狼人。' },
};

export const ROLE_ORDER: WwRole[] = ['werewolf', 'wolfking', 'whitewolf', 'seer', 'witch', 'hunter', 'guard', 'idiot', 'knight', 'villager'];
export const isWolf = (r: WwRole) => ROLE_INFO[r].team === 'wolf';
export const isGod = (r: WwRole) => ROLE_INFO[r].team === 'god';

export type RoleCounts = Partial<Record<WwRole, number>>;

export interface WwBoard {
  id: string;
  name: string;
  desc: string;
  roles: RoleCounts;
}

export const BOARDS: WwBoard[] = [
  { id: 'six', name: '6 人入门局', desc: '2 狼 · 预言家、女巫 · 2 民，十几分钟一局', roles: { werewolf: 2, seer: 1, witch: 1, villager: 2 } },
  { id: 'nine', name: '9 人预女猎', desc: '3 狼 · 预言家、女巫、猎人 · 3 民，最经典的板子', roles: { werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 } },
  { id: 'twelve-guard', name: '12 人预女猎守', desc: '4 狼 · 预言家、女巫、猎人、守卫 · 4 民', roles: { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 } },
  { id: 'twelve-idiot', name: '12 人预女猎白', desc: '4 狼 · 预言家、女巫、猎人、白痴 · 4 民', roles: { werewolf: 4, seer: 1, witch: 1, hunter: 1, idiot: 1, villager: 4 } },
  { id: 'wolfking', name: '12 人狼王守卫', desc: '狼王 + 3 狼 · 预言家、女巫、猎人、守卫 · 4 民', roles: { wolfking: 1, werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 } },
  { id: 'whitewolf', name: '12 人白狼王骑士', desc: '白狼王 + 3 狼 · 预言家、女巫、守卫、骑士 · 4 民', roles: { whitewolf: 1, werewolf: 3, seer: 1, witch: 1, guard: 1, knight: 1, villager: 4 } },
];

/** 新建狼人杀房间的参数 */
export interface WerewolfCreateOptions {
  boardId?: string;
  /** 自定义板子 */
  roles?: RoleCounts;
  /** 你也参加（随机一个座位）；false 时全员 AI，你旁观 */
  join?: boolean;
  humanName?: string;
  model?: string;
  effort?: string;
  sheriff?: boolean;
  narration?: 'fixed' | 'ai';
  narratorModel?: string;
  winRule?: 'edge' | 'all';
}

export const boardSize = (roles: RoleCounts) => ROLE_ORDER.reduce((n, r) => n + (roles[r] ?? 0), 0);
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 16;

/** 检查自定义角色配置，返回问题（没问题返回空） */
export function checkRoles(roles: RoleCounts): string {
  const n = boardSize(roles);
  const wolves = ROLE_ORDER.filter(isWolf).reduce((s, r) => s + (roles[r] ?? 0), 0);
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) return `人数要在 ${MIN_PLAYERS}~${MAX_PLAYERS} 人之间（现在 ${n} 人）`;
  if (wolves < 1) return '至少要有一名狼人阵营的角色';
  if (wolves * 2 >= n) return '狼人阵营太多了，要少于总人数的一半';
  for (const r of ROLE_ORDER) {
    if (r !== 'werewolf' && r !== 'villager' && (roles[r] ?? 0) > 1) return `${ROLE_INFO[r].name}最多一名`;
  }
  return '';
}

/** 板子的文字说明，例如「3 狼人、预言家、女巫、猎人、3 平民」 */
export function rolesText(roles: RoleCounts) {
  return ROLE_ORDER.filter((r) => (roles[r] ?? 0) > 0)
    .map((r) => ((roles[r] ?? 0) > 1 ? `${roles[r]} ${ROLE_INFO[r].name}` : ROLE_INFO[r].name))
    .join('、');
}

// ---------------- 状态 ----------------

export type DeathCause = 'wolf' | 'poison' | 'vote' | 'shot' | 'duel' | 'knight' | 'explode' | 'whitewolf';
export const DEATH_LABELS: Record<DeathCause, string> = {
  wolf: '夜里出局',
  poison: '夜里出局',
  vote: '被投票放逐',
  shot: '被枪杀',
  duel: '决斗出局',
  knight: '决斗失败',
  explode: '自爆',
  whitewolf: '被白狼王带走',
};

export interface WwSeat {
  seat: number;
  name: string;
  avatar: string;
  /** AI 玩家对应的参与者 */
  participantId?: string;
  human?: boolean;
  role: WwRole;
  alive: boolean;
  death?: { day: number; cause: DeathCause };
  /** 白痴翻牌后不能投票 */
  idiotRevealed?: boolean;
  /** 身份已经公开：role 公开了具体角色（开枪、自爆、骑士翻牌），wolf / good 只知道阵营（骑士决斗的结果） */
  revealed?: 'role' | 'wolf' | 'good';
}

/** 玩家在座位上做的身份标记（只是猜测，不会发给 AI）：狼人阵营、好人，或者具体角色 */
export type WwGuess = WwRole | 'wolf' | 'good';

/** 等待处理的一步流程（存在房间里，服务重启后接着做） */
export type WwTask =
  | { t: 'nightStart' }
  | { t: 'guard' }
  | { t: 'wolves' }
  | { t: 'witch' }
  | { t: 'seer' }
  | { t: 'dawn' }
  | { t: 'sheriffSignup' }
  | { t: 'sheriffSpeech'; seat: number; pk?: boolean }
  | { t: 'sheriffVote'; candidates: number[]; round: 1 | 2 }
  | { t: 'announce' }
  | { t: 'death'; seat: number; cause: DeathCause; lastWords: boolean; marked?: boolean }
  | { t: 'shoot'; seat: number }
  | { t: 'lastWords'; seat: number }
  | { t: 'badge'; seat: number }
  | { t: 'speechOrder' }
  | { t: 'speech'; seat: number; pk?: boolean }
  | { t: 'vote'; candidates?: number[]; round: 1 | 2 }
  | { t: 'exile'; seat: number }
  | { t: 'end' };

/** 等人类玩家做的决定 */
export type WwPending =
  | { kind: 'target'; action: 'guard' | 'check' | 'shoot' | 'badge' | 'vote' | 'sheriffVote' | 'whitewolf'; options: number[]; allowSkip: boolean; prompt: string }
  | { kind: 'witch'; victim: number | null; canSave: boolean; canPoison: boolean; options: number[]; prompt: string }
  | { kind: 'yesno'; action: 'sheriffRun'; prompt: string }
  | {
      kind: 'speech';
      action: 'speech' | 'pk' | 'lastWords' | 'sheriffSpeech' | 'wolfchat';
      prompt: string;
      /** 狼人夜聊：同时选刀谁 */
      killOptions?: number[];
      canExplode?: boolean;
      /** 白狼王自爆时可以带走的人 */
      explodeOptions?: number[];
      duelOptions?: number[];
    };

export interface WwNight {
  day: number;
  guard?: number | null;
  wolfKill?: number | null;
  saved?: boolean;
  poison?: number | null;
  check?: { target: number; wolf: boolean };
  /** 狼人夜聊里每只狼的提议（中途停下再继续时不用重来） */
  wolfProposals?: { seat: number; target: number | null }[];
  deaths: { seat: number; cause: DeathCause }[];
}

export interface WerewolfState {
  boardName: string;
  roles: RoleCounts;
  seats: WwSeat[];
  /** 人类玩家的座位；旁观时没有 */
  humanSeat?: number;
  sheriffEnabled: boolean;
  sheriff: number | null;
  sheriffDone: boolean;
  /** 播报：固定文字 / AI 主持人 */
  narration: 'fixed' | 'ai';
  narratorModel: string;
  /** 屠边（杀光神职或平民）/ 屠城（杀光所有好人） */
  winRule: 'edge' | 'all';
  /** 第几天（第 N 夜在第 N 天之前） */
  day: number;
  phase: 'setup' | 'night' | 'day' | 'end';
  tasks: WwTask[];
  /** 正在进行的一步（服务重启后从这一步重新开始） */
  current?: WwTask;
  /** 界面上显示的「现在在干什么」 */
  activity?: string;
  /** activity 从什么时候开始（界面上显示已经等了多久） */
  activityAt?: number;
  witch: { save: boolean; poison: boolean };
  guardLast: number | null;
  knightUsed: boolean;
  nights: WwNight[];
  pending: (WwPending & { seat: number; id: string }) | null;
  winner: 'wolf' | 'village' | null;
  /** 旁观时是否显示每个人的身份 */
  showRoles: boolean;
  /** 每一步之间停多久（毫秒），让人看得过来 */
  pace: number;
  /** 你在座位上做的身份标记（座位号 → 猜测） */
  guesses?: Record<number, WwGuess>;
}

/** 公开信息里能确定的狼人数量：本局总数、公开确认出局的、场上还剩几名（范围） */
export function wolfCount(ww: WerewolfState) {
  const total = ROLE_ORDER.filter(isWolf).reduce((n, r) => n + (ww.roles[r] ?? 0), 0);
  const deadConfirmed = ww.seats.filter((s) => !s.alive && (s.revealed === 'role' || s.revealed === 'wolf') && isWolf(s.role)).length;
  // 出局但身份没公开的人里，可能有狼也可能没有
  const deadUnknown = ww.seats.filter((s) => !s.alive && !s.revealed).length;
  const max = total - deadConfirmed;
  const min = Math.max(ww.phase === 'end' ? 0 : 1, max - deadUnknown);
  return { total, deadConfirmed, min: Math.min(min, max), max };
}

// ---------------- 发身份 ----------------

export type Rng = () => number;

export function shuffle<T>(list: T[], rng: Rng = Math.random): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function dealRoles(roles: RoleCounts, rng: Rng = Math.random): WwRole[] {
  const deck = ROLE_ORDER.flatMap((r) => Array.from({ length: roles[r] ?? 0 }, () => r));
  return shuffle(deck, rng);
}

// ---------------- 查询 ----------------

export const seatOf = (s: WerewolfState, n: number) => s.seats.find((x) => x.seat === n);
export const alive = (s: WerewolfState) => s.seats.filter((x) => x.alive);
export const aliveSeats = (s: WerewolfState) => alive(s).map((x) => x.seat);
export const findRole = (s: WerewolfState, role: WwRole) => s.seats.find((x) => x.role === role);
export const aliveWolves = (s: WerewolfState) => alive(s).filter((x) => isWolf(x.role));
export const canVote = (x: WwSeat) => x.alive && !x.idiotRevealed;

/** 被毒死的不能开枪；自爆的狼王也不能 */
export function canShoot(x: WwSeat, cause: DeathCause) {
  return (x.role === 'hunter' || x.role === 'wolfking') && cause !== 'poison' && cause !== 'explode';
}

// ---------------- 夜晚结算 ----------------

/**
 * 天亮时结算昨晚的死亡：
 * - 被狼人杀害的人，被守卫守护或者被女巫救了就活下来；但同时被守又被救（同守同救）仍然出局；
 * - 被毒的人出局（守卫挡不住毒药）。
 */
export function resolveNight(n: WwNight): { seat: number; cause: DeathCause }[] {
  const deaths: { seat: number; cause: DeathCause }[] = [];
  if (n.wolfKill != null) {
    const guarded = n.guard === n.wolfKill;
    const saved = !!n.saved;
    if (guarded === saved) deaths.push({ seat: n.wolfKill, cause: 'wolf' });
  }
  if (n.poison != null) {
    const i = deaths.findIndex((d) => d.seat === n.poison);
    if (i >= 0) deaths[i].cause = 'poison';
    else deaths.push({ seat: n.poison, cause: 'poison' });
  }
  return deaths.sort((a, b) => a.seat - b.seat);
}

/** 狼人刀谁：票数最多的；平票时按第一位提议者的选择，否则取平票里座位最小的 */
export function wolfTarget(proposals: { seat: number; target: number | null }[]): number | null {
  const counts = new Map<number, number>();
  for (const p of proposals) if (p.target != null) counts.set(p.target, (counts.get(p.target) ?? 0) + 1);
  if (!counts.size) return null;
  const max = Math.max(...counts.values());
  const top = [...counts].filter(([, c]) => c === max).map(([t]) => t);
  const first = proposals.find((p) => p.target != null)?.target;
  return first != null && top.includes(first) ? first : Math.min(...top);
}

// ---------------- 投票 ----------------

export interface Tally {
  counts: { target: number; votes: number; voters: number[] }[];
  /** 得票最多的（可能平票） */
  top: number[];
  abstain: number[];
}

/** 计票：警长一票算 1.5 票 */
export function tallyVotes(votes: Record<number, number | null>, sheriff: number | null, weight = 1.5): Tally {
  const map = new Map<number, { votes: number; voters: number[] }>();
  const abstain: number[] = [];
  for (const [voterStr, target] of Object.entries(votes)) {
    const voter = Number(voterStr);
    if (target == null) {
      abstain.push(voter);
      continue;
    }
    const e = map.get(target) ?? { votes: 0, voters: [] };
    e.votes += voter === sheriff ? weight : 1;
    e.voters.push(voter);
    map.set(target, e);
  }
  const counts = [...map].map(([target, e]) => ({ target, votes: e.votes, voters: e.voters.sort((a, b) => a - b) })).sort((a, b) => b.votes - a.votes || a.target - b.target);
  const max = counts[0]?.votes ?? 0;
  return { counts, top: counts.filter((c) => c.votes === max).map((c) => c.target), abstain: abstain.sort((a, b) => a - b) };
}

// ---------------- 胜负 ----------------

/** 好人杀光狼人获胜；狼人屠边（杀光所有神职或所有平民）或屠城（杀光所有好人）获胜 */
export function checkWinner(s: Pick<WerewolfState, 'seats' | 'winRule'>): 'wolf' | 'village' | null {
  const living = s.seats.filter((x) => x.alive);
  if (!living.some((x) => isWolf(x.role))) return 'village';
  const goods = living.filter((x) => !isWolf(x.role));
  if (!goods.length) return 'wolf';
  if (s.winRule === 'edge') {
    const hasGods = s.seats.some((x) => isGod(x.role));
    const hasVillagers = s.seats.some((x) => x.role === 'villager');
    if (hasGods && !goods.some((x) => isGod(x.role))) return 'wolf';
    if (hasVillagers && !goods.some((x) => x.role === 'villager')) return 'wolf';
  }
  return null;
}

// ---------------- 发言顺序 ----------------

/**
 * 白天的发言顺序（只算活着的人）：
 * 有警长时从警长的下一位开始，警长最后发言；没有警长时从 startAfter（昨晚最先出局的座位）的下一位开始。
 */
export function speechOrder(s: Pick<WerewolfState, 'seats' | 'sheriff'>, startAfter: number | null): number[] {
  const seats = s.seats.map((x) => x.seat).sort((a, b) => a - b);
  const living = new Set(s.seats.filter((x) => x.alive).map((x) => x.seat));
  const sheriff = s.sheriff != null && living.has(s.sheriff) ? s.sheriff : null;
  const pivot = sheriff ?? startAfter ?? seats[seats.length - 1];
  const i = Math.max(0, seats.indexOf(pivot));
  const rotated = [...seats.slice(i + 1), ...seats.slice(0, i + 1)].filter((n) => living.has(n));
  if (sheriff == null) return rotated;
  return [...rotated.filter((n) => n !== sheriff), sheriff];
}

// ---------------- 谁能看到什么 ----------------

/** 消息的可见范围：所有人 / 狼人频道 / 某个座位 / 只有上帝视角 */
export type WwVisibility = 'public' | 'wolves' | `seat:${number}` | 'god';

export interface WwViewer {
  /** 上帝视角：旁观、或者自己已经出局 */
  god: boolean;
  seat?: number;
  wolf: boolean;
}

export function canSee(v: WwVisibility | undefined, viewer: WwViewer) {
  if (!v || v === 'public') return true;
  if (viewer.god) return true;
  if (v === 'wolves') return viewer.wolf;
  if (v === 'god') return false;
  return v === `seat:${viewer.seat}`;
}

/** 人类玩家现在的视角 */
export function viewerOf(s: WerewolfState): WwViewer {
  const me = s.humanSeat != null ? seatOf(s, s.humanSeat) : undefined;
  if (!me) return { god: true, wolf: false };
  return { god: !me.alive || s.phase === 'end', seat: me.seat, wolf: isWolf(me.role) };
}

/** AI 主持人的播报有没有漏说或者说错座位号：座位号和准确结果里的不一样，就要把准确结果也显示出来 */
export function narrationNeedsFacts(narration: string, facts: string) {
  const seats = (t: string) => [...new Set([...t.matchAll(/(\d+)\s*号/g)].map((m) => m[1]))].sort().join(',');
  return seats(narration) !== seats(facts);
}

/**
 * 在「AI」页改了某个 AI 的名字、头像或颜色：座位和这一局里它说过的话一起改（座位号和身份不变）。
 * 返回改动过的消息，好推给前端。
 */
export function syncSeatFromParticipant(room: Room, p: Participant): Message[] {
  const ww = room.werewolf;
  const seat = ww?.seats.find((s) => s.participantId === p.id);
  if (!seat) return [];
  seat.name = p.name;
  seat.avatar = p.avatar;
  const changed: Message[] = [];
  for (const m of room.messages) {
    // 游戏结束时的「身份公开」里写着每个人的名字（旧版本的消息没有 reveal 标记，按开头认）
    if (m.kind === 'ww' && (m.ww?.reveal || m.content.startsWith('身份公开：'))) {
      const content = revealText(ww!);
      if (m.content !== content) {
        m.content = content;
        changed.push(m);
      }
      continue;
    }
    if (m.participantId !== p.id) continue;
    const speakerName = `${seatLabel(seat.seat)} ${p.name}`;
    if (m.speakerName === speakerName && m.avatar === p.avatar && m.color === p.color) continue;
    Object.assign(m, { speakerName, avatar: p.avatar, color: p.color });
    changed.push(m);
  }
  return changed;
}

/** 游戏结束时公开所有人的身份 */
export function revealText(ww: WerewolfState) {
  return `身份公开：${ww.seats.map((s) => `${seatLabel(s.seat)} ${s.name}：${ROLE_INFO[s.role].name}`).join('；')}。`;
}

/** 「3号」这样的称呼 */
export const seatLabel = (n: number) => `${n}号`;
