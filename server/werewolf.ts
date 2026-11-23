// 狼人杀：程序当法官，按规则推进流程；AI 玩家只负责以自己的身份发言、投票、选择夜间目标。
//
// 流程是一个存在房间里的「待办步骤」队列（夜里守卫 → 狼人 → 女巫 → 预言家 → 天亮 → 警长竞选 → 公布死讯 →
// 发言 → 投票 → 放逐 ……）。每一步开始前先存盘，暂停、停止或者服务重启以后都能从这一步接着做。
// 每个 AI 只看得到自己该知道的信息：公开发言和公告、自己的夜间结果、狼人能看到狼队频道。

import {
  ROLE_INFO,
  aliveSeats,
  aliveWolves,
  canShoot,
  canSee,
  checkWinner,
  dealRoles,
  findRole,
  isWolf,
  resolveNight,
  rolesText,
  seatLabel,
  seatOf,
  shuffle,
  speechOrder,
  tallyVotes,
  wolfCount,
  wolfTarget,
  BOARDS,
  checkRoles,
  boardSize,
  DEATH_LABELS,
  type DeathCause,
  type RoleCounts,
  type WerewolfState,
  type WwNight,
  type WwPending,
  type WwSeat,
  type WwTask,
  type WwVisibility,
  type WerewolfCreateOptions,
} from '../shared/werewolf.ts';

export type { WerewolfCreateOptions };
import type { Message, Participant, Room, RoomEvent, WwMessageInfo } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { completeChat, streamChat, streamMeter, type ChatMessage } from './llm.ts';
import { newId, type Store } from './store.ts';

// ---------------- 新建房间 ----------------


const AI_NAMES = ['林薇', '周铭', '顾远', '苏晴', '陈墨', '叶舟', '沈默', '许知', '江屿', '宋然', '白露', '温言', '秦川', '夏禾', '陆离', '安歌', '程野', '唐棠'];
const AVATARS = ['🦊', '🐱', '🐼', '🦉', '🐯', '🐸', '🐧', '🦁', '🐨', '🐰', '🐻', '🐶', '🐹', '🦄', '🐙', '🦋'];
const COLORS = ['#38bdf8', '#c084fc', '#fb923c', '#4ade80', '#f472b6', '#facc15', '#f87171', '#a78bfa', '#2dd4bf', '#fda4af', '#93c5fd', '#bef264'];
const STYLES = [
  '说话简短直接，不爱绕弯子',
  '喜欢分析，逻辑链条清楚，会复盘每个人的发言',
  '情绪比较外露，被怀疑时会激动地辩解',
  '谨慎保守，不轻易表态，喜欢观察别人',
  '喜欢带节奏，说话有煽动性',
  '幽默，爱开玩笑，但关键时刻很认真',
  '有点新手，偶尔犹豫，但很真诚',
  '老练，擅长抓发言里的漏洞',
];

export function createWerewolfRoom(o: WerewolfCreateOptions, defaultModel: string, rng: () => number = Math.random): Room {
  const board = BOARDS.find((b) => b.id === o.boardId);
  const roles: RoleCounts = board ? board.roles : (o.roles ?? BOARDS[1].roles);
  const problem = checkRoles(roles);
  if (problem) throw new Error(problem);
  const n = boardSize(roles);
  const deck = dealRoles(roles, rng);
  const humanSeat = o.join === false ? undefined : 1 + Math.floor(rng() * n);
  const humanName = (o.humanName || '我').trim() || '我';
  const names = shuffle(AI_NAMES.filter((x) => x !== humanName), rng);
  const avatars = shuffle(AVATARS, rng);
  const styles = shuffle(STYLES, rng);
  const model = o.model || defaultModel;
  const participants: Participant[] = [];
  const seats: WwSeat[] = deck.map((role, i) => {
    const seat = i + 1;
    if (seat === humanSeat) return { seat, name: humanName, avatar: '🧑', human: true, role, alive: true };
    const name = names.shift() ?? `玩家${seat}`;
    const avatar = avatars[i % avatars.length];
    const p: Participant = {
      id: newId(),
      name,
      avatar,
      color: COLORS[i % COLORS.length],
      model,
      reasoningEffort: o.effort ?? '',
      bio: `${seat}号玩家`,
      persona: styles[i % styles.length],
      temperature: 0.9,
      enabled: true,
    };
    participants.push(p);
    return { seat, name, avatar, participantId: p.id, role, alive: true };
  });
  const now = Date.now();
  const werewolf: WerewolfState = {
    boardName: board?.name ?? `${n} 人自定义局`,
    roles,
    seats,
    humanSeat,
    sheriffEnabled: o.sheriff ?? n >= 9,
    sheriff: null,
    sheriffDone: false,
    narration: o.narration === 'ai' ? 'ai' : 'fixed',
    narratorModel: o.narratorModel || model,
    winRule: o.winRule === 'all' ? 'all' : 'edge',
    day: 0,
    phase: 'setup',
    tasks: [],
    witch: { save: true, poison: true },
    guardLast: null,
    knightUsed: false,
    nights: [],
    pending: null,
    winner: null,
    showRoles: true,
    pace: 800,
  };
  return {
    id: newId(),
    mode: 'werewolf',
    title: `狼人杀 · ${werewolf.boardName}`,
    scenario: `${n} 人局：${rolesText(roles)}`,
    participants,
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS, humanName, humanRole: humanSeat ? 'participant' : 'observer', turnMode: 'manual', autoPauseAfter: 0 },
    werewolf,
    createdAt: now,
    updatedAt: now,
  };
}

/** 再来一局：同样的玩家和板子，重新发身份 */
export function resetWerewolf(room: Room, rng: () => number = Math.random) {
  const ww = room.werewolf!;
  const deck = dealRoles(ww.roles, rng);
  ww.seats = ww.seats.map((s, i) => ({ seat: s.seat, name: s.name, avatar: s.avatar, participantId: s.participantId, human: s.human, role: deck[i], alive: true }));
  Object.assign(ww, {
    sheriff: null,
    sheriffDone: false,
    day: 0,
    phase: 'setup',
    tasks: [],
    current: undefined,
    activity: undefined,
    activityAt: undefined,
    guesses: {},
    witch: { save: true, poison: true },
    guardLast: null,
    knightUsed: false,
    nights: [],
    pending: null,
    winner: null,
  } satisfies Partial<WerewolfState>);
  room.messages = [];
}

// ---------------- 给 AI 的提示词 ----------------

const winText = (ww: WerewolfState) =>
  ww.winRule === 'edge' ? '狼人杀光所有神职或者所有平民就获胜（屠边）；好人放逐或杀死所有狼人就获胜' : '狼人杀光所有好人才获胜（屠城）；好人放逐或杀死所有狼人就获胜';

