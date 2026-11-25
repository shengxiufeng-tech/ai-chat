// 对话调度：决定谁发言、调用模型、处理插话 / 暂停 / 打断

import { resolveGrowth, type InvestigatorSheet } from '../shared/coc.ts';
import { otherSpeakerNames, stripImpersonation } from '../shared/text.ts';
import fs from 'node:fs';
import { ASSET_KIND_LABELS, type Message, type Participant, type Room, type RoomEvent, type RunnerState, type RunStatus } from '../shared/types.ts';
import { chatTokens, DEFAULT_CONTEXT_WINDOW, estimateTokens, inputBudget, omissionNote, prependToFirst, stepFit } from './context.ts';
import { completeChat, contextWindowOf, streamChat, streamMeter, type ChatPart, type WireMessage } from './llm.ts';
import { activePlanner, appendToLast, applyPlanCommands, plannerInstruction, writerBlock } from './planner.ts';
import {
  buildKpMessages,
  buildTeammateMessages,
  growthRecord,
  kpOf,
  noteMessage,
  processKpCommands,
  resolveCheck,
  resolveSan,
  rollMessage,
  rollText,
  teammatesOf,
} from './trpg.ts';
import {
  buildAgentMessages,
  buildModeratorMessages,
  parseModeratorChoice,
  pickByMention,
  pickRoundRobin,
  stripNamePrefix,
  type BuildOut,
  type PromptCache,
  type SentTurn,
  usableHistory,
} from './prompt.ts';
import { newId, type Store } from './store.ts';
import { WerewolfGame, type WwAnswer } from './werewolf.ts';

/** 测试用：每次请求模型前看一眼发出去的消息（多人对话和跑团） */
let requestHook: ((roomId: string, participantId: string, messages: WireMessage[]) => void) | undefined;
export function onModelRequest(fn: typeof requestHook) {
  requestHook = fn;
}

type Listener = (ev: RoomEvent) => void;

/** 发给 Magpie 的会话 id：每个房间里的每个 AI 各一个，固定不变 */
export const sessionIdFor = (roomId: string, who: string) => `ai-chat-${roomId}-${who}`;

/** 裁剪后历史开头的说明：有前情提要就附上 */
const preface = (dropped: number, summary?: string) =>
  summary ? `（为了控制上下文长度，更早的 ${dropped} 条消息已省略，下面是那部分对话的前情提要。）\n【前情提要】\n${summary}\n【前情提要结束】` : omissionNote(dropped);

/** 队列里的一次发言请求：指定参与者，或交给规则自动选 */
type TurnRequest = { participantId: string } | 'auto';

export class RoomRunner {
  private status: RunStatus = 'paused';
  private current: { messageId: string; participantId: string; controller: AbortController } | null =
    null;
  private picking = false;
  private aiTurnsSinceHuman = 0;
  private queue: TurnRequest[] = [];
  private working = false;
  private wake: (() => void) | null = null;
  /** 每次暂停 / 停止都会加一，用来作废暂停前已经开始挑人的请求 */
  private epoch = 0;
  private listeners = new Set<Listener>();
  /** 跑团：本轮（自玩家上次行动以来）AI 队友是否已经行动过 */
  private teammatesActed = false;
  /** 跑团：守秘人因为自动掷骰连续接着说的次数 */
  private kpChain = 0;
  /** 已经提示过「上下文被裁剪」的 参与者:模型 */
  /** 狼人杀：对局控制和正在发言的玩家 */
  private wwGame?: WerewolfGame;
  /** 提示缓存：每条 AI 消息生成时最后那条消息的原文和模型的原话（只存在内存里，重启后第一轮重新拼） */
  private sentTurns = new Map<string, SentTurn>();
  private promptCache: PromptCache = { sentFor: (m) => this.sentTurns.get(m.id) };
  private wwGenerating: { messageId: string; participantId: string } | null = null;

  constructor(
    private roomId: string,
    private store: Store,
  ) {}

  private get room(): Room {
    const room = this.store.getRoom(this.roomId);
    if (!room) throw new Error('房间不存在');
    return room;
  }

