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
        { id: 'deepseek/deepseek-v4', name: undefined, ownedBy: 'deepseek' },
        { id: 'openai/gpt-5', name: 'GPT-5', ownedBy: 'openai' },
      ]);
    },
  );
});
