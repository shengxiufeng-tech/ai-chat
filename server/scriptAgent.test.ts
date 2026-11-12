import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crop, decodeJpeg, encodeJpeg, fit, normalizeBox } from './images.ts';
import { ImportManager } from './imports.ts';
import { assemble, compactImages, execTool, parsePages, pregenSheet, rangeText, runScriptAgent, runScriptAgentWith, type Workspace } from './scriptAgent.ts';
import type { AgentMessage } from './llm.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一张假的页面图片：白底，左上角一块黑色 */
function pageJpeg(w = 600, h = 800) {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h / 4; y++) for (let x = 0; x < w / 4; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return encodeJpeg({ width: w, height: h, data }, 90);
}

function workspace(pages: { text: string; images?: number }[]): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-agent-'));
  pages.forEach((_, i) => fs.writeFileSync(path.join(dir, `page-${i + 1}.jpg`), pageJpeg()));
  return {
    dir,
    fileName: 'test.pdf',
    pages: pages.map((p, i) => ({ page: i + 1, text: p.text, chars: p.text.replace(/\s/g, '').length, images: p.images ?? 0 })),
    fields: {},
    assets: [],
    pregens: [],
    seen: [],
  };
}

const LONG = '这是剧本正文。'.repeat(80);
const hooks = () => {
  const log: string[] = [];
  return { log, hooks: { activity: (t: string) => log.push(t), step: () => {}, usage: () => {}, changed: () => {} } };
};

test('图片：按相对坐标裁切、缩小', () => {
  const img = decodeJpeg(pageJpeg(600, 800));
  const c = crop(img, { left: 0, top: 0, right: 250, bottom: 250 });
  assert.equal(c.width, 150);
  assert.equal(c.height, 200);
  assert.ok(c.data[0] < 40, '左上角是黑色');
  const small = fit(img, 400);
  assert.equal(Math.max(small.width, small.height), 400);
  assert.equal(fit(img, 2000), img, '本来就小的不放大');
  assert.deepEqual(normalizeBox({ left: 900, right: 100, top: -5, bottom: 2000 }), { left: 100, top: 0, right: 900, bottom: 1000 });
});

test('页码范围', () => {
  assert.deepEqual(parsePages('1-3, 5，7~8', 10), [1, 2, 3, 5, 7, 8]);
  assert.deepEqual(parsePages('9-12', 10), [9, 10]);
  assert.deepEqual(parsePages([2, 2, 30], 10), [2]);
  assert.equal(rangeText([1, 2, 3, 5, 7, 8]), '1-3、5、7-8');
});

test('工具：读文字、看页面、裁切保存、调整、删除', () => {
  const ws = workspace([{ text: LONG }, { text: '', images: 1 }]);
  const run = (name: string, args: object) => execTool(ws, { id: 'x', name, arguments: JSON.stringify(args) });
  assert.match(run('read_text', { pages: '1-2' }).text, /【第 1 页】\n这是剧本正文[\s\S]*【第 2 页】\n（这一页没有文字层/);
  const view = run('view_page', { page: 2 });
  assert.equal(view.images?.length, 1);
  assert.deepEqual(ws.seen, [2]);
  assert.match(run('view_page', { page: 9 }).text, /页码 9 不存在/);

  const saved = run('save_image', { page: 2, left: 0, top: 0, right: 500, bottom: 500, kind: 'map', visibility: 'keeper', title: '一楼', description: '三个房间' });
  assert.equal(saved.images?.length, 1, '保存后把裁好的图给模型确认');
  assert.equal(saved.activity, '保存了一张地图', '进度里不显示标题，避免剧透');
  const asset = ws.assets[0];
  assert.ok(fs.existsSync(asset.file));
  assert.equal(asset.width, 300);
  run('adjust_image', { id: asset.id, left: 0, top: 0, right: 1000, bottom: 1000 });
  assert.equal(ws.assets[0].width, 600);
  run('delete_image', { id: asset.id });
  assert.equal(ws.assets.length, 0);
  assert.ok(!fs.existsSync(asset.file));
  assert.match(execTool(ws, { id: 'x', name: 'read_text', arguments: '{坏的' }).text, /不是合法的 JSON/);
});

