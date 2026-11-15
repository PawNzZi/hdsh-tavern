/**
 * 通用 OpenAI 兼容供应商客户端。
 *
 * 用户在 App 里配好「供应商 / Base URL / API Key / 模型」后，酒馆的生成不再走
 * DSH 的默认模型，而是直接打这个兼容接口（DeepSeek、OpenRouter、自建网关都适用）。
 *
 * 只实现酒馆需要的最小面：列模型 + 流式对话。
 */

export const DEFAULT_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1'
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1'
  }
};

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** 把请求体里的 provider 归一化；缺 baseUrl/apiKey/model 任一就返回 null（表示没配）。 */
export function normalizeProvider(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().slice(0, 24) : '';
  const fallbackBase = kind && DEFAULT_PROVIDERS[kind] ? DEFAULT_PROVIDERS[kind].baseUrl : '';
  const baseUrl = trimSlash(raw.baseUrl || fallbackBase);
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  return { kind, baseUrl, apiKey, model };
}

function headersOf(apiKey, kind) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
  // OpenRouter 建议带来源标识，不带也能用
  if (kind === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/PawNzZi/hdsh-tavern';
    headers['X-Title'] = 'DSH Tavern';
  }
  return headers;
}

/** 拉取供应商的模型列表，返回 `[{id, name}]`。 */
export async function listProviderModels({ baseUrl, apiKey, kind = '' }) {
  const url = `${trimSlash(baseUrl)}/models`;
  const response = await fetch(url, {
    headers: headersOf(apiKey, kind),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = json?.error?.message || json?.message || text.slice(0, 200);
    throw new Error(`拉取模型失败（HTTP ${response.status}）：${message}`);
  }
  const rows = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : (typeof row?.name === 'string' ? row.name : '');
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof row?.name === 'string' && row.name.length > 0 ? row.name : id;
    models.push({ id, name });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/**
 * 流式对话：异步迭代增量文本。
 *
 * @param {{baseUrl:string,apiKey:string,kind?:string,model:string,messages:object[],
 *   maxTokens?:number,temperature?:number,stop?:string[],signal?:AbortSignal}} input
 */
export async function* streamProviderChat(input) {
  const url = `${trimSlash(input.baseUrl)}/chat/completions`;
  const body = {
    model: input.model,
    messages: input.messages,
    stream: true
  };
  if (Number.isFinite(Number(input.maxTokens)) && Number(input.maxTokens) > 0) {
    body.max_tokens = Math.min(32768, Math.floor(Number(input.maxTokens)));
  }
  if (Number.isFinite(Number(input.temperature)) && Number(input.temperature) >= 0) {
    body.temperature = Math.max(0, Math.min(2, Number(input.temperature)));
  }
  if (Array.isArray(input.stop) && input.stop.length > 0) {
    body.stop = input.stop.slice(0, 8).map(String);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: headersOf(input.apiKey, input.kind),
    body: JSON.stringify(body),
    signal: input.signal ?? AbortSignal.timeout(600000)
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text)?.error?.message || message;
    } catch { /* 保持原样 */ }
    throw new Error(`供应商返回 HTTP ${response.status}：${message}`);
  }
  if (!response.body) {
    throw new Error('供应商没有返回流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.length === 0 || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = json?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield delta;
        }
        if (choice?.finish_reason === 'error') {
          throw new Error('供应商返回错误：finish_reason=error');
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}
