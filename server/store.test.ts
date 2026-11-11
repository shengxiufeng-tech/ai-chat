import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { snippet, Store } from './store.ts';

function room(id: string, title: string, extra: Partial<Room> = {}): Room {
  return {
    id,
    mode: 'chat',
    title,
    scenario: '',
    participants: [],
    messages: [],
    settings: { ...DEFAULT_ROOM_SETTINGS },
    createdAt: 0,
    updatedAt: Number(id.replace(/\D/g, '')) || 0,
    ...extra,
  };
}

test('搜索标题、AI 名字、场景和消息内容，并给出片段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-store-'));
  try {
    const store = new Store(dir);
    store.addRoom(room('r1', '辩论赛'));
    store.addRoom(
      room('r2', '圆桌闲聊', {
        participants: [
          { id: 'p', name: '苏格拉', avatar: '🏛️', color: '#fff', model: 'm', reasoningEffort: '', bio: '爱追问的哲学家', persona: '', temperature: 1, enabled: true },
        ],
      }),
    );
    store.addRoom(
      room('r3', '雾锁白水镇', {
        mode: 'trpg',
        messages: [
          { id: 'm', role: 'ai', speakerName: '守秘人', content: '你听到井里传来一阵若有若无的歌声。[检定:聆听]', status: 'done', createdAt: 0 },
        ],
      }),
    );
    assert.equal(store.listRooms().length, 3);
    assert.deepEqual(store.listRooms('辩论').map((r) => r.id), ['r1']);
    assert.equal(store.listRooms('辩论')[0].match?.where, 'title');
    assert.equal(store.listRooms('哲学家')[0].match?.where, 'participant');
    const hit = store.listRooms('歌声');
    assert.equal(hit[0].id, 'r3');
    assert.equal(hit[0].match?.where, 'message');
    assert.equal(hit[0].match?.speaker, '守秘人');
    assert.doesNotMatch(hit[0].match!.text, /检定/); // 守秘人指令不出现在片段里
    assert.equal(store.listRooms('检定').length, 0); // 也不会被搜到
    assert.equal(store.listRooms('不存在的词').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('片段截取', () => {
  assert.equal(snippet('短句', '短'), '短句');
  const long = `${'甲'.repeat(50)}关键词${'乙'.repeat(50)}`;
  const s = snippet(long, '关键词', 5, 5);
  assert.equal(s, '…甲甲甲甲甲关键词乙乙乙乙乙…');
  assert.match(snippet(long, '关键词'), /^…甲{6}关键词/);
});