test('预设调查员：没写的技能用基础值，中文别名能对上', () => {
  const s = pregenSheet(
    { name: '哈维', occupation: '记者', age: 28, characteristics: { STR: 50, CON: 60, SIZ: 70, DEX: 55, APP: 60, INT: 75, POW: 65, EDU: 80 }, luck: 45, skills: { 侦查: 65, 图书馆: 70, 自创技能: 30 }, hp: 13 },
    '1920s',
  );
  assert.equal(s.skills['侦查'], 65);
  assert.equal(s.skills['图书馆使用'], 70);
  assert.equal(s.skills['自创技能'], 30);
  assert.ok(s.skills['聆听'] > 0, '没写的技能有基础值');
  assert.equal(s.hp.max, 13);
  assert.equal(s.mp.max, 13); // POW 65 / 5
  assert.equal(s.luck, 45);
});

test('旧图片会被换成一句说明，只保留最近两条', () => {
  const img = (n: number): AgentMessage => ({ role: 'user', content: [{ type: 'text', text: `第 ${n} 页：` }, { type: 'image_url', image_url: { url: 'data:x' } }] });
  const msgs: AgentMessage[] = [{ role: 'system', content: 's' }, img(1), img(2), img(3), img(4), img(5), img(6)];
  compactImages(msgs);
  const withImages = msgs.filter((m) => Array.isArray(m.content));
  assert.equal(withImages.length, 2);
  assert.match(msgs[1].content as string, /第 1 页：\n（这张图片已省略/);
  const few: AgentMessage[] = [img(1), img(2), img(3)];
  compactImages(few);
  assert.equal(few.filter((m) => Array.isArray(m.content)).length, 3, '图片不多时不压缩（少破坏提示缓存）');
});

test('整理助手（模拟模型）：分类、看图片页、保存地图和手出物、写入结果', async () => {
  const ws = workspace([{ text: LONG }, { text: LONG }, { text: '', images: 1 }, { text: '图', images: 2 }, { text: '', images: 1 }]);
  const { log, hooks: h } = hooks();
  await runScriptAgent(ws, { baseUrl: 'mock', apiKey: '', model: 'mock/fast', signal: new AbortController().signal, hooks: h });
  assert.equal(ws.fields.title, '模拟 PDF 剧本');
  assert.ok(ws.fields.keeper_brief);
  assert.deepEqual(ws.seen.sort(), [3, 4, 5]);
  assert.deepEqual(ws.assets.map((a) => [a.kind, a.visibility]), [['map', 'keeper'], ['handout', 'player']]);
  assert.equal(ws.pregens[0].name, '模拟调查员');
  assert.ok(log.includes('查看第 3 页') && log.includes('整理完成'));
  assert.ok(!log.some((l) => l.includes('模拟剪报')), '进度里没有手出物的标题');

  const r = assemble(ws);
  assert.equal(r.title, '模拟 PDF 剧本');
  assert.equal(r.era, '1920s');
  assert.match(r.secret, /【守秘人速览/);
  assert.match(r.secret, /【译名表/);
  assert.match(r.secret, /【第 1 页】/);
  assert.match(r.secret, /【第 3 页】\n（图片页转写）/, '地图页的转写交给守秘人');
  assert.doesNotMatch(r.secret, /【第 5 页】/, '插图页默认不交给守秘人');
  assert.deepEqual(r.pages?.map((p) => p.category), ['scenario', 'scenario', 'map', 'handout', 'art']);
  assert.equal(r.assets?.length, 2);
  assert.equal((r.assets![0] as { file?: string }).file, undefined, '不把磁盘路径交给前端');
  // 不排除插图以后，第 5 页（没有文字）仍然没有内容，不会出现空页
  assert.doesNotMatch(assemble(ws, []).secret, /【第 5 页】/);
});

test('模型不支持工具调用时改用逐页识别', async () => {
  const ws = workspace([{ text: LONG }, { text: '', images: 1 }, { text: '', images: 1 }]);
  const { log, hooks: h } = hooks();
  await runScriptAgent(ws, { baseUrl: 'mock', apiKey: '', model: 'mock/notools', signal: new AbortController().signal, hooks: h });
  assert.equal(ws.fallback, true);
  assert.ok(log[0].includes('改用逐页识别'));
  assert.equal(ws.fields.title, '模拟固定流程剧本');
  assert.equal(ws.assets.length, 2);
  assert.equal(ws.pages[0].category, 'rules', '汇总时列出的跳过页');
  assert.match(assemble(ws).warning ?? '', /简化流程/);
});

