// OpenAI 兼容接口的流式调用（Magpie、各家 API、本地模型都能用）

import type { ModelInfo } from '../shared/types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatChunk {
  content?: string;
  reasoning?: string;
}

const USER_AGENT = 'ai-chat/0.1';

export const isMock = (baseUrl: string) => baseUrl.trim().toLowerCase() === 'mock';

function endpoint(baseUrl: string, path: string) {
  return baseUrl.trim().replace(/\/+$/, '') + path;
}

/** 把网络错误翻译成人能看懂的话 */
function describeFetchError(err: unknown, baseUrl: string): Error {
  if (err instanceof Error && err.name === 'AbortError') return err;
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } })?.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code ?? '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(
      `连接不上模型服务 ${baseUrl}（${code}）。如果用的是 Magpie，请确认 Magpie 正在运行。`,
    );
  }
  return new Error(`请求模型服务失败：${err instanceof Error ? err.message : String(err)}`);
}

async function readError(res: Response): Promise<Error> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // ignore
  }
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = json?.error?.message ?? json?.message ?? text;
  } catch {
    // 不是 JSON，用原文
  }
  return new Error(`模型服务返回 ${res.status}：${String(detail).slice(0, 500)}`);
}

/**
 * 把内容里的 <think>...</think> 拆成思考过程。
 * 部分开源推理模型（DeepSeek-R1、QwQ 等）会把思考写在正文里，标签可能被切在两个分块之间。
 */
export class ThinkSplitter {
  private buf = '';
  private inThink = false;
  private sawContent = false;

  push(text: string): ChatChunk {
    this.buf += text;
    let content = '';
    let reasoning = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end >= 0) {
          reasoning += this.buf.slice(0, end);
          this.buf = this.buf.slice(end + '</think>'.length);
          this.inThink = false;
          continue;
        }
        const keep = partialTagLength(this.buf, '</think>');
        reasoning += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      const start = this.buf.indexOf('<think>');
      // 只在正文还没开始（前面只有空白）时把 <think> 当作思考标签
      if (start >= 0 && !this.sawContent && this.buf.slice(0, start).trim() === '') {
        this.buf = this.buf.slice(start + '<think>'.length);
        this.inThink = true;
        continue;
      }
      const keep = this.sawContent ? 0 : partialTagLength(this.buf, '<think>');
      const out = this.buf.slice(0, this.buf.length - keep);
      if (out.trim() !== '') this.sawContent = true;
      content += out;
      this.buf = this.buf.slice(this.buf.length - keep);
      break;
    }
    return { content, reasoning };
  }

  flush(): ChatChunk {
    const rest = this.buf;
    this.buf = '';
    return this.inThink ? { reasoning: rest } : { content: rest };
  }
}

/** buf 末尾有多少字符可能是 tag 的开头 */
function partialTagLength(buf: string, tag: string) {
  for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
    if (tag.startsWith(buf.slice(buf.length - n))) return n;
  }
  return 0;
}

/** 流式对话：逐块产出正文和思考过程 */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  if (isMock(opts.baseUrl)) {
    yield* mockStream(opts);
    return;
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  let res: Response;
  try {
    res = await fetch(endpoint(opts.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey || 'magpie-ai-chat'}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw describeFetchError(err, opts.baseUrl);
  }
  if (!res.ok) throw await readError(res);

  const splitter = new ThinkSplitter();
  const contentType = res.headers.get('content-type') ?? '';

  // 有的服务即使要求流式也会直接返回完整 JSON
  if (contentType.includes('application/json')) {
    const json: any = await res.json();
    const msg = json?.choices?.[0]?.message ?? {};
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { reasoning };
    if (typeof msg.content === 'string') {
      yield splitter.push(msg.content);
      yield splitter.flush();
    }
    return;
  }

  if (!res.body) throw new Error('模型服务没有返回内容');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  const handleLine = (line: string): ChatChunk | null | 'done' => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return 'done';
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return null;
    }
    if (json?.error) {
      throw new Error(`模型服务报错：${json.error.message ?? JSON.stringify(json.error)}`);
    }
    const delta = json?.choices?.[0]?.delta ?? {};
    const out: ChatChunk = {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (typeof delta.content === 'string' && delta.content) {
      const split = splitter.push(delta.content);
      if (split.content) out.content = split.content;
      if (split.reasoning) out.reasoning = (out.reasoning ?? '') + split.reasoning;
    }
    return out.content || out.reasoning ? out : null;
  };

  try {
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const r = handleLine(line);
        if (r === 'done') {
          done = true;
          break;
        }
        if (r) yield r;
      }
    }
    if (!done && pending) {
      const r = handleLine(pending);
      if (r && r !== 'done') yield r;
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message.startsWith('模型服务'))) {
      throw err;
    }
    throw describeFetchError(err, opts.baseUrl);
  } finally {
    reader.releaseLock();
  }
  const rest = splitter.flush();
  if (rest.content || rest.reasoning) yield rest;
}

/** 非流式：把流拼起来返回正文 */
export async function completeChat(opts: ChatOptions): Promise<string> {
  let text = '';
  for await (const chunk of streamChat(opts)) {
    if (chunk.content) text += chunk.content;
  }
  return text;
}

/** 读取模型列表 */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  if (isMock(baseUrl)) {
    return [
      { id: 'mock/fast', name: '模拟模型（快）', ownedBy: 'mock' },
      { id: 'mock/thinker', name: '模拟模型（带思考）', ownedBy: 'mock' },
    ];
  }
  let res: Response;
  try {
    res = await fetch(endpoint(baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey || 'magpie-ai-chat'}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw describeFetchError(err, baseUrl);
  }
  if (!res.ok) throw await readError(res);
  const json: any = await res.json();
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return list
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({ id: m.id, name: m.display_name ?? m.name, ownedBy: m.owned_by }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------- 模拟模式 ----------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      },
      { once: true },
    );
  });

const MOCK_LINES = [
  '我觉得这个问题可以换个角度看。',
  '刚才的说法有道理，但我想补充一点。',
  '说实话，我不太同意前面的观点。',
  '如果把时间尺度拉长，结论可能会不一样。',
  '我们不妨先把概念定义清楚。',
  '举个具体的例子也许更好理解。',
];

async function* mockStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
  const name = system.match(/你是「([^」]+)」/)?.[1];
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  // 主持人挑人：直接从候选名单里随机选
  if (system.includes('只输出下一位发言者的名字')) {
    const names = [...last.matchAll(/^- 「([^」]+)」/gm)].map((m) => m[1]);
    await sleep(200, opts.signal);
    yield { content: names[Math.floor(Math.random() * names.length)] ?? '' };
    return;
  }

  if (opts.model.includes('thinker')) {
    for (const piece of ['（模拟思考）', '先看看大家说了什么，', '再想想我的立场。']) {
      await sleep(80, opts.signal);
      yield { reasoning: piece };
    }
  }

  const quoted = last
    .replace(/（现在轮到你「[^」]*」发言）/g, '')
    .trim()
    .split('\n')
    .pop()!
    .replace(/\s+/g, ' ')
    .slice(-40);
  const text =
    `（模拟回复）我是${name ?? '某位 AI'}。` +
    MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)] +
    (quoted ? `针对「…${quoted}」这句，` : '') +
    '这里只是用来测试界面和流程的模拟文字，接上真实模型后就会是真正的对话。';
  for (const ch of Array.from(text)) {
    await sleep(15, opts.signal);
    yield { content: ch };
  }
}