function rulesText(ww: WerewolfState) {
  const has = (r: keyof typeof ROLE_INFO) => (ww.roles[r] ?? 0) > 0;
  const lines = [
    '- 每晚狼人一起选一名玩家杀害；天亮后法官公布昨晚出局的玩家（不公布死因）。',
    ww.sheriffEnabled ? '- 第一天白天先竞选警长：想当的人上警发言，其他人投票。警长投票算 1.5 票，白天最后一个发言；警长出局时可以把警徽交给别人或者撕掉。' : '',
    '- 白天按顺序每人发言一次，然后所有人投票放逐一名玩家；平票的玩家再各发言一次，其他人重新投票，再平票就没人出局。被放逐的玩家有遗言；第一夜出局的玩家也有遗言。',
    has('witch') ? '- 女巫：一瓶解药一瓶毒药，各用一次，同一晚只能用一瓶，不能救自己；用掉解药以后就不知道每晚谁被杀了。' : '',
    has('guard') ? '- 守卫：每晚守护一人，不能连续两晚守同一个人；同一个人被守卫守护又被女巫救，仍然会出局。' : '',
    has('hunter') || has('wolfking') ? '- 猎人和狼王出局时可以开枪带走一名玩家，但被毒死不能开枪。' : '',
    has('idiot') ? '- 白痴被投票放逐时翻牌免死，之后还能发言但不能投票。' : '',
    has('knight') ? '- 骑士白天发言时可以翻牌和一名玩家决斗（一局一次）：对方是狼人则对方出局、直接进入黑夜；对方是好人则骑士出局。' : '',
    '- 狼人可以在白天发言时自爆，直接结束当天进入黑夜' + (has('whitewolf') ? '；白狼王自爆时可以带走一名玩家。' : '。'),
  ];
  return lines.filter(Boolean).join('\n');
}

