import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { listModels, streamChat, ThinkSplitter, type ChatChunk } from './llm.ts';

function splitAll(pieces: string[]) {
  const s = new ThinkSplitter();
  let content = '';
  let reasoning = '';
  for (const piece of [...pieces.map((x) => s.push(x)), s.flush()]) {
    content += piece.content ?? '';
    reasoning += piece.reasoning ?? '';
  }
  return { content, reasoning };
}

test('ThinkSplitter 处理被切开的标签', () => {
  assert.deepEqual(splitAll(['<thi', 'nk>想一想</th', 'ink>答案']), { content: '答案', reasoning: '想一想' });
  assert.deepEqual(splitAll(['\n<think>a</think>\n\nb']), { content: '\n\nb', reasoning: 'a' });
  assert.deepEqual(splitAll(['没有思考']), { content: '没有思考', reasoning: '' });
  // 正文中间出现的 <think> 不当作标签
  assert.deepEqual(splitAll(['正文 <think>x</think>']), { content: '正文 <think>x</think>', reasoning: '' });
  // 结尾的 "<" 不能丢
  assert.deepEqual(splitAll(['a <']), { content: 'a <', reasoning: '' });
});

async function withServer(handler: http.RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.close();
  }
}

test('解析 OpenAI 兼容的 SSE 流，包括 reasoning_content 和跨分块的行', async () => {
  let seenAuth = '';
  let seenBody: any;
  await withServer(
    (req, res) => {
      seenAuth = String(req.headers.authorization);
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const events = [
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { reasoning_content: '先想' } }] },
          { choices: [{ delta: { content: '你' } }] },
          { choices: [{ delta: { content: '好' } }] },
        ];
        const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
        // 故意在一行中间切开
        res.write(text.slice(0, 50));
        setTimeout(() => {
          res.write(text.slice(50));
          res.end();
        }, 20);
      });
    },
    async (baseUrl) => {
      const chunks: ChatChunk[] = [];
      for await (const c of streamChat({
        baseUrl,
        apiKey: 'magpie-ai-chat',
        model: 'x/y',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
      })) {
        chunks.push(c);
      }
      assert.equal(chunks.map((c) => c.content ?? '').join(''), '你好');
      assert.equal(chunks.map((c) => c.reasoning ?? '').join(''), '先想');
      assert.equal(seenAuth, 'Bearer magpie-ai-chat');
      assert.equal(seenBody.model, 'x/y');
      assert.equal(seenBody.stream, true);
      assert.equal(seenBody.temperature, 0.5);
    },
  );
});

test('错误状态码给出可读的报错', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found' } }));
    },
    async (baseUrl) => {
      await assert.rejects(async () => {
        for await (const _ of streamChat({ baseUrl, apiKey: '', model: 'nope', messages: [] })) {
          // 不会到这里
        }
      }, /404：model not found/);
    },
  );
});

test('连接不上时提示检查 Magpie', async () => {
  // 先占一个端口再关掉，得到一个肯定没人监听的端口
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  await assert.rejects(async () => {
    for await (const _ of streamChat({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: '',
      model: 'x',
      messages: [],
    })) {
      // 不会到这里
    }
  }, /Magpie/);
});

test('读取模型列表（Magpie 的 display_name）', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'openai/gpt-5', display_name: 'GPT-5', owned_by: 'openai' },
            { id: 'deepseek/deepseek-v4', owned_by: 'deepseek' },
          ],
        }),
      );
    },
    async (baseUrl) => {
      const models = await listModels(baseUrl, '');
      assert.deepEqual(models, [
        { id: 'deepseek/deepseek-v4', ownedBy: 'deepseek' },
        { id: 'openai/gpt-5', name: 'GPT-5', ownedBy: 'openai' },
      ]);
    },
  );
});