test('导入任务：上传、后台整理、进度、结果、拷贝图片', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-imports-'));
  const mgr = new ImportManager(root);
  const job = mgr.create('Haunting.pdf', 3);
  assert.throws(() => mgr.start(job.id, { baseUrl: 'mock', apiKey: '', model: 'mock/fast' }), /还有 3 页没有上传完/);
  mgr.savePage(job.id, 1, LONG, 0, pageJpeg());
  mgr.savePage(job.id, 2, '', 1, pageJpeg());
  mgr.savePage(job.id, 3, '', 1, pageJpeg());
  assert.equal(mgr.get(job.id).uploaded, 3);
  mgr.start(job.id, { baseUrl: 'mock', apiKey: '', model: 'mock/fast' });
  assert.equal(mgr.get(job.id).status, 'running');
  for (let i = 0; i < 200 && mgr.get(job.id).status === 'running'; i++) await sleep(25);
  const p = mgr.get(job.id);
  assert.equal(p.status, 'done', p.error);
  assert.equal(p.checklist.imagePagesSeen, 2);
  assert.equal(p.checklist.maps, 1);
  assert.ok(p.usage.input > 0);
  assert.ok(p.result?.importId === job.id);

  // 调整交给守秘人的页面
  const withArt = mgr.assemble(job.id, []);
  assert.deepEqual(withArt.excluded, []);

  // 服务重启后还能读到
  const again = new ImportManager(root);
  assert.equal(again.get(job.id).status, 'done');
  const dest = path.join(root, 'room-assets');
  const { assets, pregens } = again.takeAssets(job.id, dest);
  assert.equal(assets.length, 2);
  assert.ok(fs.existsSync(path.join(dest, `${assets[0].id}.jpg`)));
  assert.equal(pregens?.length, 1);
});

test('导入任务可以取消', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-imports-'));
  const mgr = new ImportManager(root);
  const job = mgr.create('a.pdf', 2);
  mgr.savePage(job.id, 1, LONG, 0, pageJpeg());
  mgr.savePage(job.id, 2, '', 1, pageJpeg());
  mgr.start(job.id, { baseUrl: 'mock', apiKey: '', model: 'mock/fast' });
  await sleep(50);
  mgr.cancel(job.id);
  for (let i = 0; i < 100 && mgr.get(job.id).status === 'running'; i++) await sleep(20);
  assert.equal(mgr.get(job.id).status, 'cancelled');
});

test('一步最多看 6 张图片，多出来的请模型下一步再看', async () => {
  const ws = workspace(Array.from({ length: 9 }, () => ({ text: '', images: 1 })));
  let step = 0;
  const imagesPerRequest: number[] = [];
  const fake = async (opts: { messages: AgentMessage[] }) => {
    const last = opts.messages.at(-1)!;
    if (Array.isArray(last.content)) imagesPerRequest.push(last.content.filter((p) => p.type === 'image_url').length);
    step++;
    // 第一步一次要看 9 页，第二步写完并结束
    const calls =
      step === 1
        ? Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, name: 'view_page', arguments: JSON.stringify({ page: i + 1 }) }))
        : [
            { id: 'w1', name: 'write', arguments: JSON.stringify({ field: 'intro', content: 'x' }) },
            { id: 'w2', name: 'write', arguments: JSON.stringify({ field: 'keeper_brief', content: 'y' }) },
            { id: 'f', name: 'finish', arguments: '{}' },
          ];
    return { content: '', toolCalls: calls, message: { role: 'assistant' as const, content: null, tool_calls: calls } };
  };
  await runScriptAgentWith(fake as never, ws, { baseUrl: 'x', apiKey: '', model: 'm', signal: new AbortController().signal, hooks: hooks().hooks });
  assert.deepEqual(imagesPerRequest, [6], '第二次请求里只带了 6 张图片');
  assert.equal(ws.seen.length, 6, '多出来的 3 页不算看过');
});
