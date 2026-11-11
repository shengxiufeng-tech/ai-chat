// 后端入口：REST 接口 + SSE 实时推送 + 托管打包后的前端

import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { OCCUPATIONS, quickInvestigator, type InvestigatorSheet, type TrpgState } from '../shared/coc.ts';
import type {
  AppSettings,
  Participant,
  Room,
  RoomEvent,
  RoomSettings,
  TrpgCreateOptions,
} from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { AccessControl, lanAddresses } from './access.ts';
import { estimateTokens } from './context.ts';
import { completeChat, completeChatWithUsage, listModels, primeModelCache, type ChatMessage } from './llm.ts';
import { BUILTIN_TEMPLATES, ROOM_PRESETS } from './presets.ts';
import { RunnerManager, sessionIdFor } from './runner.ts';
import { BAISHUI, customScenario, improvScenario } from './scenarios.ts';
import { classifyEra, cleanText, extractScriptText, prepareScript } from './scripts.ts';
import { newId, normalizeRoom, Store } from './store.ts';
import { buildAssistantMessages, kpOf, parseSuggestions } from './trpg.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件也没关系
}

const PORT = Number(process.env.PORT || 8787);
// npm run lan（或 npm start -- --lan）：让同一个 Wi-Fi 下的手机也能访问
const LAN_FLAG = process.argv.includes('--lan');
const HOST = process.env.HOST || (LAN_FLAG ? '0.0.0.0' : '127.0.0.1');
const LAN_MODE = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const store = new Store(DATA_DIR);
const runners = new RunnerManager(store);
const app = express();
app.use(express.json({ limit: '25mb' }));
// 其他设备（手机）要先输入访问码；本机访问不受影响
const access = new AccessControl(DATA_DIR);
app.use(access.middleware);

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => unknown;
/** 包一层：把抛出的错误变成 JSON 返回 */
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

function getRoom(id: string): Room {
  const room = store.getRoom(id);
  if (!room) throw new HttpError(404, '房间不存在');
  return room;
}

const param = (req: Request, name: string) => String(req.params[name]);

function roomMeta(room: Room): Omit<Room, 'messages'> {
  const { messages: _messages, ...meta } = room;
  return meta;
}

function emitRoom(room: Room) {
  runners.get(room.id).emit({ type: 'room', room: roomMeta(room) });
}

const PALETTE = ['#38bdf8', '#c084fc', '#fb923c', '#4ade80', '#f472b6', '#facc15', '#f87171', '#a78bfa'];

function makeParticipant(input: Partial<Participant>, room?: Room): Participant {
  const used = new Set(room?.participants.map((p) => p.color));
  const color = input.color || PALETTE.find((c) => !used.has(c)) || PALETTE[0];
  return {
    id: newId(),
    name: String(input.name || '新角色').trim(),
    avatar: input.avatar || '🤖',
    color,
    model: input.model ?? store.getSettings().defaultModel,
    reasoningEffort: input.reasoningEffort ?? '',
    bio: input.bio ?? '',
    persona: input.persona ?? '',
    temperature: typeof input.temperature === 'number' ? input.temperature : 0.8,
    enabled: input.enabled ?? true,
    ...(input.role ? { role: input.role } : {}),
  };
}

function allTemplates() {
  return [...BUILTIN_TEMPLATES, ...store.getUserTemplates()];
}

function cleanSettings(input: Partial<RoomSettings>): Partial<RoomSettings> {
  const out: Partial<RoomSettings> = {};
  if (typeof input.humanName === 'string' && input.humanName.trim()) out.humanName = input.humanName.trim();
  if (input.humanRole && ['host', 'participant', 'observer'].includes(input.humanRole)) out.humanRole = input.humanRole;
  if (input.turnMode && ['round_robin', 'moderator', 'manual'].includes(input.turnMode)) out.turnMode = input.turnMode;
  if (typeof input.moderatorModel === 'string') out.moderatorModel = input.moderatorModel.trim();
  if (typeof input.autoPauseAfter === 'number') out.autoPauseAfter = Math.max(0, Math.floor(input.autoPauseAfter));
  if (input.replyLength && ['short', 'medium', 'long'].includes(input.replyLength)) out.replyLength = input.replyLength;
  if (typeof input.replyOnHumanMessage === 'boolean') out.replyOnHumanMessage = input.replyOnHumanMessage;
  if (typeof input.turnDelayMs === 'number') out.turnDelayMs = Math.min(60000, Math.max(0, input.turnDelayMs));
  if (input.promptMode && ['standard', 'humanlike'].includes(input.promptMode)) out.promptMode = input.promptMode;
  return out;
}

