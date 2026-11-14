import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TavernStore } from '../lib/store.js';
import { buildPrompt, DEFAULT_PROMPT_ORDER, mergePromptOrder } from '../lib/prompt.js';
import { compactChat, planCompaction, memoryCoveredIndex } from '../lib/memory.js';

const root = path.join(os.tmpdir(), `dsh-tavern-memory-${randomUUID()}`);
process.env.DSH_TAVERN_HOME = path.join(root, 'plugin');

const store = new TavernStore(path.join(root, 'pure'));
const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: '测试角色', description: '描述', first_mes: '你好' }
};
const character = store.importCard(Buffer.from(JSON.stringify(card)), 'card.json');
const countTokens = (text) => Math.ceil(String(text).length / 2);

// 1) 100 轮 = 200 条，historyLimit 20 → 折叠前 180 条、保留最后 20 条
const messages = Array.from({ length: 200 }, (_, index) => ({
  id: `m_${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `第${index}条对话内容，用来测试压缩边界。`
}));
{
  const plan = planCompaction({ messages, historyLimit: 20, memory: null });
  assert.equal(plan.start, 0);
  assert.equal(plan.end, 180);
  assert.equal(plan.foldable, 180);
  assert.equal(plan.tail, 20);
}

// 2) 摘要覆盖到 m_179 后，同一份数据不再重复折叠
{
  const memory = { summary: '摘要', throughMessageId: 'm_179' };
  assert.equal(memoryCoveredIndex(messages, memory), 179);
  const plan = planCompaction({ messages, historyLimit: 20, memory });
  assert.equal(plan.foldable, 0);
}

// 3) 再聊 30 条 → 只折叠新增的 30 条（增量）
{
  const more = messages.concat(Array.from({ length: 30 }, (_, index) => ({
    id: `m_${200 + index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `新增第${index}条。`
  })));
  const plan = planCompaction({
    messages: more,
    historyLimit: 20,
    memory: { summary: '摘要', throughMessageId: 'm_179' }
  });
  assert.equal(plan.start, 180);
  assert.equal(plan.end, 210);
  assert.equal(plan.foldable, 30);
}

// 4) Prompt：摘要进 system，逐字历史只剩最后 20 条，已折叠的不重复出现
{
  const chat = {
    messages,
    memory: { summary: '很早以前，测试角色和用户约好了去看海。', throughMessageId: 'm_179' },
    worldState: {},
    variables: {},
    injects: []
  };
  const prompt = buildPrompt(character, [], chat, '继续', '我', {
    historyLimit: 20,
    memory: chat.memory.summary,
    memoryThroughId: chat.memory.throughMessageId,
    countTokens
  });
  assert.ok(prompt.system.includes('【剧情记忆】'));
  assert.ok(prompt.system.includes('约好了去看海'));
  assert.equal(prompt.memoryUsed, true);
  assert.equal(prompt.historyUsed, 20);
  assert.equal(prompt.historyStart, 180);
  const history = prompt.messages.filter((message) => message.role !== 'system');
  // 20 条逐字历史 + 本轮输入
  assert.equal(history.length, 21);
  assert.ok(history[0].content[0].text.includes('第180条'));
  assert.equal(history[history.length - 1].content[0].text, '继续');
  assert.ok(prompt.messages.every((message) => !JSON.stringify(message).includes('第179条')));
  assert.ok(prompt.messages.some((message) => JSON.stringify(message).includes('第180条')));
}

// 5) Prompt 顺序：新 section 会被旧版 App 的 9 项顺序自动补齐
{
  assert.ok(DEFAULT_PROMPT_ORDER.includes('memory'));
  const merged = mergePromptOrder(['main', 'worldBefore', 'personaDescription', 'characterDescription', 'characterPersonality', 'scenario', 'systemPrompt', 'worldAfter', 'examples']);
  assert.ok(merged.includes('memory'));
  assert.ok(merged.indexOf('memory') > merged.indexOf('worldAfter'));
}

// 6) compactChat：写入 chat.memory，记录覆盖范围与压缩日志
{
  const chat = store.addChat(character.id);
  chat.messages = messages.slice();
  const result = await compactChat({
    chat,
    store,
    historyLimit: 20,
    countTokens,
    userName: '我',
    characterName: '测试角色',
    summarize: async () => '（摘要）用户和测试角色聊了 180 条。',
    mode: 'manual',
    force: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.stats.foldedMessages, 180);
  assert.equal(result.stats.tailMessages, 20);
  assert.equal(chat.memory.throughMessageId, 'm_179');
  assert.equal(chat.memory.sourceMessages, 180);
  assert.equal(chat.memory.summary, '（摘要）用户和测试角色聊了 180 条。');
  assert.equal(chat.memoryLog.length, 1);
  assert.equal(chat.memoryLog[0].mode, 'manual');

  // 7) 增量：再聊 30 条只折叠 30 条，覆盖点前移
  chat.messages = chat.messages.concat(Array.from({ length: 30 }, (_, index) => ({
    id: `m_${200 + index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `新增第${index}条。`
  })));
  const second = await compactChat({
    chat,
    store,
    historyLimit: 20,
    countTokens,
    summarize: async () => '（摘要2）',
    mode: 'auto'
  });
  assert.equal(second.ok, true);
  assert.equal(second.stats.foldedMessages, 30);
  assert.equal(chat.memory.throughMessageId, 'm_209');
  assert.equal(chat.memory.sourceMessages, 210);
  assert.equal(chat.memory.summary, '（摘要2）');
}

// 8) 可折叠条数不足时自动压缩跳过
{
  const chat = store.addChat(character.id);
  chat.messages = messages.slice(0, 6);
  const result = await compactChat({
    chat,
    store,
    historyLimit: 2,
    minFoldMessages: 8,
    countTokens,
    summarize: async () => '不该调用',
    mode: 'auto'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-few');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('dsh-tavern memory ok');
