// OpenAI 兼容接口的流式调用（Magpie、各家 API、本地模型都能用）

import type { ModelInfo, TokenUsage } from '../shared/types.ts';
import { estimateTokens } from './context.ts';

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
  /** 思考强度，作为 reasoning_effort 发送；空则不发送 */
  reasoningEffort?: string;
  /**
   * 会话 id，作为 X-Magpie-Session 发送。Magpie 靠它认出同一段对话，把后续请求留在同一个账号上，
   * 服务商那边缓存的提示词才能被复用。
   */
  sessionId?: string;
  signal?: AbortSignal;
  /** 等第一段内容最多多久（毫秒），默认 3 分钟：推理模型可能要先想一会儿 */
  firstTokenTimeoutMs?: number;
  /** 两段内容之间最多隔多久（毫秒），默认 90 秒 */
  idleTimeoutMs?: number;
}

export interface ChatChunk {
  content?: string;
  reasoning?: string;
  usage?: TokenUsage;
  /** 结束原因：stop / length（达到输出上限）/ content_filter；流没有正常结束时为 incomplete */
  finish?: string;
}

/** 不接受 stream_options 的服务（报错过一次就记住，之后不再发送） */
const noStreamOptions = new Set<string>();

/** 把各家的 usage 字段统一起来：OpenAI、DeepSeek、Anthropic 风格都认 */
export function parseUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const num = (...vals: unknown[]) => vals.find((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const input = num(u.prompt_tokens, u.input_tokens);
  const output = num(u.completion_tokens, u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const usage: TokenUsage = { input: input ?? 0, output: output ?? 0 };
  const cached = num(
    u.prompt_tokens_details?.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.cache_read_input_tokens,
    u.input_tokens_details?.cached_tokens,
    u.cached_tokens,
  );
  if (cached !== undefined) usage.cached = cached;
  const reasoning = num(u.completion_tokens_details?.reasoning_tokens, u.output_tokens_details?.reasoning_tokens);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
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

/**
 * 流式对话：逐块产出正文和思考过程。
 * 模型长时间没有任何新内容时自动停止并报错（而不是一直卡着），界面上会出现「重试」。
 */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  const first = opts.firstTokenTimeoutMs ?? 180_000;
  const gap = opts.idleTimeoutMs ?? 90_000;
  const idle = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : idle.signal;
  let timer = setTimeout(() => idle.abort(), first);
  let seen = false;
  try {
    for await (const chunk of streamChatRaw({ ...opts, signal })) {
      if (chunk.content || chunk.reasoning) {
        seen = true;
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), gap);
      }
      yield chunk;
    }
  } catch (err) {
    if (idle.signal.aborted && !opts.signal?.aborted) {
      throw new Error(
        seen
          ? `模型的回复中断了：超过 ${Math.round(gap / 1000)} 秒没有新内容，已自动停止。可以点「重试」。`
          : `模型超过 ${Math.round(first / 1000)} 秒没有任何回应，已自动停止。可以点「重试」再试一次。`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function* streamChatRaw(opts: ChatOptions): AsyncGenerator<ChatChunk> {
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
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  // 请服务商在流的最后报告用量（包括缓存命中），否则很多服务在流式输出时根本不报
  const baseKey = opts.baseUrl.trim();
  if (!noStreamOptions.has(baseKey)) body.stream_options = { include_usage: true };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey || 'magpie-ai-chat'}`,
    'User-Agent': USER_AGENT,
  };
  if (opts.sessionId) headers['X-Magpie-Session'] = opts.sessionId;

  const send = async () => {
    try {
      return await fetch(endpoint(opts.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      throw describeFetchError(err, opts.baseUrl);
    }
  };
  let res = await send();
  if (!res.ok && res.status === 400 && body.stream_options) {
    const err = await readError(res);
    if (!/stream_options|include_usage/i.test(err.message)) throw err;
    // 这个服务不认 stream_options：记住它，去掉后重发
    noStreamOptions.add(baseKey);
    delete body.stream_options;
    res = await send();
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
    const usage = parseUsage(json?.usage);
    if (usage) yield { usage };
    const finish = json?.choices?.[0]?.finish_reason;
    if (typeof finish === 'string' && finish) yield { finish };
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
    const usage = parseUsage(json?.usage);
    if (usage) out.usage = usage;
    const finish = json?.choices?.[0]?.finish_reason;
    if (typeof finish === 'string' && finish) out.finish = finish;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (typeof delta.content === 'string' && delta.content) {
      const split = splitter.push(delta.content);
      if (split.content) out.content = split.content;
      if (split.reasoning) out.reasoning = (out.reasoning ?? '') + split.reasoning;
    }
    return out.content || out.reasoning || out.usage || out.finish ? out : null;
  };

  let done = false;
  let finished = false;
  try {
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
        if (r?.finish) finished = true;
        if (r) yield r;
      }
    }
    if (!done && pending) {
      const r = handleLine(pending);
      if (r === 'done') done = true;
      else if (r) {
        if (r.finish) finished = true;
        yield r;
      }
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
  // 既没有 [DONE] 也没有结束原因：连接在回复结束前断开了
  if (!done && !finished) yield { finish: 'incomplete' };
}

/** 非流式：把流拼起来返回正文 */
export async function completeChat(opts: ChatOptions): Promise<string> {
  return (await completeChatWithUsage(opts)).text;
}

export async function completeChatWithUsage(opts: ChatOptions): Promise<{ text: string; usage?: TokenUsage }> {
  let text = '';
  let usage: TokenUsage | undefined;
  for await (const chunk of streamChat(opts)) {
    if (chunk.content) text += chunk.content;
    if (chunk.usage) usage = chunk.usage;
  }
  return { text, usage };
}

/** 读取模型列表 */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  if (isMock(baseUrl)) {
    return [
      { id: 'mock/fast', name: '模拟模型（快）', ownedBy: 'mock', reasoning: false, reasoningLevels: [], contextWindow: 128_000 },
      {
        id: 'mock/thinker',
        name: '模拟模型（带思考）',
        ownedBy: 'mock',
        reasoning: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        contextWindow: 200_000,
      },
      { id: 'mock/tiny', name: '模拟模型（上下文很小，测试裁剪用）', ownedBy: 'mock', reasoning: false, reasoningLevels: [], contextWindow: 6_000 },
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
    .filter((m) => typeof m?.id === 'string' && (m.kind === undefined || m.kind === 'chat'))
    .map((m) => parseModel(m))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------- 模型信息缓存（用来查上下文窗口） ----------------

const MODEL_CACHE_TTL = 10 * 60 * 1000;
const modelCache = new Map<string, { at: number; models: Promise<ModelInfo[]> }>();

/** 带缓存的模型列表；读取失败时返回空列表（10 分钟内不再重试，避免每次发言都去请求） */
export function cachedModels(baseUrl: string, apiKey: string, { force = false } = {}): Promise<ModelInfo[]> {
  const hit = modelCache.get(baseUrl);
  if (!force && hit && Date.now() - hit.at < MODEL_CACHE_TTL) return hit.models;
  const models = listModels(baseUrl, apiKey).catch(() => [] as ModelInfo[]);
  modelCache.set(baseUrl, { at: Date.now(), models });
  return models;
}

export function primeModelCache(baseUrl: string, models: ModelInfo[]) {
  modelCache.set(baseUrl, { at: Date.now(), models: Promise.resolve(models) });
}

export async function contextWindowOf(baseUrl: string, apiKey: string, model: string): Promise<number | undefined> {
  const models = await cachedModels(baseUrl, apiKey);
  return models.find((m) => m.id === model)?.contextWindow;
}

/** 解析一条模型信息，兼容 Magpie 的 supported_reasoning_levels / reasoning_levels */
export function parseModel(m: any): ModelInfo {
  const info: ModelInfo = { id: m.id };
  const name = m.display_name ?? m.name;
  if (typeof name === 'string' && name) info.name = name;
  if (typeof m.owned_by === 'string') info.ownedBy = m.owned_by;
  if (typeof m.reasoning === 'boolean') info.reasoning = m.reasoning;
  let levels: unknown[] | undefined;
  if (Array.isArray(m.supported_reasoning_levels)) {
    levels = m.supported_reasoning_levels.map((x: any) => (typeof x === 'string' ? x : x?.effort));
  } else if (Array.isArray(m.reasoning_levels)) {
    levels = m.reasoning_levels;
  }
  if (levels) {
    info.reasoningLevels = [...new Set(levels.filter((x): x is string => typeof x === 'string' && x !== ''))];
  }
  const ctx = m.context_window ?? m.context_length;
  if (typeof ctx === 'number' && ctx > 0) info.contextWindow = ctx;
  return info;
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

const mockLastPrompt = new Map<string, string>();

async function* mockStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  // 测试用：一个总是出错的模型
  if (opts.model === 'mock/broken') throw new Error('模拟的服务错误');
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (lastUser.includes('【构思任务】')) yield* mockPlan(opts, lastUser);
  else {
    // 构思 / 执笔：执笔模型照着构思写
    if (lastUser.includes('【本轮构思】')) yield { content: '（照构思执笔）' };
    yield* mockReply(opts);
  }
  const prompt = opts.messages.map((m) => `<${m.role}>${m.content}`).join('\n');
  const key = opts.sessionId ?? '';
  const prev = mockLastPrompt.get(key) ?? '';
  mockLastPrompt.set(key, prompt);
  let common = 0;
  while (common < prev.length && common < prompt.length && prev[common] === prompt[common]) common++;
  const input = estimateTokens(prompt);
  yield { usage: { input, output: 60, cached: key ? Math.floor(estimateTokens(prompt.slice(0, common)) / 64) * 64 : 0 } };
}

/** 模拟构思模型：给出要点和指令 */
async function* mockPlan(opts: ChatOptions, last: string): AsyncGenerator<ChatChunk> {
  const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
  const kp = system.includes('跑团的守秘人');
  const cmds = !kp
    ? ''
    : last.includes('请开场')
      ? '[NPC:老船夫:撑乌篷船的老汉，沉默寡言，警告你天黑后别去镇中心的井边]'
      : last.includes('【骰子】')
        ? '[线索:雾中的歌声:码头附近能隐约听到女人哼唱的歌声，像是从镇中心传来]'
        : '[检定:侦查]';
  const text = [
    '（模拟构思）',
    '- 要点：回应上一句，推进一步，不替别人做决定',
    '- 语气：自然，篇幅中等',
    kp ? `指令：${cmds}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  for (const ch of Array.from(text)) {
    await sleep(4, opts.signal);
    yield { content: ch };
  }
}

async function* mockReply(opts: ChatOptions): AsyncGenerator<ChatChunk> {
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

  // 模拟剧本整理（不会给出任何剧情内容）
  if (system.includes('剧本整理助手')) {
    await sleep(200, opts.signal);
    const firstLine = last.replace(/^剧本原文如下：\s*/, '').split('\n').find((l) => l.trim()) ?? '模拟剧本';
    yield {
      content: `【标题】\n${firstLine.trim().slice(0, 20)}\n【时代背景】\n1920 年代，模拟的地点\n【玩家简介】\n（模拟简介）你受朋友之托前来调查一件怪事。\n【开团须知】\n推荐 2~4 人\n游玩时长约 2 小时\n【守秘人速览】\n（模拟速览）这里是只有守秘人能看的提纲。`,
    };
    return;
  }

  // 跑团：模拟守秘人、AI 队友和规则助手
  if (system.includes('跑团的守秘人')) {
    // 测试用：按剧本修正成功线的检定
    if (last.includes('测试修正')) {
      const text = '（模拟守秘人）手包被压在沉重的行李箱底下，能不能完整抽出来全看运气。[检定:幸运:-1d20]';
      for (const ch of Array.from(text)) {
        await sleep(6, opts.signal);
        yield { content: ch };
      }
      return;
    }
    // 测试用：模拟守秘人串身份，替 AI 队友说话
    if (last.includes('测试串身份')) {
      const mate = system.match(/AI 队友「([^」]+)」/)?.[1] ?? '队友';
      const text = `【${mate}（AI 队友）】：（我站起身）这里不安全，我们先找地方住下吧。\n\n（模拟守秘人）夜色彻底沉了下来，浓雾贴着门缝渗进茶馆。周婶开始收拾碗筷，准备打烊。你们打算怎么安顿？`;
      for (const ch of Array.from(text)) {
        await sleep(12, opts.signal);
        yield { content: ch };
      }
      return;
    }
    const afterRoll = last.includes('【骰子】');
    const opening = last.includes('请开场');
    const text = opening
      ? '（模拟守秘人）傍晚，乌篷船靠上了白水镇的码头，雾气像湿棉花一样裹住了整个小镇。船夫压低声音说："天黑以后，别去镇中心的井边。"你打算怎么做？[NPC:老船夫:撑乌篷船的老汉，沉默寡言，警告你天黑后别去镇中心的井边][备忘:伏笔:老船夫年轻时参加过祭井，知道井下水道的入口]'
      : afterRoll
        ? '（模拟守秘人）根据骰子的结果，你注意到了一些不寻常的东西……雾里似乎传来若有若无的歌声。你接下来要做什么？[线索:雾中的歌声:码头附近能隐约听到女人哼唱的歌声，像是从镇中心传来]'
        : '（模拟守秘人）你仔细打量四周，似乎有什么东西藏在暗处。\n\n【规则小贴士】需要用「侦查」来发现隐藏的东西。[检定:侦查]';
    for (const ch of Array.from(text)) {
      await sleep(8, opts.signal);
      yield { content: ch };
    }
    return;
  }
  if (system.includes('扮演 AI 调查员')) {
    await sleep(100, opts.signal);
    yield { content: '（模拟队友）我跟在你后面，帮你留意周围的动静。' };
    return;
  }
  if (system.includes('规则助手')) {
    await sleep(150, opts.signal);
    yield {
      content: last.includes('3 个')
        ? '1. 我去茶馆打听沈怀瑾的消息\n2. 我仔细检查码头附近有没有可疑的痕迹\n3. 我询问船夫为什么不能去井边'
        : '（模拟规则助手）检定就是掷 1d100，结果小于等于技能值就算成功。数字越小越好！',
    };
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
