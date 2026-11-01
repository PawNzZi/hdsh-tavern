/**
 * 世界书：格式归一化 + 关键词激活。
 * P0 支持 constant、主/次级关键词、顺序、预算；递归/定时放到 P1。
 */
import { randomUUID } from 'node:crypto';

function text(value, max = 100000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function keys(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, 300)).filter(Boolean).slice(0, 30)
    : [];
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function normalizeEntry(raw, index = 0) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: text(source.id, 80) || `e_${randomUUID()}`,
    uid: Number.isFinite(Number(source.uid)) ? Number(source.uid) : index,
    comment: text(source.comment, 200),
    keys: keys(source.key ?? source.keys),
    secondaryKeys: keys(source.keysecondary ?? source.secondaryKeys),
    content: text(source.content),
    enabled: source.disable === true ? false : bool(source.enabled, true),
    constant: bool(source.constant, false),
    selective: bool(source.selective, false),
    selectiveLogic: number(source.selectiveLogic, 0, 0, 3),
    order: number(source.order, 100, -100000, 100000),
    position: number(source.position, 0, 0, 20),
    depth: number(source.depth, 4, 0, 100),
    role: number(source.role, 0, 0, 2),
    probability: number(source.probability, 100, 0, 100),
    useProbability: bool(source.useProbability, true),
    caseSensitive: bool(source.caseSensitive, false),
    matchWholeWords: bool(source.matchWholeWords, true),
    group: text(source.group, 100),
    groupWeight: number(source.groupWeight, 100, 0, 1000),
    prioritizeInclusion: bool(source.prioritizeInclusion, false),
    scanDepth: number(source.scanDepth, 0, 0, 100),
    excludeRecursion: bool(source.excludeRecursion, false),
    preventRecursion: bool(source.preventRecursion, false),
    delayUntilRecursion: number(source.delayUntilRecursion, 0, 0, 10),
    sticky: number(source.sticky, 0, 0, 100),
    cooldown: number(source.cooldown, 0, 0, 100),
    delay: number(source.delay, 0, 0, 100)
  };
}

