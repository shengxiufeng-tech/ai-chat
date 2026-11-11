// 前后端共用的数据类型

import type { InvestigatorSheet, RollRecord, TrpgState } from './coc.ts';

export type ParticipantRole = 'kp' | 'player';

/** 房间里的一个 AI 角色 */
export interface Participant {
  id: string;
  name: string;
  /** 头像，用一个 emoji */
  avatar: string;
  /** 主题色，用于消息左侧色条 */
  color: string;
  /** 模型 id，例如 Magpie 的 `provider/model` */
  model: string;
  /** 思考强度（reasoning_effort），空字符串表示用模型默认值、不发送 */
  reasoningEffort: string;
  /** 一句话简介：其他参与者能看到 */
  bio: string;
  /** 人设提示词：只有这个角色自己能看到 */
  persona: string;
  temperature: number;
  /** 关闭后不参与自动轮换，但仍可手动点名 */
  enabled: boolean;
  /** 跑团房间里的身份：守秘人或 AI 队友 */
  role?: ParticipantRole;
}

/** 角色模板（内置或用户保存的） */
export interface CharacterTemplate {
  id: string;
  name: string;
  avatar: string;
  color: string;
  bio: string;
  persona: string;
  temperature: number;
  builtin?: boolean;
}

export type RoomMode = 'chat' | 'trpg';
export type TurnMode = 'round_robin' | 'moderator' | 'manual';
export type HumanRole = 'host' | 'participant' | 'observer';
export type ReplyLength = 'short' | 'medium' | 'long';
/** standard：带多人对话规则的提示词；humanlike：只告诉模型它在和真人聊天 */
export type PromptMode = 'standard' | 'humanlike';

export interface RoomSettings {
  /** 你在对话中的名字 */
  humanName: string;
  /** 你的身份 */
  humanRole: HumanRole;
  /** 下一位发言者怎么决定 */
  turnMode: TurnMode;
  /** AI 主持模式下，用来挑选下一位发言者的模型（空则用全局默认模型） */
  moderatorModel: string;
  /** 自动对话连续进行多少轮 AI 发言后暂停（0 表示不自动暂停） */
  autoPauseAfter: number;
  /** 回复篇幅 */
  replyLength: ReplyLength;
  /** 暂停状态下你发消息后，是否让一位 AI 接话 */
  replyOnHumanMessage: boolean;
  /** 自动对话时两次发言之间的间隔（毫秒） */
  turnDelayMs: number;
  /** 提示词风格 */
  promptMode: PromptMode;
}

export type MessageStatus = 'streaming' | 'done' | 'interrupted' | 'error';

export interface Message {
  id: string;
  role: 'human' | 'ai' | 'system';
  /** AI 消息对应的参与者 id */
  participantId?: string;
  /** 发言时的名字快照（参与者改名或被删除后仍能显示） */
  speakerName: string;
  avatar?: string;
  color?: string;
  model?: string;
  /** 发言时使用的思考强度 */
  reasoningEffort?: string;
  content: string;
  /** 推理模型的思考过程（如果有） */
  reasoning?: string;
  status: MessageStatus;
  error?: string;
  createdAt: number;
  /** 跑团：玩家的场外发言 */
  ooc?: boolean;
  /** 跑团：系统消息的种类 */
  kind?: 'roll';
  /** 跑团：骰子 / 数值变化记录 */
  roll?: RollRecord;
}

export interface Room {
  id: string;
  mode: RoomMode;
  title: string;
  /** 场景 / 话题 / 背景设定，所有 AI 都能看到 */
  scenario: string;
  participants: Participant[];
  messages: Message[];
  settings: RoomSettings;
  /** 跑团房间的状态 */
  trpg?: TrpgState;
  createdAt: number;
  updatedAt: number;
}

export interface RoomSummary {
  id: string;
  mode: RoomMode;
  title: string;
  avatars: string[];
  participantCount: number;
  messageCount: number;
  updatedAt: number;
  /** 搜索时：命中的位置和上下文片段 */
  match?: { where: 'title' | 'participant' | 'scenario' | 'message'; text: string; speaker?: string };
}

export type RunStatus = 'running' | 'paused';

export interface RunnerState {
  status: RunStatus;
  /** 正在生成的消息 */
  generating: { messageId: string; participantId: string } | null;
  /** AI 主持人正在挑选下一位发言者 */
  picking: boolean;
  /** 自上次人类发言以来 AI 连续发言的次数 */
  aiTurnsSinceHuman: number;
}

export interface AppSettings {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  ownedBy?: string;
  /** 是否是推理（会思考的）模型；undefined 表示不知道 */
  reasoning?: boolean;
  /** 支持的思考强度档位，如 ["low","medium","high"]；undefined 表示不知道 */
  reasoningLevels?: string[];
  contextWindow?: number;
}

export interface RoomPreset {
  id: string;
  name: string;
  description: string;
  title: string;
  scenario: string;
  templateIds: string[];
  /** 不用模板、直接写在预设里的角色 */
  participants?: Partial<Participant>[];
  settings?: Partial<RoomSettings>;
}

/** 新建跑团房间的参数 */
export interface TrpgCreateOptions {
  scenarioId: string;
  /** AI 即兴剧本的主题 */
  theme?: string;
  /** 自己的剧本文本 */
  customScript?: string;
  era?: '1920s' | 'modern';
  kpModel: string;
  kpEffort: string;
  teammateCount: number;
  teammateModel: string;
  teachingMode: boolean;
  autoRoll: boolean;
  humanName: string;
}

/** 服务端通过 SSE 推给前端的事件 */
export type RoomEvent =
  | { type: 'snapshot'; room: Room; runner: RunnerState }
  | { type: 'room'; room: Omit<Room, 'messages'> }
  | { type: 'runner'; runner: RunnerState }
  | { type: 'message_added'; message: Message }
  | { type: 'message_delta'; messageId: string; content?: string; reasoning?: string }
  | { type: 'message_updated'; message: Message }
  | { type: 'message_deleted'; messageId: string }
  | { type: 'messages_cleared' }
  | { type: 'notice'; level: 'info' | 'error'; text: string };

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  humanName: '我',
  humanRole: 'host',
  turnMode: 'round_robin',
  moderatorModel: '',
  autoPauseAfter: 6,
  replyLength: 'medium',
  replyOnHumanMessage: true,
  turnDelayMs: 800,
  promptMode: 'standard',
};

/** 思考强度的中文名 */
export const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export const effortLabel = (effort?: string) => (effort ? (EFFORT_LABELS[effort] ?? effort) : '默认');

/** 用于排序的思考强度顺序 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type { InvestigatorSheet, RollRecord, TrpgState };
