/**
 * 剧情记忆（上下文压缩）。
 *
 * 规则：最近 `historyLimit` 条消息逐字保留，更早的消息折叠成一段摘要，
 * 摘要存在 chat.memory 里，每轮拼 prompt 时注入 system（见 prompt.js）。
 *
 * 设计约束：
 *   - 只折叠「还没被摘要覆盖」的一段，已覆盖的不重复送模型（增量合并）；
 *   - 首次折叠可能很长，按消息条数 / 字符数切块，逐块与旧摘要合并（滚动摘要）；
 *   - 原始消息一条都不删，data.json 仍是完整记录，摘要只是发给模型的视图；
 *   - 折叠边界尽量落在 user 消息前，避免把一问一答拆开。
 */
/** 摘要 section 在 Prompt 顺序里的 id。 */
export const MEMORY_SECTION = 'memory';

/** 单条摘要正文的长度上限（字符），防御模型话痨。 */
// 摘要不做「内容上限」，只留一个防跑飞的极端值（约 20 万字符）
const MAX_SUMMARY_CHARS = 200000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const asString = (value) => (typeof value === 'string' ? value : '');

/**
 * 把 data.json 里可能残缺的 memory 规整成固定结构；没有正文就当作没有。
 * @param {unknown} raw
 * @returns {{version:number, summary:string, throughMessageId:string, sourceMessages:number, tokens:number, updatedAt:number}|null}
 */
export function normalizeMemory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = asString(raw.summary).trim();
  if (summary.length === 0) return null;
  return {
    version: 1,
    summary,
    throughMessageId: asString(raw.throughMessageId),
    sourceMessages: Number.isFinite(Number(raw.sourceMessages))
      ? Math.max(0, Math.floor(Number(raw.sourceMessages)))
      : 0,
    tokens: Number.isFinite(Number(raw.tokens)) ? Math.max(0, Math.floor(Number(raw.tokens))) : 0,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0
  };
}

/** 取一个 chat 的摘要正文；没有就返回空串。 */
export function memorySummary(chat) {
  return normalizeMemory(chat?.memory)?.summary ?? '';
}

/**
 * 摘要已经覆盖到 messages 里的哪一条（返回下标）。
 * 没配置返回 -1；消息被删/改了 id 找不到也返回 -1（调用方会重新完整折叠）。
 */
export function memoryCoveredIndex(messages, memory) {
  const id = normalizeMemory(memory)?.throughMessageId ?? '';
  if (id.length === 0) return -1;
  const list = Array.isArray(messages) ? messages : [];
  return list.findIndex((message) => message?.id === id);
}

/**
 * 规划一次压缩折叠哪一段。
 *
 * @param {object} input
 * @param {object[]} input.messages chat.messages
 * @param {number} input.historyLimit 逐字保留的条数（App 设置，2~100）
 * @param {object|null} input.memory 现有 chat.memory
 * @returns {{start:number, end:number, foldable:number, covered:number, tail:number, historyLimit:number}}
 */
export function planCompaction({ messages, historyLimit, memory }) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const limit = clamp(Math.floor(Number(historyLimit) || 20), 2, 100);
  const covered = memoryCoveredIndex(list, memory);
  const tail = Math.min(limit, total);
  let end = Math.max(covered + 1, total - tail);
  const start = Math.max(0, covered + 1);
  // 尾巴尽量从一条 user 消息开始；assistant 单独开头时多折叠一条。
  if (end > start && end + 1 < total && list[end]?.role === 'assistant') {
    end += 1;
  }
  return {
    start,
    end,
    foldable: Math.max(0, end - start),
    covered,
    tail: Math.max(0, total - end),
    historyLimit: limit
  };
}

/**
 * 清掉模型看不见、也不该进摘要的标签（媒体/状态栏/快捷选项），只留正文。
 * 正常的回复在落盘时已经清过一遍，这里是兜底。
 */