// ---------------- 手机访问 ----------------

async function accessInfo(withCode: boolean) {
  const code = access.accessCode;
  const urls = LAN_MODE
    ? await Promise.all(
        lanAddresses().map(async (ip) => {
          const url = `http://${ip}:${PORT}/`;
          const qr = await QRCode.toString(`${url}?code=${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
          return { url, qr: withCode ? qr : '' };
        }),
      )
    : [];
  return { lan: LAN_MODE, port: PORT, code: withCode ? code : '', urls };
}

app.get(
  '/api/access',
  h((req) => accessInfo(access.isLocal(req))),
);

app.post(
  '/api/access/reset',
  h((req) => {
    if (!access.isLocal(req)) throw new HttpError(403, '只能在电脑上重置访问码');
    access.reset();
    return accessInfo(true);
  }),
);

// ---------------- 设置与模型 ----------------

app.get(
  '/api/settings',
  h(() => store.getSettings()),
);

app.put(
  '/api/settings',
  h((req) => {
    const body = req.body as Partial<AppSettings>;
    const patch: Partial<AppSettings> = {};
    if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim();
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.defaultModel === 'string') patch.defaultModel = body.defaultModel.trim();
    return store.saveSettings(patch);
  }),
);

app.get(
  '/api/models',
  h(async () => {
    const s = store.getSettings();
    try {
      const models = await listModels(s.baseUrl, s.apiKey);
      primeModelCache(s.baseUrl, models);
      return { models };
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  }),
);

app.post(
  '/api/diagnostics/cache',
  h(async (req) => {
    const s = store.getSettings();
    const model = String(req.body?.model || s.defaultModel || '').trim();
    if (!model) throw new HttpError(400, '请先选择要测试的模型');
    // 内容固定的长提示。Gemini 的自动缓存要求提示至少 1~4 千 token（因模型而异），「长」档约 9 千 token
    const long = req.body?.size === 'long';
    const system = `你是缓存测试助手。下面是一段固定的参考资料，请忽略它的内容，只按用户要求回复。\n\n${Array(long ? 6 : 2)
      .fill(BAISHUI.secret)
      .join('\n\n')}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: '这是一条缓存测试消息，请只回复一个字：好' },
    ];
    const sessionId = `ai-chat-diagnostics-${Date.now()}`;
    const run = async () => {
      const started = Date.now();
      try {
        const r = await completeChatWithUsage({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          model,
          messages,
          sessionId,
          signal: AbortSignal.timeout(120000),
        });
        return { ok: true, usage: r.usage ?? null, ms: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
      }
    };
    const first = await run();
    if (!first.ok) return { model, first, second: null };
    // 等几秒：有的服务（比如 DeepSeek）在请求结束后才把缓存建好
    await new Promise((r) => setTimeout(r, 3000));
    const second = await run();
    return { model, first, second, promptTokens: estimateTokens(system), size: long ? 'long' : 'standard' };
  }),
);

/** 导入剧本：上传文件（base64）或粘贴文字，提取并整理成「玩家可看」和「守秘人专用」两部分 */
app.post(
  '/api/scripts/prepare',
  h(async (req) => {
    const b = req.body ?? {};
    let text = typeof b.text === 'string' ? cleanText(b.text) : '';
    const name = typeof b.name === 'string' ? b.name : '';
    if (typeof b.data === 'string' && b.data) {
      try {
        text = await extractScriptText(name, Buffer.from(b.data, 'base64'));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    if (!text.trim()) throw new HttpError(400, '没有读到剧本内容（文件是空的，或者内容都是图片）');
    const s = store.getSettings();
    return prepareScript(text, {
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: String(b.model || s.defaultModel || ''),
      fileName: name || undefined,
    });
  }),
);

// ---------------- 模板与预设 ----------------

app.get(
  '/api/templates',
  h(() => allTemplates()),
);

app.post(
  '/api/templates',
  h((req) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, '模板需要名字');
    return store.saveUserTemplate({
      name: String(b.name),
      avatar: b.avatar || '🤖',
      color: b.color || PALETTE[0],
      bio: b.bio ?? '',
      persona: b.persona ?? '',
      temperature: typeof b.temperature === 'number' ? b.temperature : 0.8,
    });
  }),
);

app.delete(
  '/api/templates/:id',
  h((req) => {
    store.deleteUserTemplate(param(req, 'id'));
  }),
);

app.get(
  '/api/presets',
  h(() => ROOM_PRESETS),
);

// ---------------- 房间 ----------------

app.get(
  '/api/rooms',
  h((req) => store.listRooms(typeof req.query.q === 'string' ? req.query.q : '')),
);

const TEAMMATE_AVATARS = ['🧭', '📷', '🩺', '🗝️'];
const TEAMMATE_PERSONAS = [
  '性格谨慎细心，喜欢先观察再行动，说话不多但很靠谱。',
  '性格开朗大胆，好奇心强，有点冒失，喜欢开玩笑缓解紧张。',
  '性格冷静理性，凡事讲证据，遇到怪事会先想科学的解释。',
];

function createTrpgRoom(o: TrpgCreateOptions): Room {
  const era = o.eraLabel ? classifyEra(o.eraLabel) : o.era === 'modern' ? 'modern' : '1920s';
  const p = o.prepared;
  const scenario =
    o.scenarioId === 'improv'
      ? improvScenario(o.theme ?? '', era, o.eraLabel)
      : o.scenarioId === 'custom' && p
        ? {
            id: 'custom',
            title: String(p.title || '自定义剧本').slice(0, 40),
            era: p.eraLabel ? classifyEra(p.eraLabel) : p.era === 'modern' ? 'modern' : '1920s',
            eraLabel: String(p.eraLabel ?? ''),
            playerInfo: String(p.playerInfo ?? ''),
            intro: String(p.intro || '使用你导入的剧本。'),
            secret: String(p.secret ?? ''),
          }
        : o.scenarioId === 'custom'
          ? customScenario(o.customScript ?? '', era)
          : BAISHUI;
  const now = Date.now();
  const room: Room = {
    id: newId(),
    mode: 'trpg',
    title: scenario.title,
    scenario: scenario.intro,
    participants: [],
    messages: [],
    settings: {
      ...DEFAULT_ROOM_SETTINGS,
      humanName: (o.humanName || '我').trim(),
      humanRole: 'participant',
      turnMode: 'manual',
      autoPauseAfter: 0,
      replyLength: 'medium',
    },
    createdAt: now,
    updatedAt: now,
  };
  const kpModel = o.kpModel || store.getSettings().defaultModel;
  room.participants.push(
    makeParticipant(
      {
        name: '守秘人',
        avatar: '🕯️',
        color: '#a78bfa',
        model: kpModel,
        reasoningEffort: o.kpEffort ?? '',
        bio: '主持游戏、扮演所有 NPC 的守秘人（KP）',
        persona: '',
        temperature: 0.9,
        role: 'kp',
      },
      room,
    ),
  );
  const trpg: TrpgState = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioIntro: scenario.intro,
    scenarioSecret: scenario.secret,
    era: scenario.era,
    eraLabel: scenario.eraLabel || undefined,
    playerInfo: scenario.playerInfo || undefined,
    teachingMode: o.teachingMode ?? true,
    autoRoll: o.autoRoll ?? false,
    teammatesAct: true,
    sheets: {},
    started: false,
    assistantLog: [],
    notebook: o.notebook ?? true,
    notes: [],
    memo: o.memo ?? true,
    memos: [],
  };
  const count = Math.max(0, Math.min(3, Math.floor(o.teammateCount ?? 0)));
  const occupations = [...OCCUPATIONS].sort(() => Math.random() - 0.5);
  const usedNames = new Set<string>();
  for (let i = 0; i < count; i++) {
    let sheet = quickInvestigator({ occupationId: occupations[i].id, era: scenario.era });
    for (let tries = 0; usedNames.has(sheet.name) && tries < 10; tries++) {
      sheet = quickInvestigator({ occupationId: occupations[i].id, era: scenario.era });
    }
    usedNames.add(sheet.name);
    const p = makeParticipant(
      {
        name: sheet.name,
        avatar: TEAMMATE_AVATARS[i % TEAMMATE_AVATARS.length],
        model: o.teammateModel || kpModel,
        bio: `AI 队友 · ${sheet.occupation}`,
        persona: TEAMMATE_PERSONAS[i % TEAMMATE_PERSONAS.length],
        temperature: 0.9,
        role: 'player',
      },
      room,
    );
    room.participants.push(p);
    trpg.sheets[p.id] = sheet;
  }
  room.trpg = trpg;
  return room;
}

