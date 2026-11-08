import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractReplyMeta } from '../lib/reply.js';
import { applyStatusSchema, enrichProgress, normalizeStatusSchema, statusSchemaFor } from '../lib/status.js';
import { TavernStore } from '../lib/store.js';

// 1. 通用状态块：不认具体卡片，也不翻译值
{
  const raw = [
    '正文。',
    '<StatusBlock>',
    'HP: 10',
    'MP：5',
    '- 好感度: small push',
    '</StatusBlock>',
    '<Options>',
    'A. 继续前进',
    'B. 原地休息',
    '</Options>'
  ].join('\n');
  const parsed = extractReplyMeta(raw);
  assert.deepEqual(parsed.statusLines.map((line) => line.label), ['HP', 'MP', '好感度']);
  assert.equal(parsed.statusLines[2].value, 'small push', '默认不翻译值');
  assert.deepEqual(parsed.quickOptions, ['继续前进', '原地休息']);
  assert.ok(!parsed.text.includes('StatusBlock'));
  assert.ok(!parsed.text.includes('Options'));
}

// 2. 中文状态栏 + 中文选项
{
  const parsed = extractReplyMeta('【状态栏】\n等级: 3\n体力：80\n\n【选项】\n1. 去酒馆\n2. 回家');
  assert.deepEqual(parsed.statusLines.map((line) => `${line.label}=${line.value}`), ['等级=3', '体力=80']);
  assert.deepEqual(parsed.quickOptions, ['去酒馆', '回家']);
}

// 3. <Analysis> 只剥离，不当状态；不再有硬编码忽略名单
{
  const parsed = extractReplyMeta('<Analysis>\nTime: 12:00\n郑怡云: 笑了笑\n</Analysis>\n正文。');
  assert.equal(parsed.statusLines.length, 0);
  assert.equal(parsed.text, '正文。');

  // 旧卡显式开启后才解析 Analysis，并可用 schema 忽略字段。
  const schema = normalizeStatusSchema({
    parseAnalysis: true,
    ignoreLabels: ['Time', '郑怡云']
  });
  const legacy = extractReplyMeta('<Analysis>\nTime: 12:00\n郑怡云: 笑了笑\n好感度: +2\n</Analysis>\n正文。', schema);
  assert.deepEqual(legacy.statusLines, [{ label: '好感度', value: '+2' }]);
  assert.equal(legacy.text, '正文。');
}

// 4. 变量补丁：JSONPatch path 末段作为标签
{
  const parsed = extractReplyMeta('<UpdateVariable>[{"op":"replace","path":"/stats/affection","value":12}]</UpdateVariable>');
  assert.deepEqual(parsed.statusLines, [{ label: 'affection', value: '12' }]);
  assert.equal(parsed.text, '（角色只返回了状态更新）');
}

// 5. 卡级 schema：忽略字段 + 值规则 + 去重
{
  const schema = normalizeStatusSchema({
    ignoreLabels: ['Time'],
    valueRules: [
      { label: '攻略阶段', pattern: '.*?([+-]\\d+(?:\\.\\d+)?).*', replacement: '$1' }
    ]
  });
  const lines = applyStatusSchema([
    { label: 'Time', value: '12:00' },
    { label: '攻略阶段', value: '小幅推进 +2' },
    { label: '攻略阶段', value: '+2' },
    { label: '备注', value: '随便写写' }
  ], schema);
  assert.deepEqual(lines.map((line) => `${line.label}=${line.value}`), ['攻略阶段=+2', '备注=随便写写']);
}

// 6. 进度：跨消息累积 + 阶段映射
{
  const schema = normalizeStatusSchema({
    progress: {
      label: '攻略阶段',
      initial: 0,
      stages: [{ name: '陌生', min: 0 }, { name: '熟悉', min: 10 }, { name: '亲近', min: 20 }]
    }
  });
  const history = [
    { role: 'assistant', statusLines: [{ label: '攻略阶段', value: '+4' }] },
    { role: 'user', statusLines: [] },
    { role: 'assistant', statusLines: [{ label: '攻略阶段', value: '+6' }] }
  ];
  const current = [{ label: '攻略阶段', value: '+1' }];
  enrichProgress(current, history, [], schema);
  assert.equal(current[0].value, '11 · 熟悉');

  const absolute = [{ label: '攻略阶段', value: '30 · 亲近' }];
  enrichProgress(absolute, [], [], schema);
  assert.equal(absolute[0].value, '30 · 亲近');
}

// 7. schema 来源：角色扩展 / 世界书 status_schema 条目
{
  const character = { extensions: { hdsh_status: { ignoreLabels: ['Time'] } } };
  const schema = statusSchemaFor(character, []);
  assert.deepEqual(schema.ignoreLabels, ['Time']);

  const worlds = [{
    entries: [{
      comment: 'status_schema',
      keys: [],
      content: JSON.stringify({ ignoreLabels: ['History check'] })
    }]
  }];
  const fromWorld = statusSchemaFor({ extensions: {} }, worlds);
  assert.deepEqual(fromWorld.ignoreLabels, ['History check']);
  assert.equal(statusSchemaFor({ extensions: {} }, []), null);
}

// 8. 世界书 stage_names_overview 自动推导阶段
{
  const schema = normalizeStatusSchema({ progress: { label: '阶段', initial: 0 } });
  const worlds = [{
    entries: [{
      content: 'stage_names_overview:\n  - 陌生 (>= 0)\n  - 熟悉 (>= 10)\n  - 亲近 (>= 20)\nother: 1'
    }]
  }];
  const lines = [{ label: '阶段', value: '+12' }];
  enrichProgress(lines, [], worlds, schema);
  assert.equal(lines[0].value, '12 · 熟悉');
}

// 9. store 读取历史时按卡级 schema 重算
{
  const root = path.join(os.tmpdir(), `dsh-tavern-status-${randomUUID()}`);
  const store = new TavernStore(root);
  const card = {
    name: '状态测试',
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
    extensions: {
      hdsh_status: {
        ignoreLabels: ['Time'],
        progress: {
          label: '好感',
          initial: 0,
          stages: [{ name: '陌生', min: 0 }, { name: '熟悉', min: 5 }]
        }
      }
    },
    spec: '',
    specVersion: '',
    book: null
  };
  const character = store.addCharacter(card);
  const chat = store.addChat(character.id);
  store.appendMessage(chat.id, 'user', '嗨');
  store.appendMessage(chat.id, 'assistant', '回复', {
    statusLines: [{ label: '好感', value: '+6' }, { label: 'Time', value: '12:00' }]
  });
  const reloaded = store.chat(chat.id);
  const last = reloaded.messages[reloaded.messages.length - 1];
  assert.deepEqual(last.statusLines, [{ label: '好感', value: '6 · 熟悉', key: '好感' }]);
  assert.equal(reloaded.variables['好感'], 6);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('dsh-tavern status ok');
