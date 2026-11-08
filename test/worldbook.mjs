import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activateEntries, matchesKey } from '../lib/worldbook.js';
import { buildPrompt, mergePromptOrder, DEFAULT_PROMPT_ORDER } from '../lib/prompt.js';
import { applyVariables, initialVariables, renderVariables, variableSchemaFor } from '../lib/variables.js';
import { TavernStore } from '../lib/store.js';

const random = (value) => () => value;
const msg = (text, role = 'user', speaker = undefined) => ({ role, text, ...(speaker ? { speaker } : {}) });

function entry(overrides = {}) {
  return {
    id: overrides.id ?? `e_${randomUUID()}`,
    keys: ['alpha'],
    content: 'content',
    enabled: true,
    constant: false,
    selective: false,
    selectiveLogic: 0,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    probability: 100,
    useProbability: true,
    caseSensitive: false,
    matchWholeWords: true,
    group: '',
    groupWeight: 100,
    prioritizeInclusion: false,
    scanDepth: 0,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    ...overrides
  };
}

const activate = (entries, messages, options = {}) => activateEntries(entries, messages, {
  messageIndex: messages.length + 1,
  random: random(0.5),
  ...options
});

// 1. 正则 key 与字面 key 都能用
{
  const regex = entry({ id: 're', keys: ['/alpha\\s+beta/i'], content: 'R' });
  const plain = entry({ id: 'pl', keys: ['alpha beta'], content: 'P' });
  const result = activate([regex, plain], [msg('ALPHA BETA')]);
  assert.deepEqual(result.entries.map((item) => item.id).sort(), ['pl', 're']);
  // 扫描默认带说话人前缀，锚定正则应失败；关闭 includeNames 后成功。
  const anchored = entry({ id: 'anchor', keys: ['/^ALPHA BETA$/'], content: 'A' });
  assert.equal(activate([anchored], [msg('ALPHA BETA')]).entries.length, 0);
  assert.equal(activate([anchored], [msg('ALPHA BETA')], { includeNames: false }).entries.length, 1);
  assert.equal(matchesKey('a/b', 'a/b'), true);
}

// 2. selectiveLogic：0 AND_ANY / 1 NOT_ALL / 2 NOT_ANY / 3 AND_ALL
{
  const base = { keys: ['alpha'], secondaryKeys: ['x', 'y'], selective: true };
  const logic = (value, text) => activate([entry({ ...base, selectiveLogic: value })], [msg(text)]).entries.length;
  assert.equal(logic(0, 'alpha x'), 1);
  assert.equal(logic(0, 'alpha'), 0);
  assert.equal(logic(1, 'alpha x'), 1);
  assert.equal(logic(1, 'alpha x y'), 0);
  assert.equal(logic(2, 'alpha x'), 0);
  assert.equal(logic(2, 'alpha'), 1);
  assert.equal(logic(3, 'alpha x y'), 1);
  assert.equal(logic(3, 'alpha x'), 0);
}

// 3. 同一位置内 order 大的排在后面（ST 语义）
{
  const low = entry({ id: 'low', keys: ['alpha'], order: 100, content: 'LOW' });
  const high = entry({ id: 'high', keys: ['alpha'], order: 250, content: 'HIGH' });
  const result = activate([high, low], [msg('alpha')]);
  assert.deepEqual(result.entries.map((item) => item.id), ['low', 'high']);
}

