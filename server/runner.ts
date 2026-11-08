// 对话调度：决定谁发言、调用模型、处理插话 / 暂停 / 打断

import type { Message, Participant, Room, RoomEvent, RunnerState, RunStatus } from '../shared/types.ts';
import { completeChat, streamChat } from './llm.ts';
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

  // ---------- 对外操作 ----------

  /** 开始 / 继续自动对话 */
  run() {
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
  addHumanMessage(content: string, { interrupt = false } = {}) {
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
    room.messages.push(message);
    this.store.touchRoom(room.id, { immediate: true });
    this.emit({ type: 'message_added', message });
    this.aiTurnsSinceHuman = 0;

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

  clearMessages() {
    this.stop();
    this.room.messages = [];
    this.aiTurnsSinceHuman = 0;
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

        const ok = await this.generateTurn(speaker);
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

  /** 生成一次发言，返回是否成功（被打断也算成功） */
  private async generateTurn(p: Participant): Promise<boolean> {
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
      return false;
    }

    room.messages.push(message);
    this.emit({ type: 'message_added', message });
    const controller = new AbortController();
    this.current = { messageId: message.id, participantId: p.id, controller };
    this.emitState();

    let ok = true;
    try {
      const stream = streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model,
        temperature: p.temperature,
        messages: buildAgentMessages(room, p, history),
        signal: controller.signal,
      });
      for await (const chunk of stream) {
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
    message.reasoning = message.reasoning?.trim() || undefined;

    const stillThere = room.messages.includes(message);
    if (stillThere && message.status === 'interrupted' && !message.content) {
      // 一个字还没说就被打断，直接去掉
      room.messages = room.messages.filter((m) => m !== message);
      this.emit({ type: 'message_deleted', messageId: message.id });
    } else if (stillThere) {
      if (message.status === 'done' && !message.content) {
        message.status = 'error';
        message.error = '模型返回了空内容';
        ok = false;
      }
      this.emit({ type: 'message_updated', message });
    }
    this.store.touchRoom(room.id, { immediate: true });
    this.emitState();
    return ok;
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
