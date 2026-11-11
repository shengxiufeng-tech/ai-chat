// 对话调度：决定谁发言、调用模型、处理插话 / 暂停 / 打断

import { resolveGrowth, type InvestigatorSheet } from '../shared/coc.ts';
import { otherSpeakerNames, stripImpersonation } from '../shared/text.ts';
import type { Message, Participant, Room, RoomEvent, RunnerState, RunStatus } from '../shared/types.ts';
import { DEFAULT_CONTEXT_WINDOW, fitToContext } from './context.ts';
import { completeChat, contextWindowOf, streamChat } from './llm.ts';
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
  usableHistory,
} from './prompt.ts';
import { newId, type Store } from './store.ts';

type Listener = (ev: RoomEvent) => void;

/** 发给 Magpie 的会话 id：每个房间里的每个 AI 各一个，固定不变 */
export const sessionIdFor = (roomId: string, who: string) => `ai-chat-${roomId}-${who}`;

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
  private trimNotified = new Set<string>();

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
        : null,
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

  /** 开始 / 继续自动对话 */
  run() {
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
  }

  /** 让某位参与者（或按规则自动选的下一位）说一句 */
  requestTurn(participantId?: string) {
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

  private buildMessages(room: Room, p: Participant, history: Message[]) {
    if (room.mode === 'trpg' && room.trpg) {
      if (p.role === 'kp') return buildKpMessages(room, p, history);
      if (p.role === 'player') return buildTeammateMessages(room, p, history);
    }
    return buildAgentMessages(room, p, history);
  }

  /** 生成一次发言，返回是否成功（被打断也算成功） */
  private async generateTurn(p: Participant): Promise<{ ok: boolean; message?: Message }> {
    const room = this.room;
    const settings = this.store.getSettings();
    const model = p.model || settings.defaultModel;

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
    try {
      // 按模型的上下文窗口裁掉最早的对话
      const window = (await contextWindowOf(settings.baseUrl, settings.apiKey, model)) ?? DEFAULT_CONTEXT_WINDOW;
      const fit = fitToContext((h) => this.buildMessages(room, p, h), history, window);
      if (fit.dropped > 0) {
        message.trimmed = fit.dropped;
        const key = `${p.id}:${model}`;
        if (!this.trimNotified.has(key)) {
          this.trimNotified.add(key);
          const notebook = room.mode === 'trpg' && room.trpg?.notebook;
          this.notice(
            `对话已经接近「${p.name}」所用模型的上下文上限（约 ${Math.round(window / 1000)}k），更早的消息不再发给它${notebook ? '，重要的 NPC 和线索仍然记在守秘人笔记里' : ''}。`,
          );
        }
      }
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
      for await (const chunk of stream) {
        if (chunk.finish === 'length' || chunk.finish === 'content_filter' || chunk.finish === 'incomplete') {
          message.truncated = chunk.finish;
        }
        if (chunk.content) message.content += chunk.content;
        if (chunk.reasoning) message.reasoning += chunk.reasoning;
        this.emit({
          type: 'message_delta',
          messageId: message.id,
          content: chunk.content,
          reasoning: chunk.reasoning,
        });
        this.store.touchRoom(room.id);
      }
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
    }

    message.content = stripNamePrefix(message.content, p.name);
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