  // ---------- 事件订阅 ----------

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev: RoomEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error('推送事件失败', err);
      }
    }
  }

  state(): RunnerState {
    return {
      status: this.status,
      generating: this.current
        ? { messageId: this.current.messageId, participantId: this.current.participantId }
        : this.wwGenerating,
      picking: this.picking,
      aiTurnsSinceHuman: this.aiTurnsSinceHuman,
    };
  }

  private emitState() {
    this.emit({ type: 'runner', runner: this.state() });
  }

  private notice(text: string, level: 'info' | 'error' = 'info') {
    this.emit({ type: 'notice', level, text });
  }

  /** 推送房间信息（不含消息），角色卡变化时用 */
  emitRoomMeta() {
    const { messages: _messages, ...meta } = this.room;
    this.emit({ type: 'room', room: meta });
  }

  // ---------- 对外操作 ----------

  /** 狼人杀的对局控制（第一次用到时创建） */
  private werewolf(): WerewolfGame {
    this.wwGame ??= new WerewolfGame({
      roomId: this.roomId,
      store: this.store,
      room: () => this.room,
      emit: (ev) => this.emit(ev),
      emitRoomMeta: () => this.emitRoomMeta(),
      setGenerating: (g) => {
        this.wwGenerating = g;
        this.emitState();
      },
      notice: (text, level) => this.notice(text, level),
      isRunning: () => this.status === 'running',
      stopped: () => {
        this.status = 'paused';
        this.emitState();
      },
    });
    return this.wwGame;
  }

  /** 狼人杀：人类玩家提交决定 */
  werewolfAnswer(id: string, answer: WwAnswer) {
    if (this.room.mode !== 'werewolf') throw new Error('这不是狼人杀房间');
    this.werewolf().answer(id, answer);
  }

  /** 开始 / 继续自动对话 */
  run() {
    if (this.room.mode === 'werewolf') {
      if (this.room.werewolf?.phase === 'end') throw new Error('这局已经结束了，可以点「再来一局」');
      this.status = 'running';
      this.emitState();
      this.werewolf().start();
      return;
    }
    if (this.room.mode === 'trpg') {
      throw new Error('跑团模式由你的行动推动：描述你要做什么，守秘人就会回应');
    }
    if (this.room.settings.turnMode === 'manual') {
      throw new Error('当前是「手动点名」模式，请点角色旁边的「发言」按钮');
    }
    if (!this.room.participants.some((p) => p.enabled)) {
      throw new Error('房间里还没有启用的 AI 角色');
    }
    this.status = 'running';
    this.aiTurnsSinceHuman = 0;
    this.emitState();
    this.kick();
  }

  /** 暂停：当前这句话说完后停下 */
  pause() {
    this.status = 'paused';
    this.epoch++;
    this.queue = [];
    this.wake?.();
    this.emitState();
  }

  /** 停止：暂停并立刻打断正在说的话 */
  stop() {
    this.pause();
    this.current?.controller.abort();
    this.wwGame?.abort();
  }

  /** 让某位参与者（或按规则自动选的下一位）说一句 */
  requestTurn(participantId?: string) {
    if (this.room.mode === 'werewolf') throw new Error('狼人杀由法官按顺序安排发言，点「开始」或「继续」');
    if (participantId && !this.room.participants.some((p) => p.id === participantId)) {
      throw new Error('找不到这个角色');
    }
    if (!participantId && !this.room.participants.some((p) => p.enabled)) {
      throw new Error('房间里还没有启用的 AI 角色');
    }
    this.queue.push(participantId ? { participantId } : 'auto');
    this.wake?.();
    this.kick();
  }

  /** 人类发言 */
  addHumanMessage(content: string, { interrupt = false, ooc = false } = {}) {
    const room = this.room;
    if (interrupt) this.current?.controller.abort();
    const message: Message = {
      id: newId(),
      role: 'human',
      speakerName: room.settings.humanName,
      content: content.trim(),
      status: 'done',
      createdAt: Date.now(),
    };
    if (room.mode === 'trpg' && ooc) message.ooc = true;
    if (room.mode === 'trpg' && !ooc) this.acceptPendingDecisions();
    room.messages.push(message);
    this.store.touchRoom(room.id, { immediate: true });
    this.emit({ type: 'message_added', message });
    this.aiTurnsSinceHuman = 0;

    if (room.mode === 'trpg') {
      this.kpChain = 0;
      this.teammatesActed = false;
      const kp = kpOf(room);
      const mentioned = pickByMention(room);
      if (!ooc && mentioned && mentioned.role === 'player') {
        // 点名 AI 队友：先让队友回应，再由守秘人描述结果
        this.queue.push({ participantId: mentioned.id });
        this.teammatesActed = true;
      }
      if (kp) this.queue.push({ participantId: kp.id });
      this.kick();
      this.emitState();
      return message;
    }

    // 自动对话进行中：循环会自然接上（@ 到的人优先）
    // 暂停中：按设置让一位 AI 接话
    if (this.status !== 'running' && room.settings.replyOnHumanMessage && room.participants.length) {
      const mentioned = pickByMention(room);
      if (mentioned || room.participants.some((p) => p.enabled)) {
        this.queue.push(mentioned ? { participantId: mentioned.id } : 'auto');
        this.kick();
      }
    } else {
      this.wake?.();
    }
    this.emitState();
    return message;
  }

  editMessage(messageId: string, content: string) {
    const room = this.room;
    const m = room.messages.find((x) => x.id === messageId);
    if (!m) throw new Error('消息不存在');
    if (m.status === 'streaming') throw new Error('这条消息还在生成中');
    m.content = content;
    if (m.status === 'error') {
      m.status = 'done';
      m.error = undefined;
    }
    this.store.touchRoom(room.id, { immediate: true });
    this.emit({ type: 'message_updated', message: m });
  }

  deleteMessage(messageId: string) {
    const room = this.room;
    if (this.current?.messageId === messageId) this.current.controller.abort();
    room.messages = room.messages.filter((m) => m.id !== messageId);
    this.store.touchRoom(room.id, { immediate: true });
    this.emit({ type: 'message_deleted', messageId });
  }

  /** 重新生成最后一条 AI 消息 */
  regenerate(messageId: string) {
    const room = this.room;
    const last = room.messages.at(-1);
    if (!last || last.id !== messageId || last.role !== 'ai') {
      throw new Error('只能重新生成最后一条 AI 消息');
    }
    if (last.status === 'streaming') throw new Error('这条消息还在生成中');
    const participantId = last.participantId;
    if (!participantId || !room.participants.some((p) => p.id === participantId)) {
      throw new Error('这位角色已经被删除了');
    }
    this.deleteMessage(messageId);
    this.requestTurn(participantId);
  }

  // ---------- 跑团 ----------

  private get trpg() {
    const trpg = this.room.trpg;
    if (!trpg) throw new Error('这不是跑团房间');
    return trpg;
  }

  /** 守秘人开场 */
  startTrpg() {
    const trpg = this.trpg;
    if (!trpg.sheets.player) throw new Error('请先创建你的调查员');
    const kp = kpOf(this.room);
    if (!kp) throw new Error('房间里没有守秘人');
    trpg.started = true;
    this.teammatesActed = false;
    this.kpChain = 0;
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emitRoomMeta();
    this.requestTurn(kp.id);
  }

  /** 发起技能成长检定（生成一张待掷的卡片） */
  createGrowth() {
    const roll = growthRecord(this.room);
    if (!roll) {
      if (this.room.messages.some((m) => m.roll?.type === 'growth' && m.roll.pending)) {
        throw new Error('已经有一张待掷的技能成长卡片了');
      }
      throw new Error('从上次成长检定到现在，还没有成功使用过可以成长的技能');
    }
    const msg = rollMessage(newId(), roll);
    this.room.messages.push(msg);
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emit({ type: 'message_added', message: msg });
    return msg;
  }

  setSheet(key: string, sheet: InvestigatorSheet) {
    const trpg = this.trpg;
    if (key !== 'player' && !teammatesOf(this.room).some((p) => p.id === key)) {
      throw new Error('找不到这个调查员');
    }
    trpg.sheets[key] = sheet;
    if (key !== 'player') {
      const p = this.room.participants.find((x) => x.id === key);
      if (p) p.name = sheet.name;
    }
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emitRoomMeta();
  }

  private findRoll(messageId: string) {
    const m = this.room.messages.find((x) => x.id === messageId);
    if (!m || m.kind !== 'roll' || !m.roll) throw new Error('找不到这次掷骰');
    return m as Message & { roll: NonNullable<Message['roll']> };
  }

  private updateRollMessage(m: Message) {
    if (m.roll) m.content = rollText(m.roll);
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emit({ type: 'message_updated', message: m });
  }

  /** 玩家点击掷骰 */
  resolveRoll(messageId: string) {
    const trpg = this.trpg;
    const m = this.findRoll(messageId);
    const r = m.roll;
    if (!r.pending) throw new Error('这次已经掷过了');
    if (r.type === 'growth') {
      const sheet = trpg.sheets[r.actor];
      if (!sheet) throw new Error('找不到这个调查员');
      resolveGrowth(r, sheet);
      this.updateRollMessage(m);
      this.emitRoomMeta();
      return m; // 成长检定不需要守秘人接着说
    }
    if (r.type === 'check') {
      resolveCheck(r);
      // 失败了而且可以孤注一掷：先让玩家决定，守秘人这时还不描述后果
      if (!r.success && r.pushable && r.actor === 'player') {
        if (trpg.autoRoll) r.pushable = false;
        else r.decision = 'pending';
      }
    } else if (r.type === 'san') {
      const sheet = trpg.sheets[r.actor];
      if (!sheet) throw new Error('找不到这个调查员');
      resolveSan(r, sheet);
      this.emitRoomMeta();
    }
    this.updateRollMessage(m);
    this.afterHumanRoll();
    return m;
  }

  /** 接受失败，不孤注一掷 */
  acceptRoll(messageId: string) {
    const m = this.findRoll(messageId);
    const r = m.roll;
    if (r.decision !== 'pending') throw new Error('这次检定不需要再做选择');
    r.decision = 'accepted';
    r.pushable = false;
    this.updateRollMessage(m);
    this.afterHumanRoll();
    return m;
  }

  /** 玩家没做选择就直接输入了新的行动：视为接受失败 */
  private acceptPendingDecisions() {
    for (const m of this.room.messages) {
      if (m.roll?.decision === 'pending') {
        m.roll.decision = 'accepted';
        m.roll.pushable = false;
        this.updateRollMessage(m);
      }
    }
  }

  /** 孤注一掷：对失败的检定再骰一次。how 是玩家说明怎么更努力地尝试（可选），会先发给守秘人 */
  pushRoll(messageId: string, how?: string) {
    const m = this.findRoll(messageId);
    const r = m.roll;
    if (r.type !== 'check' || r.pending || r.success || !r.pushable || r.pushedAlready) {
      throw new Error('这次检定不能孤注一掷');
    }
    r.pushedAlready = true;
    r.pushable = false;
    r.decision = 'pushed';
    this.updateRollMessage(m);
    const text = how?.trim();
    if (text) {
      const said: Message = {
        id: newId(),
        role: 'human',
        speakerName: this.room.settings.humanName,
        content: `（孤注一掷）${text}`,
        status: 'done',
        createdAt: Date.now(),
      };
      this.room.messages.push(said);
      this.emit({ type: 'message_added', message: said });
    }
    const push: typeof r = {
      type: 'check',
      actor: r.actor,
      actorName: r.actorName,
      pending: false,
      label: r.label,
      target: r.target,
      // 孤注一掷沿用同一条成功线，不重新掷修正骰
      ...(r.baseTarget !== undefined ? { baseTarget: r.baseTarget, modifier: r.modifier } : {}),
      difficulty: r.difficulty,
      bonus: r.bonus,
      pushed: true,
    };
    resolveCheck(push);
    const msg = rollMessage(newId(), push);
    this.room.messages.push(msg);
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emit({ type: 'message_added', message: msg });
    this.afterHumanRoll();
    return msg;
  }

  private afterHumanRoll() {
    const room = this.room;
    // 还有没掷的骰子、或者还在考虑要不要孤注一掷时，守秘人先不接着说（成长检定不算）
    const stillPending = room.messages.some(
      (m) => m.roll && m.roll.actor === 'player' && m.roll.type !== 'growth' && (m.roll.pending || m.roll.decision === 'pending'),
    );
    const kp = kpOf(room);
    if (!stillPending && kp) {
      this.kpChain = 0;
      this.aiTurnsSinceHuman = 0;
      this.queue.push({ participantId: kp.id });
      this.kick();
    }
  }

  /** 守秘人说完后：处理骰子指令，安排接下来谁说话 */
  private afterKpTurn(message: Message) {
    const room = this.room;
    const res = processKpCommands(room, message.content);
    for (const problem of res.problems) this.notice(problem, 'error');
    for (const roll of res.rolls) {
      const msg = rollMessage(newId(), roll);
      room.messages.push(msg);
      this.emit({ type: 'message_added', message: msg });
    }
    // 守秘人展示的手出物 / 地图
    for (const asset of res.shows) {
      const msg: Message = {
        id: newId(),
        role: 'system',
        kind: 'handout',
        speakerName: '守秘人',
        content: `守秘人展示了${ASSET_KIND_LABELS[asset.kind]}「${asset.title}」`,
        asset: { id: asset.id, title: asset.title, kind: asset.kind },
        status: 'done',
        createdAt: Date.now(),
      };
      room.messages.push(msg);
      this.emit({ type: 'message_added', message: msg });
    }
    if (res.shows.length) this.emitRoomMeta();
    // 笔记有更新时，在主对话里提示一下
    for (const ev of res.notes) {
      const msg = noteMessage(newId(), ev);
      room.messages.push(msg);
      this.emit({ type: 'message_added', message: msg });
    }
    if (res.sheetsChanged || res.notes.length || res.memosChanged) this.emitRoomMeta();
    this.store.touchRoom(room.id, { immediate: true });

    if (res.pendingHuman > 0) {
      // 等玩家掷骰：已经排队的队友先别说话，等守秘人描述完结果再行动
      const teammateIds = new Set(teammatesOf(room).map((p) => p.id));
      const before = this.queue.length;
      this.queue = this.queue.filter((r) => r === 'auto' || !teammateIds.has(r.participantId));
      if (this.queue.length !== before) this.teammatesActed = false;
      return;
    }
    const kp = kpOf(room);
    if (res.needContinue && kp) {
      if (this.kpChain < 3) {
        this.kpChain++;
        this.queue.push({ participantId: kp.id });
      } else {
        this.notice('守秘人连续掷骰太多次，先停下来等你行动。');
      }
      return;
    }
    if (room.trpg?.teammatesAct && !this.teammatesActed) {
      this.teammatesActed = true;
      for (const p of teammatesOf(room)) if (p.enabled) this.queue.push({ participantId: p.id });
    }
  }

  clearMessages() {
    this.stop();
    this.room.messages = [];
    delete this.room.contextCuts;
    this.sentTurns.clear();
    this.aiTurnsSinceHuman = 0;
    if (this.room.trpg) {
      this.room.trpg.started = false;
      this.emitRoomMeta();
    }
    this.store.touchRoom(this.roomId, { immediate: true });
    this.emit({ type: 'messages_cleared' });
    this.emitState();
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  // ---------- 调度循环 ----------

  private kick() {
    if (!this.working) void this.work();
  }

  private async work() {
    this.working = true;
    try {
      for (;;) {
        let request: TurnRequest | undefined = this.queue.shift();
        if (!request && this.status === 'running' && this.room.settings.turnMode !== 'manual') {
          request = 'auto';
        }
        if (!request) break;

        const epoch = this.epoch;
        const speaker = request === 'auto' ? await this.pickNext() : this.findParticipant(request.participantId);
        if (epoch !== this.epoch) continue; // 挑人期间被暂停了
        if (!speaker) {
          if (request === 'auto') {
            this.notice('没有可以发言的 AI 角色（都被关闭了？）', 'error');
            this.status = 'paused';
            this.emitState();
          }
          continue;
        }

        const { ok, message } = await this.generateTurn(speaker);
        if (ok && message?.status === 'done' && this.room.mode === 'trpg' && speaker.role === 'kp') {
          this.afterKpTurn(message);
        }
        if (!ok && this.room.mode === 'trpg') this.queue = [];
        if (!ok && this.status === 'running') {
          this.status = 'paused';
          this.notice('出错了，自动对话已暂停。处理好之后可以点「继续」。', 'error');
          this.emitState();
          this.queue = [];
          continue;
        }

        if (this.status === 'running') {
          const limit = this.room.settings.autoPauseAfter;
          if (limit > 0 && this.aiTurnsSinceHuman >= limit) {
            this.status = 'paused';
            this.notice(`AI 已经连续发言 ${limit} 次，自动暂停。你可以插话，或点「继续」。`);
            this.emitState();
            continue;
          }
          if (this.queue.length === 0) await this.sleep(this.room.settings.turnDelayMs);
        }
      }
    } catch (err) {
      console.error('调度循环出错', err);
      this.status = 'paused';
      this.notice(`调度出错：${err instanceof Error ? err.message : String(err)}`, 'error');
      this.emitState();
    } finally {
      this.working = false;
    }
  }

  /** 可以被暂停 / 插话提前唤醒的等待 */
  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private findParticipant(id: string): Participant | undefined {
    return this.room.participants.find((p) => p.id === id);
  }

  private async pickNext(): Promise<Participant | undefined> {
    const room = this.room;
    if (room.mode === 'trpg') return kpOf(room);
    const mentioned = pickByMention(room);
    if (mentioned) return mentioned;

    if (room.settings.turnMode === 'moderator') {
      const active = room.participants.filter((p) => p.enabled);
      if (active.length <= 1) return active[0];
      const settings = this.store.getSettings();
      const model = room.settings.moderatorModel || settings.defaultModel || active[0].model;
      this.picking = true;
      this.emitState();
      try {
        const output = await completeChat({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model,
          messages: buildModeratorMessages(room),
          temperature: 0.3,
          sessionId: sessionIdFor(room.id, 'moderator'),
          signal: AbortSignal.timeout(60000),
        });
        const choice = parseModeratorChoice(output, room);
        const last = usableHistory(room.messages).at(-1);
        if (choice && last?.role === 'ai' && last.participantId === choice.id) {
          // 同一个 AI 刚说完又被选中（中间没人插话），换成下一位
          return pickRoundRobin(room);
        }
        if (choice) return choice;
        this.notice(`AI 主持人的回答「${output.slice(0, 30)}」里没有找到角色名，改为轮流发言。`);
      } catch (err) {
        this.notice(
          `AI 主持人挑选失败（${err instanceof Error ? err.message : String(err)}），改为轮流发言。`,
          'error',
        );
      } finally {
        this.picking = false;
        this.emitState();
      }
    }
    return pickRoundRobin(room);
  }

  /** 剧本地图的图片（data URL），按文件缓存 */
  private mapImageCache = new Map<string, string>();
  private mapImage(roomId: string, assetId: string): string | undefined {
    const file = this.store.assetPath(roomId, assetId);
    let url = this.mapImageCache.get(file);
    if (!url) {
      if (!fs.existsSync(file)) return undefined;
      url = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
      this.mapImageCache.set(file, url);
    }
    return url;
  }

  /** 守秘人：把剧本地图附在第一条消息里（位置固定，不影响提示缓存） */
  private withMaps(room: Room, messages: WireMessage[]): WireMessage[] {
    const trpg = room.trpg;
    const maps = (trpg?.assets ?? []).filter((a) => a.kind === 'map');
    if (!maps.length || trpg?.mapsToKp === false) return messages;
    const parts: ChatPart[] = [{ type: 'text', text: '【剧本地图】下面是剧本附带的地图，只有你（守秘人）能看到，主持时用来确定方位、距离和路线：' }];
    for (const m of maps) {
      const url = this.mapImage(room.id, m.id);
      if (!url) continue;
      parts.push({ type: 'text', text: `地图「${m.title}」：` }, { type: 'image_url', image_url: { url } });
    }
    if (parts.length === 1) return messages;
    const i = messages.findIndex((m) => m.role !== 'system');
    const first = messages[i];
    if (i < 0 || first.role !== 'user') return messages;
    const out = messages.slice();
    out[i] = { role: 'user', content: [...parts, ...(typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : first.content)] };
    return out;
  }

  private buildMessages(room: Room, p: Participant, history: Message[], cache?: PromptCache, out?: BuildOut, noTail = false): WireMessage[] {
    if (room.mode === 'trpg' && room.trpg) {
      if (p.role === 'kp') {
        const msgs = buildKpMessages(room, p, history, cache, out, noTail);
        return noTail ? msgs : this.withMaps(room, msgs);
      }
      if (p.role === 'player') return buildTeammateMessages(room, p, history, cache, out, noTail);
    }
    return buildAgentMessages(room, p, history, cache, out, noTail);
  }

  /**
   * 让请求放进模型的上下文：阶梯式裁剪。
   * 裁剪点存在房间里，放得下就不动（前缀不变，提示缓存能命中）；涨满了才一次裁到上限的 70%，
   * 并把新裁掉的部分（连同之前的提要）整理成前情提要，放在历史开头，到下次裁剪前都不变。
   */
  private async fitFor(
    p: Participant,
    model: string,
    build: (h: Message[]) => WireMessage[],
    history: Message[],
    opts: { key: string; signal: AbortSignal; effort?: string },
  ) {
    const room = this.room;
    const settings = this.store.getSettings();
    const window = (await contextWindowOf(settings.baseUrl, settings.apiKey, model)) ?? DEFAULT_CONTEXT_WINDOW;
    const cut = room.contextCuts?.[opts.key];
    const found = cut ? history.findIndex((m) => m.id === cut.from) : -1;
    const start = Math.max(0, found);
    const prev = found >= 0 ? cut?.summary : undefined;
    const decorate = (msgs: WireMessage[], dropped: number, summary?: string) => (dropped > 0 ? prependToFirst(msgs, preface(dropped, summary)) : msgs);
    // 搜裁剪点时先拿现有的提要估算长度，新提要写好后再正式拼一次
    const fit = stepFit((h, d) => decorate(build(h), d, prev), history, window, start);
    if (!fit.moved) return fit;

    this.notice(
      `对话涨满了「${p.name}」所用模型（${model}）的上下文（约 ${Math.round(window / 1000)}k），正在把更早的 ${fit.dropped} 条消息整理成前情提要，之后要再涨满才会重新整理。`,
    );
    let summary: string | undefined;
    try {
      summary = await this.summarize(p, model, history.slice(found >= 0 ? start : 0, fit.dropped), prev, window, opts);
    } catch (err) {
      if (opts.signal.aborted) throw err;
      this.notice(`整理前情提要失败（${err instanceof Error ? err.message : String(err)}），这一轮先只省略更早的消息。`, 'error');
    }
    room.contextCuts = { ...room.contextCuts, [opts.key]: { from: history[fit.dropped].id, summary: summary ?? prev, at: Date.now() } };
    this.store.touchRoom(room.id, { immediate: true });
    const messages = decorate(build(history.slice(fit.dropped)), fit.dropped, summary ?? prev);
    return { messages, dropped: fit.dropped, tokens: chatTokens(messages), moved: true };
  }

  /** 把一段较早的对话整理成前情提要：从这个 AI 的视角（看不到的不会写进去），用它自己的模型；太长就分几段接着整理 */
  private async summarize(p: Participant, model: string, segment: Message[], prev: string | undefined, window: number, opts: { signal: AbortSignal; effort?: string }) {
    const room = this.room;
    const settings = this.store.getSettings();
    const trpg = room.mode === 'trpg';
    const kp = trpg && p.role === 'kp';
    const self = trpg && p.role === 'player' ? (room.trpg?.sheets[p.id]?.name ?? p.name) : p.name;
    const text = (c: WireMessage['content']) => (typeof c === 'string' ? c : c.map((x) => (x.type === 'text' ? x.text : '')).join(''));
    const lines = this.buildMessages(room, p, segment, undefined, undefined, true)
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'assistant' ? `【${self}（就是这份提要的读者）】：${text(m.content)}` : text(m.content)));
    const who = trpg ? (kp ? '这场《克苏鲁的呼唤》跑团的守秘人' : `这场《克苏鲁的呼唤》跑团里的 AI 调查员「${self}」`) : `这场多人对话里的「${p.name}」`;
    const system = [
      `你在帮${who}整理前情提要。对话太长了，下面这段较早的记录之后不会再发给 TA。请整理成一份前情提要，让 TA 只看提要也能接着${kp ? '主持' : '参与'}下去。`,
      '要求：',
      `- 按时间顺序写清楚发生了什么${trpg ? '：去过哪些地方、遇到了谁、NPC 的身份和态度、发现的线索' : '：聊了哪些话题、各人的观点和立场'}、做出的决定和约定、还没解决的问题。`,
      '- 人名、地名、物品名照原文写，不要编造记录里没有的内容；分清楚是谁说的、谁做的。',
      trpg ? '- 调查员的 HP、SAN 等数值不用抄，之后每轮都会附上最新的。' : '',
      kp ? '- 可以写守秘人自己的推进思路和埋下的伏笔（这份提要只有守秘人看得到）。' : '',
      '- 写成连贯的几段话或简短的条目，控制在 1500 字以内，只输出提要本身。',
    ]
      .filter(Boolean)
      .join('\n');
    // 太长的话分几段，一段一段接着整理（每段都带上之前整理好的提要）
    const chunkBudget = Math.max(2_000, inputBudget(window) - 8_000);
    const chunks: string[][] = [[]];
    let used = 0;
    for (const line of lines) {
      const t = estimateTokens(line);
      if (used + t > chunkBudget && chunks[chunks.length - 1].length) {
        chunks.push([]);
        used = 0;
      }
      chunks[chunks.length - 1].push(line);
      used += t;
    }
    let summary = prev;
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const user = `${summary ? `【更早的前情提要】\n${summary}\n\n【之后的对话记录】` : '【对话记录】'}\n${chunk.join('\n\n')}\n\n请${summary ? '把更早的前情提要和之后的对话记录合并成一份新的' : '整理成一份'}前情提要。`;
      const out = await completeChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model,
        reasoningEffort: opts.effort || undefined,
        temperature: 0.3,
        sessionId: sessionIdFor(room.id, `${p.id}-summary`),
        signal: opts.signal,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const clean = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!clean) throw new Error('模型返回了空内容');
      summary = clean;
    }
    return summary;
  }

  /** 构思阶段：让构思模型先想清楚这一轮说什么，构思内容实时显示在消息的「构思」里 */
  private async runPlanner(p: Participant, message: Message, history: Message[], signal: AbortSignal): Promise<string> {
    const room = this.room;
    const settings = this.store.getSettings();
    const planner = activePlanner(p)!;
    const kp = room.mode === 'trpg' && p.role === 'kp';
    const instruction = plannerInstruction({ kp, name: room.settings.promptMode === 'humanlike' ? undefined : p.name });
    const fit = await this.fitFor(p, planner.model, (h) => appendToLast(this.buildMessages(room, p, h), instruction), history, {
      key: `${p.id}:plan`,
      signal,
      effort: planner.reasoningEffort,
    });
    if (fit.dropped > 0) message.trimmed = Math.max(message.trimmed ?? 0, fit.dropped);
    const stream = streamChat({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: planner.model,
      // 构思偏重逻辑，温度不要太高（推理模型会忽略这个参数）
      temperature: Math.min(p.temperature, 0.7),
      reasoningEffort: planner.reasoningEffort || undefined,
      messages: fit.messages,
      // 构思模型单独一个会话 id，缓存不会和执笔模型互相干扰
      sessionId: sessionIdFor(room.id, `${p.id}-plan`),
      signal,
    });
    let plan = '';
    for await (const chunk of stream) {
      if (!chunk.content) continue;
      plan += chunk.content;
      message.plan = plan;
      this.emit({ type: 'message_delta', messageId: message.id, plan: chunk.content });
      this.store.touchRoom(room.id);
    }
    plan = plan.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!plan) throw new Error('构思模型返回了空内容');
    return plan;
  }

  /** 生成一次发言，返回是否成功（被打断也算成功） */
  private async generateTurn(p: Participant): Promise<{ ok: boolean; message?: Message }> {
    const room = this.room;
    const settings = this.store.getSettings();
    const model = p.model || settings.defaultModel;
    const planner = activePlanner(p);
    const kp = room.mode === 'trpg' && p.role === 'kp';

    const history = [...room.messages];
    const message: Message = {
      id: newId(),
      role: 'ai',
      participantId: p.id,
      speakerName: p.name,
      avatar: p.avatar,
      color: p.color,
      model,
      reasoningEffort: p.reasoningEffort || undefined,
      content: '',
      reasoning: '',
      status: 'streaming',
      createdAt: Date.now(),
      ...(planner ? { planner: { model: planner.model, reasoningEffort: planner.reasoningEffort || undefined }, plan: '', planning: true } : {}),
    };

    if (!model) {
      message.status = 'error';
      message.error = `「${p.name}」还没有选择模型，请在角色设置里选一个，或在全局设置里设置默认模型。`;
      room.messages.push(message);
      this.store.touchRoom(room.id, { immediate: true });
      this.emit({ type: 'message_added', message });
      return { ok: false, message };
    }

    room.messages.push(message);
    this.emit({ type: 'message_added', message });
    const controller = new AbortController();
    this.current = { messageId: message.id, participantId: p.id, controller };
    this.emitState();

    let ok = true;
    let plan = '';
    let meter: ReturnType<typeof streamMeter> | undefined;
    const out: BuildOut = {};
    let raw = '';
    try {
      // 构思 / 执笔：先构思；构思失败时由执笔模型单独完成，不让整轮卡住
      if (planner) {
        try {
          plan = await this.runPlanner(p, message, history, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) throw err;
          message.planError = err instanceof Error ? err.message : String(err);
        }
        message.planning = false;
        message.plan = plan || message.plan || undefined;
        this.emit({ type: 'message_updated', message });
      }
      const extra = plan ? writerBlock(plan, { kp }) : '';
      // 提示缓存：拼历史时把之前每一轮最后那条消息的原文和模型的原话放回去（构思 / 执笔的不做：构思会一直留在历史里，太占上下文）
      const cache = planner ? undefined : this.promptCache;
      const fit = await this.fitFor(p, model, (h) => appendToLast(this.buildMessages(room, p, h, cache, out), extra), history, {
        key: p.id,
        signal: controller.signal,
        effort: p.reasoningEffort,
      });
      if (fit.dropped > 0) message.trimmed = Math.max(message.trimmed ?? 0, fit.dropped);
      requestHook?.(room.id, p.id, fit.messages);
      const stream = streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model,
        temperature: p.temperature,
        reasoningEffort: p.reasoningEffort || undefined,
        messages: fit.messages,
        // 每个 AI 一个固定的会话 id：Magpie 会把它的请求留在同一个账号上，缓存才能命中
        sessionId: sessionIdFor(room.id, p.id),
        signal: controller.signal,
      });
      meter = streamMeter(message);
      for await (const chunk of stream) {
        if (chunk.finish === 'length' || chunk.finish === 'content_filter' || chunk.finish === 'incomplete') {
          message.truncated = chunk.finish;
        }
        if (chunk.content) message.content += chunk.content;
        if (chunk.reasoning) message.reasoning += chunk.reasoning;
        const thinkMs = meter.chunk(chunk);
        if (!chunk.content && !chunk.reasoning && thinkMs === undefined) continue;
        this.emit({
          type: 'message_delta',
          messageId: message.id,
          content: chunk.content,
          reasoning: chunk.reasoning,
          ...(thinkMs !== undefined ? { thinkMs } : {}),
        });
        this.store.touchRoom(room.id);
      }
      raw = message.content;
      message.status = 'done';
      this.aiTurnsSinceHuman++;
    } catch (err) {
      if (controller.signal.aborted) {
        message.status = 'interrupted';
        this.aiTurnsSinceHuman++;
      } else {
        ok = false;
        message.status = 'error';
        message.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.current = null;
      delete message.planning;
      meter?.finish();
    }

    message.content = stripNamePrefix(message.content, p.name);
    // 守秘人：骰子、数值、笔记等指令以构思为准，执笔模型写的指令不算
    if (plan && kp && message.status === 'done' && message.content.trim()) message.content = applyPlanCommands(message.content, plan);
    // 去掉替别人写的发言（拟人模式的对话记录没有名字标签，不需要）
    if (room.mode === 'trpg' || room.settings.promptMode !== 'humanlike') {
      const cleaned = stripImpersonation(message.content, otherSpeakerNames(room, p.id));
      if (cleaned.removed) {
        message.content = cleaned.text;
        message.filtered = cleaned.removed;
      }
    }
    message.reasoning = message.reasoning?.trim() || undefined;

    const stillThere = room.messages.includes(message);
    if (stillThere && message.status === 'interrupted' && !message.content) {
      // 一个字还没说就被打断，直接去掉
      room.messages = room.messages.filter((m) => m !== message);
      this.emit({ type: 'message_deleted', messageId: message.id });
    } else if (stillThere) {
      if (message.status === 'done' && !message.content) {
        message.status = 'error';
        message.error = message.filtered ? '模型只写了替别人说的话，已经被移除。可以点「重试」重新生成。' : '模型返回了空内容';
        ok = false;
      }
      // 记下这一轮发出去的最后那条消息和模型的原话，下一轮原样放回历史
      if (message.status === 'done' && !planner && out.prompt !== undefined && raw) {
        this.sentTurns.set(message.id, { prompt: out.prompt, reply: raw, content: message.content, state: out.state, full: out.full });
      }
      this.emit({ type: 'message_updated', message });
    }
    this.store.touchRoom(room.id, { immediate: true });
    this.emitState();
    return { ok, message: stillThere ? message : undefined };
  }
}

export class RunnerManager {
  private runners = new Map<string, RoomRunner>();
  constructor(private store: Store) {}

  get(roomId: string): RoomRunner {
    let r = this.runners.get(roomId);
    if (!r) {
      r = new RoomRunner(roomId, this.store);
      this.runners.set(roomId, r);
    }
    return r;
  }

  remove(roomId: string) {
    this.runners.get(roomId)?.dispose();
    this.runners.delete(roomId);
  }
}
