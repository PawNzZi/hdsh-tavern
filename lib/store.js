/**
 * 酒馆本地数据：角色、世界书、聊天、头像。
 * 数据目录与鲸鱼娘完全隔离。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseCardBuffer, extractCardMeta, readPngCard } from './card.js';
import { extractReplyMeta } from './reply.js';
import { applyStatusSchema, statusSchemaFor } from './status.js';
import { applyVariables, initialVariables, variableSchemaFor, variablesFromMessages } from './variables.js';
import { substitute } from './prompt.js';
import { normalizeWorldBook, normalizeEntry } from './worldbook.js';

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
      if (raw && typeof raw === 'object') {
        // 字段缺失时做一次修复，而不是整库丢弃。
        return {
          version: 1,
          characters: Array.isArray(raw.characters) ? raw.characters : [],
          worlds: Array.isArray(raw.worlds) ? raw.worlds : [],
          chats: Array.isArray(raw.chats) ? raw.chats : [],
          mediaUsage: raw.mediaUsage !== null && typeof raw.mediaUsage === 'object'
            ? raw.mediaUsage
            : { date: '', counts: {} }
        };
      }
    } catch {
      // 解析失败：备份损坏文件，避免下一次写操作直接覆盖掉用户数据。
      try {
        if (fs.existsSync(this.dataFile)) {
          fs.renameSync(this.dataFile, `${this.dataFile}.corrupt-${Date.now()}`);
        }
      } catch {
        // 备份失败也只能继续用空库启动。
      }
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
      // 只在首次读取时尝试从头像 PNG 补齐开场白，避免每次聊天都读一遍图片。
      if (item.greetingsChecked !== true) {
        item.greetingsChecked = true;
        changed = true;
        if (typeof item.avatar === 'string' && item.avatar.length > 0 && fs.existsSync(item.avatar)) {
          try {
            const embedded = readPngCard(fs.readFileSync(item.avatar));
            if (embedded.alternateGreetings.length > (item.alternateGreetings || []).length) {
              item.alternateGreetings = embedded.alternateGreetings;
            }
          } catch {
            // 头像没有角色卡元数据时保持原数据
          }
        }
      }
      if (!Array.isArray(item.statusLines) || !Array.isArray(item.quickOptions)) {
        const meta = extractCardMeta(item);
        item.statusLines = meta.statusLines;
        item.quickOptions = meta.quickOptions;
        changed = true;
      }
      // 卡级状态规则可能来自后导入的世界书，读角色时再套一次。
      const characterWorlds = (item.worldIds || []).map((worldId) => this.world(worldId)).filter(Boolean);
      const statusSchema = statusSchemaFor(item, characterWorlds);
      if (statusSchema !== null && Array.isArray(item.statusLines)) {
        const next = applyStatusSchema(item.statusLines, statusSchema);
        if (JSON.stringify(next) !== JSON.stringify(item.statusLines)) {
          item.statusLines = next;
          changed = true;
        }
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
      const character = this.character(item.characterId);
      const worlds = character === null
        ? []
        : (character.worldIds || []).map((worldId) => this.world(worldId)).filter(Boolean);
      const schema = statusSchemaFor(character, worlds);
      for (const message of item.messages) {
        if (message.role !== 'assistant') continue;
        const tagged = /<(?:Analysis|JSONPatch|StatusBlock|Status|State|UpdateVariable)>|【(?:状态栏|状态|选项|Options?)】/i.test(message.text)
          || (Array.isArray(message.quickOptions) && message.quickOptions.some((option) => option.includes('|')));
        if (tagged) {
          const cleaned = extractReplyMeta(message.text, schema);
          message.text = cleaned.text;
          message.statusLines = cleaned.statusLines;
          message.quickOptions = cleaned.quickOptions;
          changed = true;
        } else if (Array.isArray(message.statusLines)) {
          const next = applyStatusSchema(message.statusLines, schema);
          if (JSON.stringify(next) !== JSON.stringify(message.statusLines)) {
            message.statusLines = next;
            changed = true;
          }
        }
      }
      if (changed) this.save();
      const variableSchema = variableSchemaFor(character, worlds);
      if (Object.keys(variableSchema).length > 0) {
        let running = initialVariables(variableSchema);
        for (const message of item.messages) {
          if (message.role !== 'assistant' || !Array.isArray(message.statusLines)) continue;
          const before = JSON.stringify(message.statusLines);
          const applied = applyVariables(message.statusLines, running, variableSchema);
          running = applied.variables;
          if (JSON.stringify(applied.lines) !== before) {
            message.statusLines = applied.lines;
            changed = true;
          }
        }
        if (JSON.stringify(item.variables) !== JSON.stringify(running)) {
          item.variables = running;
          changed = true;
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
        ownerCharacterId: character.id,
        createdAt: now,
        updatedAt: now
      };
      this.data.worlds.push(world);
      worldId = world.id;
    }
    character.worldIds = worldId.length > 0 ? [worldId] : [];
    delete character.book;
    const worlds = character.worldIds.map((id) => this.world(id)).filter(Boolean);
    character.statusLines = applyStatusSchema(character.statusLines || [], statusSchemaFor(character, worlds));
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
    const meta = extractCardMeta(current);
    const worlds = (current.worldIds || []).map((worldId) => this.world(worldId)).filter(Boolean);
    current.statusLines = applyStatusSchema(meta.statusLines, statusSchemaFor(current, worlds));
    current.quickOptions = meta.quickOptions;
    current.updatedAt = Date.now();
    this.save();
    return current;
  }

  deleteCharacter(id) {
    const index = this.data.characters.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [character] = this.data.characters.splice(index, 1);
    // 单聊按 characterId 清理；群聊按成员列表清理，避免留下孤儿 chat。
    this.data.chats = this.data.chats.filter((chat) => {
      if (chat.isGroup === true) return !(chat.characterIds || []).includes(id);
      return chat.characterId !== id;
    });
    // 角色卡内嵌世界书随角色一起删除，并解除其它角色的引用。
    const ownedWorlds = this.data.worlds.filter((world) => world.ownerCharacterId === id);
    if (ownedWorlds.length > 0) {
      const ownedIds = new Set(ownedWorlds.map((world) => world.id));
      this.data.worlds = this.data.worlds.filter((world) => !ownedIds.has(world.id));
      for (const other of this.data.characters) {
        other.worldIds = (other.worldIds || []).filter((worldId) => !ownedIds.has(worldId));
      }
    }
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
    const world = {
      id: `w_${randomUUID()}`,
      name: text(name, 120) || '世界书',
      entries: entries.map((entry, index) => normalizeEntry(entry, index)),
      createdAt: now,
      updatedAt: now
    };
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
    if (Array.isArray(patch.entries)) {
      world.entries = patch.entries.map((entry, index) => normalizeEntry(entry, index));
    }
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
    const chatWorlds = (character.worldIds || []).map((worldId) => this.world(worldId)).filter(Boolean);
    const chat = {
      id: `t_${randomUUID()}`,
      characterId,
      title: text(title, 120) || character.name,
      messages: [],
      variables: initialVariables(variableSchemaFor(character, chatWorlds)),
      injects: [],
      automationRuns: {},
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

  /**
   * 取这个对话固定的 Agent 会话 id，没有就生成一个并存盘。
   *
   * 为什么要固定：AgentRunner 每生成一次都会创建会话，之前每次随机 uuid，
   * 于是 DSH 的会话列表里堆出一堆「无头对话」。固定成每个酒馆对话一个，
   * 复用（resume）同一个会话，列表里就只多一条。
   */
  /**
   * 丢弃这个对话固定的 Agent 会话：消息被删除/改写后，旧会话里还留着那段历史，
   * 继续 resume 会把已删的内容带回上下文。清空 id 后下次生成会新建会话，
   * 上下文完全按酒馆记录重建。
   */
  resetAgentSession(chatId) {
    const chat = this.chat(chatId);
    if (chat === null) return false;
    if (typeof chat.agentSessionId !== 'string' || chat.agentSessionId.length === 0) {
      return false;
    }
    chat.agentSessionId = '';
    chat.updatedAt = Date.now();
    this.save();
    return true;
  }

  ensureAgentSession(chatId) {
    const chat = this.chat(chatId);
    if (chat === null) return '';
    if (typeof chat.agentSessionId !== 'string' || chat.agentSessionId.length === 0) {
      chat.agentSessionId = 'tavern-' + randomUUID();
      chat.updatedAt = Date.now();
      this.save();
    }
    return chat.agentSessionId;
  }

  /**
   * 写入剧情记忆（上下文压缩的摘要）。
   *
   * memory 为 null 表示清除；memoryLog 只保留最近 10 条，用于回看每次压缩的
   * 前后 token 与覆盖范围，不参与 prompt。
   */
  setChatMemory(chatId, memory, meta = {}) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
      chat.memory = null;
    } else {
      chat.memory = {
        version: 1,
        summary: text(memory.summary, 20000).trim(),
        throughMessageId: typeof memory.throughMessageId === 'string' ? memory.throughMessageId : '',
        sourceMessages: Number.isFinite(Number(memory.sourceMessages))
          ? Math.max(0, Math.floor(Number(memory.sourceMessages)))
          : 0,
        tokens: Number.isFinite(Number(memory.tokens))
          ? Math.max(0, Math.floor(Number(memory.tokens)))
          : 0,
        updatedAt: Number.isFinite(Number(memory.updatedAt)) ? Number(memory.updatedAt) : Date.now()
      };
    }
    if (meta !== null && typeof meta === 'object' && chat.memory !== null) {
      const log = Array.isArray(chat.memoryLog) ? chat.memoryLog : [];
      log.push({
        at: Date.now(),
        mode: typeof meta.mode === 'string' ? meta.mode : 'manual',
        fromId: typeof meta.fromId === 'string' ? meta.fromId : '',
        toId: typeof meta.toId === 'string' ? meta.toId : '',
        beforeTokens: Number.isFinite(Number(meta.beforeTokens)) ? Math.max(0, Math.floor(Number(meta.beforeTokens))) : 0,
        afterTokens: Number.isFinite(Number(meta.afterTokens)) ? Math.max(0, Math.floor(Number(meta.afterTokens))) : 0
      });
      chat.memoryLog = log.slice(-10);
    }
    chat.updatedAt = Date.now();
    this.save();
    return chat.memory;
  }

  /** 清除剧情记忆；返回是否本来就有。 */
  clearChatMemory(chatId) {
    const chat = this.chat(chatId);
    if (chat === null) return false;
    const had = chat.memory !== null && chat.memory !== undefined;
    chat.memory = null;
    chat.memoryLog = [];
    chat.updatedAt = Date.now();
    this.save();
    return had;
  }

  updateWorldState(chatId, worldState) {
    const chat = this.chat(chatId);
    if (chat === null) return;
    chat.worldState = worldState !== null && typeof worldState === 'object' && !Array.isArray(worldState)
      ? worldState
      : {};
    this.save();
  }

  setChatVariables(chatId, variables) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    chat.variables = variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? variables
      : {};
    this.save();
    return chat.variables;
  }

  setChatInjections(chatId, injections) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    chat.injects = Array.isArray(injections) ? injections.slice(0, 20) : [];
    this.save();
    return chat.injects;
  }

  setChatAutomationRuns(chatId, runs) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    chat.automationRuns = runs !== null && typeof runs === 'object' && !Array.isArray(runs) ? runs : {};
    this.save();
    return chat.automationRuns;
  }

  branchChat(chatId, messageId) {
    const source = this.chat(chatId);
    if (source === null) return null;
    const index = source.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const now = Date.now();
    // 分支保留角色/群聊身份与消息元数据（状态栏、快捷选项、媒体、说话人）。
    const worldState = source.worldState === undefined
      ? {}
      : JSON.parse(JSON.stringify(source.worldState));
    delete worldState.__meta;
    const chat = {
      id: `t_${randomUUID()}`,
      characterId: source.characterId,
      ...(Array.isArray(source.characterIds) ? { characterIds: source.characterIds.slice() } : {}),
      ...(source.isGroup === true ? { isGroup: true } : {}),
      title: `${source.title} · 分支`,
      messages: source.messages.slice(0, index + 1).map((message) => {
        const copy = {
          id: `m_${randomUUID()}`,
          role: message.role,
          text: message.text,
          at: message.at
        };
        for (const key of ['speaker', 'statusLines', 'quickOptions', 'imageUrl', 'audioUrl', 'audioText', 'swipes']) {
          if (message[key] === undefined) continue;
          copy[key] = Array.isArray(message[key])
            ? JSON.parse(JSON.stringify(message[key]))
            : message[key];
        }
        if (Number.isFinite(Number(message.activeSwipe))) copy.activeSwipe = Number(message.activeSwipe);
        return copy;
      }),
      worldState,
      variables: source.variables !== null && typeof source.variables === 'object'
        ? JSON.parse(JSON.stringify(source.variables))
        : {},
      injects: Array.isArray(source.injects) ? JSON.parse(JSON.stringify(source.injects)) : [],
      automationRuns: source.automationRuns !== null && typeof source.automationRuns === 'object'
        ? JSON.parse(JSON.stringify(source.automationRuns))
        : {},
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
    character.greetingsChecked = false;
    character.updatedAt = Date.now();
    this.save();
    return character;
  }

  appendMessage(chatId, role, message, meta = {}) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const value = text(message, 200000);
    const item = { id: `m_${randomUUID()}`, role, text: value, at: Date.now() };
    if (role === 'assistant') {
      const variants = Array.isArray(meta.swipes)
        ? meta.swipes.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 20)
        : [];
      item.swipes = variants.length > 0 ? variants : [value];
      item.activeSwipe = Number.isFinite(Number(meta.activeSwipe))
        ? Math.max(0, Math.min(item.swipes.length - 1, Math.floor(Number(meta.activeSwipe))))
        : item.swipes.length - 1;
      item.text = item.swipes[item.activeSwipe];
    }
    if (typeof meta.speaker === 'string' && meta.speaker.length > 0) item.speaker = meta.speaker;
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
    if (message.role === 'assistant') {
      if (!Array.isArray(message.swipes) || message.swipes.length === 0) message.swipes = [message.text];
      if (!Number.isFinite(Number(message.activeSwipe))) message.activeSwipe = 0;
      const index = Math.max(0, Math.min(message.swipes.length - 1, Math.floor(Number(message.activeSwipe))));
      message.swipes[index] = message.text;
      message.activeSwipe = index;
    }
    if (typeof meta.speaker === 'string' && meta.speaker.length > 0) message.speaker = meta.speaker;
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

  appendSwipe(chatId, messageId, variant) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const message = chat.messages.find((item) => item.id === messageId);
    if (message === undefined || message.role !== 'assistant') return null;
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) message.swipes = [message.text];
    if (message.swipes.length >= 20) return null;
    message.swipes.push(text(variant, 200000));
    message.activeSwipe = message.swipes.length - 1;
    message.text = message.swipes[message.activeSwipe];
    this.save();
    return message;
  }

  selectSwipe(chatId, messageId, index) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const message = chat.messages.find((item) => item.id === messageId);
    if (message === undefined || message.role !== 'assistant' || !Array.isArray(message.swipes)) return null;
    const target = Math.max(0, Math.min(message.swipes.length - 1, Math.floor(Number(index))));
    message.activeSwipe = target;
    message.text = message.swipes[target];
    this.save();
    return message;
  }

  deleteSwipe(chatId, messageId, index) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const message = chat.messages.find((item) => item.id === messageId);
    if (message === undefined || message.role !== 'assistant' || !Array.isArray(message.swipes)) return null;
    if (message.swipes.length <= 1) return null;
    const target = Math.max(0, Math.min(message.swipes.length - 1, Math.floor(Number(index))));
    message.swipes.splice(target, 1);
    message.activeSwipe = Math.max(0, Math.min(message.swipes.length - 1, target - 1));
    message.text = message.swipes[message.activeSwipe];
    this.save();
    return message;
  }

  appendToMessage(chatId, messageId, suffix) {
    const chat = this.chat(chatId);
    if (chat === null) return null;
    const message = chat.messages.find((item) => item.id === messageId);
    if (message === undefined) return null;
    message.text = `${message.text}${text(suffix, 200000)}`;
    if (message.role === 'assistant') {
      if (!Array.isArray(message.swipes) || message.swipes.length === 0) message.swipes = [message.text];
      const index = Number.isFinite(Number(message.activeSwipe)) ? Number(message.activeSwipe) : 0;
      message.swipes[Math.max(0, Math.min(message.swipes.length - 1, index))] = message.text;
    }
    this.save();
    return message;
  }

  deleteMessage(chatId, messageId) {
    const chat = this.chat(chatId);
    if (chat === null) return false;
    const before = chat.messages.length;
    const wasLast = before > 0 && chat.messages[before - 1].id === messageId;
    chat.messages = chat.messages.filter((item) => item.id !== messageId);
    if (chat.messages.length === before) return false;
    // 删掉最后一条等于聊天没有推进；ST 会移除定时效果，这里清空本 chat 的计时状态。
    if (wasLast) {
      chat.worldState = {};
    }
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
