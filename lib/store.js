/**
 * 酒馆本地数据：角色、世界书、聊天、头像。
 * 数据目录与鲸鱼娘完全隔离。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseCardBuffer, extractCardMeta, readPngCard } from './card.js';
import { extractReplyMeta, normalizeStatusValue, enrichStatus } from './reply.js';
import { substitute } from './prompt.js';
import { normalizeWorldBook } from './worldbook.js';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
export const TAVERN_ROOT = process.env.DSH_TAVERN_HOME || path.join(DSH_HOME, 'tavern');
const DATA_FILE = path.join(TAVERN_ROOT, 'data.json');
const AVATAR_DIR = path.join(TAVERN_ROOT, 'avatars');

function empty() {
  return { version: 1, characters: [], worlds: [], chats: [], mediaUsage: { date: '', counts: {} } };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function text(value, max = 200000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function strings(value, max = 40) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, max)
    : [];
}

export class TavernStore {
  constructor(root = TAVERN_ROOT) {
    this.root = root;
    this.dataFile = path.join(root, 'data.json');
    this.avatarDir = path.join(root, 'avatars');
    this.data = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      if (raw && raw.version === 1 && Array.isArray(raw.characters) && Array.isArray(raw.worlds) && Array.isArray(raw.chats)) {
        return raw;
      }
    } catch {
      // 首次启动或损坏时重建空库。
    }
    return empty();
  }

  save() {
    atomicWrite(this.dataFile, this.data);
  }

  characters() {
    return this.data.characters.map((item) => ({
      id: item.id,
      name: item.name,
      avatar: item.avatar,
      description: item.description,
      tags: item.tags,
      updatedAt: item.updatedAt
    }));
  }

  character(id) {
    const item = this.data.characters.find((entry) => entry.id === id) || null;
    if (item !== null) {
      let changed = false;
      if (typeof item.avatar === 'string' && item.avatar.length > 0 && fs.existsSync(item.avatar)) {
        try {
          const embedded = readPngCard(fs.readFileSync(item.avatar));
          if (embedded.alternateGreetings.length > (item.alternateGreetings || []).length) {
            item.alternateGreetings = embedded.alternateGreetings;
            changed = true;
          }
        } catch {
          // 头像没有角色卡元数据时保持原数据
        }
      }
      if (!Array.isArray(item.statusLines) || !Array.isArray(item.quickOptions)) {
        const meta = extractCardMeta(item);
        item.statusLines = meta.statusLines;
        item.quickOptions = meta.quickOptions;
        changed = true;
      }
      if (changed) this.save();
    }
    return item;
  }

  world(id) {
    return this.data.worlds.find((item) => item.id === id) || null;
  }

  worlds() {
    return this.data.worlds.map((item) => ({
      id: item.id,
      name: item.name,
      entryCount: item.entries.length,
      updatedAt: item.updatedAt
    }));
  }

  chats(characterId = '') {
    return this.data.chats
      .filter((item) => characterId.length === 0 || item.characterId === characterId)
      .map((item) => {
        const last = item.messages.length > 0 ? item.messages[item.messages.length - 1] : null;
        return {
          id: item.id,
          characterId: item.characterId,
          characterIds: item.characterIds || [item.characterId],
          isGroup: item.isGroup === true,
          title: item.title,
          messageCount: item.messages.length,
          lastText: last === null ? '' : String(last.text).slice(0, 120),
          lastRole: last === null ? '' : last.role,
          updatedAt: item.updatedAt
        };
      });
  }

  chat(id) {
    const item = this.data.chats.find((entry) => entry.id === id) || null;
    if (item !== null) {
      let changed = false;
      for (const message of item.messages) {
        if (message.role !== 'assistant') continue;
        if (Array.isArray(message.statusLines)) {
          for (const line of message.statusLines) {
            if (line === null || typeof line.label !== 'string' || typeof line.value !== 'string') continue;
            const next = normalizeStatusValue(line.label, line.value);
            if (next !== line.value) {
              line.value = next;
              changed = true;
            }
          }
        }
        if (!/<(?:Analysis|JSONPatch|StatusBlock|Status>|【(?:状态栏|状态|选项|Options?)】)/i.test(message.text)
          && !(Array.isArray(message.quickOptions) && message.quickOptions.some((option) => option.includes('|')))) continue;
        const cleaned = extractReplyMeta(message.text);
        message.text = cleaned.text;
        message.statusLines = cleaned.statusLines;
        message.quickOptions = cleaned.quickOptions;
        changed = true;
      }
      if (changed) this.save();
      const character = this.character(item.characterId);
      if (character !== null) {
        const worlds = (character.worldIds || []).map((id) => this.world(id)).filter(Boolean);
        for (let index = 0; index < item.messages.length; index += 1) {
          const message = item.messages[index];
          if (message.role !== 'assistant' || !Array.isArray(message.statusLines)) continue;
          const next = enrichStatus(message.statusLines, item.messages.slice(0, index), worlds);
          for (let lineIndex = 0; lineIndex < next.length; lineIndex += 1) {
            if (message.statusLines[lineIndex].value !== next[lineIndex].value) {
              message.statusLines[lineIndex] = next[lineIndex];
              changed = true;
            }
          }
        }
        if (changed) this.save();
      }
    }
    return item;
  }

  addCharacter(card, image = null) {
    const now = Date.now();
    const character = {
      id: `c_${randomUUID()}`,
      ...card,
      avatar: '',
      createdAt: now,
      updatedAt: now
    };
    if (image !== null) {
      fs.mkdirSync(this.avatarDir, { recursive: true });
      const file = path.join(this.avatarDir, `${character.id}.png`);
      fs.writeFileSync(file, image);
      character.avatar = file;
    }
    let worldId = '';
    if (card.book !== null) {
      const world = {
        id: `w_${randomUUID()}`,
        name: worldNameFor(card),
        entries: card.book.entries,
        createdAt: now,
        updatedAt: now
      };
      this.data.worlds.push(world);
      worldId = world.id;
    }
    character.worldIds = worldId.length > 0 ? [worldId] : [];
    delete character.book;
    this.data.characters.push(character);
    this.save();
    return character;
  }

  updateCharacter(id, patch) {
    const current = this.character(id);
    if (current === null) return null;
    for (const key of ['name', 'description', 'personality', 'scenario', 'firstMes', 'example',
      'creatorNotes', 'systemPrompt', 'postHistory', 'voice']) {
      if (typeof patch[key] === 'string') current[key] = text(patch[key]);
    }
    if (Array.isArray(patch.tags)) current.tags = strings(patch.tags);
    if (Array.isArray(patch.alternateGreetings)) current.alternateGreetings = strings(patch.alternateGreetings);
    if (Array.isArray(patch.worldIds)) current.worldIds = strings(patch.worldIds, 20);
    current.updatedAt = Date.now();
    this.save();
    return current;
  }

  deleteCharacter(id) {
    const index = this.data.characters.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [character] = this.data.characters.splice(index, 1);
    this.data.chats = this.data.chats.filter((chat) => chat.characterId !== id);
    if (character.avatar) {
      try { fs.rmSync(character.avatar, { force: true }); } catch { /* ignore */ }
    }
    this.save();
    return true;
  }

  importCard(buffer, fileName) {
    const parsed = parseCardBuffer(buffer, fileName);
    return this.addCharacter(parsed.card, parsed.image);
  }

  addWorld(name, entries = []) {
    const now = Date.now();
    const world = { id: `w_${randomUUID()}`, name: text(name, 120) || '世界书', entries, createdAt: now, updatedAt: now };
    this.data.worlds.push(world);
    this.save();
    return world;
  }

  importWorld(raw) {
    const normalized = normalizeWorldBook(raw, '导入的世界书');
    return this.addWorld(normalized.name, normalized.entries);
  }

  updateWorld(id, patch) {
    const world = this.world(id);
    if (world === null) return null;
    if (typeof patch.name === 'string') world.name = text(patch.name, 120);
    if (Array.isArray(patch.entries)) world.entries = patch.entries;
    world.updatedAt = Date.now();
    this.save();
    return world;
  }

  deleteWorld(id) {
    const index = this.data.worlds.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.data.worlds.splice(index, 1);
    for (const character of this.data.characters) {
      character.worldIds = (character.worldIds || []).filter((worldId) => worldId !== id);
    }
    this.save();
    return true;
  }

  addChat(characterId, title = '', greetingIndex = 0, userName = '你') {
    const character = this.character(characterId);
    if (character === null) return null;
    const now = Date.now();
    const chat = {
      id: `t_${randomUUID()}`,
      characterId,
      title: text(title, 120) || character.name,
      messages: [],
      worldState: {},
      createdAt: now,
      updatedAt: now
    };
    const greetings = [character.firstMes, ...(character.alternateGreetings || [])]
      .filter((greeting) => typeof greeting === 'string' && greeting.trim().length > 0);
    const index = Number.isFinite(Number(greetingIndex)) ? Math.max(0, Math.floor(Number(greetingIndex))) : 0;
    const greeting = greetings[Math.min(index, Math.max(0, greetings.length - 1))] || '';
    if (greeting.length > 0) {
      chat.messages.push({ id: `m_${randomUUID()}`, role: 'assistant', text: substitute(greeting, character, userName), at: now });
    }
    this.data.chats.push(chat);
    this.save();
    return chat;
  }

  addGroupChat(characterIds, title = '') {
    const ids = (Array.isArray(characterIds) ? characterIds : [])
      .filter((id) => typeof id === 'string' && this.character(id) !== null)
      .slice(0, 8);
    if (ids.length < 2) return null;
    const now = Date.now();
    const chat = {
      id: `t_${randomUUID()}`,
      characterId: ids[0],
      characterIds: ids,
      isGroup: true,
      title: text(title, 120) || '群聊',
      messages: [],
      worldState: {},
      createdAt: now,
      updatedAt: now
    };
    this.data.chats.push(chat);
    this.save();
    return chat;
  }

  updateWorldState(chatId, worldState) {    const chat = this.chat(chatId);
    if (chat === null) return;
    chat.worldState = worldState !== null && typeof worldState === 'object' && !Array.isArray(worldState)
      ? worldState
      : {};
    this.save();
  }

  branchChat(chatId, messageId) {
    const source = this.chat(chatId);
    if (source === null) return null;
    const index = source.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const now = Date.now();
    const chat = {
      id: `t_${randomUUID()}`,
      characterId: source.characterId,
      title: `${source.title} · 分支`,
      messages: source.messages.slice(0, index + 1).map((message) => ({
        id: `m_${randomUUID()}`,
        role: message.role,
        text: message.text,
        at: message.at
      })),
      worldState: source.worldState === undefined ? {} : JSON.parse(JSON.stringify(source.worldState)),
      createdAt: now,
      updatedAt: now
    };
    this.data.chats.push(chat);
    this.save();
    return chat;
  }

  setAvatar(characterId, buffer) {
    const character = this.character(characterId);
    if (character === null) return null;
    fs.mkdirSync(this.avatarDir, { recursive: true });
    const file = path.join(this.avatarDir, `${character.id}.png`);
    fs.writeFileSync(file, buffer);
    character.avatar = file;
    character.updatedAt = Date.now();
    this.save();
    return character;
  }

  appendMessage(chatId, role, message, meta = {}) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const item = { id: `m_${randomUUID()}`, role, text: text(message, 200000), at: Date.now() };
    if (Array.isArray(meta.statusLines)) item.statusLines = meta.statusLines;
    if (Array.isArray(meta.quickOptions)) item.quickOptions = meta.quickOptions;
    if (typeof meta.imageUrl === 'string' && meta.imageUrl.length > 0) item.imageUrl = meta.imageUrl;
    if (typeof meta.audioUrl === 'string' && meta.audioUrl.length > 0) item.audioUrl = meta.audioUrl;
    if (typeof meta.audioText === 'string' && meta.audioText.length > 0) item.audioText = meta.audioText;
    chat.messages.push(item);
    chat.updatedAt = item.at;
    this.save();
    return item;
  }

  updateMessage(chatId, messageId, nextText, meta = {}) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const message = chat.messages.find((item) => item.id === messageId);
    if (message === undefined) return null;
    message.text = text(nextText, 200000);
    if (Array.isArray(meta.statusLines)) message.statusLines = meta.statusLines;
    if (Array.isArray(meta.quickOptions)) message.quickOptions = meta.quickOptions;
    if (typeof meta.imageUrl === 'string' && meta.imageUrl.length > 0) message.imageUrl = meta.imageUrl;
    if (typeof meta.audioUrl === 'string' && meta.audioUrl.length > 0) message.audioUrl = meta.audioUrl;
    if (typeof meta.audioText === 'string' && meta.audioText.length > 0) message.audioText = meta.audioText;
    message.at = Date.now();
    chat.updatedAt = message.at;
    this.save();
    return message;
  }

  deleteMessage(chatId, messageId) {
    const chat = this.chat(chatId);
    if (chat === null) return false;
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((item) => item.id !== messageId);
    if (chat.messages.length === before) return false;
    chat.updatedAt = Date.now();
    this.save();
    return true;
  }

  mediaUsage(characterId) {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (!this.data.mediaUsage || this.data.mediaUsage.date !== today) {
      this.data.mediaUsage = { date: today, counts: {} };
      this.save();
    }
    const counts = this.data.mediaUsage.counts[characterId] || { image: 0, voice: 0 };
    return { image: Number(counts.image) || 0, voice: Number(counts.voice) || 0, date: today };
  }

  recordMedia(characterId, type) {
    const usage = this.mediaUsage(characterId);
    const counts = this.data.mediaUsage.counts[characterId] || { image: 0, voice: 0 };
    counts[type] = (Number(counts[type]) || 0) + 1;
    this.data.mediaUsage.counts[characterId] = counts;
    this.save();
    return usage;
  }

  deleteChat(id) {
    const index = this.data.chats.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.data.chats.splice(index, 1);
    this.save();
    return true;
  }
}

function worldNameFor(card) {
  return `${card.name} 的世界书`;
}