// 4. sticky：激活后持续 N 条，不刷新；结束后进入 cooldown
{
  const e = entry({ id: 'sticky', keys: ['alpha'], sticky: 2 });
  const turn1 = activate([e], [msg('alpha')], { messageIndex: 2 });
  assert.equal(turn1.entries.length, 1);
  assert.equal(turn1.worldState.sticky.stickyUntil, 5);
  const turn2 = activate([e], [msg('nothing')], { messageIndex: 3, worldState: turn1.worldState });
  assert.equal(turn2.entries[0].reason, 'sticky');
  assert.equal(turn2.worldState.sticky.stickyUntil, 5, 'sticky 不能被续期');
  const turn3 = activate([e], [msg('nothing')], { messageIndex: 4, worldState: turn2.worldState });
  assert.equal(turn3.entries[0].reason, 'sticky');
  const turn4 = activate([e], [msg('nothing')], { messageIndex: 5, worldState: turn3.worldState });
  assert.equal(turn4.entries.length, 0);

  const withCooldown = entry({ id: 'sc', keys: ['alpha'], sticky: 2, cooldown: 2 });
  const first = activate([withCooldown], [msg('alpha')], { messageIndex: 2 });
  assert.equal(first.worldState.sc.stickyUntil, 5);
  assert.equal(first.worldState.sc.cooldownUntil, 7);
  assert.equal(activate([withCooldown], [msg('alpha')], { messageIndex: 5, worldState: first.worldState }).entries.length, 0);
  assert.equal(activate([withCooldown], [msg('alpha')], { messageIndex: 6, worldState: first.worldState }).entries.length, 0);
  assert.equal(activate([withCooldown], [msg('alpha')], { messageIndex: 7, worldState: first.worldState }).entries.length, 1);

  const cooldownOnly = entry({ id: 'co', keys: ['alpha'], cooldown: 2 });
  const once = activate([cooldownOnly], [msg('alpha')], { messageIndex: 2 });
  assert.equal(once.worldState.co.cooldownUntil, 5);
  assert.equal(activate([cooldownOnly], [msg('alpha')], { messageIndex: 3, worldState: once.worldState }).entries.length, 0);
  assert.equal(activate([cooldownOnly], [msg('alpha')], { messageIndex: 4, worldState: once.worldState }).entries.length, 0);
  assert.equal(activate([cooldownOnly], [msg('alpha')], { messageIndex: 5, worldState: once.worldState }).entries.length, 1);
}

// 5. delay：聊天至少 N 条才能触发
{
  const e = entry({ id: 'delay', keys: ['alpha'], delay: 3 });
  assert.equal(activate([e], [msg('alpha')], { messageIndex: 1 }).entries.length, 0);
  assert.equal(activate([e], [msg('alpha')], { messageIndex: 3 }).entries.length, 0);
  assert.equal(activate([e], [msg('alpha')], { messageIndex: 4 }).entries.length, 1);
}

// 6. 递归、excludeRecursion、preventRecursion、delayUntilRecursion
{
  const a = entry({ id: 'a', keys: ['alpha'], content: 'beta' });
  const b = entry({ id: 'b', keys: ['beta'], content: 'B' });
  assert.equal(activate([a, b], [msg('alpha')]).entries.length, 2);

  const aPrevent = entry({ id: 'a', keys: ['alpha'], content: 'beta', preventRecursion: true });
  assert.equal(activate([aPrevent, b], [msg('alpha')]).entries.length, 1);

  const bExclude = entry({ id: 'b', keys: ['beta'], content: 'B', excludeRecursion: true });
  assert.equal(activate([a, bExclude], [msg('alpha')]).entries.length, 1);

  const bDelayed = entry({ id: 'b', keys: ['beta'], content: 'B', delayUntilRecursion: 1 });
  const delayed = activate([a, bDelayed], [msg('alpha')]);
  assert.equal(delayed.entries.length, 2);
  assert.equal(delayed.entries.find((item) => item.id === 'b').reason, 'recursion');

  const bDelayed2 = entry({ id: 'b2', keys: ['beta'], content: 'B2', delayUntilRecursion: 2 });
  const delayed2 = activate([a, bDelayed2], [msg('alpha')], { recursionDepth: 2 });
  assert.equal(delayed2.entries.length, 2);
  assert.equal(delayed2.entries.find((item) => item.id === 'b2').recursionDepth, 2);
}

// 7. 扫描带说话人前缀
{
  const nameOnly = entry({ id: 'name', keys: ['Alice'], content: 'A' });
  assert.equal(activate([nameOnly], [msg('hello', 'assistant')], { characterName: 'Alice' }).entries.length, 1);
  assert.equal(activate([nameOnly], [msg('hello', 'assistant')], { characterName: 'Alice', includeNames: false }).entries.length, 0);
  assert.equal(activate([nameOnly], [msg('hi', 'assistant', 'Bob')], { characterName: 'Alice' }).entries.length, 0);
  assert.equal(activate([nameOnly], [msg('hi', 'assistant', 'Alice')], { characterName: 'Alice' }).entries.length, 1);
}