function systemPrompt(room: Room, x: WwSeat, p: Participant) {
  const ww = room.werewolf!;
  const info = ROLE_INFO[x.role];
  const team = info.team === 'wolf' ? '狼人阵营' : '好人阵营';
  const mates = isWolf(x.role)
    ? ww.seats
        .filter((s) => s.seat !== x.seat && isWolf(s.role))
        .map((s) => `${seatLabel(s.seat)}${s.role === 'werewolf' ? '' : `（${ROLE_INFO[s.role].name}）`}`)
        .join('、')
    : '';
  return [
    `你正在和朋友们玩一局狼人杀，你是 ${seatLabel(x.seat)} 玩家「${x.name}」。`,
    `你的身份：${info.name}（${team}）。${info.desc}`,
    mates ? `你的狼队友：${mates}。好人不知道谁是狼人，不要暴露队友。` : '',
    `\n本局 ${ww.seats.length} 人：${rolesText(ww.roles)}。${winText(ww)}。`,
    `\n【规则】\n${rulesText(ww)}`,
    `\n【怎么玩】
- 你的目标是让你的阵营获胜。像真人玩家一样说话：口语化，有自己的判断、立场和情绪，可以怀疑别人、为自己辩解、拉票、跳身份。
- ${info.team === 'wolf' ? '你是狼人：要伪装成好人，可以假装成平民甚至冒充神职，带偏好人的判断；也要配合队友。' : '你是好人：认真分析每个人的发言和投票，找出狼人。神职要考虑什么时候亮明身份。'}
- 只根据你能知道的信息推理。别人的身份你不知道（除非你是狼人、或者你查验过），不要假装知道，除非你是在故意骗人。
- 每次发言 60~180 字，说清楚你的看法和你打算投谁。不要说自己是 AI，不要提到这些规则说明。`,
    p.persona.trim() ? `\n【你的说话风格】${p.persona.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 这个座位能看到的对局记录 → 发给模型的消息（自己的发言是 assistant） */
function historyFor(room: Room, x: WwSeat): ChatMessage[] {
  const viewer = { god: false, seat: x.seat, wolf: isWolf(x.role) };
  const turns: ChatMessage[] = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  };
  for (const m of room.messages) {
    if (m.status === 'streaming' || m.status === 'error' || !m.content.trim()) continue;
    if (!canSee(m.visibility, viewer)) continue;
    const seat = m.ww?.seat;
    if (m.kind === 'ww') {
      push('user', m.visibility?.startsWith('seat:') ? `【只有你知道】${m.content}` : m.visibility === 'wolves' ? `【狼队频道】${m.content}` : `【法官】${m.content}`);
    } else if (seat === x.seat) {
      push('assistant', m.content.trim());
    } else if (seat != null) {
      const who = `${seatLabel(seat)} ${seatOf(room.werewolf!, seat)?.name ?? ''}`.trim();
      const tag = m.ww?.speech === 'wolfchat' ? `狼队夜聊 · ${who}` : m.ww?.speech === 'lastWords' ? `${who} 的遗言` : m.ww?.speech === 'sheriffSpeech' ? `${who}（警长竞选发言）` : who;
      push('user', `【${tag}】：${m.content.trim()}`);
    }
  }
  return turns;
}

/** 公开的身份：开枪、自爆、骑士决斗、白痴翻牌 */
const revealedText = (s: WwSeat) => (s.revealed === 'role' ? ROLE_INFO[s.role].name : s.revealed === 'wolf' ? '狼人' : '好人');

/** 最后一条消息里附上的局面、所有人都知道的公开信息，和自己的私密信息 */
function stateBlock(room: Room, x: WwSeat) {
  const ww = room.werewolf!;
  const living = ww.seats.filter((s) => s.alive);
  const dead = ww.seats.filter((s) => !s.alive).map((s) => `${seatLabel(s.seat)}（第 ${s.death?.day} 天，${DEATH_LABELS[s.death!.cause]}）`);
  const wolves = wolfCount(ww);
  const reveals = ww.seats.filter((s) => s.revealed).map((s) => `${seatLabel(s.seat)} 是${revealedText(s)}${s.alive ? '' : '（已出局）'}`);
  const hidden = ww.seats.filter((s) => !s.alive && !s.revealed).map((s) => seatLabel(s.seat));
  const range = wolves.min === wolves.max ? `${wolves.max} 名` : `${wolves.min}~${wolves.max} 名`;
  const facts = [
    `本局狼人阵营一共 ${wolves.total} 名。`,
    reveals.length ? `已经公开的身份：${reveals.join('、')}。` : '还没有人公开身份。',
    hidden.length ? `${hidden.join('、')} 出局时没有公开身份。` : '',
    wolves.deadConfirmed ? `确认出局的狼人 ${wolves.deadConfirmed} 名。` : '还没有确认出局的狼人。',
    `只看公开信息，场上还剩 ${range}狼人${wolves.min < wolves.max ? '（出局的人里有没有狼还不确定）' : ''}。`,
  ];

  const mine: string[] = [];
  if (isWolf(x.role)) {
    const team = ww.seats.filter((s) => isWolf(s.role));
    const alive = team.filter((s) => s.alive).map((s) => (s.seat === x.seat ? `你（${seatLabel(s.seat)}）` : seatLabel(s.seat)));
    const gone = team.filter((s) => !s.alive).map((s) => `${seatLabel(s.seat)}（第 ${s.death?.day} 天${DEATH_LABELS[s.death!.cause]}）`);
    mine.push(`狼队现在还活着 ${alive.length} 人：${alive.join('、') || '没有了'}${gone.length ? `；已经出局的队友：${gone.join('、')}` : ''}。场上一共还有 ${alive.length} 名狼人`);
  }
  if (x.role === 'seer') {
    const checks = ww.nights.filter((n) => n.check).map((n) => `第 ${n.day} 夜验 ${seatLabel(n.check!.target)}：${n.check!.wolf ? '狼人' : '好人'}`);
    if (checks.length) mine.push(`你的查验结果：${checks.join('；')}`);
    const aliveWolves = ww.nights.filter((n) => n.check?.wolf && seatOf(ww, n.check.target)?.alive).map((n) => seatLabel(n.check!.target));
    if (aliveWolves.length) mine.push(`你验出的狼人里还活着的：${aliveWolves.join('、')}`);
  }
  if (x.role === 'witch') {
    mine.push(`你的药：解药${ww.witch.save ? '还在' : '已用'}，毒药${ww.witch.poison ? '还在' : '已用'}`);
    const used = ww.nights.flatMap((n) => [n.saved && n.wolfKill ? `第 ${n.day} 夜救了 ${seatLabel(n.wolfKill)}` : '', n.poison ? `第 ${n.day} 夜毒了 ${seatLabel(n.poison)}` : '']).filter(Boolean);
    if (used.length) mine.push(`你用过的药：${used.join('；')}`);
  }
  if (x.role === 'guard') {
    const guarded = ww.nights.filter((n) => n.guard).map((n) => `第 ${n.day} 夜守 ${seatLabel(n.guard!)}`);
    if (guarded.length) mine.push(`你守护过：${guarded.join('；')}（不能连续两晚守同一个人）`);
  }
  if (x.role === 'knight') mine.push(ww.knightUsed ? '你已经用过决斗' : '你的决斗还没用');
  return [
    `【当前局面】第 ${ww.day} 天${ww.phase === 'night' ? '夜里' : '白天'}。存活 ${living.length} 人：${living.map((s) => `${seatLabel(s.seat)}${s.idiotRevealed ? '（白痴，已翻牌，不能投票）' : ''}`).join('、')}。${dead.length ? `出局：${dead.join('、')}。` : ''}${ww.sheriff ? `警长：${seatLabel(ww.sheriff)}。` : ''}`,
    `【公开信息】${facts.filter(Boolean).join('')}`,
    `【你】${seatLabel(x.seat)}「${x.name}」，身份${ROLE_INFO[x.role].name}${x.alive ? '' : '（你已经出局）'}。${mine.join('。')}${mine.length ? '。' : ''}`,
  ].join('\n');
}

function buildMessages(room: Room, x: WwSeat, p: Participant, task: string): ChatMessage[] {
  const turns = historyFor(room, x);
  const tail = `${stateBlock(room, x)}\n\n${task}`;
  const last = turns[turns.length - 1];
  if (last && last.role === 'user') last.content += `\n\n${tail}`;
  else turns.push({ role: 'user', content: tail });
  return [{ role: 'system', content: systemPrompt(room, x, p) }, ...turns];
}

const list = (seats: number[]) => seats.map(seatLabel).join('、');

/** 「【选择:5号】」→ 5；「【选择:不选】」→ null；看不懂 → undefined */
export function parseChoice(text: string, options: number[], allowSkip: boolean): number | null | undefined {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = clean.match(/【\s*选择\s*[:：]\s*([^】]*)】/) ?? clean.match(/选择\s*[:：]\s*(\S+)/);
  const raw = m?.[1] ?? clean;
  if (allowSkip && /不选|弃票|不投|不开枪|空守|不守|撕|放弃|不用/.test(raw)) return null;
  const n = Number(raw.match(/(\d+)\s*号?/)?.[1]);
  if (options.includes(n)) return n;
  return undefined;
}

/** 发言末尾的动作：【自爆】【自爆:5号】【决斗:5号】【刀:5号】 */
/** 给人类看的提示：去掉只写给 AI 的格式要求（【刀:N号】之类）和可选列表（界面上有按钮） */
export function humanPrompt(task: string) {
  return task
    .replace(/^【任务：[^】]+】/, '')
    .split(/(?<=[。！？])/)
    .filter((x) => !x.includes('【') && !/^\s*可选：/.test(x))
    .join('')
    .trim();
}

export function parseSpeechActions(text: string) {
  const explode = /【\s*自爆\s*(?:[:：]\s*(\d+)\s*号?)?\s*】/.exec(text);
  const duel = /【\s*决斗\s*[:：]\s*(\d+)\s*号?\s*】/.exec(text);
  const kill = /【\s*(?:刀|杀)\s*[:：]\s*(\d+|不刀|空刀)\s*号?\s*】/.exec(text);
  const content = text
    .replace(/【\s*(?:自爆|决斗|刀|杀)[^】]*】/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return {
    content,
    explode: !!explode,
    explodeTarget: explode?.[1] ? Number(explode[1]) : undefined,
    duel: duel ? Number(duel[1]) : undefined,
    kill: kill ? (/\d/.test(kill[1]) ? Number(kill[1]) : null) : undefined,
  };
}

// ---------------- 对局控制 ----------------

/** RoomRunner 提供给狼人杀的能力 */
export interface WwHost {
  readonly roomId: string;
  readonly store: Store;
  room(): Room;
  emit(ev: RoomEvent): void;
  emitRoomMeta(): void;
  setGenerating(g: { messageId: string; participantId: string } | null): void;
  notice(text: string, level?: 'info' | 'error'): void;
  isRunning(): boolean;
  /** 对局循环停下了（暂停、出错或者结束） */
  stopped(): void;
}

type SpeechKind = Extract<WwPending, { kind: 'speech' }>['action'];
interface SpeechResult {
  explode: boolean;
  explodeTarget?: number;
  duel?: number;
  kill?: number | null;
}

export type WwAnswer = { target?: number | null; action?: 'save' | 'poison' | 'none'; yes?: boolean; text?: string; explode?: boolean; explodeTarget?: number; duel?: number };

export class WerewolfGame {
  private looping = false;
  private controller: AbortController | null = null;
  private waiting: { id: string; resolve: (a: WwAnswer) => void; reject: (e: unknown) => void } | null = null;

  constructor(private host: WwHost) {}

  private get room() {
    return this.host.room();
  }
  private get ww() {
    return this.room.werewolf!;
  }
  private save() {
    this.host.store.touchRoom(this.host.roomId, { immediate: true });
  }
  private meta() {
    this.save();
    this.host.emitRoomMeta();
  }
  private setActivity(text: string | undefined) {
    if (text !== this.ww.activity) this.ww.activityAt = text ? Date.now() : undefined;
    this.ww.activity = text;
    this.host.emitRoomMeta();
  }

  get running() {
    return this.looping;
  }

  /** 开始 / 继续 */
  start() {
    if (this.looping) return;
    void this.loop();
  }

  /** 停止：打断正在进行的调用；这一步会在继续时重新开始 */
  abort() {
    this.controller?.abort();
    this.controller = null;
    if (this.waiting) {
      this.waiting.reject(new DOMException('已停止', 'AbortError'));
      this.waiting = null;
    }
  }

  /** 人类玩家提交决定 */
  answer(id: string, a: WwAnswer) {
    const pending = this.ww.pending;
    if (!pending || pending.id !== id || !this.waiting) throw new Error('现在不需要你做决定（可能已经过时了，刷新一下）');
    const w = this.waiting;
    this.waiting = null;
    w.resolve(a);
  }

  private async loop() {
    this.looping = true;
    try {
      while (this.host.isRunning()) {
        const ww = this.ww;
        if (ww.phase === 'end') break;
        if (!ww.current) {
          if (!ww.tasks.length) ww.tasks.push({ t: 'nightStart' });
          ww.current = ww.tasks.shift()!;
          this.save();
        }
        this.controller = null;
        try {
          await this.runTask(ww.current);
          ww.current = undefined;
          ww.activity = ww.activityAt = undefined;
          this.meta();
        } catch (err) {
          const aborted = (err as { name?: string })?.name === 'AbortError';
          ww.pending = null;
          ww.activity = ww.activityAt = undefined;
          this.meta();
          if (!aborted) this.host.notice(`狼人杀暂停了：${err instanceof Error ? err.message : String(err)}。处理好以后点「继续」从这一步重新开始。`, 'error');
          break;
        }
        if (this.ww.phase === 'end') break;
        if (this.ww.pace > 0) await new Promise((r) => setTimeout(r, this.ww.pace));
      }
    } finally {
      this.looping = false;
      this.host.setGenerating(null);
      this.host.stopped();
    }
  }

  // ---------- 消息 ----------

  private addMessage(m: Omit<Message, 'id' | 'createdAt' | 'status'> & { status?: Message['status'] }): Message {
    const msg: Message = { id: newId(), createdAt: Date.now(), status: 'done', ...m };
    this.room.messages.push(msg);
    this.host.emit({ type: 'message_added', message: msg });
    this.save();
    return msg;
  }

  /** 法官消息 */
  private judge(content: string, type: WwMessageInfo['type'], visibility: WwVisibility = 'public', extra: Partial<WwMessageInfo> = {}) {
    return this.addMessage({ role: 'system', kind: 'ww', speakerName: '法官', content, visibility, ww: { type, ...extra } });
  }

  /** 重要公告：固定文字，或者让 AI 主持人播报 */
  private async narrate(facts: string, type: WwMessageInfo['type'] = 'announce') {
    const ww = this.ww;
    if (ww.narration !== 'ai') return this.judge(facts, type);
    const settings = this.host.store.getSettings();
    const msg = this.addMessage({ role: 'system', kind: 'ww', speakerName: '法官', content: '', status: 'streaming', visibility: 'public', ww: { type } });
    // 用局部变量：abort() 会把 this.controller 清空
    const controller = new AbortController();
    this.controller = controller;
    try {
      let text = '';
      for await (const chunk of streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: ww.narratorModel || settings.defaultModel,
        temperature: 0.9,
        sessionId: `ai-chat-${this.host.roomId}-narrator`,
        signal: controller.signal,
        messages: [
          {
            role: 'system',
            content:
              '你是一局狼人杀的法官主持人。用一两句有氛围的话播报下面的结果，像主持人在现场说话。只能说给出的事实（座位号要说对），不要透露任何没给出的身份信息，不要加新的事实，不要分析局势。',
          },
          { role: 'user', content: facts },
        ],
      })) {
        if (!chunk.content) continue;
        text += chunk.content;
        msg.content = text;
        this.host.emit({ type: 'message_delta', messageId: msg.id, content: chunk.content });
      }
      msg.content = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || facts;
      // 播报里一定要有准确的结果：AI 的话后面附上原始事实
      if (!msg.content.includes(facts)) msg.content += `\n\n（${facts}）`;
    } catch (err) {
      if (controller.signal.aborted) {
        this.room.messages = this.room.messages.filter((m) => m !== msg);
        this.host.emit({ type: 'message_deleted', messageId: msg.id });
        throw err;
      }
      msg.content = facts;
    } finally {
      this.controller = null;
    }
    msg.status = 'done';
    this.host.emit({ type: 'message_updated', message: msg });
    this.save();
    return msg;
  }

  // ---------- 和玩家交互 ----------

  private participantOf(x: WwSeat) {
    const p = this.room.participants.find((q) => q.id === x.participantId);
    if (!p) throw new Error(`${seatLabel(x.seat)} 找不到对应的 AI 玩家`);
    return p;
  }

  private isHuman(x: WwSeat) {
    return !!x.human;
  }

  /** 等人类玩家做决定 */
  private ask(seat: number, p: WwPending): Promise<WwAnswer> {
    const id = newId();
    this.ww.pending = { ...p, seat, id };
    this.meta();
    return new Promise<WwAnswer>((resolve, reject) => {
      this.waiting = { id, resolve, reject };
    }).finally(() => {
      if (this.ww.pending?.id === id) this.ww.pending = null;
      this.meta();
    });
  }

  /** 让 AI 做一个决定：只回复一行「【选择:N号】」；看不懂时再问一次，还不行就随机 */
  private async aiDecide(x: WwSeat, task: string): Promise<string> {
    const p = this.participantOf(x);
    const settings = this.host.store.getSettings();
    this.controller ??= new AbortController();
    const signal = this.controller.signal;
    return completeChat({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: p.model || settings.defaultModel,
      reasoningEffort: p.reasoningEffort || undefined,
      temperature: p.temperature,
      sessionId: `ai-chat-${this.host.roomId}-${p.id}`,
      signal,
      messages: buildMessages(this.room, x, p, task),
    });
  }

  /** 选一个座位（或者不选） */
  private async choose(seat: number, action: Extract<WwPending, { kind: 'target' }>['action'], options: number[], allowSkip: boolean, prompt: string): Promise<number | null> {
    const x = seatOf(this.ww, seat)!;
    if (!options.length) return null;
    if (this.isHuman(x)) {
      const a = await this.ask(seat, { kind: 'target', action, options, allowSkip, prompt });
      if (a.target == null) return allowSkip ? null : options[0];
      return options.includes(a.target) ? a.target : allowSkip ? null : options[0];
    }
    const task = `【任务：选择】${prompt}\n可选：${list(options)}${allowSkip ? '，或者「不选」' : ''}。\n只回复一行：【选择:N号】${allowSkip ? '（或者【选择:不选】）' : ''}，可以在下一行用一句话说明理由（不会公开）。`;
    for (let i = 0; i < 2; i++) {
      const text = await this.aiDecide(x, i ? `${task}\n（上次的回复格式不对，这次只回复【选择:N号】）` : task);
      const c = parseChoice(text, options, allowSkip);
      if (c !== undefined) return c;
    }
    return allowSkip ? null : options[Math.floor(Math.random() * options.length)];
  }

  /** 发言（AI 实时显示；人类在界面上输入） */
  private async speak(seat: number, action: SpeechKind, task: string, extra: Partial<Extract<WwPending, { kind: 'speech' }>> = {}): Promise<SpeechResult> {
    const ww = this.ww;
    const x = seatOf(ww, seat)!;
    const visibility: WwVisibility = action === 'wolfchat' ? 'wolves' : 'public';
    const speakerName = `${seatLabel(seat)} ${x.name}`;
    if (this.isHuman(x)) {
      const a = await this.ask(seat, { kind: 'speech', action, prompt: humanPrompt(task), ...extra });
      const text = (a.text ?? '').trim() || '（过）';
      this.addMessage({ role: 'human', speakerName, content: text, visibility, ww: { type: 'announce', seat, speech: action } });
      return { explode: !!a.explode && !!extra.canExplode, explodeTarget: a.explodeTarget, duel: a.duel, kill: a.target ?? undefined };
    }
    const p = this.participantOf(x);
    const settings = this.host.store.getSettings();
    const model = p.model || settings.defaultModel;
    const msg = this.addMessage({
      role: 'ai',
      participantId: p.id,
      speakerName,
      avatar: x.avatar,
      color: p.color,
      model,
      reasoningEffort: p.reasoningEffort || undefined,
      content: '',
      reasoning: '',
      status: 'streaming',
      visibility,
      ww: { type: 'announce', seat, speech: action },
    });
    this.host.setGenerating({ messageId: msg.id, participantId: p.id });
    const controller = new AbortController();
    this.controller = controller;
    const meter = streamMeter(msg);
    try {
      for await (const chunk of streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model,
        reasoningEffort: p.reasoningEffort || undefined,
        temperature: p.temperature,
        sessionId: `ai-chat-${this.host.roomId}-${p.id}`,
        signal: controller.signal,
        messages: buildMessages(this.room, x, p, task),
      })) {
        if (chunk.content) msg.content += chunk.content;
        if (chunk.reasoning) msg.reasoning += chunk.reasoning;
        const thinkMs = meter.chunk(chunk);
        if (!chunk.content && !chunk.reasoning && thinkMs === undefined) continue;
        this.host.emit({ type: 'message_delta', messageId: msg.id, content: chunk.content, reasoning: chunk.reasoning, ...(thinkMs !== undefined ? { thinkMs } : {}) });
      }
      meter.finish();
    } catch (err) {
      // 停止或出错：去掉没说完的发言，这一步之后重新开始
      this.room.messages = this.room.messages.filter((m) => m !== msg);
      this.host.emit({ type: 'message_deleted', messageId: msg.id });
      if (controller.signal.aborted) throw err;
      throw new Error(`${speakerName} 的模型出错了（${err instanceof Error ? err.message : String(err)}），可以在「AI」页换个模型`);
    } finally {
      this.controller = null;
      this.host.setGenerating(null);
    }
    const r = parseSpeechActions(msg.content.replace(/<think>[\s\S]*?<\/think>/g, ''));
    msg.content = r.content || '（没有说话）';
    msg.reasoning = msg.reasoning?.trim() || undefined;
    msg.status = 'done';
    this.host.emit({ type: 'message_updated', message: msg });
    this.save();
    return {
      explode: r.explode && !!extra.canExplode,
      explodeTarget: r.explodeTarget && extra.explodeOptions?.includes(r.explodeTarget) ? r.explodeTarget : undefined,
      duel: r.duel && extra.duelOptions?.includes(r.duel) ? r.duel : undefined,
      kill: r.kill === null ? null : r.kill && extra.killOptions?.includes(r.kill) ? r.kill : undefined,
    };
  }

  /** 同时问很多人（投票、上警）：AI 一起想，最后一起公布 */
  private async all<T>(seats: number[], fn: (seat: number) => Promise<T>): Promise<Map<number, T>> {
    this.controller = new AbortController();
    try {
      const human = seats.filter((s) => seatOf(this.ww, s)?.human);
      const ai = seats.filter((s) => !human.includes(s));
      const results = await Promise.all([...ai.map(async (s) => [s, await fn(s)] as const), ...human.map(async (s) => [s, await fn(s)] as const)]);
      return new Map(results);
    } finally {
      this.controller = null;
    }
  }

  // ---------- 每一步 ----------

  private night(): WwNight {
    const ww = this.ww;
    let n = ww.nights.find((x) => x.day === ww.day);
    if (!n) {
      n = { day: ww.day, deaths: [] };
      ww.nights.push(n);
    }
    return n;
  }

  private async runTask(task: WwTask) {
    const ww = this.ww;
    switch (task.t) {
      case 'nightStart': {
        ww.day += 1;
        ww.phase = 'night';
        this.night();
        this.judge(`第 ${ww.day} 夜，天黑请闭眼。`, 'phase');
        const next: WwTask[] = [];
        const alive = (r: Parameters<typeof findRole>[1]) => findRole(ww, r)?.alive;
        if (alive('guard')) next.push({ t: 'guard' });
        next.push({ t: 'wolves' });
        if (alive('witch') && (ww.witch.save || ww.witch.poison)) next.push({ t: 'witch' });
        if (alive('seer')) next.push({ t: 'seer' });
        next.push({ t: 'dawn' });
        ww.tasks.unshift(...next);
        return;
      }

      case 'guard': {
        const g = findRole(ww, 'guard')!;
        this.setActivity('守卫正在行动…');
        const options = aliveSeats(ww).filter((n) => n !== ww.guardLast);
        const target = await this.choose(g.seat, 'guard', options, true, `今晚你要守护谁？${ww.guardLast ? `（昨晚守的是 ${seatLabel(ww.guardLast)}，今晚不能再守）` : ''}`);
        this.night().guard = target;
        ww.guardLast = target;
        this.judge(target ? `你今晚守护了 ${seatLabel(target)}。` : '你今晚没有守护任何人。', 'private', `seat:${g.seat}`);
        this.judge(`守卫（${seatLabel(g.seat)}）守护了 ${target ? seatLabel(target) : '无人'}。`, 'night', 'god');
        return;
      }

      case 'wolves': {
        const n = this.night();
        n.wolfProposals ??= [];
        const options = aliveSeats(ww);
        for (const w of aliveWolves(ww)) {
          if (n.wolfProposals.some((p) => p.seat === w.seat)) continue;
          this.setActivity('狼人正在商量…');
          const r = await this.speak(
            w.seat,
            'wolfchat',
            `【任务：狼人夜聊】现在是第 ${ww.day} 夜，你和狼队友悄悄商量今晚杀谁（只有狼人能看到）。简短说一两句你的想法，最后单独一行写【刀:N号】。可选：${list(options)}。`,
            { killOptions: options },
          );
          const first = n.wolfProposals.find((p) => p.target != null)?.target;
          const fallback = first ?? options.filter((s) => !isWolf(seatOf(ww, s)!.role))[0] ?? null;
          n.wolfProposals.push({ seat: w.seat, target: r.kill === undefined ? fallback : r.kill });
          this.save();
        }
        n.wolfKill = wolfTarget(n.wolfProposals);
        this.judge(n.wolfKill ? `狼人今晚决定杀 ${seatLabel(n.wolfKill)}。` : '狼人今晚没有杀人。', 'night', 'wolves');
        return;
      }

      case 'witch': {
        const w = findRole(ww, 'witch')!;
        const n = this.night();
        const victim = n.wolfKill ?? null;
        const canSave = ww.witch.save && victim != null && victim !== w.seat;
        const canPoison = ww.witch.poison;
        if (!canSave && !canPoison) return;
        this.setActivity('女巫正在行动…');
        // 解药用掉以后就不知道谁被杀了
        const knows = ww.witch.save ? victim : null;
        const options = aliveSeats(ww).filter((s) => s !== w.seat);
        let action: 'save' | 'poison' | 'none' = 'none';
        let target: number | null = null;
        const prompt = `${knows != null ? `今晚 ${seatLabel(knows)} 被狼人杀害了。` : ww.witch.save ? '今晚没有人被杀。' : '（你的解药已经用掉了，不知道今晚谁被杀）'}${victim === w.seat && ww.witch.save ? '被杀的是你自己，女巫不能自救。' : ''}`;
        if (this.isHuman(w)) {
          const a = await this.ask(w.seat, { kind: 'witch', victim: knows, canSave, canPoison, options, prompt });
          action = a.action === 'save' && canSave ? 'save' : a.action === 'poison' && canPoison && a.target != null && options.includes(a.target) ? 'poison' : 'none';
          target = action === 'poison' ? a.target! : null;
        } else {
          const formats = [canSave ? '【救】' : '', canPoison ? '【毒:N号】' : '', '【不用药】'].filter(Boolean).join('、');
          const task = `【任务：女巫用药】${prompt}\n你现在${canSave ? '可以用解药救人' : ''}${canSave && canPoison ? '，也' : ''}${canPoison ? `可以用毒药毒死一名玩家（可选：${list(options)}）` : ''}；同一晚只能用一瓶。\n只回复一行：${formats} 之一，可以在下一行用一句话说明理由。`;
          const text = await this.aiDecide(w, task);
          if (canSave && /【\s*救\s*】/.test(text)) action = 'save';
          else {
            const m = /【\s*毒\s*[:：]\s*(\d+)/.exec(text);
            if (canPoison && m && options.includes(Number(m[1]))) {
              action = 'poison';
              target = Number(m[1]);
            }
          }
        }
        if (action === 'save') {
          n.saved = true;
          ww.witch.save = false;
        } else if (action === 'poison') {
          n.poison = target;
          ww.witch.poison = false;
        }
        const result = action === 'save' ? `你用解药救了 ${seatLabel(victim!)}。` : action === 'poison' ? `你用毒药毒了 ${seatLabel(target!)}。` : '你今晚没有用药。';
        this.judge(`${prompt}${result}`, 'private', `seat:${w.seat}`);
        this.judge(`女巫（${seatLabel(w.seat)}）${action === 'save' ? `救了 ${seatLabel(victim!)}` : action === 'poison' ? `毒了 ${seatLabel(target!)}` : '没有用药'}。`, 'night', 'god');
        return;
      }

      case 'seer': {
        const s = findRole(ww, 'seer')!;
        this.setActivity('预言家正在查验…');
        const checked = new Set(ww.nights.filter((n) => n.check).map((n) => n.check!.target));
        const options = aliveSeats(ww).filter((n) => n !== s.seat);
        const preferred = options.filter((n) => !checked.has(n));
        const target = (await this.choose(s.seat, 'check', preferred.length ? preferred : options, false, '今晚你要查验谁的身份？'))!;
        const wolf = isWolf(seatOf(ww, target)!.role);
        this.night().check = { target, wolf };
        this.judge(`你查验了 ${seatLabel(target)}：${wolf ? '狼人' : '好人'}。`, 'private', `seat:${s.seat}`);
        this.judge(`预言家（${seatLabel(s.seat)}）查验 ${seatLabel(target)}：${wolf ? '狼人' : '好人'}。`, 'night', 'god');
        return;
      }

      case 'dawn': {
        const n = this.night();
        n.deaths = resolveNight(n);
        ww.phase = 'day';
        this.judge('天亮了，请睁眼。', 'phase');
        const next: WwTask[] = [];
        // 第一天先竞选警长，再公布昨晚的死讯
        if (ww.day === 1 && ww.sheriffEnabled && !ww.sheriffDone) next.push({ t: 'sheriffSignup' });
        next.push({ t: 'announce' }, { t: 'speechOrder' });
        ww.tasks.unshift(...next);
        return;
      }

      case 'sheriffSignup': {
        this.setActivity('正在决定要不要上警…');
        const seats = aliveSeats(ww);
        const answers = await this.all(seats, async (seat) => {
          const x = seatOf(ww, seat)!;
          if (this.isHuman(x)) return !!(await this.ask(seat, { kind: 'yesno', action: 'sheriffRun', prompt: '要竞选警长吗？警长投票算 1.5 票，白天最后发言。' })).yes;
          const text = await this.aiDecide(x, '【任务：是否上警】现在是第一天白天，开始竞选警长。你要上警（参加竞选）吗？只回复一行：【选择:上警】或【选择:不上警】，可以在下一行用一句话说明理由。');
          return /上警】/.test(text) && !/不上警/.test(text);
        });
        const candidates = seats.filter((s) => answers.get(s));
        ww.sheriffDone = true;
        if (!candidates.length) {
          this.judge('没有人竞选警长，本局没有警长。', 'announce');
        } else if (candidates.length === 1) {
          ww.sheriff = candidates[0];
          this.judge(`只有 ${seatLabel(candidates[0])} 上警，${seatLabel(candidates[0])} 当选警长。`, 'announce');
        } else if (candidates.length === seats.length) {
          this.judge('所有人都上警了，没有人可以投票，警徽流失。', 'announce');
        } else {
          ww.sheriffDone = false;
          this.judge(`上警的玩家：${list(candidates)}。请依次发表竞选发言。`, 'announce');
          ww.tasks.unshift(...candidates.map((seat) => ({ t: 'sheriffSpeech', seat }) as WwTask), { t: 'sheriffVote', candidates, round: 1 });
        }
        return;
      }

      case 'sheriffSpeech': {
        this.setActivity(`${seatLabel(task.seat)} 正在发言…`);
        await this.speak(
          task.seat,
          task.pk ? 'pk' : 'sheriffSpeech',
          task.pk
            ? `【任务：警长 PK 发言】你和别人在警长竞选中平票，请再发言一次争取当选（60~150 字）。`
            : `【任务：警长竞选发言】你上警了，请发表竞选发言：说说你为什么要当警长、你的身份或者你的判断（可以撒谎），以及你打算怎么带领大家（60~180 字）。`,
        );
        return;
      }

      case 'sheriffVote': {
        const voters = aliveSeats(ww).filter((s) => !task.candidates.includes(s) && seatOf(ww, s)!.alive);
        if (!voters.length) {
          ww.sheriffDone = true;
          this.judge('没有可以投票的玩家，警徽流失。', 'announce');
          return;
        }
        this.setActivity('正在投票选警长…');
        const votes = await this.all(voters, (seat) => this.choose(seat, 'sheriffVote', task.candidates, true, `投票选警长，候选人：${list(task.candidates)}。`));
        const t = tallyVotes(Object.fromEntries(votes), null);
        this.voteCard(votes, t, 'sheriff');
        if (t.top.length === 1) {
          ww.sheriff = t.top[0];
          ww.sheriffDone = true;
          await this.narrate(`${seatLabel(t.top[0])} 当选警长。`);
        } else if (t.top.length > 1 && task.round === 1) {
          this.judge(`${list(t.top)} 平票，进入 PK：请这几位再各发言一次，然后重新投票。`, 'announce');
          ww.tasks.unshift(...t.top.map((seat) => ({ t: 'sheriffSpeech', seat, pk: true }) as WwTask), { t: 'sheriffVote', candidates: t.top, round: 2 });
        } else {
          ww.sheriffDone = true;
          this.judge('没有选出警长，警徽流失。', 'announce');
        }
        return;
      }

      case 'announce': {
        const n = this.night();
        const deaths = n.deaths;
        await this.narrate(deaths.length ? `昨晚 ${list(deaths.map((d) => d.seat))} 出局。` : '昨晚是平安夜，没有人出局。');
        // 同一晚的死亡一起生效，再依次处理技能、遗言和警徽
        for (const d of deaths) this.markDead(d.seat, d.cause);
        if (this.checkEnd()) return;
        ww.tasks.unshift(...deaths.map((d) => ({ t: 'death', seat: d.seat, cause: d.cause, lastWords: ww.day === 1, marked: true }) as WwTask));
        return;
      }

      case 'death': {
        const x = seatOf(ww, task.seat)!;
        if (!task.marked) {
          if (!x.alive) return;
          this.markDead(task.seat, task.cause);
          if (this.checkEnd()) return;
        }
        const next: WwTask[] = [];
        if (canShoot(x, task.cause)) next.push({ t: 'shoot', seat: x.seat });
        if (task.lastWords) next.push({ t: 'lastWords', seat: x.seat });
        if (ww.sheriff === x.seat) next.push({ t: 'badge', seat: x.seat });
        ww.tasks.unshift(...next);
        return;
      }

      case 'shoot': {
        const x = seatOf(ww, task.seat)!;
        const name = ROLE_INFO[x.role].name;
        this.setActivity(`${seatLabel(x.seat)} 正在决定要不要开枪…`);
        const options = aliveSeats(ww).filter((s) => s !== x.seat);
        const target = await this.choose(x.seat, 'shoot', options, true, `你是${name}，出局时可以开枪带走一名玩家，要开枪吗？`);
        if (target) {
          x.revealed = 'role';
          await this.narrate(`${seatLabel(x.seat)} 翻牌：${name}！开枪带走了 ${seatLabel(target)}。`, 'skill');
          ww.tasks.unshift({ t: 'death', seat: target, cause: 'shot', lastWords: true });
        } else {
          this.judge(`${seatLabel(x.seat)} 没有开枪。`, 'skill');
        }
        return;
      }

      case 'lastWords': {
        this.setActivity(`${seatLabel(task.seat)} 正在发表遗言…`);
        await this.speak(task.seat, 'lastWords', '【任务：遗言】你出局了，请发表遗言（可以交代身份、留下你的判断，30~150 字）。');
        return;
      }

      case 'badge': {
        const x = seatOf(ww, task.seat)!;
        const options = aliveSeats(ww).filter((s) => s !== x.seat);
        this.setActivity(`${seatLabel(x.seat)} 正在移交警徽…`);
        const target = await this.choose(x.seat, 'badge', options, true, '你是警长，出局了。把警徽交给谁？也可以选「不选」撕掉警徽。');
        ww.sheriff = target;
        this.judge(target ? `${seatLabel(x.seat)} 把警徽交给了 ${seatLabel(target)}。` : `${seatLabel(x.seat)} 撕掉了警徽，本局不再有警长。`, 'announce');
        return;
      }

      case 'speechOrder': {
        const n = this.night();
        const order = speechOrder(ww, n.deaths[0]?.seat ?? null);
        if (!order.length) return;
        this.judge(`请从 ${seatLabel(order[0])} 开始依次发言${ww.sheriff && order.includes(ww.sheriff) ? `，警长 ${seatLabel(ww.sheriff)} 最后发言` : ''}。`, 'phase');
        ww.tasks.unshift(...order.map((seat) => ({ t: 'speech', seat }) as WwTask), { t: 'vote', round: 1 });
        return;
      }

      case 'speech': {
        const x = seatOf(ww, task.seat)!;
        if (!x.alive) return;
        this.setActivity(`${seatLabel(x.seat)} 正在发言…`);
        const others = aliveSeats(ww).filter((s) => s !== x.seat);
        const canExplode = isWolf(x.role) && !task.pk;
        const canDuel = x.role === 'knight' && !ww.knightUsed && !task.pk;
        const hints = [
          canExplode ? `如果你决定自爆（直接结束今天进入黑夜），在发言最后单独写【自爆】${x.role === 'whitewolf' ? '，要带走某人就写【自爆:N号】' : ''}，一般不需要自爆。` : '',
          canDuel ? `如果你要翻牌和某人决斗（一局一次），在发言最后写【决斗:N号】，没把握就不要用。` : '',
        ].filter(Boolean);
        const r = await this.speak(
          x.seat,
          task.pk ? 'pk' : 'speech',
          task.pk
            ? `【任务：PK 发言】你在放逐投票中平票了，请再发言一次，争取不被放逐（60~150 字）。`
            : `【任务：发言】现在是第 ${ww.day} 天白天，轮到你（${seatLabel(x.seat)}）发言。${hints.join('')}`,
          {
            canExplode,
            explodeOptions: x.role === 'whitewolf' ? others : undefined,
            duelOptions: canDuel ? others : undefined,
          },
        );
        if (r.explode) {
          this.clearDay();
          x.revealed = 'role';
          await this.narrate(`${seatLabel(x.seat)} 自爆了！${ROLE_INFO[x.role].name === '狼人' ? '' : `翻牌：${ROLE_INFO[x.role].name}。`}今天的发言和投票结束，直接进入黑夜。`, 'skill');
          const next: WwTask[] = [{ t: 'death', seat: x.seat, cause: 'explode', lastWords: false }];
          if (x.role === 'whitewolf' && r.explodeTarget) {
            this.judge(`白狼王带走了 ${seatLabel(r.explodeTarget)}。`, 'skill');
            next.unshift({ t: 'death', seat: r.explodeTarget, cause: 'whitewolf', lastWords: false });
          }
          ww.tasks.unshift(...next);
        } else if (r.duel) {
          ww.knightUsed = true;
          const target = seatOf(ww, r.duel)!;
          x.revealed = 'role';
          target.revealed = isWolf(target.role) ? 'wolf' : 'good';
          if (isWolf(target.role)) {
            this.clearDay();
            await this.narrate(`${seatLabel(x.seat)} 翻牌骑士，和 ${seatLabel(target.seat)} 决斗：${seatLabel(target.seat)} 是狼人，出局！直接进入黑夜。`, 'skill');
            ww.tasks.unshift({ t: 'death', seat: target.seat, cause: 'duel', lastWords: false });
          } else {
            await this.narrate(`${seatLabel(x.seat)} 翻牌骑士，和 ${seatLabel(target.seat)} 决斗：${seatLabel(target.seat)} 是好人，骑士以死谢罪。`, 'skill');
            ww.tasks.unshift({ t: 'death', seat: x.seat, cause: 'knight', lastWords: false });
          }
        }
        return;
      }

      case 'vote': {
        const voters = ww.seats.filter((s) => s.alive && !s.idiotRevealed && !(task.round === 2 && task.candidates?.includes(s.seat))).map((s) => s.seat);
        const pool = task.candidates ?? aliveSeats(ww);
        if (!voters.length) return;
        this.setActivity(task.round === 2 ? 'PK 后重新投票…' : '大家正在投票…');
        const votes = await this.all(voters, (seat) =>
          this.choose(
            seat,
            'vote',
            pool.filter((s) => s !== seat),
            true,
            task.round === 2 ? `PK 结束，请在平票的玩家中投票放逐一人：${list(pool)}。` : '发言结束，请投票放逐一名你认为是狼人的玩家（可以弃票）。',
          ),
        );
        const t = tallyVotes(Object.fromEntries(votes), ww.sheriff);
        this.voteCard(votes, t, 'exile');
        if (!t.top.length) {
          this.judge('所有人都弃票了，今天没有人被放逐。', 'announce');
        } else if (t.top.length === 1) {
          ww.tasks.unshift({ t: 'exile', seat: t.top[0] });
        } else if (task.round === 1) {
          this.judge(`${list(t.top)} 平票，进入 PK：请这几位再各发言一次，其他人重新投票。`, 'announce');
          ww.tasks.unshift(...t.top.map((seat) => ({ t: 'speech', seat, pk: true }) as WwTask), { t: 'vote', candidates: t.top, round: 2 });
        } else {
          this.judge('再次平票，今天没有人被放逐。', 'announce');
        }
        return;
      }

      case 'exile': {
        const x = seatOf(ww, task.seat)!;
        if (x.role === 'idiot' && !x.idiotRevealed) {
          x.idiotRevealed = true;
          x.revealed = 'role';
          await this.narrate(`${seatLabel(x.seat)} 被投票放逐，翻牌：白痴！免于出局，但之后不能再投票。`, 'skill');
          return;
        }
        await this.narrate(`${seatLabel(x.seat)} 被投票放逐。`);
        ww.tasks.unshift({ t: 'death', seat: x.seat, cause: 'vote', lastWords: true });
        return;
      }

      case 'end': {
        ww.phase = 'end';
        ww.tasks = [];
        const winner = ww.winner ?? checkWinner(ww) ?? 'village';
        ww.winner = winner;
        const reveal = ww.seats.map((s) => `${seatLabel(s.seat)} ${s.name}：${ROLE_INFO[s.role].name}`).join('；');
        await this.narrate(`游戏结束，${winner === 'wolf' ? '狼人阵营' : '好人阵营'}获胜！`, 'end');
        this.judge(`身份公开：${reveal}。`, 'end');
        return;
      }
    }
  }

  private markDead(seat: number, cause: DeathCause) {
    const x = seatOf(this.ww, seat);
    if (!x || !x.alive) return;
    x.alive = false;
    x.death = { day: this.ww.day, cause };
    this.meta();
  }

  /** 有一方获胜就结束（跳过剩下的所有步骤） */
  private checkEnd() {
    const w = checkWinner(this.ww);
    if (!w) return false;
    this.ww.winner = w;
    this.ww.tasks = [{ t: 'end' }];
    return true;
  }

  /** 自爆、决斗成功：今天剩下的发言和投票都取消 */
  private clearDay() {
    this.ww.tasks = this.ww.tasks.filter((t) => !['speech', 'vote', 'exile', 'speechOrder'].includes(t.t));
  }

  private voteCard(votes: Map<number, number | null>, t: ReturnType<typeof tallyVotes>, kind: 'exile' | 'sheriff') {
    const ww = this.ww;
    const lines = [...votes].sort((a, b) => a[0] - b[0]).map(([v, target]) => `${seatLabel(v)}${v === ww.sheriff && kind === 'exile' ? '（警长）' : ''}→${target ? seatLabel(target) : '弃票'}`);
    const result = t.counts.map((c) => `${seatLabel(c.target)} ${c.votes} 票`).join('，') || '没有人得票';
    this.judge(`${kind === 'sheriff' ? '警长竞选' : `第 ${ww.day} 天放逐`}投票：${lines.join('，')}。结果：${result}。`, 'vote', 'public', {
      votes: [...votes].map(([voter, target]) => ({ voter, target })),
      voteKind: kind,
    });
  }
}

/** 测试用：某个座位这一步会发给模型的消息 */
export function playerMessages(room: Room, seat: number, task = '【任务：发言】') {
  const x = seatOf(room.werewolf!, seat)!;
  const p = room.participants.find((q) => q.id === x.participantId)!;
  return buildMessages(room, x, p, task);
}
