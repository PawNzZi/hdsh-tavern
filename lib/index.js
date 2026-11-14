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
import { LlmRunner } from './llm-runner.js';
import { previewPrompt, buildGroupPrompt } from './prompt.js';
import { compactChat, normalizeMemory, planCompaction } from './memory.js';
import { extractReplyMeta } from './reply.js';
import { statusSchemaFor } from './status.js';
import { applyVariables, initialVariables, renderVariables, variableSchemaFor, variablesFromMessages } from './variables.js';
import { runAutomations } from './automation.js';
import { runScript } from './script.js';
import { detectMediaIntent } from './media-intent.js';
import { exportBackup, importBackup } from './backup.js';
import { generateImage, generateVoice, saveMedia } from './media.js';

export const name = 'hdsh-tavern';
export const inject = ['webServer', 'connection'];

const PLUGIN_VERSION = '0.4.3';
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
    scanDepth: Number(body.scanDepth) || 12,
    recursionDepth: Number.isFinite(Number(body.recursionDepth)) ? Number(body.recursionDepth) : 2,
    minActivations: Number.isFinite(Number(body.minActivations)) ? Number(body.minActivations) : 0,
    maxDepth: Number.isFinite(Number(body.maxDepth)) ? Number(body.maxDepth) : 0,
    includeNames: body.includeNames !== false,
    contextTokens: Number(body.contextTokens) || 0,
    persona: trim(body.persona, 4000),
    mainPrompt: trim(body.mainPrompt, 20000),
    countTokens
  };
}

