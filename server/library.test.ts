import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { quickInvestigator } from '../shared/coc.ts';
import type { PreparedScript, Room } from '../shared/types.ts';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.ts';
import { ScriptLibrary } from './library.ts';
import type { Workspace } from './scriptAgent.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const prepared = (secret: string, extra: Partial<PreparedScript> = {}): PreparedScript => ({
  title: '老宅疑云',
  eraLabel: '1920 年代，波士顿',
  era: '1920s',
  intro: '简介',
  playerInfo: '',
  secret,
  chars: secret.length,
  ...extra,
});

test('剧本库：加入、按文件指纹找回、同样的内容不重复存', () => {
  const root = tmp('ai-chat-lib-');
  const lib = new ScriptLibrary(root);
  const a = lib.add({ prepared: prepared('秘密 A'), source: { kind: 'file', fileName: 'a.docx', hash: 'h1' } });
  assert.equal(lib.findByHash('h1'), a);
  assert.equal(lib.findByHash('nope'), undefined);
  assert.equal(lib.get(a).libraryId, a);
  assert.equal(lib.get(a).secret, '秘密 A');

  // 同一个备份导入两次：只存一份
  const b1 = lib.add({ prepared: prepared('秘密 B'), source: { kind: 'backup' } });
  const b2 = lib.add({ prepared: prepared('秘密 B'), source: { kind: 'backup' } });
  assert.equal(b1, b2);
  assert.equal(lib.list().length, 2);

  // 重新整理同一个文件：覆盖原来那条
  const a2 = lib.add({ prepared: prepared('秘密 A（重新整理）'), source: { kind: 'file', fileName: 'a.docx', hash: 'h1' } });
  assert.equal(a2, a);
  assert.equal(lib.get(a).secret, '秘密 A（重新整理）');

  // 列表里没有守秘人资料
  assert.equal((lib.list()[0] as unknown as { secret?: string }).secret, undefined);

  // 重启后还在；删除
  const again = new ScriptLibrary(root);
  assert.equal(again.list().length, 2);
  again.remove(b1);
  assert.equal(again.list().length, 1);
  assert.ok(!fs.existsSync(path.join(root, b1)));
  assert.throws(() => again.get(b1), /没有这个剧本/);
});

test('剧本库：手出物图片跟着剧本走，创建房间时拷贝过去', () => {
  const root = tmp('ai-chat-lib-');
  const src = tmp('ai-chat-src-');
  fs.writeFileSync(path.join(src, 'x.jpg'), 'IMAGE-X');
  const lib = new ScriptLibrary(root);
  const pregen = quickInvestigator({ name: '哈维', occupationId: 'journalist' });
  const id = lib.add({
    prepared: prepared('秘密', {
      assets: [
        { id: 'ax', kind: 'handout', title: '剪报', description: '', visibility: 'player', page: 1, width: 1, height: 1 },
        { id: 'ay', kind: 'map', title: '地图', description: '', visibility: 'keeper', page: 2, width: 1, height: 1 },
      ],
      pregens: [pregen],
    }),
    source: { kind: 'pdf', pages: 5, hash: 'p1' },
    images: { ax: path.join(src, 'x.jpg'), ay: Buffer.from('IMAGE-Y') },
  });
  const item = lib.list()[0];
  assert.deepEqual([item.handouts, item.maps, item.pregens], [1, 1, 1]);
  const dest = tmp('ai-chat-room-');
  const { assets, pregens } = lib.takeAssets(id, dest);
  assert.equal(assets.length, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'ax.jpg'), 'utf8'), 'IMAGE-X');
  assert.equal(fs.readFileSync(path.join(dest, 'ay.jpg'), 'utf8'), 'IMAGE-Y');
  assert.equal(pregens?.[0].name, '哈维');
});

test('剧本库：PDF 剧本可以重新调整交给守秘人的页面', () => {
  const lib = new ScriptLibrary(tmp('ai-chat-lib-'));
  const ws: Workspace = {
    dir: '/nowhere',
    fileName: 'a.pdf',
    pages: [
      { page: 1, text: '规则'.repeat(200), chars: 400, images: 0, category: 'rules' },
      { page: 2, text: '正文'.repeat(200), chars: 400, images: 0, category: 'scenario' },
    ],
    fields: { intro: '简介', keeper_brief: '速览' },
    assets: [],
    pregens: [],
    seen: [],
  };
  const id = lib.add({ prepared: prepared('【第 2 页】'), source: { kind: 'pdf', hash: 'p2' }, ws });
  const withRules = lib.assemble(id, []);
  assert.match(withRules.secret, /【第 1 页】/);
  assert.deepEqual(withRules.excluded, []);
  assert.doesNotMatch(lib.assemble(id, ['rules']).secret, /【第 1 页】/);
  const text = lib.add({ prepared: prepared('纯文字'), source: { kind: 'paste' } });
  assert.throws(() => lib.assemble(text, []), /不是 PDF/);
});

test('剧本库：第一次运行时把已有的「我自己的剧本」房间加进来，只做一次', () => {
  const root = tmp('ai-chat-lib-');
  const assets = tmp('ai-chat-assets-');
  fs.writeFileSync(path.join(assets, 'h1.jpg'), 'IMG');
  const room = (id: string, scenarioId: string): Room => ({
    id,
    mode: 'trpg',
    title: `房间 ${id}`,
    scenario: '',
    participants: [],
    messages: [],
    settings: DEFAULT_ROOM_SETTINGS,
    createdAt: 0,
    updatedAt: 0,
    trpg: {
      scenarioId,
      scenarioTitle: `剧本 ${id}`,
      scenarioIntro: 'i',
      scenarioSecret: `秘密 ${id}`,
      era: '1920s',
      teachingMode: false,
      autoRoll: false,
      teammatesAct: true,
      sheets: {},
      started: true,
      assistantLog: [],
      notebook: true,
      notes: [],
      memo: true,
      memos: [],
      assets: [{ id: 'h1', kind: 'handout', title: '信', description: '', visibility: 'player', page: 1, width: 1, height: 1, shown: true }],
    },
  });
  const lib = new ScriptLibrary(root);
  const n = lib.backfillOnce([room('r1', 'custom'), room('r2', 'baishui'), room('r3', 'improv')], (_r, a) => path.join(assets, `${a}.jpg`));
  assert.equal(n, 1, '只收「我自己的剧本」');
  const id = lib.list()[0].id;
  assert.equal(lib.get(id).title, '剧本 r1');
  assert.equal(lib.get(id).assets?.[0].shown, undefined, '不带游戏进度');
  assert.ok(fs.existsSync(path.join(root, id, 'h1.jpg')));
  lib.remove(id);
  assert.equal(lib.backfillOnce([room('r1', 'custom')], () => ''), 0, '已经补过一次，删掉的不会再回来');
});

test('剧本库：同样内容再加入时补上之前缺的图片', () => {
  const root = tmp('ai-chat-lib-');
  const lib = new ScriptLibrary(root);
  const p = prepared('同一个剧本', { assets: [{ id: 'img1', kind: 'handout', title: '信', description: '', visibility: 'player', page: 1, width: 1, height: 1 }] });
  const id = lib.add({ prepared: p, source: { kind: 'backup' } }); // 旧备份：没有图片
  assert.ok(!fs.existsSync(path.join(root, id, 'img1.jpg')));
  assert.equal(lib.add({ prepared: p, source: { kind: 'room' }, images: { img1: Buffer.from('IMG') } }), id);
  assert.equal(fs.readFileSync(path.join(root, id, 'img1.jpg'), 'utf8'), 'IMG');
});
