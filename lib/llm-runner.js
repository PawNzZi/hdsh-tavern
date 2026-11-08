/**
 * 直接调用 DSH LLM 服务，传入完整的 messages 数组。
 *
 * 这是「真正的多轮 messages」：system / user / assistant 按真实轮次发送，
 * 不再把历史拍平成一条 user 文本，也不需要每轮创建隐藏 Agent。
 * 只有 DSH 没有 llm 服务时才退回 AgentRunner（单条 user 的兼容路径）。
 */
import { randomUUID } from 'node:crypto';

function textOfBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export class LlmRunner {
  constructor({ ctx, log }) {
    this.ctx = ctx;
    this.log = log || (() => {});
  }

  available() {
    try {
      return typeof this.ctx.get?.('llm')?.stream === 'function';
    } catch {
      return false;
    }
  }

  selection() {
    let selection;
    try {
      selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
    } catch (error) {
      throw new Error(`无法读取默认模型：${error?.message ?? error}`);
    }
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      throw new Error('DSH 没有配置默认模型');
    }
    return selection;
  }

  /**
   * 流式生成一次。
   * @param {{messages: object[], maxTokens?: number, temperature?: number, stop?: string[], signal?: AbortSignal, onDelta?: (text: string) => void}} input
   * @returns {Promise<{text: string, finish: object | null}>}
   */
  async complete({ messages, maxTokens, temperature, stop, signal, onDelta }) {
    const llm = this.ctx.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('DSH 没有可用的 llm 服务');
    }
    const selection = this.selection();
    const options = {
      provider: selection.provider,
      model: selection.model,
      messages,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      ...(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
        ? { maxTokens: Math.min(32768, Math.floor(Number(maxTokens))) }
        : {}),
      ...(Number.isFinite(Number(temperature)) && Number(temperature) >= 0
        ? { temperature: Math.max(0, Math.min(2, Number(temperature))) }
        : {}),
      ...(Array.isArray(stop) && stop.length > 0 ? { stop: stop.slice(0, 8).map(String) } : {}),
      ...(signal === undefined ? {} : { signal })
    };
    let text = '';
    let blockText = '';
    let sawDelta = false;
    let finish = null;
    for await (const chunk of llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
        sawDelta = true;
        onDelta?.(chunk.text);
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        blockText += chunk.block.text;
      } else if (chunk.type === 'finish') {
        finish = chunk.reason ?? null;
        if (finish?.kind === 'aborted') {
          throw new Error('生成已取消');
        }
        if (finish?.kind === 'error') {
          const message = finish?.failure?.message ?? finish?.failure?.code ?? '模型调用失败';
          throw new Error(message);
        }
      } else if (chunk.type === 'error') {
        throw new Error(chunk.message ?? chunk.failure?.message ?? '模型调用失败');
      }
    }
    if (!sawDelta && blockText.length > 0) text = blockText;
    return { text: text.trim(), finish };
  }

  /** 生成多个候选（swipe）。每次调用都是独立的一轮，只改变采样。 */
  async variants(input, count = 2) {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      const result = await this.complete({
        ...input,
        // 给每次候选一个不同的 id，避免 provider 侧做过强的请求级去重。
        messages: input.messages.map((message) => ({ ...message })),
        temperature: input.temperature
      });
      if (result.text.length > 0) results.push(result.text);
    }
    return results;
  }
}

export function messagesText(messages) {
  return (messages || []).map((message) => textOfBlocks(message.content)).join('\n');
}

export function newMessageId() {
  return `tm_${randomUUID()}`;
}
