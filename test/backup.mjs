import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TavernStore } from '../lib/store.js';
import { exportBackup, importBackup } from '../lib/backup.js';

function card() {
  return {
    name: '备份角色',
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
}

const rootA = path.join(os.tmpdir(), `dsh-tavern-backup-a-${randomUUID()}`);
const rootB = path.join(os.tmpdir(), `dsh-tavern-backup-b-${randomUUID()}`);
try {
  const source = new TavernStore(rootA);
  const world = source.addWorld('备份世界书', [{ comment: '入口', keys: ['酒馆'], content: '酒馆很吵。' }]);
  const character = source.addCharacter(card());
  character.worldIds = [world.id];
  source.save();
  const chat = source.addChat(character.id, '测试聊天');
  source.appendMessage(chat.id, 'user', '你好');

  const bundle = exportBackup(source, {
    characterIds: [character.id],
    chatIds: [chat.id],
    worldIds: [world.id]
  });
  assert.equal(bundle.format, 'hdsh-tavern-backup');
  assert.equal(bundle.characters.length, 1);
  assert.equal(bundle.worlds.length, 1);
  assert.equal(bundle.chats.length, 1);
  assert.equal(bundle.characters[0].avatar, undefined);

  const target = new TavernStore(rootB);
  const result = importBackup(target, bundle);
  assert.equal(result.characters, 1);
  assert.equal(result.worlds, 1);
  assert.equal(result.chats, 1);
  const importedCharacter = target.data.characters[0];
  const importedWorld = target.data.worlds[0];
  const importedChat = target.data.chats[0];
  assert.notEqual(importedCharacter.id, character.id);
  assert.notEqual(importedWorld.id, world.id);
  assert.deepEqual(importedCharacter.worldIds, [importedWorld.id]);
  assert.equal(importedChat.characterId, importedCharacter.id);
  const importedUser = importedChat.messages.find((message) => message.text === '你好' && message.role === 'user');
  assert.equal(importedUser.role, 'user');

  assert.throws(() => importBackup(target, { format: 'wrong' }), /不是有效的酒馆备份文件/);
  console.log('dsh-tavern backup ok');
} finally {
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
}
