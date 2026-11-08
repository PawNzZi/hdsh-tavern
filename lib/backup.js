/**
 * 酒馆数据备份：角色卡、聊天、世界书。
 *
 * 只导出 JSON 结构；角色头像文件不内联（避免备份体积和跨设备路径问题）。
 * 导入时统一重新生成 id，避免覆盖本机已有数据；聊天按角色映射重建。
 */
import { randomUUID } from 'node:crypto';

function strings(value, limit = 1000) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.length > 0).slice(0, limit)
    : [];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function exportBackup(store, { characterIds, chatIds, worldIds } = {}) {
  const wantedCharacters = new Set(strings(characterIds, 2000));
  const wantedChats = new Set(strings(chatIds, 5000));
  const wantedWorlds = new Set(strings(worldIds, 2000));
  const characters = store.data.characters
    .filter((character) => wantedCharacters.has(character.id))
    .map((character) => {
      const copy = clone(character);
      delete copy.avatar;
      return copy;
    });
  const worlds = store.data.worlds
    .filter((world) => wantedWorlds.has(world.id))
    .map((world) => clone(world));
  const chats = store.data.chats
    .filter((chat) => wantedChats.has(chat.id))
    .map((chat) => clone(chat));
  return {
    format: 'hdsh-tavern-backup',
    version: 1,
    exportedAt: Date.now(),
    characters,
    worlds,
    chats
  };
}

function sanitizeCard(card, worldMap) {
  const copy = clone(card);
  delete copy.id;
  delete copy.avatar;
  delete copy.createdAt;
  delete copy.updatedAt;
  copy.book = null;
  copy.worldIds = strings(copy.worldIds, 20)
    .map((id) => worldMap.get(id) ?? '')
    .filter((id) => id.length > 0);
  return copy;
}

export function importBackup(store, bundle) {
  if (bundle === null || typeof bundle !== 'object'
    || bundle.format !== 'hdsh-tavern-backup' || !Array.isArray(bundle.characters)
    || !Array.isArray(bundle.worlds) || !Array.isArray(bundle.chats)) {
    throw new Error('不是有效的酒馆备份文件');
  }
  const worldMap = new Map();
  let worlds = 0;
  for (const raw of bundle.worlds) {
    if (raw === null || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name : '导入的世界书';
    const created = store.addWorld(name, Array.isArray(raw.entries) ? raw.entries : []);
    if (typeof raw.id === 'string' && raw.id.length > 0) worldMap.set(raw.id, created.id);
    worlds += 1;
  }

  const characterMap = new Map();
  let characters = 0;
  for (const raw of bundle.characters) {
    if (raw === null || typeof raw !== 'object') continue;
    const clean = sanitizeCard(raw, worldMap);
    const created = store.addCharacter(clean);
    // addCharacter 会对内嵌书重建 worldIds；这里恢复导入的显式世界书引用。
    created.worldIds = clean.worldIds;
    store.save();
    if (typeof raw.id === 'string' && raw.id.length > 0) characterMap.set(raw.id, created.id);
    characters += 1;
  }

  let chats = 0;
  for (const raw of bundle.chats) {
    if (raw === null || typeof raw !== 'object') continue;
    const characterIds = strings(raw.characterIds, 20)
      .map((id) => characterMap.get(id) ?? '')
      .filter((id) => id.length > 0);
    const characterId = typeof raw.characterId === 'string'
      ? (characterMap.get(raw.characterId) ?? '')
      : '';
    const mapped = characterIds.length > 0 ? characterIds : (characterId.length > 0 ? [characterId] : []);
    if (mapped.length === 0) continue;
    const copy = clone(raw);
    copy.id = `ch_${randomUUID()}`;
    copy.characterId = mapped[0];
    copy.characterIds = mapped;
    copy.updatedAt = Date.now();
    if (Array.isArray(copy.messages)) {
      copy.messages = copy.messages.map((message) => {
        if (message === null || typeof message !== 'object') return message;
        return { ...message, id: `m_${randomUUID()}` };
      });
    }
    store.data.chats.push(copy);
    chats += 1;
  }
  store.save();
  return { characters, worlds, chats };
}
