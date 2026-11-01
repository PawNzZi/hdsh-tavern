/**
 * dsh-tavern：独立酒馆插件。
 *
 * 与 dsh-whale-companion 完全分离：
 *   - 独立数据目录 <DSH_HOME>/tavern；
 *   - 独立 tavern-roleplay Agent 预设，无任何工具；
 *   - 独立 /tavern/* HTTP API；
 *   - 不读取鲸鱼娘人格/记忆/聊天。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TavernStore, TAVERN_ROOT } from './store.js';
import { parseCardBuffer, writePngCard } from './card.js';
import { TavernAgent } from './agent.js';
import { previewPrompt, buildGroupPrompt } from './prompt.js';
import { extractReplyMeta, enrichStatus } from './reply.js';
import { generateImage, generateVoice, saveMedia } from './media.js';

export const name = 'hdsh-tavern';
export const inject = ['webServer', 'connection'];

const PLUGIN_VERSION = '0.1.0';
const SCHEMA_VERSION = 1;
const MAX_JSON_BODY = 48 * 1024 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

function methodOf(req) {
  return (req.method || 'GET').toUpperCase();
}

function admit(ctx, req, res) {
  let verdict;
  try {
    const connection = ctx.connection;
    if (typeof connection?.admit === 'function') {
      verdict = connection.admit(req);
      if (verdict && 'peer' in verdict) return true;
    } else if (typeof connection?.requestRejection === 'function') {
      if (connection.requestRejection(req) === undefined) return true;
    }
  } catch {
    // fall through
  }
  sendError(res, 401, 'unauthorized', 'DSH authentication required');
  return false;
}

function readJson(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = raw.length === 0 ? {} : JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function trim(value, max = 200000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function promptOptions(body, countTokens) {
  return {
    worldMaxTokens: Number(body.worldMaxTokens) || 6000,
    historyLimit: Number(body.historyLimit) || 24,
    promptOrder: Array.isArray(body.promptOrder) ? body.promptOrder : undefined,
    countTokens
  };
}

function generationOptions(body) {
  const maxTokens = Number(body.maxTokens);
  const temperature = Number(body.temperature);
  return {
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(Number.isFinite(temperature) && temperature >= 0 ? { temperature } : {})
  };
}

function idOf(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return url.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

function pathOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    const line = `[dsh-tavern] ${message}`;
    try { ctx.logger?.info?.(line); } catch { /* ignore */ }
    console.info(line);
  };
  const store = new TavernStore();
  const agent = new TavernAgent({ ctx, log });
  const tokenMeter = ctx.get?.('tokenMeter');
  const countTokens = (text) => {
    if (typeof text !== 'string' || text.length === 0) return 0;
    try {
      if (tokenMeter && typeof tokenMeter.estimateMessage === 'function') {
        return tokenMeter.estimateMessage({
          id: 'tavern-estimate',
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' }
        });
      }
    } catch {
      // fall through to estimate
    }
    return Math.ceil(text.length / 2);
  };

  const promptForChat = (chat, text, userName, body) => {
    const characters = (chat.characterIds && chat.characterIds.length > 0
      ? chat.characterIds
      : [chat.characterId])
      .map((id) => store.character(id))
      .filter(Boolean);
    if (characters.length === 0) return null;
    const worlds = [...new Set(characters.flatMap((character) => character.worldIds || []))]
      .map((id) => store.world(id))
      .filter(Boolean);
    const options = promptOptions(body, countTokens);
    return chat.isGroup === true
      ? buildGroupPrompt(characters, worlds, chat, text, userName, options)
      : previewPrompt(characters[0], worlds, chat, text, userName, options);
  };

  const asksForImage = (text) => /发.{0,6}(图|照片|自拍|相片)|来.{0,4}(图|照片|自拍)|给我.{0,4}(图|照片|自拍)|拍.{0,3}(照|图)|看看你/.test(text);
  const asksForVoice = (text) => /语音|声音|说句话|听你|发条.{0,4}(语音|声音)|念给我/.test(text);
  const mediaLimit = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(50, Math.floor(number)));
  };

  async function attachMedia(chat, character, body, cleaned, messageId, userText) {
    const apiKey = trim(body.apiKey, 500);
    if (apiKey.length === 0) return {};
    const imageLimit = mediaLimit(body.imageLimit, 3);
    const voiceLimit = mediaLimit(body.voiceLimit, 5);
    const usage = store.mediaUsage(character.id);
    const wantImage = cleaned.imagePrompt.length > 0 || asksForImage(userText);
    const wantVoice = cleaned.voiceText.length > 0 || asksForVoice(userText);
    const result = {};
    if (wantImage && imageLimit > 0 && usage.image < imageLimit) {
      try {
        const prompt = cleaned.imagePrompt.length > 0
          ? cleaned.imagePrompt
          : `${character.name}，${userText}，日常手机生活照，人物长相与角色设定一致，自然光线，画面干净，无文字无水印`;
        const buffer = await generateImage({
          apiKey,
          workspaceId: trim(body.workspaceId, 120),
          prompt
        });
        const file = saveMedia(TAVERN_ROOT, buffer, 'png');
        result.imageUrl = `/tavern/media/${file}`;
        store.recordMedia(character.id, 'image');
      } catch (error) {
        log(`image media failed: ${error?.message ?? error}`);
      }
    }
    if (wantVoice && voiceLimit > 0 && usage.voice < voiceLimit) {
      try {
        const raw = cleaned.voiceText.length > 0 ? cleaned.voiceText : cleaned.text;
        const voiceText = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
        if (voiceText.length > 0) {
          const buffer = await generateVoice({
            apiKey,
            workspaceId: trim(body.workspaceId, 120),
            voice: trim(body.voice, 80),
            text: voiceText
          });
          const file = saveMedia(TAVERN_ROOT, buffer, 'mp3');
          result.audioUrl = `/tavern/media/${file}`;
          result.audioText = voiceText;
          store.recordMedia(character.id, 'voice');
        }
      } catch (error) {
        log(`voice media failed: ${error?.message ?? error}`);
      }
    }
    if (Object.keys(result).length > 0) {
      store.updateMessage(chat.id, messageId, cleaned.text, {
        statusLines: cleaned.statusLines,
        quickOptions: cleaned.quickOptions,
        imageUrl: result.imageUrl,
        audioUrl: result.audioUrl,
        audioText: result.audioText
      });
    }
    return result;
  }

  async function characters(req, res) {
    if (!admit(ctx, req, res)) return;
    const path = pathOf(req);
    const method = methodOf(req);
    if (path.endsWith('/avatar')) {
      const parts = path.split('/').filter(Boolean);
      const character = store.character(parts[2] || '');
      if (character === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      if (method === 'POST') {
        try {
          const body = await readJson(req);
          const encoded = trim(body.contentBase64, MAX_JSON_BODY);
          if (encoded.length === 0) {
            sendError(res, 400, 'bad-request', 'contentBase64 is required');
            return;
          }
          const updated = store.setAvatar(character.id, Buffer.from(encoded, 'base64'));
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, character: updated });
        } catch (error) {
          sendError(res, 400, 'avatar-failed', error?.message ?? 'avatar update failed');
        }
        return;
      }
      if (method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', 'GET or POST only');
        return;
      }
      if (!character.avatar) {
        sendError(res, 404, 'not-found', 'avatar not found');
        return;
      }
      try {
        const data = fs.readFileSync(character.avatar);
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=3600',
          'content-length': data.length
        });
        res.end(data);
      } catch {
        sendError(res, 404, 'not-found', 'avatar file missing');
      }
      return;
    }
    if (path.endsWith('/export')) {
      const parts = path.split('/').filter(Boolean);
      const character = store.character(parts[2] || '');
      if (character === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const format = query.get('format') === 'png' ? 'png' : 'json';
      const worlds = (character.worldIds || []).map((id) => store.world(id)).filter(Boolean);
      const embeddedEntries = worlds.flatMap((world) => world.entries || []);
      if (format === 'png') {
        let image = null;
        try { image = character.avatar ? fs.readFileSync(character.avatar) : null; } catch { /* ignore */ }
        const png = writePngCard(image, {
          ...character,
          embeddedBook: embeddedEntries.length > 0 ? { entries: embeddedEntries } : undefined
        });
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-disposition': `attachment; filename="${encodeURIComponent(character.name)}.png"`,
          'content-length': png.length
        });
        res.end(png);
        return;
      }
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        card: {
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            name: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
            first_mes: character.firstMes,
            mes_example: character.example,
            creator_notes: character.creatorNotes,
            system_prompt: character.systemPrompt,
            post_history_instructions: character.postHistory,
            alternate_greetings: character.alternateGreetings || [],
            tags: character.tags || [],
            creator: character.creator || '',
            character_version: character.characterVersion || '',
            extensions: character.extensions || {},
            character_book: embeddedEntries.length > 0 ? { entries: embeddedEntries } : undefined
          }
        }
      });
      return;
    }
    if (path === '/tavern/characters') {
      if (method === 'GET') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, characters: store.characters(), worlds: store.worlds() });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const card = {
          name: trim(body.name, 120),
          description: trim(body.description),
          personality: trim(body.personality),
          scenario: trim(body.scenario),
          firstMes: trim(body.firstMes),
          example: trim(body.example),
          creatorNotes: trim(body.creatorNotes),
          systemPrompt: trim(body.systemPrompt),
          postHistory: trim(body.postHistory),
          alternateGreetings: Array.isArray(body.alternateGreetings) ? body.alternateGreetings : [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          creator: '',
          characterVersion: '',
          extensions: {},
          spec: '',
          specVersion: '',
          book: null
        };
        if (card.name.length === 0) {
          sendError(res, 400, 'bad-request', 'name is required');
          return;
        }
        const character = store.addCharacter(card, null);
        sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, character });
        return;
      }
    }
    const id = idOf(req);
    if (path.includes('/characters/')) {
      const character = store.character(id);
      if (character === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, character });
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJson(req);
        const updated = store.updateCharacter(id, body);
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, character: updated });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, deleted: store.deleteCharacter(id) });
        return;
      }
    }
    sendError(res, 404, 'not-found', 'unknown characters route');
  }

  async function parseCharacter(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    try {
      const body = await readJson(req);
      const encoded = trim(body.contentBase64, MAX_JSON_BODY);
      if (encoded.length === 0) {
        sendError(res, 400, 'bad-request', 'contentBase64 is required');
        return;
      }
      const parsed = parseCardBuffer(Buffer.from(encoded, 'base64'), trim(body.fileName, 240));
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        source: parsed.source,
        hasImage: parsed.image !== null,
        card: parsed.card,
        book: parsed.card.book
      });
    } catch (error) {
      sendError(res, 400, 'parse-failed', error?.message ?? 'parse failed');
    }
  }

  async function importCharacter(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    try {
      const body = await readJson(req);
      const encoded = trim(body.contentBase64, MAX_JSON_BODY);
      if (encoded.length === 0) {
        sendError(res, 400, 'bad-request', 'contentBase64 is required');
        return;
      }
      const buffer = Buffer.from(encoded, 'base64');
      const character = store.importCard(buffer, trim(body.fileName, 240));
      store.save();
      sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, character });
    } catch (error) {
      sendError(res, 400, 'import-failed', error?.message ?? 'import failed');
    }
  }

  async function worlds(req, res) {
    if (!admit(ctx, req, res)) return;
    const path = pathOf(req);
    const method = methodOf(req);
    if (path === '/tavern/worlds') {
      if (method === 'GET') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, worlds: store.worlds() });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const world = store.addWorld(trim(body.name, 120), Array.isArray(body.entries) ? body.entries : []);
        sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, world });
        return;
      }
    }
    const id = idOf(req);
    if (path.includes('/worlds/')) {
      const world = store.world(id);
      if (world === null) {
        sendError(res, 404, 'not-found', 'world not found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, world });
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJson(req);
        const updated = store.updateWorld(id, body);
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, world: updated });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, deleted: store.deleteWorld(id) });
        return;
      }
    }
    sendError(res, 404, 'not-found', 'unknown worlds route');
  }

  async function importWorld(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    try {
      const body = await readJson(req);
      const world = store.importWorld(body);
      sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, world });
    } catch (error) {
      sendError(res, 400, 'import-failed', error?.message ?? 'import failed');
    }
  }

  async function chats(req, res) {
    if (!admit(ctx, req, res)) return;
    const path = pathOf(req);
    const method = methodOf(req);
    if (path === '/tavern/chats/group') {
      if (method === 'POST') {
        const body = await readJson(req);
        const chat = store.addGroupChat(body.characterIds, trim(body.title, 120));
        if (chat === null) {
          sendError(res, 400, 'bad-request', 'at least two valid characters are required');
          return;
        }
        sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, chat });
        return;
      }
    }
    if (path === '/tavern/chats') {
      if (method === 'GET') {
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chats: store.chats(query.get('characterId') || '') });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const chat = store.addChat(trim(body.characterId, 80), trim(body.title, 120), Number(body.greetingIndex) || 0, trim(body.userName, 40) || '你');
        if (chat === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, chat });
        return;
      }
    }
    const id = idOf(req);
    if (path.includes('/chats/')) {
      const chat = store.chat(id);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chat });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, deleted: store.deleteChat(id) });
        return;
      }
    }
    sendError(res, 404, 'not-found', 'unknown chats route');
  }

  async function sendMessageStream(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const chatId = pathOf(req).split('/')[3] || '';
    const chat = store.chat(chatId);
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const character = store.character(chat.characterId);
    if (character === null) {
      sendError(res, 404, 'not-found', 'character not found');
      return;
    }
    let userMessage = null;
    try {
      const body = await readJson(req);
      const text = trim(body.text, 20000).trim();
      if (text.length === 0) {
        sendError(res, 400, 'bad-request', 'text is required');
        return;
      }
      const worlds = (character.worldIds || []).map((id) => store.world(id)).filter(Boolean);
      const prompt = promptForChat(chat, text, trim(body.userName, 40) || '你', body);
      if (prompt === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      userMessage = store.appendMessage(chat.id, 'user', text);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(': stream\n\n');
      let streamed = '';
      let mediaStreamHidden = false;
      const rawReply = await agent.generate(prompt.system, prompt.user, 120000, (delta) => {
        streamed += delta;
        if (mediaStreamHidden) return;
        const mediaAt = delta.search(/<media_(?:image|voice)>/i);
        const safe = mediaAt >= 0 ? delta.slice(0, mediaAt) : delta;
        if (mediaAt >= 0) mediaStreamHidden = true;
        if (safe.length === 0) return;
        try {
          res.write(`event: delta\ndata: ${JSON.stringify({ text: safe })}\n\n`);
        } catch {
          // 客户端断开时继续完成生成，消息仍会落盘。
        }
      }, generationOptions(body));
      const cleaned = extractReplyMeta(rawReply);
      const enriched = enrichStatus(cleaned.statusLines, chat.messages, worlds);
      const assistant = store.appendMessage(chat.id, 'assistant', cleaned.text, {
        statusLines: enriched,
        quickOptions: cleaned.quickOptions
      });
      const media = await attachMedia(chat, character, body, { ...cleaned, statusLines: enriched }, assistant.id, text);
      store.updateWorldState(chat.id, prompt.worldState);
      res.write(`event: done\ndata: ${JSON.stringify({
        user: userMessage,
        reply: { ...assistant, ...media },
        streamed,
        prompt: {
          activated: prompt.activated,
          truncated: prompt.truncated,
          worldChars: prompt.worldChars
        }
      })}\n\n`);
      res.end();
    } catch (error) {
      log(`stream chat failed: ${error?.message ?? error}`);
      if (userMessage !== null) {
        store.deleteMessage(chat.id, userMessage.id);
      }
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message ?? 'model failed' })}\n\n`);
        res.end();
      }
    }
  }

  async function sendMessage(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const chatId = pathOf(req).split('/')[3] || '';
    const chat = store.chat(chatId);
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const character = store.character(chat.characterId);
    if (character === null) {
      sendError(res, 404, 'not-found', 'character not found');
      return;
    }
    try {
      const body = await readJson(req);
      const text = trim(body.text, 20000).trim();
      if (text.length === 0) {
        sendError(res, 400, 'bad-request', 'text is required');
        return;
      }
      const worlds = (character.worldIds || []).map((id) => store.world(id)).filter(Boolean);
      const prompt = promptForChat(chat, text, trim(body.userName, 40) || '你', body);
      const reply = await agent.generate(prompt.system, prompt.user, 120000, null, generationOptions(body));
      const cleaned = extractReplyMeta(reply);
      const enriched = enrichStatus(cleaned.statusLines, chat.messages, worlds);
      const userMessage = store.appendMessage(chat.id, 'user', text);
      const assistantMessage = store.appendMessage(chat.id, 'assistant', cleaned.text, {
        statusLines: enriched,
        quickOptions: cleaned.quickOptions
      });
      const media = await attachMedia(chat, character, body, { ...cleaned, statusLines: enriched }, assistantMessage.id, text);
      store.updateWorldState(chat.id, prompt.worldState);
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        user: userMessage,
        reply: { ...assistantMessage, ...media },
        prompt: {
          activated: prompt.activated,
          truncated: prompt.truncated,
          worldChars: prompt.worldChars
        }
      });
    } catch (error) {
      log(`chat failed: ${error?.message ?? error}`);
      sendError(res, 502, 'model-error', error?.message ?? 'model failed');
    }
  }

  async function branchChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const source = store.chat(parts[2] || '');
    if (source === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    try {
      const body = await readJson(req);
      const chat = store.branchChat(source.id, trim(body.messageId, 100));
      if (chat === null) {
        sendError(res, 404, 'not-found', 'message not found');
        return;
      }
      sendJson(res, 201, { schemaVersion: SCHEMA_VERSION, chat });
    } catch (error) {
      sendError(res, 400, 'branch-failed', error?.message ?? 'branch failed');
    }
  }

  async function exportChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'GET') {
      sendError(res, 405, 'method-not-allowed', 'GET only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chat = store.chat(parts[2] || '');
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const character = store.character(chat.characterId);
    const query = new URL(req.url || '/', 'http://localhost').searchParams;
    const format = query.get('format') === 'json' ? 'json' : 'markdown';
    if (format === 'json') {
      sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chat, character });
      return;
    }
    const lines = [`# ${chat.title}`, '', `角色：${character === null ? '' : character.name}`, ''];
    for (const message of chat.messages) {
      lines.push(`**${message.role === 'user' ? 'User' : (character === null ? 'Character' : character.name)}**`, '', message.text, '');
    }
    sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, format, text: lines.join('\n') });
  }

  async function messageAction(req, res) {
    if (!admit(ctx, req, res)) return;
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    const messageId = parts[4] || '';
    const chat = store.chat(chatId);
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const method = methodOf(req);
    try {
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJson(req);
        const text = trim(body.text, 20000);
        if (text.trim().length === 0) {
          sendError(res, 400, 'bad-request', 'text is required');
          return;
        }
        const message = store.updateMessage(chatId, messageId, text);
        if (message === null) {
          sendError(res, 404, 'not-found', 'message not found');
          return;
        }
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, message });
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, deleted: store.deleteMessage(chatId, messageId) });
        return;
      }
      sendError(res, 405, 'method-not-allowed', 'PATCH or DELETE only');
    } catch (error) {
      sendError(res, 400, 'bad-request', error?.message ?? 'message operation failed');
    }
  }

  async function regenerate(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chat = store.chat(parts[2] || '');
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const character = store.character(chat.characterId);
    if (character === null) {
      sendError(res, 404, 'not-found', 'character not found');
      return;
    }
    try {
      const body = await readJson(req);
      const targetId = trim(body.messageId, 100);
      const targetIndex = targetId.length > 0
        ? chat.messages.findIndex((message) => message.id === targetId)
        : chat.messages.map((message) => message.role).lastIndexOf('assistant');
      if (targetIndex < 0) {
        sendError(res, 404, 'not-found', 'assistant message not found');
        return;
      }
      const prefix = chat.messages.slice(0, targetIndex);
      const userIndex = prefix.map((message) => message.role).lastIndexOf('user');
      if (userIndex < 0) {
        sendError(res, 400, 'bad-request', 'no user message before this reply');
        return;
      }
      const userText = prefix[userIndex].text;
      const history = prefix.slice(0, userIndex);
      const worlds = (character.worldIds || []).map((id) => store.world(id)).filter(Boolean);
      const prompt = promptForChat({ ...chat, messages: history }, userText, trim(body.userName, 40) || '你', body);
      if (prompt === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const reply = await agent.generate(prompt.system, prompt.user, 120000, null, generationOptions(body));
      const cleaned = extractReplyMeta(reply);
      const enriched = enrichStatus(cleaned.statusLines, chat.messages, worlds);
      const message = store.updateMessage(chat.id, chat.messages[targetIndex].id, cleaned.text, {
        statusLines: enriched,
        quickOptions: cleaned.quickOptions
      });
      store.updateWorldState(chat.id, prompt.worldState);
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        message,
        prompt: {
          activated: prompt.activated,
          truncated: prompt.truncated,
          worldChars: prompt.worldChars
        }
      });
    } catch (error) {
      log(`regenerate failed: ${error?.message ?? error}`);
      sendError(res, 502, 'model-error', error?.message ?? 'model failed');
    }
  }

  async function promptPreview(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    try {
      const body = await readJson(req);
      const chat = store.chat(trim(body.chatId, 80));
      const character = chat ? store.character(chat.characterId) : store.character(trim(body.characterId, 80));
      if (character === null) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const emptyChat = chat || { messages: [] };
      const worlds = (character.worldIds || []).map((id) => store.world(id)).filter(Boolean);
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        prompt: promptForChat(emptyChat, trim(body.text, 20000), trim(body.userName, 40) || '你', body)
      });
    } catch (error) {
      sendError(res, 400, 'bad-request', error?.message ?? 'preview failed');
    }
  }

  async function mediaFile(req, res) {
    if (methodOf(req) !== 'GET') {
      sendError(res, 405, 'method-not-allowed', 'GET only');
      return;
    }
    const name = pathOf(req).split('/').pop() || '';
    if (!/^m_[a-f0-9-]+\.(png|mp3)$/i.test(name)) {
      sendError(res, 404, 'not-found', 'media not found');
      return;
    }
    const file = path.join(TAVERN_ROOT, 'media', name);
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': name.endsWith('.png') ? 'image/png' : 'audio/mpeg',
        'cache-control': 'private, max-age=3600',
        'content-length': data.length
      });
      res.end(data);
    } catch {
      sendError(res, 404, 'not-found', 'media file missing');
    }
  }

  const routes = [
    { kind: 'prefix', path: '/tavern/media', handler: mediaFile },
    { kind: 'exact', path: '/tavern/health', handler: async (req, res) => {
      if (!admit(ctx, req, res)) return;
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        installed: true,
        version: PLUGIN_VERSION,
        dataRoot: store.root,
        characters: store.data.characters.length,
        worlds: store.data.worlds.length,
        chats: store.data.chats.length
      });
    } },
    { kind: 'prefix', path: '/tavern/characters/parse', handler: parseCharacter },
    { kind: 'prefix', path: '/tavern/characters/import', handler: importCharacter },
    { kind: 'prefix', path: '/tavern/characters', handler: characters },
    { kind: 'prefix', path: '/tavern/worlds/import', handler: importWorld },
    { kind: 'prefix', path: '/tavern/worlds', handler: worlds },
    { kind: 'prefix', path: '/tavern/chats', handler: (req, res) => {
      const path = pathOf(req);
      if (path.endsWith('/branch')) return branchChat(req, res);
      if (path.endsWith('/export')) return exportChat(req, res);
      if (path.endsWith('/messages/stream')) return sendMessageStream(req, res);
      if (path.includes('/messages/')) return messageAction(req, res);
      if (path.endsWith('/regenerate')) return regenerate(req, res);
      if (path.includes('/messages')) return sendMessage(req, res);
      return chats(req, res);
    } },
    { kind: 'exact', path: '/tavern/prompt/preview', handler: promptPreview }
  ];

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register({ ...route, handler: wrap(route.handler) }));
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-tavern routes');

  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        log(`request failed: ${error?.message ?? error}`);
        if (!res.writableEnded) {
          sendError(res, 500, 'internal', error?.message ?? 'internal error');
        }
      }
    };
  }

  log(`v${PLUGIN_VERSION} loaded, data=${store.root}, tools=disabled`);
}