export function normalizeWorldBook(raw, fallbackName = '世界书') {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawEntries = source.entries;
  const entries = [];
  if (Array.isArray(rawEntries)) {
    rawEntries.forEach((entry, index) => entries.push(normalizeEntry(entry, index)));
  } else if (rawEntries !== null && typeof rawEntries === 'object') {
    Object.keys(rawEntries).forEach((key, index) => entries.push(normalizeEntry(rawEntries[key], index)));
  }
  return {
    name: text(source.name, 120) || fallbackName,
    entries
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matches(haystack, needle, caseSensitive, wholeWords) {
  if (needle.length === 0) return false;
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  if (!wholeWords) {
    return source.includes(target);
  }
  // 中文没有空格分词，整词边界会把“去酒馆”判成不匹配。
  if (/[\u3400-\u9fff]/.test(target)) {
    return source.includes(target);
  }
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(target)}([^\\p{L}\\p{N}_]|$)`, 'u');
  return pattern.test(source);
}

function secondaryMatches(entry, text) {
  if (entry.secondaryKeys.length === 0) return true;
  const results = entry.secondaryKeys.map((key) => matches(text, key, entry.caseSensitive, entry.matchWholeWords));
  switch (entry.selectiveLogic) {
    case 1: // NOT_ALL
      return !results.every(Boolean);
    case 2: // NOT_ANY
      return !results.some(Boolean);
    case 3: // AND_ALL
      return results.every(Boolean);
    default: // AND_ANY
      return results.some(Boolean);
  }
}

function scanEntry(entry, messages, defaultDepth) {
  if (!entry.enabled) return false;
  const depth = entry.scanDepth > 0 ? Math.min(100, entry.scanDepth) : defaultDepth;
  const text = messages.slice(-Math.max(1, depth)).map((message) => String(message.text || '')).join('\n');
  if (entry.constant) return true;
  if (entry.keys.length === 0) return false;
  const primary = entry.keys.some((key) => matches(text, key, entry.caseSensitive, entry.matchWholeWords));
  if (!primary) return false;
  if (!entry.selective) return true;
  return secondaryMatches(entry, text);
}

/**
 * 扫描最近消息，返回激活条目。
 * 支持：常驻、主/次关键词、选择性逻辑、概率、递归、分组竞争、字符预算。
 */
export function activateEntries(entries, messages, options = {}) {
  const scanDepth = Math.max(1, Math.min(50, Number(options.scanDepth) || 8));
  const maxChars = Math.max(500, Math.min(200000, Number(options.maxChars) || 12000));
  const maxTokens = Math.max(100, Math.min(64000, Number(options.maxTokens) || 6000));
  const countTokens = typeof options.countTokens === 'function'
    ? options.countTokens
    : (value) => Math.ceil(String(value).length / 2);
  const recursionDepth = Math.max(0, Math.min(4, Number(options.recursionDepth) || 2));
  const messageIndex = Math.max(0, Number(options.messageIndex) || messages.length);
  const previousState = options.worldState !== null && typeof options.worldState === 'object'
    ? options.worldState
    : {};
  const worldState = JSON.parse(JSON.stringify(previousState));
  // 兼容旧数据/手工导入：缺失字段按默认值补齐，避免预览直接崩溃。
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Array.isArray(entry.keys)) entry.keys = entry.keys ? [String(entry.keys)] : [];
    if (!Array.isArray(entry.secondaryKeys)) entry.secondaryKeys = [];
    if (typeof entry.content !== 'string') entry.content = String(entry.content ?? '');
    if (typeof entry.group !== 'string') entry.group = '';
    entry.groupWeight = Number(entry.groupWeight) || 100;
    entry.prioritizeInclusion = entry.prioritizeInclusion === true;
    entry.order = Number(entry.order) || 100;
    entry.position = Number(entry.position) || 0;
    entry.depth = Number(entry.depth) || 4;
    entry.probability = Number(entry.probability) || 100;
    entry.useProbability = entry.useProbability !== false;
    entry.caseSensitive = entry.caseSensitive === true;
    entry.matchWholeWords = entry.matchWholeWords === true;
    entry.selective = entry.selective === true;
    entry.selectiveLogic = Number(entry.selectiveLogic) || 0;
    entry.scanDepth = Number(entry.scanDepth) || 0;
    entry.excludeRecursion = entry.excludeRecursion === true;
    entry.preventRecursion = entry.preventRecursion === true;
    entry.delayUntilRecursion = Number(entry.delayUntilRecursion) || 0;
    entry.sticky = Number(entry.sticky) || 0;
    entry.cooldown = Number(entry.cooldown) || 0;
    entry.delay = Number(entry.delay) || 0;
    entry.enabled = entry.enabled !== false;
    entry.constant = entry.constant === true;
  }
  const active = new Map();
  const add = (entry, reason, depth = 0) => {
    if (active.has(entry.id)) return false;
    active.set(entry.id, { ...entry, reason, recursionDepth: depth });
    const state = worldState[entry.id] ?? {};
    if (entry.sticky > 0) state.stickyUntil = Math.max(Number(state.stickyUntil) || 0, messageIndex + entry.sticky);
    if (entry.cooldown > 0) state.cooldownUntil = Math.max(Number(state.cooldownUntil) || 0, messageIndex + entry.cooldown);
    if (Object.keys(state).length > 0) worldState[entry.id] = state;
    return true;
  };

  for (const entry of entries) {
    if (!entry || entry.enabled === false) continue;
    const state = worldState[entry.id] ?? {};
    if (Number(state.cooldownUntil) > messageIndex) continue;
    if (entry.delay > 0 && messageIndex < entry.delay) continue;
    if (entry.sticky > 0 && Number(state.stickyUntil) > messageIndex) {
      add(entry, 'sticky');
      continue;
    }
    if (entry.delayUntilRecursion > 0) continue;
    if (entry.constant) {
      add(entry, 'constant');
      continue;
    }
    if (!scanEntry(entry, messages, scanDepth)) continue;
    if (entry.useProbability && entry.probability < 100 && Math.random() * 100 >= entry.probability) continue;
    add(entry, 'keyword');
  }

  // 递归：已激活条目的内容再次命中其他条目的关键词。
  for (let depth = 1; depth <= recursionDepth; depth += 1) {
    const sourceText = [...active.values()]
      .filter((entry) => !entry.preventRecursion && entry.recursionDepth < depth)
      .map((entry) => entry.content)
      .join('\n');
    if (sourceText.length === 0) break;
    let changed = false;
    for (const entry of entries) {
      if (!entry || active.has(entry.id) || entry.enabled === false) continue;
      const state = worldState[entry.id] ?? {};
      if (Number(state.cooldownUntil) > messageIndex) continue;
      if (entry.excludeRecursion || entry.constant || entry.keys.length === 0) continue;
      if (!entry.keys.some((key) => matches(sourceText, key, entry.caseSensitive, entry.matchWholeWords))) continue;
      if (entry.selective && !secondaryMatches(entry, sourceText)) continue;
      if (entry.useProbability && entry.probability < 100 && Math.random() * 100 >= entry.probability) continue;
      add(entry, 'recursion', depth);
      changed = true;
    }
    if (!changed) break;
  }

  // 同组条目只保留一个：优先 inclusion，再比顺序/权重。
  const groups = new Map();
  for (const entry of active.values()) {
    if (entry.group.length === 0) continue;
    const current = groups.get(entry.group);
    if (current === undefined) {
      groups.set(entry.group, entry);
      continue;
    }
    const better = entry.prioritizeInclusion !== current.prioritizeInclusion
      ? entry.prioritizeInclusion
      : entry.groupWeight !== current.groupWeight
        ? entry.groupWeight > current.groupWeight
        : entry.order > current.order;
    if (better) groups.set(entry.group, entry);
  }
  const selectedByGroup = new Set([...groups.values()].map((entry) => entry.id));

  const candidates = [...active.values()]
    .filter((entry) => entry.group.length === 0 || selectedByGroup.has(entry.id))
    .sort((a, b) => b.order - a.order);
  let used = 0;
  let usedTokens = 0;
  const selected = [];
  for (const entry of candidates) {
    const tokens = countTokens(entry.content);
    if (usedTokens + tokens > maxTokens || used + entry.content.length > maxChars) continue;
    selected.push({ ...entry, tokens });
    used += entry.content.length;
    usedTokens += tokens;
  }
  return {
    entries: selected,
    chars: used,
    tokens: usedTokens,
    truncated: selected.length < candidates.length,
    worldState
  };
}

/** 组装注入文本：只放内容，不解释匹配原因。 */
export function renderWorldInfo(entries) {
  if (entries.length === 0) return '';
  return entries.map((entry) => entry.content.trim()).filter(Boolean).join('\n\n');
}
