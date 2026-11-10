/**
 * 酒馆专用隐藏 Agent。
 *
 * 强制：
 *   - 使用独立 tavern-roleplay 预设；
 *   - 预设 plugins 为空，不挂 shell/文件/命令/MCP；
 *   - 只使用 DSH 默认模型；
 *   - 每轮一个短生命周期 session，避免跨角色上下文污染。
 */
import { randomUUID } from 'node:crypto';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blocksToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function fold(events) {
  let text = '';
  let reason = null;
  for (const event of events) {
    if (event?.type === 'assistant/message') {
      const candidate = blocksToText(event.data?.message?.content);
      if (candidate.length > 0) text = candidate;
    } else if (event?.type === 'turn/end') {
      reason = event.data?.reason ?? null;
    }
  }
  return { text, reason };
}

export class TavernAgent {
  constructor({ ctx, log }) {
    this.ctx = ctx;
    this.log = log || (() => {});
    this.presetRegistered = false;
  }

  model() {
    let selection;
    try {
      selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    } catch (error) {
      throw new Error(`无法读取默认模型：${error?.message ?? error}`);
    }
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      throw new Error('DSH 没有配置默认模型');
    }
    return selection;
  }

  async ensurePreset() {
    if (this.presetRegistered) return true;
    const presets = this.ctx.get('agentPresets');
    if (!presets || typeof presets.register !== 'function' || typeof presets.mount !== 'function') {
      // 没有 registry 时不挂任何预设；Agent 只拿到当前 systemPrompt，不注册工具。
      this.presetRegistered = true;
      return false;
    }
    try {
      await presets.register({
        id: 'tavern-roleplay',
        name: '酒馆角色扮演',
        description: 'SillyTavern 兼容角色扮演；不挂任何工具',
        order: 60,
        plugins: []
      });
    } catch (error) {
      // 热重载可能重复注册，同名预设可以继续使用。
      if (!String(error?.message ?? error).includes('Duplicate agent preset')) {
        throw error;
      }
    }
    this.presetRegistered = true;
    return true;
  }

  async generate(system, user, timeoutMs = 120000, onDelta = null, generation = {}) {
    const hasPreset = await this.ensurePreset();
    const agents = this.ctx.get('agents');
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('DSH 没有可用的 Agent 运行时');
    }
    const presets = this.ctx.get('agentPresets');
    const selection = this.model();
    // 调用方可以指定一个固定的会话 id（每个酒馆对话一个）：
    // 之前这里每次随机 uuid，于是 DSH 会话列表里堆出一堆「无头对话」。
    const sessionId = typeof generation.sessionId === 'string' && generation.sessionId.length > 0
      ? generation.sessionId
      : `tavern-${randomUUID()}`;
    const createOptions = {
      sessionId,
      // 系统提示词会读取 {{cwd}}；这里只提供一个占位目录，不挂任何文件/命令工具。
      meta: { cwd: process.cwd() },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        ...(Number.isFinite(Number(generation.maxTokens)) && Number(generation.maxTokens) > 0
          ? { maxTokens: Math.min(32768, Math.floor(Number(generation.maxTokens))) }
          : {}),
        ...(Number.isFinite(Number(generation.temperature)) && Number(generation.temperature) >= 0
          ? { temperature: Math.max(0, Math.min(2, Number(generation.temperature))) }
          : {})
      },
      setup: async (agentCtx) => {
        const systemPrompt = agentCtx.get?.('systemPrompt') ?? this.ctx.get('systemPrompt');
        if (systemPrompt && typeof systemPrompt.section === 'function') {
          systemPrompt.section({
            name: 'tavern:character',
            order: 5000,
            text: () => system,
            interpolate: false
          });
        }
        if (typeof agentCtx.on === 'function' && typeof onDelta === 'function') {
          agentCtx.on('agent/assistant-stream', (payload) => {
            const frame = payload?.frame;
            if (frame?.type === 'chunk'
              && frame.chunk?.type === 'text-delta'
              && typeof frame.chunk.text === 'string'
              && frame.chunk.text.length > 0) {
              onDelta(frame.chunk.text);
            }
          });
        }
        if (hasPreset) {
          try {
            await presets.mount(agentCtx, 'tavern-roleplay');
          } catch (error) {
            // 恢复会话时重复挂载同一个预设有可能会报错，忽略即可
            this.log(`mount preset on resume failed: ${error?.message ?? error}`);
          }
        }
      }
    };
    let handle = null;
    try {
      // 1) 会话还活着（同一进程内连续对话）→ 直接复用
      let agent = typeof agents.get === 'function' ? agents.get(sessionId) : null;
      // 2) 会话持久化过、但 agent 已经 dispose → 恢复同一个会话，而不是新建
      if (!agent && typeof agents.resume === 'function') {
        try {
          handle = await agents.resume(createOptions);
          agent = handle.agent;
        } catch (error) {
          handle = null;
          this.log(`resume ${sessionId} failed, creating a new session: ${error?.message ?? error}`);
        }
      }
      // 3) 全新对话
      if (!agent) {
        try {
          handle = await agents.create(createOptions);
          agent = handle.agent;
        } catch (error) {
          // 会话 id 已存在、但又恢复不起来：退一步用全新会话，保证聊天不中断
          this.log(`create ${sessionId} failed, using a fresh session: ${error?.message ?? error}`);
          handle = await agents.create({
            ...createOptions,
            sessionId: `tavern-${randomUUID()}`
          });
          agent = handle.agent;
        }
      }
      const session = agent?.session;
      if (!session || typeof session.snapshotEvents !== 'function') {
        throw new Error('酒馆 Agent 没有 session');
      }
      // 续用的会话里已经带着之前那几轮（包括我们喂进去的整段提示词），
      // 再送一遍完整 prompt 会把历史重复给模型，所以这里只补发本次用户输入。
      const resumed = (Number(session.seq) || 0) > 0;
      const input = resumed
        && typeof generation.userText === 'string'
        && generation.userText.length > 0
        ? generation.userText
        : user;
      const from = Number(session.seq) || 0;
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: input }],
        source: { kind: 'user' }
      });
      await new Promise((resolve) => setImmediate(resolve));
      const idle = Promise.resolve(agent.whenIdle());
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('模型响应超时')), timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([idle, timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      let events = session.snapshotEvents(from);
      if (events.length === 0) {
        await delay(120);
        events = session.snapshotEvents(from);
      }
      const result = fold(events);
      if (result.text.trim().length === 0) {
        this.log(`empty reply, reason=${JSON.stringify(result.reason ?? null)}, events=${events.length}`);
        throw new Error(result.reason?.kind === 'error' ? '模型调用失败' : '模型返回为空');
      }
      return result.text.trim().slice(0, 200000);
    } finally {
      if (handle !== null && typeof handle.dispose === 'function') {
        try { await handle.dispose(); } catch { /* ignore */ }
      }
    }
  }
}
