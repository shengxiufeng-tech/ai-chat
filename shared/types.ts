// 前后端共用的数据类型

import type { InvestigatorSheet, MemoEntry, NoteEntry, NoteEvent, RollRecord, TrpgState } from './coc.ts';

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
  /** 构思模型：先让它想清楚这一轮说什么，再由上面的 model 照着写出来（执笔） */
  planner?: PlannerConfig;
}

export interface PlannerConfig {
  enabled: boolean;
  model: string;
  /** 构思模型的思考强度，空字符串表示用模型默认值 */
  reasoningEffort: string;
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
  /** 跑团：系统消息的种类（骰子 / 笔记提示） */
  kind?: 'roll' | 'note' | 'handout';
  /** 跑团：骰子 / 数值变化记录 */
  roll?: RollRecord;
  /** 跑团：守秘人记下的笔记 */
  note?: NoteEvent;
  /** 跑团：守秘人展示给玩家的手出物 / 地图 */
  asset?: { id: string; title: string; kind: AssetKind };
  /** 生成这条消息时，因为上下文太长而没有发给模型的早期消息条数 */
  trimmed?: number;
  /** 模型替别人写的发言，已经从正文里去掉（保留在这里供查看） */
  filtered?: string;
  /** 回复不完整：达到输出上限 / 被内容审核截断 / 连接提前断开 */
  truncated?: 'length' | 'content_filter' | 'incomplete';
  /** 构思 / 执笔：这条消息先由构思模型构思（model 是执笔模型） */
  planner?: { model: string; reasoningEffort?: string };
  /** 构思模型写的构思（只在界面上折叠显示，不会发给其他角色） */
  plan?: string;
  /** 生成中：还在构思阶段 */
  planning?: boolean;
  /** 构思失败的原因（这条由执笔模型单独写完） */
  planError?: string;
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

/** 一次请求的 token 用量 */
export interface TokenUsage {
  input: number;
  output: number;
  /** 输入里命中缓存的部分；undefined 表示服务商没有报告缓存信息 */
  cached?: number;
  /** 输出里思考过程的部分 */
  reasoning?: number;
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

/** 整理好的剧本：玩家能看的（标题、时代、简介、开团须知）和只有守秘人能看的（secret）分开 */
export interface PreparedScript {
  title: string;
  /** 时代背景（自由描述） */
  eraLabel: string;
  /** 用哪套技能：1920 年代 / 现代 */
  era: '1920s' | 'modern';
  /** 给玩家看的无剧透简介 */
  intro: string;
  /** 开团须知（推荐人数、时长、推荐技能、车卡限制等），玩家可以看 */
  playerInfo: string;
  /** 只有守秘人能看：AI 整理的速览 + 剧本原文 */
  secret: string;
  /** 原文字数 */
  chars: number;
  /** 原文太长被截断了 */
  truncated?: boolean;
  /** 整理过程中的提示（比如整理失败、改用原文） */
  warning?: string;
  // ---- PDF 剧本（整理助手生成）----
  /** 对应的导入任务（创建房间时从这里拷贝图片） */
  importId?: string;
  /** 手出物和地图 */
  assets?: ScriptAsset[];
  /** 剧本自带的预设调查员 */
  pregens?: InvestigatorSheet[];
  /** 每一页的分类（预览里只显示页码和分类，不显示内容） */
  pages?: { page: number; category: PageCategory }[];
  /** 不交给守秘人的页面分类 */
  excluded?: PageCategory[];
  /** 整理用的模型 */
  organizer?: string;
}

// ---------------- PDF 剧本导入 ----------------

export type AssetKind = 'handout' | 'map' | 'image';
export const ASSET_KIND_LABELS: Record<AssetKind, string> = { handout: '手出物', map: '地图', image: '图片' };

/** 从剧本里裁下来的图片：手出物、地图等 */
export interface ScriptAsset {
  id: string;
  kind: AssetKind;
  title: string;
  /** 给守秘人的说明：手出物的完整文字、地图的区域和标注、什么时候给玩家看 */
  description: string;
  /** 玩家能不能看（守秘人专用的地图不能展示给玩家） */
  visibility: 'player' | 'keeper';
  /** 来自第几页 */
  page: number;
  width: number;
  height: number;
  /** 守秘人已经展示给玩家了 */
  shown?: boolean;
}

export type PageCategory = 'scenario' | 'handout' | 'map' | 'pregen' | 'rules' | 'art' | 'other';
export const PAGE_CATEGORY_LABELS: Record<PageCategory, string> = {
  scenario: '剧本正文',
  handout: '手出物',
  map: '地图',
  pregen: '预设调查员',
  rules: '规则介绍',
  art: '插图',
  other: '版权 / 广告 / 空白',
};
/** 默认不交给守秘人的页面 */
export const DEFAULT_EXCLUDED: PageCategory[] = ['rules', 'art', 'other'];

export type ImportStatus = 'uploading' | 'running' | 'done' | 'error' | 'cancelled';

/** 整理进度（只有不剧透的信息） */
export interface ImportProgress {
  id: string;
  fileName: string;
  pageCount: number;
  uploaded: number;
  status: ImportStatus;
  model: string;
  step: number;
  maxSteps: number;
  startedAt?: number;
  finishedAt?: number;
  /** 最近的动作，例如「查看第 34 页」 */
  activity: { at: number; text: string }[];
  checklist: {
    categorized: number;
    imagePages: number;
    imagePagesSeen: number;
    title: boolean;
    era: boolean;
    intro: boolean;
    brief: boolean;
    glossary: boolean;
    handouts: number;
    maps: number;
    pregens: number;
  };
  usage: { input: number; output: number; cached: number };
  /** 模型不支持工具调用，改用固定流程 */
  fallback?: boolean;
  error?: string;
  result?: PreparedScript;
}

/** 新建跑团房间的参数 */
export interface TrpgCreateOptions {
  scenarioId: string;
  /** AI 即兴剧本的主题 */
  theme?: string;
  /** 自己的剧本文本（直接粘贴、没有整理时用） */
  customScript?: string;
  /** 整理好的剧本（上传文件或粘贴后点了「整理」） */
  prepared?: PreparedScript;
  /** 时代背景（自由描述，AI 即兴剧本用；技能列表会据此判断） */
  eraLabel?: string;
  era?: '1920s' | 'modern';
  kpModel: string;
  kpEffort: string;
  teammateCount: number;
  teammateModel: string;
  teachingMode: boolean;
  autoRoll: boolean;
  /** 守秘人笔记 */
  notebook?: boolean;
  /** 秘密备忘 */
  memo?: boolean;
  humanName: string;
}

/** 服务端通过 SSE 推给前端的事件 */
export type RoomEvent =
  | { type: 'snapshot'; room: Room; runner: RunnerState }
  | { type: 'room'; room: Omit<Room, 'messages'> }
  | { type: 'runner'; runner: RunnerState }
  | { type: 'message_added'; message: Message }
  | { type: 'message_delta'; messageId: string; content?: string; reasoning?: string; plan?: string }
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

export type { InvestigatorSheet, MemoEntry, NoteEntry, NoteEvent, RollRecord, TrpgState };
