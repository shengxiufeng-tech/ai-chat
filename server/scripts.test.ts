import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEra, cleanText, decodeText, extractScriptText, parseSections, prepareScript } from './scripts.ts';

test('中文 txt：UTF-8 和 GBK 都能读', () => {
  assert.equal(decodeText(Buffer.from('﻿雾锁白水镇', 'utf8')), '雾锁白水镇');
  // 「白水镇」的 GBK 编码
  const gbk = Buffer.from([0xb0, 0xd7, 0xcb, 0xae, 0xd5, 0xf2]);
  assert.equal(decodeText(gbk), '白水镇');
});

test('整理提取出来的文字', () => {
  assert.equal(cleanText('标题\r\n\r\n\r\n\r\n正文  \f第二页　'), '标题\n\n正文\n第二页');
});

test('根据时代描述判断技能列表', () => {
  assert.equal(classifyEra('1920 年代，美国新英格兰'), '1920s');
  assert.equal(classifyEra('民国时期的上海'), '1920s');
  assert.equal(classifyEra('维多利亚时代的伦敦（1890 年代）'), '1920s');
  assert.equal(classifyEra('现代日本，深夜的东京地铁'), 'modern');
  assert.equal(classifyEra('2023 年的大学校园'), 'modern');
  assert.equal(classifyEra(''), '1920s');
});

test('解析分段回答', () => {
  const s = parseSections('前言\n【标题】\n午夜列车\n【时代背景】\n现代\n【玩家简介】\n你上了车。\n【开团须知】\n无\n【守秘人速览】\n秘密内容');
  assert.equal(s['标题'], '午夜列车');
  assert.equal(s['玩家简介'], '你上了车。');
  assert.equal(s['守秘人速览'], '秘密内容');
});

test('读取文本文件；不支持的格式给出提示', async () => {
  assert.equal(await extractScriptText('剧本.txt', Buffer.from('第一行\n\n\n\n第二行')), '第一行\n\n第二行');
  await assert.rejects(() => extractScriptText('剧本.pdf', Buffer.from('')), /另存为 \.docx 或 \.txt/);
  await assert.rejects(() => extractScriptText('剧本.xlsx', Buffer.from('')), /不支持 \.xlsx/);
});

test('整理剧本：玩家能看的部分和守秘人专用的部分分开', async () => {
  const text = '午夜列车\n\n原作者：某某\n改动说明……\n\n真相：一些绝对不能剧透的内容。';
  const r = await prepareScript(text, { baseUrl: 'mock', apiKey: '', model: 'mock/fast', fileName: '午夜列车.doc' });
  assert.equal(r.title, '午夜列车');
  assert.equal(r.era, '1920s');
  assert.match(r.intro, /模拟简介/);
  assert.match(r.playerInfo, /推荐 2~4 人/);
  // 守秘人拿到速览 + 完整原文
  assert.match(r.secret, /守秘人速览/);
  assert.match(r.secret, /绝对不能剧透的内容/);
  // 玩家能看的部分不含原文里的秘密
  for (const field of [r.title, r.eraLabel, r.intro, r.playerInfo]) assert.doesNotMatch(field, /不能剧透/);
  assert.equal(r.chars, text.length);

  // 没有模型时直接用原文，并给出提示
  const plain = await prepareScript(text, { baseUrl: 'mock', apiKey: '', model: '', fileName: '午夜列车.doc' });
  assert.equal(plain.title, '午夜列车');
  assert.match(plain.warning!, /直接使用原文/);
  assert.match(plain.secret, /不能剧透/);
});