// 8. 分组：加权随机、prioritizeInclusion 按 order
{
  const light = entry({ id: 'light', group: 'g', groupWeight: 1, content: 'L' });
  const heavy = entry({ id: 'heavy', group: 'g', groupWeight: 3, content: 'H' });
  const low = activate([light, heavy], [msg('alpha')], { random: random(0.1) });
  const high = activate([light, heavy], [msg('alpha')], { random: random(0.9) });
  assert.equal(low.entries[0].id, 'light');
  assert.equal(high.entries[0].id, 'heavy');

  const p1 = entry({ id: 'p1', group: 'g', prioritizeInclusion: true, order: 10 });
  const p2 = entry({ id: 'p2', group: 'g', prioritizeInclusion: true, order: 20 });
  assert.equal(activate([p1, p2], [msg('alpha')]).entries[0].id, 'p2');
}

// 9. 预算：放不下的条目跳过，truncated 标记
{
  const big = entry({ id: 'big', keys: ['alpha'], order: 200, content: 'x'.repeat(120) });
  const small = entry({ id: 'small', keys: ['alpha'], order: 100, content: 'y'.repeat(30) });
  const result = activate([big, small], [msg('alpha')], {
    maxTokens: 100,
    maxChars: 1000,
    countTokens: (value) => String(value).length
  });
  assert.deepEqual(result.entries.map((item) => item.id), ['small']);
  assert.equal(result.truncated, true);
}

// 10. prompt：position 0-5 都注入，@D 带 role，postHistory 在最后
{
  const character = {
    name: '小鲸',
    description: 'DESC',
    personality: 'PERSON',
    scenario: 'SCENE',
    systemPrompt: 'SYS',
    example: 'EXAMPLE',
    postHistory: 'POST_HISTORY'
  };
  const worlds = [{
    entries: [
      entry({ id: 'p0', keys: [], constant: true, position: 0, content: 'POS0' }),
      entry({ id: 'p1', keys: [], constant: true, position: 1, content: 'POS1' }),
      entry({ id: 'p2', keys: [], constant: true, position: 2, content: 'AN_TOP' }),
      entry({ id: 'p3', keys: [], constant: true, position: 3, content: 'AN_BOTTOM' }),
      entry({ id: 'p4', keys: [], constant: true, position: 4, depth: 0, role: 1, content: 'DEPTH' }),
      entry({ id: 'p5', keys: [], constant: true, position: 5, content: 'EX_BEFORE' }),
      entry({ id: 'p6', keys: [], constant: true, position: 6, content: 'EX_AFTER' })
    ]
  }];
  const chat = { messages: [msg('hello', 'user')], worldState: {} };
  const built = buildPrompt(character, worlds, chat, 'next', '用户', { promptOrder: [] });
  for (const marker of ['【世界书·角色前】', '【世界书·角色后】', '【世界书·示例前】',
    '【世界书·示例后】', '【世界书·作者注上】', '【世界书·作者注下】']) {
    assert.ok(built.system.includes(marker), `missing ${marker}`);
  }
  assert.ok(built.user.includes('【世界书·深度0·user】'));
  assert.ok(built.user.indexOf('【输出要求】') > built.user.indexOf('【用户】'));
  assert.ok(built.messages.length >= 3);
  assert.equal(built.messages[0].role, 'system');
  assert.ok(built.messages.some((message) => message.role === 'user'));
  assert.equal(built.activated.length, 7);
  assert.equal(built.activated.find((item) => item.id === 'p4').role, 1);

  const before = built.system.indexOf('【世界书·角色前】');
  const desc = built.system.indexOf('【角色描述】');
  assert.ok(before >= 0 && before < desc, 'worldBefore 应在角色描述之前');
}

