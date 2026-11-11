import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { AccessControl, newAccessCode, normalizeCode } from './access.ts';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-access-'));
  const access = new AccessControl(dir);
  const app = express();
  app.use(access.middleware);
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.get(/.*/, (_req, res) => res.type('html').send('<div id="root"></div>'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = () => (server.address() as AddressInfo).port;
  // 用 Host 头模拟「不是本机」的请求（和 DNS 重绑定攻击的情形一样）
  const req = (p: string, opts: { host?: string; cookie?: string } = {}) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const headers: Record<string, string> = { host: opts.host ?? 'phone.example' };
      if (opts.cookie) headers.cookie = opts.cookie;
      http
        .get({ host: '127.0.0.1', port: port(), path: p, headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        })
        .on('error', reject);
    });
  return { dir, access, server, req };
}

test('访问码格式：8 位、不含容易看混的字符，输入时忽略大小写和横线', () => {
  const code = newAccessCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
});

test('本机访问不需要访问码', async () => {
  const { server, req } = await setup();
  try {
    assert.equal((await req('/api/ping', { host: `127.0.0.1:1234` })).status, 200);
    assert.equal((await req('/api/ping', { host: 'localhost:8787' })).status, 200);
  } finally {
    server.close();
  }
});

test('其他设备：先输入访问码，之后靠 cookie 记住', async () => {
  const { access, server, req } = await setup();
  try {
    const api = await req('/api/ping');
    assert.equal(api.status, 401);
    assert.equal(JSON.parse(api.body).needCode, true);

    const page = await req('/rooms');
    assert.equal(page.status, 401);
    assert.match(page.body, /输入访问码/);
    assert.doesNotMatch(page.body, /id="root"/);

    const wrong = await req('/?code=AAAA-AAAA');
    assert.equal(wrong.status, 401);
    assert.match(wrong.body, /访问码不对/);

    // 扫码进来：小写、不带横线也行，登录后去掉网址里的访问码
    const ok = await req(`/?code=${normalizeCode(access.accessCode).toLowerCase()}&x=1`);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/?x=1');
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    assert.match(String(ok.headers['set-cookie']), /HttpOnly/);
    assert.equal((await req('/api/ping', { cookie })).status, 200);
    assert.equal((await req('/', { cookie })).status, 200);

    // 重置访问码后，已经登录的设备要重新输入
    access.reset();
    assert.equal((await req('/api/ping', { cookie })).status, 401);
  } finally {
    server.close();
  }
});

test('输错太多次会暂时锁住', async () => {
  const { access, server, req } = await setup();
  try {
    for (let i = 0; i < 7; i++) assert.equal((await req('/?code=ZZZZ-ZZZZ')).status, 401);
    assert.equal((await req('/?code=ZZZZ-ZZZZ')).status, 429);
    // 锁住期间，正确的访问码也不行
    assert.equal((await req(`/?code=${access.accessCode}`)).status, 429);
  } finally {
    server.close();
  }
});

test('访问码保存在数据目录里，重启后不变', async () => {
  const { dir, access, server } = await setup();
  server.close();
  assert.equal(new AccessControl(dir).accessCode, access.accessCode);
  const code = access.reset();
  assert.equal(new AccessControl(dir).accessCode, code);
});
