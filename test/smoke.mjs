import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TavernStore } from '../lib/store.js';
import { parseCardBuffer } from '../lib/card.js';
import { activateEntries } from '../lib/worldbook.js';

const root = path.join(os.tmpdir(), `dsh-tavern-test-${randomUUID()}`);
const store = new TavernStore(root);

const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '测试角色',
    description: '描述',
    first_mes: '你好',
    tags: ['test'],
    character_book: {
      name: '内嵌世界书',
      entries: [{ key: ['酒馆'], content: '酒馆世界', order: 10 }]
    }
  }
};

const parsed = parseCardBuffer(Buffer.from(JSON.stringify(card)), 'card.json');
assert.equal(parsed.card.name, '测试角色');
assert.equal(parsed.card.book.entries.length, 1);

const character = store.importCard(Buffer.from(JSON.stringify(card)), 'card.json');
assert.equal(character.name, '测试角色');
assert.equal(character.worldIds.length, 1);
assert.equal(store.world(character.worldIds[0]).entries.length, 1);

const chat = store.addChat(character.id);
assert.equal(chat.messages[0].text, '你好');
const world = store.world(character.worldIds[0]);
const active = activateEntries(world.entries, [{ role: 'user', text: '去酒馆' }]);
assert.equal(active.entries.length, 1);
assert.equal(active.entries[0].content, '酒馆世界');

// 最小 PNG tEXt 卡：只需签名、tEXt、IEND，解析器不依赖 IDAT。
const encoded = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
const text = Buffer.from(`chara\u0000${encoded}`, 'latin1');
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('tEXt', text),
  chunk('IEND', Buffer.alloc(0))
]);
const pngCard = parseCardBuffer(png, 'card.png');
assert.equal(pngCard.card.name, '测试角色');
assert.equal(pngCard.source, 'png');

assert.equal(store.deleteCharacter(character.id), true);
assert.equal(store.chats().length, 0);

fs.rmSync(root, { recursive: true, force: true });
console.log('dsh-tavern smoke ok');