// 11. 旧 App 的 9 项顺序会被补齐，postHistory 不再进 system
{
  const merged = mergePromptOrder([
    'main', 'characterDescription', 'characterPersonality', 'scenario',
    'systemPrompt', 'worldBefore', 'worldAfter', 'examples', 'postHistory'
  ]);
  for (const id of ['examplesBefore', 'examplesAfter', 'authorTop', 'authorBottom', 'worldBefore', 'personaDescription']) {
    assert.ok(merged.includes(id), `missing ${id}`);
  }
  assert.ok(!merged.includes('postHistory'));
  assert.ok(merged.indexOf('examplesBefore') < merged.indexOf('examples'));
  assert.ok(merged.indexOf('examples') < merged.indexOf('examplesAfter'));
  assert.deepEqual(mergePromptOrder([]), DEFAULT_PROMPT_ORDER);
}

// 11.1 Persona 与上下文预算
{
  const character = { name: '甲', description: 'D', postHistory: '' };
  const chat = { messages: [], worldState: {} };
  const built = buildPrompt(character, [], chat, '你好', '我', { promptOrder: [], persona: '我是测试用户' });
  assert.ok(built.system.includes('【用户设定】'));
  assert.ok(built.system.includes('我是测试用户'));

  const withDepth = buildPrompt({
    ...character,
    extensions: { depth_prompt: { prompt: '角色深度提示内容', depth: 1, role: 2 } }
  }, [], { messages: [{ role: 'assistant', text: '上一条' }], worldState: {} }, '继续', '我', { promptOrder: [] });
  assert.ok(withDepth.user.includes('【角色深度提示·深度1·assistant】'));
  assert.ok(withDepth.user.includes('角色深度提示内容'));

  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', text: '这是一段很长的历史消息'.repeat(20) });
  }
  const longChat = { messages, worldState: {} };
  const trimmed = buildPrompt(character, [], longChat, '继续', '我', {
    promptOrder: [],
    historyLimit: 24,
    contextTokens: 10,
    countTokens: (value) => String(value).length
  });
  assert.ok(trimmed.historyTrimmed > 0, '应裁剪历史');
  assert.ok(trimmed.historyUsed < 10);
  assert.equal(trimmed.contextTruncated, true);
}