function generationOptions(body) {
  const maxTokens = Number(body.maxTokens);
  const temperature = Number(body.temperature);
  const stop = Array.isArray(body.stop)
    ? body.stop.filter((item) => typeof item === 'string' && item.length > 0).slice(0, 8)
    : [];
  return {
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(Number.isFinite(temperature) && temperature >= 0 ? { temperature } : {}),
    ...(stop.length > 0 ? { stop } : {})
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
  const options = config !== null && typeof config === 'object' ? config : {};
  const enabled = options.enabled !== false;
  // 剧情记忆（上下文压缩）配置；全部有默认值，不配也能用。
  const memoryOptions = options.memory !== null && typeof options.memory === 'object' ? options.memory : {};
  const memoryConfig = {
    auto: memoryOptions.auto !== false,
    ratio: Math.min(1, Math.max(0.1, Number(memoryOptions.ratio) || 0.75)),
    minFold: Math.min(2000, Math.max(2, Math.floor(Number(memoryOptions.minFoldMessages) || 8))),
    foldTrigger: Math.min(5000, Math.max(4, Math.floor(Number(memoryOptions.foldTriggerMessages) || 24))),
    summaryMaxTokens: Math.min(8000, Math.max(64, Math.floor(Number(memoryOptions.summaryMaxTokens) || 1200))),
    chunkMessages: Math.min(200, Math.max(4, Math.floor(Number(memoryOptions.chunkMessages) || 24))),
    chunkChars: Math.min(200000, Math.max(1000, Math.floor(Number(memoryOptions.chunkChars) || 12000))),
    budgetTokens: Math.min(1000000, Math.max(0, Math.floor(Number(memoryOptions.budgetTokens) || 0)))
  };
  const log = (message) => {
    const line = `[dsh-tavern] ${message}`;
    try { ctx.logger?.info?.(line); } catch { /* ignore */ }
    console.info(line);
  };
  const store = new TavernStore();
  const agent = new TavernAgent({ ctx, log });
  const llmRunner = new LlmRunner({ ctx, log });
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

  const promptForChat = (chat, text, userName, body, generationType = 'normal') => {
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
    const variableSchema = variableSchemaFor(characters[0], worlds);
    const variables = chat.variables !== null && typeof chat.variables === 'object'
      ? chat.variables
      : initialVariables(variableSchema);
    options.variables = variables;
    options.variablesText = renderVariables(variables, variableSchema);
    options.injects = Array.isArray(chat.injects) ? chat.injects : [];
    options.generationType = generationType;
    // 剧情记忆：压缩摘要 + 已覆盖到哪条消息（决定逐字窗口的起点）。
    const memory = normalizeMemory(chat.memory);
    options.memory = memory?.summary ?? '';
    options.memoryThroughId = memory?.throughMessageId ?? '';
    return chat.isGroup === true
      ? buildGroupPrompt(characters, worlds, chat, text, userName, options)
      : previewPrompt(characters[0], worlds, chat, text, userName, options);
  };

  /** 群聊里模型通常用「角色名：」开头；能对上角色卡就记下说话人。 */
  const extractSpeaker = (text, characters) => {
    const match = /^\s*([^：:\n]{1,24})\s*[：:]\s*/.exec(typeof text === 'string' ? text : '');
    if (match === null) return '';
    const name = match[1].trim();
    return characters.some((character) => character.name === name) ? name : '';
  };

  const chatCharacters = (chat) => (chat.characterIds && chat.characterIds.length > 0
    ? chat.characterIds
    : [chat.characterId])
    .map((id) => store.character(id))
    .filter(Boolean);

  // 同一聊天的写入串行化：避免两个请求交错追加 user/assistant 消息。
  const chatLocks = new Map();
  async function withChatLock(key, task) {
    const previous = chatLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    chatLocks.set(key, gate);
    try {
      await previous;
      return await task();
    } finally {
      release();
      if (chatLocks.get(key) === gate) chatLocks.delete(key);
    }
  }

  function applyAutomations(chat, schema, prompt) {
    const messageIndex = chat.messages.length;
    const runs = chat.automationRuns !== null && typeof chat.automationRuns === 'object'
      ? { ...chat.automationRuns }
      : {};
    const ids = (prompt.activated || [])
      .filter((entry) => entry.reason !== 'sticky'
        && typeof entry.automationId === 'string' && entry.automationId.length > 0
        && runs[entry.automationId] !== messageIndex)
      .map((entry) => entry.automationId);
    if (ids.length === 0) return [];
    const result = runAutomations(ids, schema, {
      variables: chat.variables,
      injections: chat.injects
    });
    if (result.changed) {
      store.setChatVariables(chat.id, result.variables);
      store.setChatInjections(chat.id, result.injections);
    }
    for (const id of result.ran) runs[id] = messageIndex;
    if (result.ran.length > 0) store.setChatAutomationRuns(chat.id, runs);
    return result.log;
  }

  /**
   * 优先走 ctx.llm.stream(messages[])：真正的多轮。
   * 没有 llm 服务时退回隐藏 Agent 的 system+user 兼容路径。
   */
  async function generate(prompt, body, onDelta = null, session = null) {
    const options = generationOptions(body);
    // 固定会话：同一酒馆对话复用同一个 DSH 会话，避免每次生成都新建「无头对话」
    if (session !== null && typeof session === 'object') {
      if (typeof session.sessionId === 'string' && session.sessionId.length > 0) {
        options.sessionId = session.sessionId;
      }
      if (typeof session.userText === 'string' && session.userText.length > 0) {
        options.userText = session.userText;
      }
    }
    if (llmRunner.available()) {
      let emitted = false;
      try {
        const result = await llmRunner.complete({
          messages: prompt.messages,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          stop: options.stop,
          onDelta: onDelta === null ? undefined : (delta) => {
            emitted = true;
            onDelta(delta);
          }
        });
        if (result.text.length > 0) return result.text;
        log('llm returned empty reply, falling back to agent');
      } catch (error) {
        if (emitted) throw error;
        log(`llm generation failed, falling back to agent: ${error?.message ?? error}`);
      }
    }
    return agent.generate(prompt.system, prompt.user, 120000, onDelta, options);
  }

  /**
   * 摘要模型调用：优先直连 ctx.llm（不产生会话）；没有 llm 服务时用
   * 固定 id 的隐藏 Agent（每个对话一条，避免每次压缩都新建无头会话）。
   */
  async function summarizeMemory(chat, { system, user, maxTokens }) {
    const limit = Math.max(64, Math.min(8000, Math.floor(Number(maxTokens) || memoryConfig.summaryMaxTokens)));
    if (llmRunner.available()) {
      const result = await llmRunner.complete({
        messages: [
          { role: 'system', content: [{ type: 'text', text: system }] },
          { role: 'user', content: [{ type: 'text', text: user }] }
        ],
        maxTokens: limit,
        temperature: 0.2
      });
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      if (text.length === 0) throw new Error('摘要模型返回为空');
      return text;
    }
    return agent.generate(system, user, 120000, null, {
      sessionId: `tavern-mem-${chat.id}`,
      maxTokens: limit,
      temperature: 0.2
    });
  }

  /** 模型上下文窗口；拿不到返回 0。60 秒缓存，避免每条消息都问一次适配器。 */
  let windowCache = 0;
  let windowCacheAt = 0;
  async function modelContextWindow() {
    if (windowCache > 0 && Date.now() - windowCacheAt < 60000) return windowCache;
    try {
      const selection = agent.model();
      const llm = ctx.get?.('llm');
      if (typeof llm?.resolveModelInfo !== 'function') return 0;
      const info = await llm.resolveModelInfo(selection.provider, selection.model);
      const context = Number(info?.context);
      if (Number.isFinite(context) && context > 0) {
        windowCache = context;
        windowCacheAt = Date.now();
        return context;
      }
    } catch {
      // 适配器不支持/未配置时退回默认预算
    }
    return 0;
  }

  /**
   * 压缩预算：优先用 App 传来的「上下文总 Token」，否则用配置，最后按模型窗口推算。
   */
  async function resolveContextBudget(body) {
    const explicit = Math.max(0, Math.min(1000000, Number(body?.contextTokens) || 0));
    if (explicit > 0) return explicit;
    if (memoryConfig.budgetTokens > 0) return memoryConfig.budgetTokens;
    const window = await modelContextWindow();
    if (window > 0) {
      const output = Math.max(512, Math.min(32768, Number(body?.maxTokens) || 2048));
      return Math.max(4096, window - output - 8192);
    }
    return 24000;
  }

  /**
   * 执行一次压缩。调用方必须已经持有该 chat 的 withChatLock。
   * 压缩成功后重置隐藏 Agent 会话，下一轮才会以「摘要 + 尾部」重建上下文。
   */
  async function runCompaction(chat, body, mode, context = {}) {
    const character = store.character(chat.characterId);
    const keep = Number.isFinite(Number(context.keep))
      ? Number(context.keep)
      : Number(body?.historyLimit);
    try {
      const result = await compactChat({
        chat,
        store,
        historyLimit: Math.max(2, Math.min(100, keep || 24)),
        minFoldMessages: mode === 'manual' ? 1 : memoryConfig.minFold,
        summaryMaxTokens: memoryConfig.summaryMaxTokens,
        chunkMessages: memoryConfig.chunkMessages,
        chunkChars: memoryConfig.chunkChars,
        countTokens,
        userName: trim(body?.userName, 40) || '你',
        characterName: character?.name || '角色',
        mode,
        force: mode === 'manual',
        summarize: (input) => summarizeMemory(chat, input),
        log
      });
      if (result.ok) {
        resetChatSession(chat);
        log(`memory updated for chat ${chat.id}: folded ${result.stats.foldedMessages} messages, ~${result.stats.beforeTokens} -> ~${result.stats.afterTokens} tokens`);
      }
      return result;
    } catch (error) {
      log(`memory compaction failed: ${error?.message ?? error}`);
      return { ok: false, reason: 'failed', message: String(error?.message ?? error) };
    }
  }

  /**
   * 自动压缩：攒够一批（条数）或 prompt 超过预算比例时压一次。
   * 返回可能被重建的 prompt。
   */
  async function maybeCompact(chat, prompt, body, text, userName) {
    if (!memoryConfig.auto) return prompt;
    const plan = planCompaction({
      messages: chat.messages,
      historyLimit: Number(body?.historyLimit) || 24,
      memory: chat.memory
    });
    if (plan.foldable < memoryConfig.minFold) return prompt;
    let triggered = plan.foldable >= memoryConfig.foldTrigger;
    if (!triggered) {
      const budget = await resolveContextBudget(body);
      triggered = budget > 0 && prompt.totalTokens > budget * memoryConfig.ratio;
    }
    if (!triggered) return prompt;
    const result = await runCompaction(chat, body, 'auto');
    if (!result.ok) return prompt;
    return promptForChat(chat, text, userName, body) ?? prompt;
  }

  const mediaLimit = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(50, Math.floor(number)));
  };

  /** 读角色头像，作为生图的参考图。读不到就返回 null（退回纯文生图）。 */
  function avatarReference(character) {
    const file = typeof character?.avatar === 'string' ? character.avatar : '';
    if (file.length === 0) return null;
    try {
      const buffer = fs.readFileSync(file);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
      // 接口限制单图 ≤20MB，这里留点余量
      if (buffer.length > 18 * 1024 * 1024) return null;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      let mime = '';
      if (buffer.length >= 8 && buffer.subarray(0, 8).equals(png)) mime = 'image/png';
      else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg';
      if (mime.length === 0) return null;
      return { mime, base64: buffer.toString('base64') };
    } catch {
      return null;
    }
  }

  async function attachMedia(chat, character, body, cleaned, messageId, userText) {
    const apiKey = trim(body.apiKey, 500);
    if (apiKey.length === 0) return {};
    const imageLimit = mediaLimit(body.imageLimit, 3);
    const voiceLimit = mediaLimit(body.voiceLimit, 5);
    const mode = body.autoMedia === 'off' || body.autoMedia === 'auto' ? body.autoMedia : 'explicit';
    const intent = detectMediaIntent({ userText: userText ?? '', replyText: cleaned.text, mode });
    const usage = store.mediaUsage(character.id);
    const wantImage = cleaned.imagePrompt.length > 0 || intent.image;
    const wantVoice = cleaned.voiceText.length > 0 || intent.voice;
    const result = {};
    if (wantImage && imageLimit > 0 && usage.image < imageLimit) {
      try {
        // 提示词里带上角色外貌，配合头像参考图，人物才稳定。
        const appearance = String(character.description || '').trim().slice(0, 300);
        const prompt = cleaned.imagePrompt.length > 0
          ? cleaned.imagePrompt
          : `${character.name}${appearance.length > 0 ? `（${appearance}）` : ''}，${userText}，日常手机生活照，保持参考图里这个人的长相与发型，自然光线，画面干净，无文字无水印`;
        const reference = avatarReference(character);
        const workspace = trim(body.workspaceId, 120);
        let buffer;
        try {
          buffer = await generateImage({ apiKey, workspaceId: workspace, prompt, reference });
        } catch (error) {
          if (reference === null) throw error;
          // 参考图被拒（例如 PNG 带 alpha 通道）时退回纯文生图，至少还能出图
          log(`image with avatar reference failed, retrying text-only: ${error?.message ?? error}`);
          buffer = await generateImage({ apiKey, workspaceId: workspace, prompt });
        }
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
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const character = characters[0];
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
      let userMessage = null;
      let assistantMessage = null;
      try {
        const body = await readJson(req);
        const text = trim(body.text, 20000).trim();
        if (text.length === 0) {
          sendError(res, 400, 'bad-request', 'text is required');
          return;
        }
        const userName = trim(body.userName, 40) || '你';
        let prompt = promptForChat(chat, text, userName, body);
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        // 自动压缩：在拼完 prompt、追加用户消息之前做，压缩后的摘要立刻生效。
        prompt = await maybeCompact(chat, prompt, body, text, userName);
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
        const rawReply = await generate(prompt, body, (delta) => {
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
        }, {
          // 这个对话固定用的 DSH 会话（没有就创建并存下来），
          // userText 用于「会话已有历史时只补发本次输入」。
          sessionId: store.ensureAgentSession(chat.id),
          userText: text
        });
        const statusSchema = statusSchemaFor(character, worlds);
        const cleaned = extractReplyMeta(rawReply, statusSchema);
        const variableSchema = variableSchemaFor(character, worlds);
        const previousVariables = chat.variables !== null && typeof chat.variables === 'object'
          ? chat.variables
          : initialVariables(variableSchema);
        const applied = applyVariables(cleaned.statusLines, previousVariables, variableSchema);
        const speaker = chat.isGroup === true ? extractSpeaker(cleaned.text, characters) : '';
        assistantMessage = store.appendMessage(chat.id, 'assistant', cleaned.text, {
          statusLines: applied.lines,
          quickOptions: cleaned.quickOptions,
          speaker
        });
        store.setChatVariables(chat.id, applied.variables);
        const automations = applyAutomations(chat, statusSchema, prompt);
        const media = await attachMedia(chat, character, body, { ...cleaned, statusLines: applied.lines }, assistantMessage.id, text);
        store.updateWorldState(chat.id, prompt.worldState);
        if (!res.writableEnded) {
          res.write(`event: done\ndata: ${JSON.stringify({
            user: userMessage,
            reply: { ...assistantMessage, ...media },
            variables: applied.variables,
            automations,
            streamed,
            prompt: {
              activated: prompt.activated,
              truncated: prompt.truncated,
              worldChars: prompt.worldChars,
              worldTokens: prompt.worldTokens
            }
          })}\n\n`);
          res.end();
        }
      } catch (error) {
        log(`stream chat failed: ${error?.message ?? error}`);
        // 只有回复没落盘时才回滚用户消息，避免出现“有角色回复但没有用户输入”的聊天。
        if (assistantMessage === null && userMessage !== null) {
          store.deleteMessage(chat.id, userMessage.id);
        }
        if (!res.writableEnded) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message ?? 'model failed' })}\n\n`);
            res.end();
          } catch {
            // 连接已断开
          }
        }
      }
    });
  }

  async function sendMessage(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const chatId = pathOf(req).split('/')[3] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const character = characters[0];
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
      try {
        const body = await readJson(req);
        const text = trim(body.text, 20000).trim();
        if (text.length === 0) {
          sendError(res, 400, 'bad-request', 'text is required');
          return;
        }
        const userName = trim(body.userName, 40) || '你';
        let prompt = promptForChat(chat, text, userName, body);
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        prompt = await maybeCompact(chat, prompt, body, text, userName);
        const reply = await generate(prompt, body, null);
        const statusSchema = statusSchemaFor(character, worlds);
        const cleaned = extractReplyMeta(reply, statusSchema);
        const variableSchema = variableSchemaFor(character, worlds);
        const previousVariables = chat.variables !== null && typeof chat.variables === 'object'
          ? chat.variables
          : initialVariables(variableSchema);
        const applied = applyVariables(cleaned.statusLines, previousVariables, variableSchema);
        const speaker = chat.isGroup === true ? extractSpeaker(cleaned.text, characters) : '';
        const userMessage = store.appendMessage(chat.id, 'user', text);
        const assistantMessage = store.appendMessage(chat.id, 'assistant', cleaned.text, {
          statusLines: applied.lines,
          quickOptions: cleaned.quickOptions,
          speaker
        });
        store.setChatVariables(chat.id, applied.variables);
        const automations = applyAutomations(chat, statusSchema, prompt);
        const media = await attachMedia(chat, character, body, { ...cleaned, statusLines: applied.lines }, assistantMessage.id, text);
        store.updateWorldState(chat.id, prompt.worldState);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          user: userMessage,
          reply: { ...assistantMessage, ...media },
          variables: applied.variables,
          automations,
          prompt: {
            activated: prompt.activated,
            truncated: prompt.truncated,
            worldChars: prompt.worldChars,
            worldTokens: prompt.worldTokens
          }
        });
      } catch (error) {
        log(`chat failed: ${error?.message ?? error}`);
        sendError(res, 502, 'model-error', error?.message ?? 'model failed');
      }
    });
  }

  async function branchChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const source = store.chat(chatId);
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
    });
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
    await withChatLock(chatId, async () => {
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
          resetChatSession(chat);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, message });
          return;
        }
        if (method === 'DELETE') {
          const deleted = store.deleteMessage(chatId, messageId);
          if (deleted) {
            resetChatSession(chat);
          }
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, deleted });
          return;
        }
        sendError(res, 405, 'method-not-allowed', 'PATCH or DELETE only');
      } catch (error) {
        sendError(res, 400, 'bad-request', error?.message ?? 'message operation failed');
      }
    });
  }

  async function regenerate(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
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
        const userName = trim(body.userName, 40) || '你';
        const variableSchema = variableSchemaFor(character, worlds);
        const previousVariables = variablesFromMessages(history, variableSchema);
        const prompt = promptForChat({
          ...chat,
          messages: history,
          variables: previousVariables
        }, userText, userName, body, 'regenerate');
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        const reply = await generate(prompt, body, null);
        const statusSchema = statusSchemaFor(character, worlds);
        const cleaned = extractReplyMeta(reply, statusSchema);
        const applied = applyVariables(cleaned.statusLines, previousVariables, variableSchema);
        const speaker = chat.isGroup === true ? extractSpeaker(cleaned.text, characters) : '';
        const appended = store.appendSwipe(chat.id, chat.messages[targetIndex].id, cleaned.text);
        const message = appended === null
          ? null
          : store.updateMessage(chat.id, appended.id, appended.text, {
            statusLines: applied.lines,
            quickOptions: cleaned.quickOptions,
            speaker
          });
        if (message === null) {
          sendError(res, 502, 'model-error', '模型没有返回可用候选');
          return;
        }
        store.setChatVariables(chat.id, applied.variables);
        store.updateWorldState(chat.id, prompt.worldState);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          message,
          variables: applied.variables,
          prompt: {
            activated: prompt.activated,
            truncated: prompt.truncated,
            worldChars: prompt.worldChars,
            worldTokens: prompt.worldTokens
          }
        });
      } catch (error) {
        log(`regenerate failed: ${error?.message ?? error}`);
        sendError(res, 502, 'model-error', error?.message ?? 'model failed');
      }
    });
  }

  async function swipeChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const character = characters[0];
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
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
        const userName = trim(body.userName, 40) || '你';
        const variableSchema = variableSchemaFor(character, worlds);
        const baseVariables = variablesFromMessages(history, variableSchema);
        const prompt = promptForChat({
          ...chat,
          messages: history,
          variables: baseVariables
        }, userText, userName, body, 'swipe');
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        const count = Math.max(1, Math.min(4, Number(body.count) || 1));
        const schema = statusSchemaFor(character, worlds);
        let last = null;
        let lastClean = null;
        for (let index = 0; index < count; index += 1) {
          const reply = await generate(prompt, body, null);
          const cleaned = extractReplyMeta(reply, schema);
          if (cleaned.text.trim().length === 0) continue;
          last = store.appendSwipe(chat.id, chat.messages[targetIndex].id, cleaned.text);
          lastClean = cleaned;
        }
        if (last === null || lastClean === null) {
          sendError(res, 502, 'model-error', '模型没有返回可用候选');
          return;
        }
        const applied = applyVariables(lastClean.statusLines, baseVariables, variableSchema);
        last = store.updateMessage(chat.id, last.id, last.text, {
          statusLines: applied.lines,
          quickOptions: lastClean.quickOptions
        });
        store.setChatVariables(chat.id, applied.variables);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          message: last,
          variables: applied.variables
        });
      } catch (error) {
        log(`swipe failed: ${error?.message ?? error}`);
        sendError(res, 502, 'model-error', error?.message ?? 'swipe failed');
      }
    });
  }

  async function selectSwipe(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
      try {
        const body = await readJson(req);
        const targetId = trim(body.messageId, 100);
        const index = Number(body.index);
        if (!Number.isFinite(index)) {
          sendError(res, 400, 'bad-request', 'index is required');
          return;
        }
        const message = store.selectSwipe(chatId, targetId, index);
        if (message === null) {
          sendError(res, 404, 'not-found', 'swipe not found');
          return;
        }
        const messageIndex = chat.messages.findIndex((item) => item.id === message.id);
        const history = messageIndex > 0 ? chat.messages.slice(0, messageIndex) : [];
        const schema = statusSchemaFor(characters[0], worlds);
        const variableSchema = variableSchemaFor(characters[0], worlds);
        const baseVariables = variablesFromMessages(history, variableSchema);
        const cleaned = extractReplyMeta(message.text, schema);
        const applied = applyVariables(cleaned.statusLines, baseVariables, variableSchema);
        const updated = store.updateMessage(chatId, message.id, message.text, {
          statusLines: applied.lines,
          quickOptions: cleaned.quickOptions
        });
        store.setChatVariables(chatId, applied.variables);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          message: updated,
          variables: applied.variables
        });
      } catch (error) {
        sendError(res, 400, 'bad-request', error?.message ?? 'select swipe failed');
      }
    });
  }

  async function deleteSwipe(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      try {
        const body = await readJson(req);
        const message = store.deleteSwipe(chatId, trim(body.messageId, 100), Number(body.index));
        if (message === null) {
          sendError(res, 400, 'bad-request', 'cannot delete this swipe');
          return;
        }
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, message });
      } catch (error) {
        sendError(res, 400, 'bad-request', error?.message ?? 'delete swipe failed');
      }
    });
  }

  async function continueChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      const character = characters[0];
      const worlds = [...new Set(characters.flatMap((item) => item.worldIds || []))]
        .map((id) => store.world(id))
        .filter(Boolean);
      const lastIndex = chat.messages.map((message) => message.role).lastIndexOf('assistant');
      if (lastIndex < 0) {
        sendError(res, 400, 'bad-request', 'no assistant message to continue');
        return;
      }
      try {
        const body = await readJson(req);
        const userName = trim(body.userName, 40) || '你';
        const prompt = promptForChat(chat,
          '（继续你上一条回复，从中断处接着写，不要重复已经写过的内容，不要解释）',
          userName, body, 'continue');
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        const reply = await generate(prompt, body, null);
        const schema = statusSchemaFor(character, worlds);
        const cleaned = extractReplyMeta(reply, schema);
        if (cleaned.text.trim().length === 0) {
          sendError(res, 502, 'model-error', '模型没有返回内容');
          return;
        }
        const target = chat.messages[lastIndex];
        const message = store.appendToMessage(chatId, target.id, cleaned.text);
        const variableSchema = variableSchemaFor(character, worlds);
        const baseVariables = variablesFromMessages(chat.messages.slice(0, lastIndex), variableSchema);
        const applied = applyVariables(cleaned.statusLines, baseVariables, variableSchema);
        const updated = store.updateMessage(chatId, target.id, message.text, {
          statusLines: applied.lines,
          quickOptions: cleaned.quickOptions
        });
        store.setChatVariables(chatId, applied.variables);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          message: updated,
          variables: applied.variables
        });
      } catch (error) {
        log(`continue failed: ${error?.message ?? error}`);
        sendError(res, 502, 'model-error', error?.message ?? 'continue failed');
      }
    });
  }

  async function impersonateChat(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      const characters = chatCharacters(chat);
      if (characters.length === 0) {
        sendError(res, 404, 'not-found', 'character not found');
        return;
      }
      try {
        const body = await readJson(req);
        const userName = trim(body.userName, 40) || '你';
        const prompt = promptForChat(chat, '（请以用户身份写一句我会说的话）', userName, body, 'impersonate');
        if (prompt === null) {
          sendError(res, 404, 'not-found', 'character not found');
          return;
        }
        const instruction = `【本次任务】不要以角色身份回复。以用户「${userName}」的身份，写一句用户在此时会说的话；只输出这句话，不要加引号，不要写角色台词，不要解释。`;
        if (Array.isArray(prompt.messages) && prompt.messages.length > 0) {
          const first = prompt.messages[0];
          if (first.role === 'system' && Array.isArray(first.content) && first.content[0]?.type === 'text') {
            first.content[0] = { type: 'text', text: `${first.content[0].text}\n\n${instruction}` };
          }
        }
        prompt.system = `${prompt.system}\n\n${instruction}`;
        const reply = await generate(prompt, body, null);
        const cleaned = extractReplyMeta(reply, null);
        if (cleaned.text.trim().length === 0) {
          sendError(res, 502, 'model-error', '模型没有返回内容');
          return;
        }
        const message = store.appendMessage(chat.id, 'user', cleaned.text);
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          message,
          variables: chat.variables ?? {}
        });
      } catch (error) {
        log(`impersonate failed: ${error?.message ?? error}`);
        sendError(res, 502, 'model-error', error?.message ?? 'impersonate failed');
      }
    });
  }


  async function runScriptEndpoint(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const parts = pathOf(req).split('/').filter(Boolean);
    const chatId = parts[2] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      try {
        const body = await readJson(req);
        const script = trim(body.script, 20000);
        if (script.length === 0) {
          sendError(res, 400, 'bad-request', 'script is required');
          return;
        }
        const result = runScript(script, {
          variables: chat.variables,
          injections: chat.injects
        });
        if (result.changed) {
          store.setChatVariables(chat.id, result.variables);
          store.setChatInjections(chat.id, result.injections);
        }
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          output: result.output,
          log: result.log,
          variables: result.variables,
          injects: result.injections
        });
      } catch (error) {
        sendError(res, 400, 'bad-request', error?.message ?? 'script failed');
      }
    });
  }

  async function backupEndpoint(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const path = pathOf(req);
    try {
      const body = await readJson(req);
      if (path.endsWith('/export')) {
        const bundle = exportBackup(store, {
          characterIds: body.characterIds,
          chatIds: body.chatIds,
          worldIds: body.worldIds
        });
        sendJson(res, 200, bundle);
        return;
      }
      if (path.endsWith('/import')) {
        const bundle = body.backup ?? body;
        const result = importBackup(store, bundle);
        sendJson(res, 200, { imported: result });
        return;
      }
      sendError(res, 404, 'not-found', 'backup route not found');
    } catch (error) {
      sendError(res, 400, 'bad-request', error?.message ?? 'backup failed');
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

  /** GET/PUT/DELETE /tavern/chats/:id/memory */
  async function memoryEndpoint(req, res) {
    if (!admit(ctx, req, res)) return;
    const chatId = pathOf(req).split('/')[3] || '';
    const chat = store.chat(chatId);
    if (chat === null) {
      sendError(res, 404, 'not-found', 'chat not found');
      return;
    }
    const method = methodOf(req);
    if (method === 'GET') {
      // 允许 App 带上当前「历史条数」，否则按默认 24 条估算待压缩量。
      let historyLimit = 24;
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const raw = Number(url.searchParams.get('historyLimit'));
        if (Number.isFinite(raw) && raw > 0) historyLimit = raw;
      } catch {
        // 用默认值
      }
      const plan = planCompaction({ messages: chat.messages, historyLimit, memory: chat.memory });
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        chatId,
        memory: normalizeMemory(chat.memory),
        memoryLog: Array.isArray(chat.memoryLog) ? chat.memoryLog.slice(-10) : [],
        stats: {
          messages: chat.messages.length,
          foldable: plan.foldable,
          tail: plan.tail
        },
        config: {
          auto: memoryConfig.auto,
          ratio: memoryConfig.ratio,
          minFoldMessages: memoryConfig.minFold,
          foldTriggerMessages: memoryConfig.foldTrigger,
          summaryMaxTokens: memoryConfig.summaryMaxTokens
        }
      });
      return;
    }
    if (method === 'PUT') {
      try {
        const body = await readJson(req);
        const summary = trim(body.summary, 20000).trim();
        if (summary.length === 0) {
          store.clearChatMemory(chat.id);
          resetChatSession(chat);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chatId, memory: null, cleared: true });
          return;
        }
        const current = normalizeMemory(chat.memory);
        const memory = store.setChatMemory(chat.id, {
          version: 1,
          summary,
          throughMessageId: current?.throughMessageId ?? '',
          sourceMessages: current?.sourceMessages ?? 0,
          tokens: countTokens(summary),
          updatedAt: Date.now()
        });
        resetChatSession(chat);
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chatId, memory });
      } catch (error) {
        sendError(res, 400, 'bad-request', error?.message ?? 'memory update failed');
      }
      return;
    }
    if (method === 'DELETE') {
      store.clearChatMemory(chat.id);
      resetChatSession(chat);
      sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, chatId, memory: null, cleared: true });
      return;
    }
    sendError(res, 405, 'method-not-allowed', 'GET/PUT/DELETE only');
  }

  /** POST /tavern/chats/:id/compact —— 手动压缩一次。 */
  async function compactChatEndpoint(req, res) {
    if (!admit(ctx, req, res)) return;
    if (methodOf(req) !== 'POST') {
      sendError(res, 405, 'method-not-allowed', 'POST only');
      return;
    }
    const chatId = pathOf(req).split('/')[3] || '';
    await withChatLock(chatId, async () => {
      const chat = store.chat(chatId);
      if (chat === null) {
        sendError(res, 404, 'not-found', 'chat not found');
        return;
      }
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const result = await runCompaction(chat, body, 'manual', {
        keep: body.keep ?? body.historyLimit
      });
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        chatId,
        ok: result.ok === true,
        reason: result.ok === true ? undefined : (result.reason ?? 'skipped'),
        memory: normalizeMemory(chat.memory),
        stats: result.stats ?? null
      });
    });
  }

  const routes = [
    { kind: 'prefix', path: '/tavern/media', handler: mediaFile, allowWhenDisabled: true },
    { kind: 'exact', path: '/tavern/health', allowWhenDisabled: true, handler: async (req, res) => {
      if (!admit(ctx, req, res)) return;
      sendJson(res, 200, {
        schemaVersion: SCHEMA_VERSION,
        installed: true,
        enabled,
        version: PLUGIN_VERSION,
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
    { kind: 'prefix', path: '/tavern/backup', handler: backupEndpoint },
    { kind: 'prefix', path: '/tavern/chats', handler: (req, res) => {
      const path = pathOf(req);
      if (path.endsWith('/compact')) return compactChatEndpoint(req, res);
      if (path.endsWith('/memory')) return memoryEndpoint(req, res);
      if (path.endsWith('/branch')) return branchChat(req, res);
      if (path.endsWith('/export')) return exportChat(req, res);
      if (path.endsWith('/swipe/select')) return selectSwipe(req, res);
      if (path.endsWith('/swipe/delete')) return deleteSwipe(req, res);
      if (path.endsWith('/swipe')) return swipeChat(req, res);
      if (path.endsWith('/continue')) return continueChat(req, res);
      if (path.endsWith('/impersonate')) return impersonateChat(req, res);
      if (path.endsWith('/script')) return runScriptEndpoint(req, res);
      if (path.endsWith('/messages/stream')) return sendMessageStream(req, res);
      if (path.includes('/messages/')) return messageAction(req, res);
      if (path.endsWith('/regenerate')) return regenerate(req, res);
      if (path.includes('/messages')) return sendMessage(req, res);
      return chats(req, res);
    } },
    { kind: 'exact', path: '/tavern/prompt/preview', handler: promptPreview }
  ];

  ctx.effect(() => {
    const disposers = routes.map(({ allowWhenDisabled, ...route }) => ctx.webServer.register({
      ...route,
      handler: wrap(route.handler, allowWhenDisabled === true)
    }));
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
    };
  }, 'dsh-tavern routes');

  /**
   * 消息被改/删后丢弃这个对话的 Agent 会话，避免旧历史继续进入上下文。
   * 尽力而为：拿不到 agents 服务也不会影响消息本身的操作。
   */
  function resetChatSession(chat) {
    const sessionId = typeof chat?.agentSessionId === 'string' ? chat.agentSessionId : '';
    if (sessionId.length === 0) return;
    try {
      const agents = ctx.get?.('agents');
      const live = typeof agents?.get === 'function' ? agents.get(sessionId) : null;
      if (live && typeof live.dispose === 'function') {
        Promise.resolve(live.dispose()).catch(() => {});
      }
    } catch { /* ignore */ }
    store.resetAgentSession(chat.id);
    log(`agent session reset for chat ${chat.id} (was ${sessionId})`);
  }

  function wrap(handler, allowWhenDisabled = false) {
    return async (req, res) => {
      try {
        if (!enabled && !allowWhenDisabled) {
          sendError(res, 409, 'disabled', 'tavern is disabled');
          return;
        }
        await handler(req, res);
      } catch (error) {
        log(`request failed: ${error?.message ?? error}`);
        if (!res.writableEnded) {
          sendError(res, 500, 'internal', error?.message ?? 'internal error');
        }
      }
    };
  }

  log(`v${PLUGIN_VERSION} loaded, data=${store.root}, enabled=${enabled}, tools=disabled`);
}