test('解析各家的用量字段（含缓存命中）', async () => {
  const { parseUsage } = await import('./llm.ts');
  assert.deepEqual(parseUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768 } }), {
    input: 1000,
    output: 50,
    cached: 768,
  });
  // DeepSeek
  assert.deepEqual(parseUsage({ prompt_tokens: 900, completion_tokens: 20, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 }), {
    input: 900,
    output: 20,
    cached: 640,
  });
  // Anthropic 风格 + 思考 token
  assert.deepEqual(
    parseUsage({ input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 0, output_tokens_details: { reasoning_tokens: 30 } }),
    { input: 500, output: 80, cached: 0, reasoning: 30 },
  );
  // 没有缓存字段时 cached 为 undefined（和「命中 0」区分开）
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 2 }), { input: 10, output: 2 });
  assert.equal(parseUsage(null), undefined);
});

test('发送会话 id 和 stream_options，并读出流最后的用量', async () => {
  let headers: http.IncomingHttpHeaders = {};
  let body: any;
  await withServer(
    (req, res) => {
      headers = req.headers;
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1920 } } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    },
    async (baseUrl) => {
      const chunks: ChatChunk[] = [];
      for await (const c of streamChat({ baseUrl, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], sessionId: 'ai-chat-r1-p1' })) {
        chunks.push(c);
      }
      assert.equal(headers['x-magpie-session'], 'ai-chat-r1-p1');
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.deepEqual(chunks.find((c) => c.usage)?.usage, { input: 2000, output: 1, cached: 1920 });
    },
  );
});

test('服务不认 stream_options 时自动去掉重发，之后也不再发送', async () => {
  const bodies: any[] = [];
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const b = JSON.parse(raw);
        bodies.push(b);
        if (b.stream_options) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
      });
    },
    async (baseUrl) => {
      const run = async () => {
        let text = '';
        for await (const c of streamChat({ baseUrl, apiKey: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] })) text += c.content ?? '';
        return text;
      };
      assert.equal(await run(), 'ok');
      assert.equal(await run(), 'ok');
      assert.deepEqual(
        bodies.map((b) => !!b.stream_options),
        [true, false, false],
      );
    },
  );
});

test('识别回复不完整：达到输出上限、连接提前断开', async () => {
  const run = async (body: string) => {
    let finish: string | undefined;
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(body);
      },
      async (baseUrl) => {
        for await (const c of streamChat({ baseUrl, apiKey: '', model: 'm', messages: [] })) if (c.finish) finish = c.finish;
      },
    );
    return finish;
  };
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  assert.equal(await run(ev({ choices: [{ delta: { content: '凤笙，钥' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n'), 'length');
  assert.equal(await run(ev({ choices: [{ delta: { content: '凤笙，钥' } }] })), 'incomplete');
  assert.equal(await run(ev({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'), 'stop');
});

test('模型长时间没有回应时自动停止并报错，而不是一直卡着', async () => {
  const run = async (handler: http.RequestListener, opts: { firstTokenTimeoutMs: number; idleTimeoutMs: number }) => {
    let error = '';
    let text = '';
    await withServer(handler, async (baseUrl) => {
      try {
        for await (const c of streamChat({ baseUrl, apiKey: '', model: 'm', messages: [], ...opts })) text += c.content ?? '';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    });
    return { error, text };
  };
  // 连上了但一直不说话（只发心跳）
  const silent = await run(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const t = setInterval(() => res.write(': ping\n\n'), 50);
      res.on('close', () => clearInterval(t));
    },
    { firstTokenTimeoutMs: 300, idleTimeoutMs: 300 },
  );
  assert.match(silent.error, /没有任何回应.*重试/);

  // 说了一半就停住
  const stalled = await run(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '凤笙，钥' } }] })}\n\n`);
    },
    { firstTokenTimeoutMs: 1000, idleTimeoutMs: 300 },
  );
  assert.equal(stalled.text, '凤笙，钥');
  assert.match(stalled.error, /回复中断了/);
});