export function cleanForMemory(value) {
  return asString(value)
    .replace(/<media_image>[\s\S]*?<\/media_image>/gi, '')
    .replace(/<media_voice>[\s\S]*?<\/media_voice>/gi, '')
    .replace(/<StatusBlock>[\s\S]*?<\/StatusBlock>/gi, '')
    .replace(/<Status>[\s\S]*?<\/Status>/gi, '')
    .replace(/<State>[\s\S]*?<\/State>/gi, '')
    .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
    .replace(/<Options>[\s\S]*?<\/Options>/gi, '')
    .trim();
}

/**
 * 把一段消息拼成「说话人：正文」的文本，喂给摘要模型。
 * @returns {string}
 */
export function transcriptOf(messages, from, to, { userName = '你', characterName = '角色' } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  for (let index = from; index < to; index += 1) {
    const message = list[index];
    if (message === null || typeof message !== 'object') continue;
    const text = cleanForMemory(message.text);
    if (text.length === 0) continue;
    const speaker = message.role === 'user'
      ? userName
      : (typeof message.speaker === 'string' && message.speaker.length > 0 ? message.speaker : characterName);
    lines.push(`${speaker}：${text}`);
  }
  return lines.join('\n');
}

/**
 * 把可折叠区切成块：每块不超过 maxMessages 条、maxChars 字符。
 * @returns {{start:number,end:number}[]}
 */
