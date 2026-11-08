// 后端入口：REST 接口 + SSE 实时推送 + 托管打包后的前端

import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppSettings, Participant, Room, RoomEvent, RoomSettings } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { listModels } from './llm.ts';
import { BUILTIN_TEMPLATES, ROOM_PRESETS } from './presets.ts';
import { RunnerManager } from './runner.ts';
import { newId, Store } from './store.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件也没关系
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const store = new Store(DATA_DIR);
const runners = new RunnerManager(store);
const app = express();
app.use(express.json({ limit: '2mb' }));

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
    bio: input.bio ?? '',
    persona: input.persona ?? '',
    temperature: typeof input.temperature === 'number' ? input.temperature : 0.8,
    enabled: input.enabled ?? true,
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
  return out;
}

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
      return { models: await listModels(s.baseUrl, s.apiKey) };
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
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
  h(() => store.listRooms()),
);

app.post(
  '/api/rooms',
  h((req) => {
    const b = req.body ?? {};
    const preset = ROOM_PRESETS.find((p) => p.id === b.presetId) ?? ROOM_PRESETS.find((p) => p.id === 'blank')!;
    const now = Date.now();
    const room: Room = {
      id: newId(),
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
    for (const key of ['avatar', 'color', 'model', 'bio', 'persona'] as const) {
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
    return runners.get(id).addHumanMessage(content, { interrupt: !!req.body?.interrupt });
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

const server = app.listen(PORT, HOST, () => {
  const s = store.getSettings();
  console.log(`\n  AI 对话室后端已启动：http://${HOST}:${PORT}`);
  console.log(`  模型服务：${s.baseUrl}${s.baseUrl === 'mock' ? '（模拟模式）' : ''}`);
  console.log(`  数据目录：${DATA_DIR}\n`);
});

function shutdown() {
  store.flushAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
