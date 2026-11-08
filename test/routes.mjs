import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 必须在动态 import 之前设置，store.js 在模块加载时读取它。
process.env.DSH_TAVERN_HOME = path.join(os.tmpdir(), `dsh-tavern-routes-${randomUUID()}`);
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
    Promise.resolve(handler(req, res)).catch((error) => {
      resolve({ status: 0, body: String(error) });
    });
  });
}

const find = (routes, p) => routes.find((route) => route.path === p);

// 启用状态：health 带 enabled、不含 dataRoot
{
  const { ctx, routes } = makeCtx();
  apply(ctx, { enabled: true });
  const health = find(routes, '/tavern/health');
  assert.ok(health, 'health route missing');
  const result = await call(health.handler, { url: '/tavern/health' });
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.installed, true);
  assert.equal(body.enabled, true);
  assert.equal(body.dataRoot, undefined);
  assert.ok(body.version.length > 0);
}

// 关闭状态：非 health 返回 409，health 仍可读，media 仍放行
{
  const { ctx, routes } = makeCtx();
  apply(ctx, { enabled: false });
  const characters = find(routes, '/tavern/characters');
  assert.ok(characters, 'characters route missing');
  const blocked = await call(characters.handler, { url: '/tavern/characters' });
  assert.equal(blocked.status, 409);
  assert.equal(JSON.parse(blocked.body).error, 'disabled');

  const health = find(routes, '/tavern/health');
  const allowed = await call(health.handler, { url: '/tavern/health' });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).enabled, false);

  const media = find(routes, '/tavern/media');
  assert.ok(media, 'media route missing');
  const missing = await call(media.handler, { url: '/tavern/media/m_00000000-0000-0000-0000-000000000000.png' });
  assert.equal(missing.status, 404);
}

// 完整链路：创建角色/聊天 → 发消息 → swipe → continue → impersonate → script
{
  const { ctx, routes } = makeCtx();
  apply(ctx, { enabled: true });
  const characters = find(routes, '/tavern/characters');
  const chats = find(routes, '/tavern/chats');

  const created = await call(characters.handler, {
    url: '/tavern/characters',
    method: 'POST',
    body: { name: '测试角色', firstMes: '你好' }
  });
  assert.equal(created.status, 201);
  const characterId = JSON.parse(created.body).character.id;

  const chatCreated = await call(chats.handler, {
    url: '/tavern/chats',
    method: 'POST',
    body: { characterId, userName: '我' }
  });
  assert.equal(chatCreated.status, 201);
  const chatId = JSON.parse(chatCreated.body).chat.id;

  const sent = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/messages`,
    method: 'POST',
    body: { text: '嗨', userName: '我', maxTokens: 100 }
  });
  assert.equal(sent.status, 200);
  const sentBody = JSON.parse(sent.body);
  assert.equal(sentBody.reply.text, '你好');
  assert.deepEqual(sentBody.reply.swipes, ['你好']);
  const messageId = sentBody.reply.id;

  const swiped = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/swipe`,
    method: 'POST',
    body: { messageId, count: 1, maxTokens: 100 }
  });
  assert.equal(swiped.status, 200);
  const swipedBody = JSON.parse(swiped.body);
  assert.equal(swipedBody.message.swipes.length, 2);
  assert.equal(swipedBody.message.activeSwipe, 1);

  const selected = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/swipe/select`,
    method: 'POST',
    body: { messageId, index: 0 }
  });
  assert.equal(selected.status, 200);
  assert.equal(JSON.parse(selected.body).message.activeSwipe, 0);

  const continued = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/continue`,
    method: 'POST',
    body: { userName: '我', maxTokens: 100 }
  });
  assert.equal(continued.status, 200);
  assert.ok(JSON.parse(continued.body).message.text.length > '你好'.length);

  const impersonated = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/impersonate`,
    method: 'POST',
    body: { userName: '我', maxTokens: 100 }
  });
  assert.equal(impersonated.status, 200);
  assert.equal(JSON.parse(impersonated.body).message.role, 'user');

  const scripted = await call(chats.handler, {
    url: `/tavern/chats/${chatId}/script`,
    method: 'POST',
    body: { script: '/setvar key=x 1 | /addvar key=x 2 | /getvar x' }
  });
  assert.equal(scripted.status, 200);
  const scriptedBody = JSON.parse(scripted.body);
  assert.equal(scriptedBody.output, '3');
  assert.equal(scriptedBody.variables.x, 3);

  const backupRoute = find(routes, '/tavern/backup');
  assert.ok(backupRoute, 'backup route missing');
  const exported = await call(backupRoute.handler, {
    url: '/tavern/backup/export',
    method: 'POST',
    body: { characterIds: [characterId], chatIds: [chatId], worldIds: [] }
  });
  assert.equal(exported.status, 200);
  const bundle = JSON.parse(exported.body);
  assert.equal(bundle.format, 'hdsh-tavern-backup');
  assert.equal(bundle.characters.length, 1);
  assert.equal(bundle.chats.length, 1);

  const imported = await call(backupRoute.handler, {
    url: '/tavern/backup/import',
    method: 'POST',
    body: { backup: bundle }
  });
  assert.equal(imported.status, 200);
  assert.equal(JSON.parse(imported.body).imported.characters, 1);
  assert.equal(JSON.parse(imported.body).imported.chats, 1);
}

fs.rmSync(process.env.DSH_TAVERN_HOME, { recursive: true, force: true });
console.log('dsh-tavern routes ok');