export function planChunks(messages, from, to, { maxMessages = 24, maxChars = 12000 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const chunks = [];
  let start = from;
  while (start < to) {
    let end = start;
    let chars = 0;
    while (end < to && end - start < maxMessages) {
      const length = asString(list[end]?.text).length;
      if (end > start && chars + length > maxChars) break;
      chars += length;
      end += 1;
    }
    if (end === start) end = start + 1;
    chunks.push({ start, end });
    start = end;
  }
  return chunks;
}

/** 摘要模型的 system 提示词。 */
export function memorySystemPrompt() {
  return [
    '你是角色扮演对话的「剧情记忆」整理器：把给定对话改写成一段可以长期复用的中文剧情摘要。',
    '',
    '写作要求：',
    '- 用第三人称、连贯的叙事散文来写，**禁止分点、编号、Markdown、表格**；句子之间要有承接关系，读起来像小说梗概。',
    '- 按时间顺序叙述，但不要逐句复述；合并重复的场景与寒暄，只保留推进剧情的内容。',
    '- 必须保留：人物（一律用角色名，不用「用户」「AI」「模型」）、称呼与关系、身份；主线事件与转折；',
    '  当前时间、地点、场景；未解决的线索、约定与承诺；重要事实与数值（好感、物品、誓言等）。',
    '- 结尾必须写清「当前进展」：此刻的场景、气氛、双方各自的处境与情绪，让下一轮对话可以直接接上。',
    '- 关键对话保留原话：引用最有信息量或最有情绪的 1–2 句台词（用「」括起），其余用叙述概括。',
    '',
    '合并规则：',
    '- 输入会给出【已有摘要】和【新增对话】：请把两者融合成一份新的完整摘要，而不是在旧摘要后面追加。',
    '- 不得丢失旧摘要里的关键事实；新旧冲突时以新对话为准，并在文中自然地交代这个变化。',
    '- 不要出现「摘要」「上文」「本次」「这一块」这类元叙述，直接写剧情本身。',
    '',
    '只输出摘要正文，不要标题、不要解释。'
  ].join('\n');
}

export function memoryUserPrompt({ summary, transcript }) {
  const previous = asString(summary).trim();
  return [
    '【已有摘要】',
    previous.length > 0 ? previous : '（无，这是第一次压缩）',
    '',
    '【新增对话】',
    asString(transcript).trim(),
    '',
    '请输出融合后的完整摘要：',
    '- 接着已有摘要的时间线往下写，已经交代过的事情不要重复描述；',
    '- 用连贯的段落叙述，收尾落在「当前进展」，让后续对话能自然接上；',
    '- 不要为了短而删信息：篇幅由信息量决定，对话多就该写长；只在重复啰嗦处压缩。',
    '- 关键对话要保留**原话片段**（用「」括起 1–2 句最有戏剧张力或信息量的台词），其余内容用叙述概括。'
  ].join('\n');
}

/**
 * 执行一次压缩：从 chat.messages 里折叠「已摘要之后、逐字窗口之前」的一段。
 *
 * 调用方负责加锁（withChatLock）与压缩后的 Agent 会话重置。
 *
 * @param {object} input
 * @param {object} input.chat 实时 chat 对象
 * @param {object} input.store TavernStore
 * @param {number} [input.historyLimit] 逐字保留条数
 * @param {number} [input.minFoldMessages] 少于这么多条就不压
 * @param {number} [input.summaryMaxTokens] 单次摘要的输出上限
 * @param {number} [input.chunkMessages] 分块条数
 * @param {number} [input.chunkChars] 分块字符数
 * @param {(text:string)=>number} input.countTokens
 * @param {(input:{system:string,user:string,maxTokens:number})=>Promise<string>} input.summarize
 * @param {(message:string)=>void} [input.log]
 * @param {boolean} [input.force] 手动压缩：忽略 minFoldMessages
 * @param {string} [input.userName]
 * @param {string} [input.characterName]
 * @param {'manual'|'auto'} [input.mode]
 * @returns {Promise<{ok:boolean, reason?:string, memory?:object, stats?:object}>}
 */
export async function compactChat({
  chat,
  store,
  historyLimit = 24,
  minFoldMessages = 8,
  summaryMaxTokens = 1200,
  chunkMessages = 24,
  chunkChars = 12000,
  countTokens,
  summarize,
  log = () => {},
  force = false,
  userName = '你',
  characterName = '角色',
  mode = 'auto'
}) {
  if (chat === null || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    return { ok: false, reason: 'no-chat' };
  }
  const memory = normalizeMemory(chat.memory);
  const plan = planCompaction({ messages: chat.messages, historyLimit, memory });
  const threshold = force ? 1 : Math.max(1, Math.floor(Number(minFoldMessages) || 8));
  if (plan.foldable <= 0) {
    return { ok: false, reason: 'nothing-to-fold', plan };
  }
  if (!force && plan.foldable < threshold) {
    return { ok: false, reason: 'too-few', plan };
  }

  const chunks = planChunks(chat.messages, plan.start, plan.end, {
    maxMessages: chunkMessages,
    maxChars: chunkChars
  });
  const beforeTokens = (memory?.tokens ?? 0)
    + countTokens(transcriptOf(chat.messages, plan.start, plan.end, { userName, characterName }));

  let summary = memory?.summary ?? '';
  let usedChunks = 0;
  for (const chunk of chunks) {
    const transcript = transcriptOf(chat.messages, chunk.start, chunk.end, { userName, characterName });
    if (transcript.length === 0) continue;
    const next = await summarize({
      system: memorySystemPrompt(),
      user: memoryUserPrompt({ summary, transcript }),
      maxTokens: summaryMaxTokens
    });
    const text = asString(next).trim();
    if (text.length === 0) throw new Error('摘要模型返回为空');
    summary = text.slice(0, MAX_SUMMARY_CHARS);
    usedChunks += 1;
  }
  if (usedChunks === 0) {
    return { ok: false, reason: 'empty-transcript', plan };
  }

  const lastFolded = chat.messages[plan.end - 1];
  const throughMessageId = asString(lastFolded?.id) || (memory?.throughMessageId ?? '');
  const sourceMessages = plan.covered >= 0
    ? (memory?.sourceMessages ?? 0) + plan.foldable
    : plan.foldable;
  const stored = store.setChatMemory(chat.id, {
    version: 1,
    summary,
    throughMessageId,
    sourceMessages,
    tokens: countTokens(summary),
    updatedAt: Date.now()
  }, {
    mode,
    fromId: asString(chat.messages[plan.start]?.id),
    toId: throughMessageId,
    beforeTokens,
    afterTokens: countTokens(summary)
  });
  log(`memory compacted (${mode}): folded ${plan.foldable} messages into ~${stored?.tokens ?? 0} tokens, tail ${plan.tail}`);
  return {
    ok: true,
    memory: stored,
    stats: {
      foldedMessages: plan.foldable,
      sourceMessages,
      tailMessages: plan.tail,
      chunks: usedChunks,
      beforeTokens,
      afterTokens: stored?.tokens ?? 0,
      throughMessageId
    }
  };
}
