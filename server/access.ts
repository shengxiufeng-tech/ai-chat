// 局域网访问控制：本机访问不需要密码；手机等其他设备第一次访问要输入访问码（扫码会自动带上），
// 之后浏览器记住一年。访问码保存在数据目录里，重启服务也不会变。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const COOKIE = 'ai_chat_access';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉了容易看混的 0/O、1/I
const MAX_FAILS = 8;
const LOCK_MS = 60_000;

export function newAccessCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 用户输入的访问码：忽略大小写、空格和横线 */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const stripV6 = (addr: string) => addr.replace(/^::ffff:/i, '');

/** 这台电脑自己的 IP 地址（包括 127.0.0.1） */
function ownAddresses(): Set<string> {
  const set = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) set.add(a.address.toLowerCase());
  }
  return set;
}

/** 手机可以用来访问的局域网 IPv4 地址，私有网段排在前面 */
export function lanAddresses(): string[] {
  const list: string[] = [];
  for (const items of Object.values(os.networkInterfaces())) {
    for (const a of items ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) list.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(list)].sort((a, b) => rank(a) - rank(b));
}

/** 请求里的 Host 是否指向这台电脑（防止恶意网页用 DNS 重绑定冒充本机请求） */
function hostIsLocal(hostHeader: string | undefined, own: Set<string>): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || own.has(host)) return true;
  const name = os.hostname().toLowerCase();
  return host === name || host === `${name}.local`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export class AccessControl {
  private file: string;
  private code: string;
  private fails = new Map<string, { count: number; until: number }>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'access.json');
    let code = '';
    try {
      code = JSON.parse(fs.readFileSync(this.file, 'utf8')).code ?? '';
    } catch {
      // 第一次启动
    }
    this.code = normalizeCode(code).length === 8 ? code : this.save(newAccessCode());
  }

  private save(code: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ code }, null, 2));
    return code;
  }

  get accessCode() {
    return this.code;
  }

  /** 换一个新的访问码，已经登录的设备都要重新输入 */
  reset() {
    this.code = this.save(newAccessCode());
    return this.code;
  }

  private token() {
    return crypto.createHash('sha256').update(`ai-chat-access:${normalizeCode(this.code)}`).digest('hex');
  }

  private matches(input: string) {
    const a = Buffer.from(normalizeCode(input));
    const b = Buffer.from(normalizeCode(this.code));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 来自这台电脑本身的请求（浏览器开在本机上） */
  isLocal(req: Request) {
    const own = ownAddresses();
    const remote = stripV6(req.socket.remoteAddress ?? '').toLowerCase();
    return own.has(remote) && hostIsLocal(req.headers.host, own);
  }

  private authed(req: Request) {
    const c = readCookie(req, COOKIE);
    if (!c) return false;
    const a = Buffer.from(c);
    const b = Buffer.from(this.token());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 检查访问码；输错太多次会暂时锁住这台设备 */
  private attempt(req: Request, code: string): 'ok' | 'wrong' | 'locked' {
    const ip = stripV6(req.socket.remoteAddress ?? '');
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.until > now) return 'locked';
    if (this.matches(code)) {
      this.fails.delete(ip);
      return 'ok';
    }
    const count = (f && f.until === 0 ? f.count : 0) + 1;
    this.fails.set(ip, count >= MAX_FAILS ? { count: 0, until: now + LOCK_MS } : { count, until: 0 });
    return count >= MAX_FAILS ? 'locked' : 'wrong';
  }

  private setCookie(res: Response) {
    res.setHeader('Set-Cookie', `${COOKIE}=${this.token()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (this.isLocal(req) || this.authed(req)) return next();

    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (req.method === 'GET' && code !== undefined && !req.path.startsWith('/api/')) {
      const r = this.attempt(req, code);
      if (r === 'ok') {
        this.setCookie(res);
        const url = new URL(req.originalUrl, 'http://x');
        url.searchParams.delete('code');
        return res.redirect(302, url.pathname + url.search);
      }
      return res.status(r === 'locked' ? 429 : 401).type('html').send(loginPage(r === 'locked' ? '输错次数太多，请 1 分钟后再试。' : '访问码不对，请再看一下电脑上显示的访问码。'));
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: '这台设备还没有输入访问码，请刷新页面。', needCode: true });
    }
    if (req.method === 'GET') return res.status(401).type('html').send(loginPage());
    return res.status(401).end();
  };
}

function loginPage(error?: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>AI 对话室 · 输入访问码</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --text:#1b1d24; --muted:#6b7080; --border:#d9dce6; --accent:#5b6cff; --danger:#e5484d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0f14; --card:#161922; --text:#e9ebf2; --muted:#8a90a2; --border:#2a2f3c; --accent:#7c8aff; --danger:#ff6b6b; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; }
  form { width:min(360px,100%); background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px 22px; display:flex; flex-direction:column; gap:14px; }
  h1 { margin:0; font-size:20px; }
  p { margin:0; color:var(--muted); font-size:14px; line-height:1.7; }
  input { font-size:22px; letter-spacing:.12em; text-align:center; text-transform:uppercase; padding:12px; border-radius:12px; border:1px solid var(--border); background:transparent; color:inherit; }
  input:focus { outline:none; border-color:var(--accent); }
  button { font-size:16px; padding:12px; border-radius:12px; border:none; background:var(--accent); color:#fff; font-weight:600; }
  .err { color:var(--danger); }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<form method="get" action="/">
  <h1>💬 AI 对话室</h1>
  <p>这是你电脑上的 AI 对话室。第一次用这台设备访问，需要输入访问码。</p>
  <p>访问码在电脑上运行 <code>npm run lan</code> 的窗口里，也可以在电脑上打开「设置 → 手机访问」查看，扫二维码可以免输入。</p>
  ${error ? `<p class="err">${error}</p>` : ''}
  <input name="code" placeholder="XXXX-XXXX" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" required autofocus>
  <button type="submit">进入</button>
</form>
</body>
</html>`;
}
