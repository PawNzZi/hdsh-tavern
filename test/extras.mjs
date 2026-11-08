import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runScript } from '../lib/script.js';
import { runAutomations } from '../lib/automation.js';
import { LlmRunner } from '../lib/llm-runner.js';
import { TavernStore } from '../lib/store.js';

// 1. STscript 子集：变量、管道、注入
{
  const result = runScript('/setvar key=affection 3 | /addvar key=affection 2 | /getvar affection | /inject id=mood 气氛不错。 | /echo 好感={{getvar::affection}}', {
    variables: {},
    injections: []
  });
  assert.equal(result.variables.affection, 5);
  assert.equal(result.output, '5');
  assert.equal(result.injections.length, 1);
  assert.equal(result.injections[0].id, 'mood');
  assert.ok(result.log.some((entry) => entry.type === 'echo'));
  assert.equal(result.changed, true);
}

// 2. Automation：addvar + inject + script
{
  const schema = {
    automations: {
      enter: [
        { action: 'addvar', key: 'affection', value: 2 },
        { action: 'inject', id: 'enter', text: '门开了。' }
      ],
      night: { action: 'script', script: '/setvar key=time 夜里 | /inject id=night 外面很安静。' }
    }
  };
  const result = runAutomations(['enter', 'night'], schema, {
    variables: { affection: 1 },
    injections: []
  });
  assert.equal(result.variables.affection, 3);
  assert.equal(result.variables.time, '夜里');
  assert.equal(result.injections.length, 2);
  assert.deepEqual(result.ran, ['enter', 'night']);
}

// 3. store：swipe 追加/切换/删除、继续追加
{
  const root = path.join(os.tmpdir(), `dsh-tavern-extras-${randomUUID()}`);
  const store = new TavernStore(root);
  const card = {
    name: '甲',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '你好',
    example: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistory: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    extensions: {},
    spec: '',
    specVersion: '',
    book: null
  };
  const character = store.addCharacter(card);
  const chat = store.addChat(character.id);
  const message = store.appendMessage(chat.id, 'assistant', '第一版');
  assert.deepEqual(message.swipes, ['第一版']);
  assert.equal(message.activeSwipe, 0);

  const second = store.appendSwipe(chat.id, message.id, '第二版');
  assert.equal(second.swipes.length, 2);
  assert.equal(second.activeSwipe, 1);
  assert.equal(second.text, '第二版');

  const selected = store.selectSwipe(chat.id, message.id, 0);
  assert.equal(selected.activeSwipe, 0);
  assert.equal(selected.text, '第一版');

  const deleted = store.deleteSwipe(chat.id, message.id, 1);
  assert.equal(deleted.swipes.length, 1);

  const continued = store.appendToMessage(chat.id, message.id, '，然后');
  assert.equal(continued.text, '第一版，然后');
  assert.equal(continued.swipes[0], '第一版，然后');

  fs.rmSync(root, { recursive: true, force: true });
}

// 4. LlmRunner：直接 messages 流式、finish、block-end 兜底
{
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      }
      if (name === 'llm') {
        return {
          async *stream(options) {
            assert.equal(options.provider, 'p');
            assert.equal(options.model, 'm');
            assert.ok(Array.isArray(options.messages));
            yield { type: 'text-delta', index: 0, text: '你' };
            yield { type: 'text-delta', index: 0, text: '好' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        };
      }
      return undefined;
    }
  };
  const runner = new LlmRunner({ ctx, log: () => {} });
  assert.equal(runner.available(), true);
  const deltas = [];
  const result = await runner.complete({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    onDelta: (text) => deltas.push(text)
  });
  assert.equal(result.text, '你好');
  assert.deepEqual(deltas, ['你', '好']);
}

console.log('dsh-tavern extras ok');