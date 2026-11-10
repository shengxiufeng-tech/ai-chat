// 简单的 JSON 文件存储：本地单人使用足够了，也不需要装数据库

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, CharacterTemplate, Room, RoomSummary } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);

/** 补全旧版本数据里没有的字段 */
export function normalizeRoom(room: Room): Room {
  room.mode = room.mode ?? 'chat';
  room.settings = { ...DEFAULT_ROOM_SETTINGS, ...room.settings };
  room.participants = (room.participants ?? []).map((p) => ({ ...p, reasoningEffort: p.reasoningEffort ?? '' }));
  room.messages = room.messages ?? [];
  // 上次关闭时还在生成的消息，标记为被打断
  for (const m of room.messages) {
    if (m.status === 'streaming') m.status = 'interrupted';
  }
  if (room.trpg) {
    room.trpg.assistantLog = room.trpg.assistantLog ?? [];
    room.trpg.sheets = room.trpg.sheets ?? {};
  }
  return room;
}

export class Store {
  private roomsDir: string;
  private rooms = new Map<string, Room>();
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private dataDir: string) {
    this.roomsDir = path.join(dataDir, 'rooms');
    fs.mkdirSync(this.roomsDir, { recursive: true });
    for (const file of fs.readdirSync(this.roomsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const room = normalizeRoom(JSON.parse(fs.readFileSync(path.join(this.roomsDir, file), 'utf8')));
        this.rooms.set(room.id, room);
      } catch (err) {
        console.error(`读取房间文件失败 ${file}:`, err);
      }
    }
  }

  // ---------- 通用读写 ----------

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown) {
    const full = path.join(this.dataDir, file);
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, full);
  }

  // ---------- 设置 ----------

  getSettings(): AppSettings {
    const defaults: AppSettings = {
      baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:3425/v1',
      apiKey: process.env.LLM_API_KEY || 'magpie-ai-chat',
      defaultModel: process.env.LLM_DEFAULT_MODEL || '',
    };
    return { ...defaults, ...this.readJson<Partial<AppSettings>>('settings.json', {}) };
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch };
    this.writeJson('settings.json', next);
    return next;
  }

  // ---------- 角色模板 ----------

  getUserTemplates(): CharacterTemplate[] {
    return this.readJson<CharacterTemplate[]>('templates.json', []);
  }

  saveUserTemplate(t: Omit<CharacterTemplate, 'id' | 'builtin'>): CharacterTemplate {
    const list = this.getUserTemplates();
    const tpl: CharacterTemplate = { ...t, id: `user-${newId()}` };
    list.push(tpl);
    this.writeJson('templates.json', list);
    return tpl;
  }

  deleteUserTemplate(id: string) {
    this.writeJson(
      'templates.json',
      this.getUserTemplates().filter((t) => t.id !== id),
    );
  }

  // ---------- 房间 ----------

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .map((r) => ({
        id: r.id,
        mode: r.mode,
        title: r.title,
        avatars: r.participants.slice(0, 4).map((p) => p.avatar),
        participantCount: r.participants.length,
        messageCount: r.messages.length,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  addRoom(room: Room) {
    this.rooms.set(room.id, room);
    this.saveRoomNow(room.id);
  }

  deleteRoom(id: string) {
    this.rooms.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    fs.rmSync(path.join(this.roomsDir, `${id}.json`), { force: true });
  }

  /** 标记房间有改动，稍后写盘（流式生成时避免频繁写文件） */
  touchRoom(id: string, { immediate = false } = {}) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.updatedAt = Date.now();
    if (immediate) {
      this.saveRoomNow(id);
      return;
    }
    if (this.saveTimers.has(id)) return;
    this.saveTimers.set(
      id,
      setTimeout(() => this.saveRoomNow(id), 1000),
    );
  }

  private saveRoomNow(id: string) {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    const room = this.rooms.get(id);
    if (!room) return;
    const full = path.join(this.roomsDir, `${id}.json`);
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(room, null, 2));
    fs.renameSync(tmp, full);
  }

  flushAll() {
    for (const id of [...this.saveTimers.keys()]) this.saveRoomNow(id);
  }
}