// 12. store：分支保留群聊身份/元数据，删最后一条清世界书计时，删角色清内嵌世界书
{
  const root = path.join(os.tmpdir(), `dsh-tavern-unit-${randomUUID()}`);
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
    book: { name: '书', entries: [] }
  };
  const a = store.addCharacter({ ...card, name: '甲' });
  const b = store.addCharacter({ ...card, name: '乙' });
  assert.equal(store.data.worlds.filter((world) => world.ownerCharacterId === a.id).length, 1);

  const group = store.addGroupChat([a.id, b.id], '群');
  const first = store.appendMessage(group.id, 'assistant', '甲：嗨', { speaker: '甲', quickOptions: ['走'] });
  const second = store.appendMessage(group.id, 'user', '继续');
  const branch = store.branchChat(group.id, second.id);
  assert.equal(branch.isGroup, true);
  assert.deepEqual(branch.characterIds, [a.id, b.id]);
  assert.equal(branch.messages.length, 2);
  assert.equal(branch.messages[0].speaker, '甲');
  assert.deepEqual(branch.messages[0].quickOptions, ['走']);
  assert.equal(branch.worldState.__meta, undefined);

  store.data.chats.find((chat) => chat.id === group.id).worldState = { e1: { stickyUntil: 99 } };
  assert.equal(store.deleteMessage(group.id, second.id), true);
  assert.deepEqual(store.data.chats.find((chat) => chat.id === group.id).worldState, {});

  assert.equal(store.deleteCharacter(a.id), true);
  assert.equal(store.data.worlds.some((world) => world.ownerCharacterId === a.id), false);
  assert.equal(store.data.chats.some((chat) => chat.isGroup === true), false);
  assert.equal(store.data.characters.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// 13. 损坏 data.json 会备份而不是静默覆盖
{
  const root = path.join(os.tmpdir(), `dsh-tavern-corrupt-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'data.json'), '{not json', 'utf8');
  const store = new TavernStore(root);
  assert.equal(store.data.characters.length, 0);
  const backups = fs.readdirSync(root).filter((name) => name.startsWith('data.json.corrupt-'));
  assert.equal(backups.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// 14. Character Filter / Generation Triggers / Automation ID
{
  const filtered = entry({
    id: 'filter',
    keys: ['alpha'],
    characterFilter: { names: ['甲'], tags: ['主角'], isExclude: false }
  });
  assert.equal(activate([filtered], [msg('alpha')], { characterName: '乙' }).entries.length, 0);
  assert.equal(activate([filtered], [msg('alpha')], { characterName: '甲' }).entries.length, 1);
  assert.equal(activate([filtered], [msg('alpha')], { characterName: '乙', characterTags: ['主角'] }).entries.length, 1);

  const excluded = entry({
    id: 'excluded',
    keys: ['alpha'],
    characterFilter: { names: ['甲'], tags: [], isExclude: true }
  });
  assert.equal(activate([excluded], [msg('alpha')], { characterName: '甲' }).entries.length, 0);
  assert.equal(activate([excluded], [msg('alpha')], { characterName: '乙' }).entries.length, 1);

  const triggered = entry({ id: 'trig', keys: ['alpha'], triggers: ['regenerate'] });
  assert.equal(activate([triggered], [msg('alpha')], { generationType: 'normal' }).entries.length, 0);
  assert.equal(activate([triggered], [msg('alpha')], { generationType: 'regenerate' }).entries.length, 1);

  const automated = entry({ id: 'auto', keys: ['alpha'], automationId: 'qr_1' });
  const result = activate([automated], [msg('alpha')]);
  assert.equal(result.entries[0].automationId, 'qr_1');
}

// 15. Min Activations + Max Depth
{
  const e = entry({ id: 'deep', keys: ['needle'], content: 'DEEP' });
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: 'user', text: index === 0 ? 'needle' : `普通消息 ${index}` });
  }
  assert.equal(activate([e], messages, { scanDepth: 2 }).entries.length, 0);
  assert.equal(activate([e], messages, { scanDepth: 2, minActivations: 1, maxDepth: 10 }).entries.length, 1);
  assert.equal(activate([e], messages, { scanDepth: 2, minActivations: 1, maxDepth: 3 }).entries.length, 0);
}

// 16. Outlet + {{outlet::Name}} + 变量
{
  const outlet = entry({
    id: 'outlet',
    keys: [],
    constant: true,
    position: 7,
    outletName: 'Lore',
    content: 'OUTLET_TEXT'
  });
  const variables = [{
    entries: [{
      comment: 'variables',
      keys: [],
      content: JSON.stringify({
        variables: {
          affection: {
            label: '好感度',
            aliases: ['好感'],
            type: 'number',
            initial: 0,
            min: 0,
            max: 100,
            stages: [{ name: '陌生', min: 0 }, { name: '熟悉', min: 10 }]
          }
        }
      })
    }]
  }];
  const character = {
    name: '甲',
    description: 'D',
    systemPrompt: '好感={{getvar::affection}}，设定={{outlet::Lore}}',
    postHistory: ''
  };
  const schema = variableSchemaFor(character, variables);
  const values = applyVariables([{ label: '好感', value: '+12' }], initialVariables(schema), schema);
  assert.equal(values.variables.affection, 12);
  assert.equal(values.lines[0].value, '12 · 熟悉');

  const built = buildPrompt(character, variables.concat([{
    entries: [outlet]
  }]), { messages: [], worldState: {} }, '你好', '我', {
    promptOrder: [],
    variables: values.variables,
    variablesText: renderVariables(values.variables, schema)
  });
  assert.ok(built.system.includes('OUTLET_TEXT'));
  assert.ok(built.system.includes('好感=12'));
  assert.ok(built.system.includes('【当前变量】'));
  assert.ok(built.system.includes('好感度：12 · 熟悉'));

  const simpleWorld = [{
    entries: [{
      comment: 'variables',
      keys: [],
      content: '好感度: 0 (0-100)\n地点: 家'
    }]
  }];
  const simple = variableSchemaFor({}, simpleWorld);
  assert.equal(simple['好感度'].max, 100);
  assert.equal(simple['地点'].initial, '家');
}

console.log('dsh-tavern worldbook/prompt ok');
