import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// store.js 在模块加载时读取这个环境变量，必须先设置。
process.env.DSH_TAVERN_HOME = path.join(os.tmpdir(), `dsh-tavern-memroutes-${randomUUID()}`);
const { apply } = await import('../lib/index.js');

function makeCtx() {
  const routes = [];
  const ctx = {
    effect(fn) { fn(); },
    webServer: {
      register(route) { routes.push(route); return () => {}; }
    },
    connection: { requestRejection() { return undefined; } },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'llm') {
        return {
          async *stream(options) {
            assert.ok(Array.isArray(options.messages));
            assert.ok(options.messages.length > 0);
            yield { type: 'text-delta', index: 0, text: '你好' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        };
      }
      return undefined;
    },
    logger: { info() {} }
  };
  return { ctx, routes };
}

function call(handler, { url, method = 'GET', body }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = {
      url,
      method,
      on(event, callback) {
        if (payload === undefined) return;
        if (event === 'data') callback(payload);
        if (event === 'end') callback();
      },
      destroy() {}
    };
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writableEnded: false,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      write(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined) chunks.push(String(chunk));
        this.writableEnded = true;
        resolve({ status: this.statusCode, body: chunks.join('') });
      }
    };
    Promise.resolve(handler(req, res)).catch((error) => resolve({ status: 0, body: String(error) }));
  });
}

const find = (routes, p) => routes.find((route) => route.path === p);

const { ctx, routes } = makeCtx();
apply(ctx, {
  enabled: true,
  memory: { auto: true, foldTriggerMessages: 8, minFoldMessages: 4, summaryMaxTokens: 200 }
});
console.log('ROUTES', routes.map((route) => route.path).join('|'));
const characters = find(routes, '/tavern/characters');
const chats = find(routes, '/tavern/chats');
const previewRoute = find(routes, '/tavern/prompt/preview');
console.log('PREVIEW', typeof previewRoute, typeof previewRoute?.handler);

const created = await call(characters.handler, {
  url: '/tavern/characters',
  method: 'POST',
  body: { name: '测试角色', firstMes: '你好' }
});
const characterId = JSON.parse(created.body).character.id;

async function newChat() {
  const response = await call(chats.handler, {
    url: '/tavern/chats',
    method: 'POST',
    body: { characterId, userName: '我' }
  });
  return JSON.parse(response.body).chat.id;
}

async function send(chatId, text) {
  const response = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/messages`,
    method: 'POST',
    body: { text, userName: '我', historyLimit: 20, maxTokens: 100 }
  });
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
}

// 手动压缩：13 条消息，保留 4 条 → 折叠 9 条
const chatId = await newChat();
for (let index = 0; index < 6; index += 1) {
  await send(chatId, `第${index}句`);
}
const compacted = await call(chats.handler, {
  url: `/tavern/chats/${chatId}/compact`,
  method: 'POST',
  body: { keep: 4, userName: '我' }
});
assert.equal(compacted.status, 200);
const compactedBody = JSON.parse(compacted.body);
assert.equal(compactedBody.ok, true);
assert.equal(compactedBody.stats.foldedMessages, 9);
assert.equal(compactedBody.memory.summary, '你好');
assert.ok(compactedBody.memory.throughMessageId.length > 0);

// 读取记忆
const memory = await call(chats.handler, { url: `/tavern/chats/${chatId}/memory` });
assert.equal(memory.status, 200);
const memoryBody = JSON.parse(memory.body);
assert.equal(memoryBody.memory.summary, '你好');
assert.equal(memoryBody.memory.sourceMessages, 9);

// App 可以带自己的「历史条数」，服务端按它估算逐字窗口
const narrowed = await call(chats.handler, {
  url: `/tavern/chats/${chatId}/memory?historyLimit=2`
});
assert.equal(JSON.parse(narrowed.body).stats.tail, 2);

// 预览：摘要进 system，逐字历史只剩 4 条
const preview = await call(previewRoute.handler, {
  url: '/tavern/prompt/preview',
  method: 'POST',
  body: { chatId, text: '继续', userName: '我', historyLimit: 20 }
});
const previewBody = JSON.parse(preview.body);
assert.equal(previewBody.prompt.memoryUsed, true);
assert.equal(previewBody.prompt.historyUsed, 4);
assert.ok(previewBody.prompt.system.includes('【剧情记忆】'));

// 手动改摘要
const edited = await call(chats.handler, {
  url: `/tavern/chats/${chatId}/memory`,
  method: 'PUT',
  body: { summary: '手工整理的记忆' }
});
assert.equal(JSON.parse(edited.body).memory.summary, '手工整理的记忆');

// 清除记忆
const cleared = await call(chats.handler, {
  url: `/tavern/chats/${chatId}/memory`,
  method: 'DELETE'
});
assert.equal(JSON.parse(cleared.body).cleared, true);
const afterClear = await call(chats.handler, { url: `/tavern/chats/${chatId}/memory` });
assert.equal(JSON.parse(afterClear.body).memory, null);

// 自动压缩：攒够 foldTriggerMessages（8）条未折叠消息后自动触发
const autoChatId = await newChat();
for (let index = 0; index < 15; index += 1) {
  await send(autoChatId, `自动第${index}句`);
}
const autoMemory = await call(chats.handler, { url: `/tavern/chats/${autoChatId}/memory` });
const autoBody = JSON.parse(autoMemory.body);
assert.ok(autoBody.memory, 'auto compaction did not create memory');
assert.ok(autoBody.memory.sourceMessages >= 8);

fs.rmSync(process.env.DSH_TAVERN_HOME, { recursive: true, force: true });
console.log('dsh-tavern memory routes ok');