app.post(
  '/api/rooms',
  h((req) => {
    const b = req.body ?? {};
    if (b.mode === 'trpg') {
      const room = createTrpgRoom(b.trpg ?? {});
      store.addRoom(room);
      return room;
    }
    const preset = ROOM_PRESETS.find((p) => p.id === b.presetId) ?? ROOM_PRESETS.find((p) => p.id === 'blank')!;
    const now = Date.now();
    const room: Room = {
      id: newId(),
      mode: 'chat',
      title: String(b.title || preset.title).trim(),
      scenario: typeof b.scenario === 'string' ? b.scenario : preset.scenario,
      participants: [],
      messages: [],
      settings: { ...DEFAULT_ROOM_SETTINGS, ...preset.settings, ...cleanSettings(b.settings ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    const templates = allTemplates();
    for (const tid of preset.templateIds) {
      const t = templates.find((x) => x.id === tid);
      if (t) room.participants.push(makeParticipant({ ...t, model: b.model || undefined }, room));
    }
    for (const inline of preset.participants ?? []) {
      room.participants.push(makeParticipant({ ...inline, model: b.model || undefined }, room));
    }
    store.addRoom(room);
    return room;
  }),
);

/** 导入导出的房间 JSON（换上新的 id，避免和现有房间冲突） */
app.post(
  '/api/rooms/import',
  h((req) => {
    const input = req.body?.room ?? req.body;
    if (!input || typeof input !== 'object' || !Array.isArray(input.participants) || !Array.isArray(input.messages)) {
      throw new HttpError(400, '不是有效的房间文件');
    }
    const room = normalizeRoom(structuredClone(input) as Room);
    const idMap = new Map<string, string>();
    for (const p of room.participants) {
      const id = newId();
      idMap.set(p.id, id);
      p.id = id;
    }
    for (const m of room.messages) {
      m.id = newId();
      if (m.participantId) m.participantId = idMap.get(m.participantId) ?? m.participantId;
      if (m.roll?.actor && idMap.has(m.roll.actor)) m.roll.actor = idMap.get(m.roll.actor)!;
    }
    if (room.trpg) {
      const sheets: Record<string, InvestigatorSheet> = {};
      for (const [key, sheet] of Object.entries(room.trpg.sheets)) sheets[idMap.get(key) ?? key] = sheet;
      room.trpg.sheets = sheets;
    }
    room.id = newId();
    room.title = String(room.title || '导入的房间');
    room.createdAt = room.createdAt || Date.now();
    room.updatedAt = Date.now();
    store.addRoom(room);
    return room;
  }),
);

app.get(
  '/api/rooms/:id',
  h((req) => ({ room: getRoom(param(req, 'id')), runner: runners.get(param(req, 'id')).state() })),
);

app.patch(
  '/api/rooms/:id',
  h((req) => {
    const room = getRoom(param(req, 'id'));
    const b = req.body ?? {};
    if (typeof b.title === 'string' && b.title.trim()) room.title = b.title.trim();
    if (typeof b.scenario === 'string') room.scenario = b.scenario;
    if (b.settings) room.settings = { ...room.settings, ...cleanSettings(b.settings) };
    store.touchRoom(room.id, { immediate: true });
    emitRoom(room);
    return roomMeta(room);
  }),
);

app.delete(
  '/api/rooms/:id',
  h((req) => {
    const id = param(req, 'id');
    getRoom(id);
    runners.remove(id);
    store.deleteRoom(id);
  }),
);

// ---------------- 参与者 ----------------

app.post(
  '/api/rooms/:id/participants',
  h((req) => {
    const room = getRoom(param(req, 'id'));
    const b = req.body ?? {};
    const tpl = b.templateId ? allTemplates().find((t) => t.id === b.templateId) : undefined;
    const p = makeParticipant({ ...tpl, ...b.participant }, room);
    room.participants.push(p);
    store.touchRoom(room.id, { immediate: true });
    emitRoom(room);
    return p;
  }),
);

app.patch(
  '/api/rooms/:id/participants/:pid',
  h((req) => {
    const room = getRoom(param(req, 'id'));
    const p = room.participants.find((x) => x.id === param(req, 'pid'));
    if (!p) throw new HttpError(404, '角色不存在');
    const b = req.body ?? {};
    if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim();
    for (const key of ['avatar', 'color', 'model', 'reasoningEffort', 'bio', 'persona'] as const) {
      if (typeof b[key] === 'string') p[key] = b[key];
    }
    if (typeof b.temperature === 'number') p.temperature = Math.min(2, Math.max(0, b.temperature));
    if (typeof b.enabled === 'boolean') p.enabled = b.enabled;
    if (typeof b.index === 'number') {
      const from = room.participants.indexOf(p);
      const to = Math.min(room.participants.length - 1, Math.max(0, b.index));
      room.participants.splice(from, 1);
      room.participants.splice(to, 0, p);
    }
    store.touchRoom(room.id, { immediate: true });
    emitRoom(room);
    return p;
  }),
);

app.delete(
  '/api/rooms/:id/participants/:pid',
  h((req) => {
    const room = getRoom(param(req, 'id'));
    room.participants = room.participants.filter((x) => x.id !== param(req, 'pid'));
    store.touchRoom(room.id, { immediate: true });
    emitRoom(room);
  }),
);

// ---------------- 对话控制 ----------------

const runnerAction = (fn: (req: Request, roomId: string) => unknown) =>
  h((req) => {
    const id = param(req, 'id');
    getRoom(id);
    try {
      const result = fn(req, id);
      return result ?? runners.get(id).state();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

app.post('/api/rooms/:id/run', runnerAction((_req, id) => runners.get(id).run()));
app.post('/api/rooms/:id/pause', runnerAction((_req, id) => runners.get(id).pause()));
app.post('/api/rooms/:id/stop', runnerAction((_req, id) => runners.get(id).stop()));
app.post(
  '/api/rooms/:id/turn',
  runnerAction((req, id) => runners.get(id).requestTurn(req.body?.participantId || undefined)),
);
app.post(
  '/api/rooms/:id/messages',
  runnerAction((req, id) => {
    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new HttpError(400, '消息不能为空');
    return runners.get(id).addHumanMessage(content, { interrupt: !!req.body?.interrupt, ooc: !!req.body?.ooc });
  }),
);
app.patch(
  '/api/rooms/:id/messages/:mid',
  runnerAction((req, id) => runners.get(id).editMessage(param(req, 'mid'), String(req.body?.content ?? ''))),
);
app.delete(
  '/api/rooms/:id/messages/:mid',
  runnerAction((req, id) => runners.get(id).deleteMessage(param(req, 'mid'))),
);
app.post(
  '/api/rooms/:id/messages/:mid/regenerate',
  runnerAction((req, id) => runners.get(id).regenerate(param(req, 'mid'))),
);
app.post('/api/rooms/:id/clear', runnerAction((_req, id) => runners.get(id).clearMessages()));

// ---------------- 跑团 ----------------

function getTrpgRoom(id: string) {
  const room = getRoom(id);
  if (!room.trpg) throw new HttpError(400, '这不是跑团房间');
  return room as Room & { trpg: TrpgState };
}

function validSheet(x: any): x is InvestigatorSheet {
  return (
    x &&
    typeof x.name === 'string' &&
    x.characteristics &&
    typeof x.skills === 'object' &&
    x.hp &&
    x.mp &&
    x.san &&
    Array.isArray(x.items)
  );
}

app.put(
  '/api/rooms/:id/trpg/sheets/:key',
  runnerAction((req, id) => {
    getTrpgRoom(id);
    const sheet = req.body?.sheet;
    if (!validSheet(sheet)) throw new HttpError(400, '角色卡数据不完整');
    runners.get(id).setSheet(param(req, 'key'), sheet);
    return { ok: true };
  }),
);

app.patch(
  '/api/rooms/:id/trpg',
  h((req) => {
    const room = getTrpgRoom(param(req, 'id'));
    const b = req.body ?? {};
    for (const key of ['teachingMode', 'autoRoll', 'teammatesAct', 'notebook', 'memo'] as const) {
      if (typeof b[key] === 'boolean') room.trpg[key] = b[key];
    }
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
    return { ok: true };
  }),
);

app.patch(
  '/api/rooms/:id/notes/:nid',
  h((req) => {
    const room = getTrpgRoom(param(req, 'id'));
    const note = room.trpg.notes.find((n) => n.id === param(req, 'nid'));
    if (!note) throw new HttpError(404, '笔记不存在');
    const b = req.body ?? {};
    if (typeof b.title === 'string' && b.title.trim()) note.title = b.title.trim().slice(0, 40);
    if (typeof b.text === 'string' && b.text.trim()) note.text = b.text.trim().slice(0, 400);
    note.updatedAt = Date.now();
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
    return note;
  }),
);

app.delete(
  '/api/rooms/:id/notes/:nid',
  h((req) => {
    const room = getTrpgRoom(param(req, 'id'));
    room.trpg.notes = room.trpg.notes.filter((n) => n.id !== param(req, 'nid'));
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
  }),
);

app.delete(
  '/api/rooms/:id/memos/:mid',
  h((req) => {
    const room = getTrpgRoom(param(req, 'id'));
    room.trpg.memos = room.trpg.memos.filter((m) => m.id !== param(req, 'mid'));
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
  }),
);

app.post('/api/rooms/:id/trpg/start', runnerAction((_req, id) => runners.get(id).startTrpg()));
app.post('/api/rooms/:id/rolls/:mid/roll', runnerAction((req, id) => runners.get(id).resolveRoll(param(req, 'mid'))));
app.post(
  '/api/rooms/:id/rolls/:mid/push',
  runnerAction((req, id) => runners.get(id).pushRoll(param(req, 'mid'), typeof req.body?.how === 'string' ? req.body.how : undefined)),
);
app.post('/api/rooms/:id/rolls/:mid/accept', runnerAction((req, id) => runners.get(id).acceptRoll(param(req, 'mid'))));
app.post('/api/rooms/:id/trpg/growth', runnerAction((_req, id) => runners.get(id).createGrowth()));

app.post(
  '/api/rooms/:id/assistant',
  h(async (req) => {
    const room = getTrpgRoom(param(req, 'id'));
    const mode = req.body?.mode === 'suggest' ? 'suggest' : 'ask';
    const question = String(req.body?.question ?? '').trim();
    if (mode === 'ask' && !question) throw new HttpError(400, '问题不能为空');
    const settings = store.getSettings();
    const kp = kpOf(room);
    const model = kp?.model || settings.defaultModel;
    if (!model) throw new HttpError(400, '还没有可用的模型，请先在设置里选择默认模型');
    let answer: string;
    try {
      answer = await completeChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model,
        temperature: 0.6,
        sessionId: sessionIdFor(room.id, 'assistant'),
        messages: buildAssistantMessages(room, question, mode),
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
    answer = answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (mode === 'suggest') return { suggestions: parseSuggestions(answer) };
    const now = Date.now();
    room.trpg.assistantLog.push({ role: 'user', content: question, at: now }, { role: 'assistant', content: answer, at: Date.now() });
    room.trpg.assistantLog = room.trpg.assistantLog.slice(-60);
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
    return { answer };
  }),
);

app.delete(
  '/api/rooms/:id/assistant',
  h((req) => {
    const room = getTrpgRoom(param(req, 'id'));
    room.trpg.assistantLog = [];
    store.touchRoom(room.id, { immediate: true });
    runners.get(room.id).emitRoomMeta();
  }),
);

// ---------------- 实时事件（SSE） ----------------

app.get('/api/rooms/:id/events', (req, res) => {
  const id = param(req, 'id');
  const room = store.getRoom(id);
  if (!room) {
    res.status(404).json({ error: '房间不存在' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (ev: RoomEvent) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const runner = runners.get(id);
  send({ type: 'snapshot', room, runner: runner.state() });
  const unsubscribe = runner.subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------- 前端页面 ----------------

const distDir = path.resolve('dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, HOST, async () => {
  const s = store.getSettings();
  console.log(`\n  AI 对话室已启动：http://localhost:${PORT}`);
  console.log(`  模型服务：${s.baseUrl}${s.baseUrl === 'mock' ? '（模拟模式）' : ''}`);
  console.log(`  数据目录：${DATA_DIR}\n`);
  if (LAN_MODE) {
    const ips = lanAddresses();
    if (!ips.length) {
      console.log('  局域网访问已开启，但没有找到这台电脑的局域网 IP，请确认已经连上 Wi-Fi 或网线。\n');
      return;
    }
    console.log('  📱 手机访问（手机和电脑要连同一个 Wi-Fi）：');
    for (const ip of ips) console.log(`     http://${ip}:${PORT}`);
    console.log(`     访问码：${access.accessCode}（第一次访问时输入，之后手机会记住）\n`);
    console.log('  用手机相机扫这个二维码可以直接打开，不用输入访问码：');
    const qr = await QRCode.toString(`http://${ips[0]}:${PORT}/?code=${access.accessCode}`, { type: 'terminal', small: true });
    console.log(qr.replace(/^/gm, '  '));
    console.log('  打不开的话：检查电脑防火墙是否允许 Node.js 接受局域网连接。\n');
  }
});

function shutdown() {
  store.flushAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
