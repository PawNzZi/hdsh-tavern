/**
 * 世界书：格式归一化 + 关键词激活。
 *
 * 语义对齐 SillyTavern（release 1.19）：
 *   - 正则 key（`/pattern/flags`）与字面 key 混用；
 *   - selective / keysecondary / selectiveLogic（AND ANY / NOT ALL / NOT ANY / AND ALL）；
 *   - constant、order、position、depth、role；
 *   - 递归（excludeRecursion / preventRecursion / delayUntilRecursion）；
 *   - 分组（逗号分隔多组、groupWeight 加权随机、prioritizeInclusion 按 order）；
 *   - 定时效果（sticky / cooldown / delay，按消息数，不刷新已有计时）；
 *   - token / 字符预算。
 *
 * 与 ST 的已知差异：
 *   - outlet（position 7）暂不注入；
 *   - 预算耗尽时跳过放不下的条目而不是整体停止；
 *   - `matchWholeWords` 对中日文自动放宽（ST 文档建议关闭整词）。
 */
import { randomUUID } from 'node:crypto';

const REGEX_CACHE_LIMIT = 500;
const REGEX_CACHE = new Map();

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

const GENERATION_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
const META_ENTRY_NAMES = new Set(['status_schema', 'variables', 'variable_schema', '变量']);

function isMetaEntry(entry) {
  const comment = String(entry.comment || '').trim().toLowerCase();
  const firstKey = Array.isArray(entry.keys) && entry.keys.length > 0
    ? String(entry.keys[0]).trim().toLowerCase()
    : '';
  return META_ENTRY_NAMES.has(comment) || META_ENTRY_NAMES.has(firstKey);
}

function stringList(value, maxItems = 50, maxLength = 80) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, maxLength))
      .slice(0, maxItems)
    : [];
}

function normalizeCharacterFilter(value) {
  if (Array.isArray(value)) {
    return { names: stringList(value), tags: [], isExclude: false };
  }
  if (value !== null && typeof value === 'object') {
    return {
      names: stringList(value.names ?? value.characters),
      tags: stringList(value.tags),
      isExclude: value.isExclude === true || value.exclude === true
    };
  }
  return { names: [], tags: [], isExclude: false };
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
    position: number(source.position, 0, 0, 7),
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
    delay: number(source.delay, 0, 0, 100),
    // ST 高级语义
    characterFilter: normalizeCharacterFilter(source.characterFilter),
    triggers: stringList(source.triggers, 10, 20).filter((item) => GENERATION_TRIGGERS.includes(item)),
    automationId: text(source.automationId, 100),
    outletName: text(source.outletName ?? source.outlet, 100)
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

/**
 * ST 的 key 允许写成 `/pattern/flags`。这里只接受安全 flags，
 * 去掉 g/y 避免 lastIndex 状态；非法正则退回字面量匹配。
 * @returns {RegExp | null}
 */
function compileKey(needle) {
  if (typeof needle !== 'string' || needle.length < 3 || needle[0] !== '/') return null;
  const last = needle.lastIndexOf('/');
  if (last <= 0) return null;
  const body = needle.slice(1, last);
  if (body.length === 0) return null;
  const rawFlags = needle.slice(last + 1);
  if (!/^[a-z]*$/i.test(rawFlags)) return null;
  const flags = [...new Set(rawFlags.toLowerCase().replace(/[gy]/g, '').split(''))].join('');
  if (!/^[imsu]*$/.test(flags)) return null;
  const cacheKey = `${body}\u0000${flags}`;
  if (REGEX_CACHE.has(cacheKey)) return REGEX_CACHE.get(cacheKey);
  let compiled = null;
  try {
    compiled = new RegExp(body, flags);
  } catch {
    compiled = null;
  }
  if (REGEX_CACHE.size >= REGEX_CACHE_LIMIT) REGEX_CACHE.clear();
  REGEX_CACHE.set(cacheKey, compiled);
  return compiled;
}

/** 单个 key 是否命中文本；正则 key 优先。 */
export function matchesKey(haystack, needle, caseSensitive = false, wholeWords = true) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || needle.length === 0) return false;
  const regex = compileKey(needle);
  if (regex !== null) return regex.test(haystack);
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

function secondaryMatches(entry, haystack) {
  if (entry.secondaryKeys.length === 0) return true;
  const results = entry.secondaryKeys.map((key) => matchesKey(haystack, key, entry.caseSensitive, entry.matchWholeWords));
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

function groupsOf(entry) {
  return String(entry.group || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function scanLine(message, userName, characterName, includeNames) {
  const body = String(message?.text ?? '');
  if (!includeNames) return body;
  const label = message?.role === 'user'
    ? userName
    : (typeof message?.speaker === 'string' && message.speaker.length > 0 ? message.speaker : characterName);
  return `${label}: ${body}`;
}

function scanText(lines, depth) {
  if (lines.length === 0) return '';
  return lines.slice(-Math.max(1, Math.min(lines.length, depth))).join('\n');
}

/**
 * 扫描最近消息，返回激活条目。
 * @param {object[]} entries
 * @param {{role?: string, text?: string, speaker?: string}[]} messages
 * @param {object} [options]
 * @param {number} [options.scanDepth=8] 全局扫描深度
 * @param {number} [options.maxTokens=6000]
 * @param {number} [options.maxChars=12000]
 * @param {number} [options.recursionDepth=2]
 * @param {number} [options.messageIndex] 当前消息序号（含本轮用户消息）
 * @param {object} [options.worldState]
 * @param {string} [options.userName='User']
 * @param {string} [options.characterName='Character']
 * @param {boolean} [options.includeNames=true]
 * @param {() => number} [options.random]
 * @param {(value: string) => number} [options.countTokens]
 */
export function activateEntries(entries, messages, options = {}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const scanDepth = Math.max(1, Math.min(100, Number(options.scanDepth) || 8));
  const maxChars = Math.max(500, Math.min(200000, Number(options.maxChars) || 12000));
  const maxTokens = Math.max(100, Math.min(64000, Number(options.maxTokens) || 6000));
  const countTokens = typeof options.countTokens === 'function'
    ? options.countTokens
    : (value) => Math.ceil(String(value).length / 2);
  const recursionDepth = Math.max(0, Math.min(10, Number(options.recursionDepth) || 2));
  const messageIndex = Math.max(0, Number(options.messageIndex) || sourceMessages.length);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const includeNames = options.includeNames !== false;
  const userName = typeof options.userName === 'string' && options.userName.length > 0 ? options.userName : 'User';
  const characterName = typeof options.characterName === 'string' && options.characterName.length > 0
    ? options.characterName
    : 'Character';
  const characterTags = Array.isArray(options.characterTags)
    ? options.characterTags.map((tag) => String(tag)).filter(Boolean)
    : [];
  const generationType = GENERATION_TRIGGERS.includes(options.generationType) ? options.generationType : 'normal';
  const minActivations = Math.max(0, Math.min(100, Number(options.minActivations) || 0));
  const maxDepth = Math.max(0, Math.min(10000, Number(options.maxDepth) || 0));
  const previousState = options.worldState !== null && typeof options.worldState === 'object'
    ? options.worldState
    : {};
  const worldState = JSON.parse(JSON.stringify(previousState));

  // 聊天回退（删除消息/分支）时，ST 会移除定时效果；这里直接清空。
  const meta = worldState.__meta !== null && typeof worldState.__meta === 'object' ? worldState.__meta : {};
  if (Number.isFinite(Number(meta.lastIndex)) && messageIndex < Number(meta.lastIndex)) {
    for (const key of Object.keys(worldState)) {
      if (key !== '__meta') delete worldState[key];
    }
  }
  meta.lastIndex = messageIndex;
  worldState.__meta = meta;

  const list = entries
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry, index) => normalizeEntry(entry, index));
  const lines = sourceMessages.map((message) => scanLine(message, userName, characterName, includeNames));
  const active = new Map();

  const activate = (entry, reason, recursion = 0) => {
    if (active.has(entry.id)) return false;
    active.set(entry.id, { ...entry, reason, recursionDepth: recursion });
    if (reason === 'sticky') return true;
    const state = worldState[entry.id] !== null && typeof worldState[entry.id] === 'object'
      ? worldState[entry.id]
      : {};
    const now = messageIndex;
    if (entry.sticky > 0) {
      // sticky=N：激活后再持续 N 条消息（ST 的示例是激活后 N 条）。
      state.stickyUntil = now + entry.sticky + 1;
    }
    if (entry.cooldown > 0) {
      // ST：cooldown 从 sticky 结束后的下一条开始算，两者都“再挡 N 条”。
      const cooldownBase = entry.sticky > 0 ? now + entry.sticky + 1 : now + 1;
      state.cooldownUntil = cooldownBase + entry.cooldown;
    }
    if (state.stickyUntil !== undefined || state.cooldownUntil !== undefined) {
      worldState[entry.id] = state;
    }
    return true;
  };

  const blocked = (entry) => {
    const state = worldState[entry.id] !== null && typeof worldState[entry.id] === 'object'
      ? worldState[entry.id]
      : {};
    // sticky 期间 cooldownUntil 也在未来（ST 的 cooldown 从 sticky 结束算起），
    // 所以必须先判断 sticky，再判断 cooldown。
    if (entry.sticky > 0 && Number(state.stickyUntil) > messageIndex) return false;
    return Number(state.cooldownUntil) > messageIndex;
  };

  const delayBlocked = (entry) => entry.delay > 0 && (messageIndex - 1) < entry.delay;

  // Generation Triggers：空 = 所有生成类型；否则只在列出的类型里生效。
  const triggersMatch = (entry) => entry.triggers.length === 0 || entry.triggers.includes(generationType);

  // Character Filter：names / tags 任一命中即通过；isExclude 反转。
  const characterMatch = (entry) => {
    const filter = entry.characterFilter;
    if (filter.names.length === 0 && filter.tags.length === 0) return true;
    const nameHit = filter.names.some((name) => name.toLowerCase() === characterName.toLowerCase());
    const tagHit = filter.tags.some((tag) => characterTags.some((own) => own.toLowerCase() === tag.toLowerCase()));
    const hit = nameHit || tagHit;
    return filter.isExclude ? !hit : hit;
  };
  const entryEligible = (entry) => entry.enabled !== false && !isMetaEntry(entry) && triggersMatch(entry) && characterMatch(entry);

  for (const entry of list) {
    if (!entryEligible(entry)) continue;
    const state = worldState[entry.id] !== null && typeof worldState[entry.id] === 'object'
      ? worldState[entry.id]
      : {};
    if (entry.sticky > 0 && Number(state.stickyUntil) > messageIndex) {
      activate(entry, 'sticky');
      continue;
    }
    if (blocked(entry)) continue;
    if (delayBlocked(entry)) continue;
    if (entry.delayUntilRecursion > 0) continue;
    if (entry.constant) {
      activate(entry, 'constant');
      continue;
    }
    if (entry.keys.length === 0) continue;
    const haystack = scanText(lines, entry.scanDepth > 0 ? entry.scanDepth : scanDepth);
    if (haystack.length === 0) continue;
    const primary = entry.keys.some((key) => matchesKey(haystack, key, entry.caseSensitive, entry.matchWholeWords));
    if (!primary) continue;
    if (entry.selective && !secondaryMatches(entry, haystack)) continue;
    if (entry.useProbability && entry.probability < 100 && random() * 100 >= entry.probability) continue;
    activate(entry, 'keyword');
  }

  // Min Activations：关键词命中不足时，向更早的历史继续扫描，直到达到数量或 Max Depth。
  if (minActivations > 0) {
    let keywordCount = [...active.values()].filter((entry) => entry.reason === 'keyword').length;
    const limit = Math.max(scanDepth + 1, maxDepth > 0 ? maxDepth : sourceMessages.length);
    for (let depth = scanDepth + 1; depth <= limit && keywordCount < minActivations; depth += 1) {
      for (const entry of list) {
        if (active.has(entry.id) || !entryEligible(entry)) continue;
        if (entry.constant || entry.keys.length === 0 || entry.delayUntilRecursion > 0) continue;
        if (blocked(entry) || delayBlocked(entry)) continue;
        const haystack = scanText(lines, depth);
        if (haystack.length === 0) continue;
        const primary = entry.keys.some((key) => matchesKey(haystack, key, entry.caseSensitive, entry.matchWholeWords));
        if (!primary) continue;
        if (entry.selective && !secondaryMatches(entry, haystack)) continue;
        if (entry.useProbability && entry.probability < 100 && random() * 100 >= entry.probability) continue;
        if (activate(entry, 'keyword')) {
          keywordCount += 1;
        }
      }
      // 本层没有新增也继续加深：目标关键词可能更早。
    }
  }

  // 递归：已激活条目的内容再次命中其他条目的关键词。
  // 每一层都重新扫描全部已激活内容，这样 delayUntilRecursion=2 的条目
  // 即使上一层没有新增，也能在下一层被匹配到（ST 的分层语义）。
  for (let depth = 1; depth <= recursionDepth; depth += 1) {
    const haystack = [...active.values()]
      .filter((entry) => entry.reason !== 'sticky' && !entry.preventRecursion && entry.content.length > 0)
      .map((entry) => entry.content)
      .join('\n');
    if (haystack.length === 0) break;
    for (const entry of list) {
      if (!entry || active.has(entry.id) || !entryEligible(entry)) continue;
      if (entry.constant || entry.keys.length === 0) continue;
      // excludeRecursion：不能被递归激活；preventRecursion 只影响它去激活别人。
      if (entry.excludeRecursion) continue;
      if (entry.delayUntilRecursion > depth) continue;
      if (blocked(entry) || delayBlocked(entry)) continue;
      const primary = entry.keys.some((key) => matchesKey(haystack, key, entry.caseSensitive, entry.matchWholeWords));
      if (!primary) continue;
      if (entry.selective && !secondaryMatches(entry, haystack)) continue;
      if (entry.useProbability && entry.probability < 100 && random() * 100 >= entry.probability) continue;
      activate(entry, 'recursion', depth);
    }
    // 本层没有新增也继续：下一层可能还有 delayUntilRecursion 条目。
  }

  // 分组：同组只保留一个。有 prioritizeInclusion 时按 order 确定；否则按 groupWeight 加权随机。
  const groupMembers = new Map();
  for (const entry of active.values()) {
    for (const group of groupsOf(entry)) {
      const members = groupMembers.get(group) ?? [];
      members.push(entry);
      groupMembers.set(group, members);
    }
  }
  const groupWinners = new Map();
  for (const [group, members] of groupMembers) {
    if (members.length === 1) {
      groupWinners.set(group, members[0]);
      continue;
    }
    const prioritized = members.filter((entry) => entry.prioritizeInclusion);
    if (prioritized.length > 0) {
      groupWinners.set(group, prioritized.reduce((best, entry) => (entry.order > best.order ? entry : best), prioritized[0]));
      continue;
    }
    const total = members.reduce((sum, entry) => sum + Math.max(1, entry.groupWeight), 0);
    let roll = random() * total;
    let chosen = members[members.length - 1];
    for (const entry of members) {
      roll -= Math.max(1, entry.groupWeight);
      if (roll < 0) {
        chosen = entry;
        break;
      }
    }
    groupWinners.set(group, chosen);
  }
  const survivors = [...active.values()].filter((entry) => {
    const groups = groupsOf(entry);
    if (groups.length === 0) return true;
    return groups.every((group) => groupWinners.get(group) === entry);
  });

  // Outlet：position 7 不自动插入，按 outletName 收集，供 {{outlet::Name}} 取用。
  const outletEntries = survivors
    .filter((entry) => entry.position === 7 && entry.outletName.length > 0)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const outlets = {};
  for (const entry of outletEntries) {
    const content = entry.content.trim();
    if (content.length === 0) continue;
    outlets[entry.outletName] = outlets[entry.outletName] === undefined
      ? content
      : `${outlets[entry.outletName]}\n\n${content}`;
  }
  const promptSurvivors = survivors.filter((entry) => entry.position !== 7);

  // 预算优先级：常驻 > 直接命中 > 递归；同层按 order 从大到小。
  const tier = (entry) => (entry.reason === 'constant' ? 3 : entry.reason === 'recursion' ? 1 : 2);
  const ordered = promptSurvivors.slice().sort((a, b) => (
    tier(b) - tier(a)
    || b.order - a.order
    || a.content.length - b.content.length
    || a.id.localeCompare(b.id)
  ));

  let usedChars = 0;
  let usedTokens = 0;
  const selected = [];
  for (const entry of ordered) {
    const tokens = countTokens(entry.content);
    if (usedTokens + tokens > maxTokens || usedChars + entry.content.length > maxChars) {
      continue;
    }
    selected.push({ ...entry, tokens });
    usedChars += entry.content.length;
    usedTokens += tokens;
  }

  // 清理已过期的定时状态，避免 worldState 无限增长。
  for (const key of Object.keys(worldState)) {
    if (key === '__meta') continue;
    const state = worldState[key];
    if (state === null || typeof state !== 'object') {
      delete worldState[key];
      continue;
    }
    const stickyUntil = Number(state.stickyUntil) || 0;
    const cooldownUntil = Number(state.cooldownUntil) || 0;
    if (stickyUntil <= messageIndex && cooldownUntil <= messageIndex) {
      delete worldState[key];
    }
  }

  // 渲染顺序：order 小的在前，大的靠近结尾（与 ST 的“order 越大越靠后”一致）。
  selected.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return {
    entries: selected,
    outlets,
    chars: usedChars,
    tokens: usedTokens,
    truncated: selected.length < promptSurvivors.length,
    worldState
  };
}

/** 组装注入文本：只放内容，不解释匹配原因。 */
export function renderWorldInfo(entries) {
  if (entries.length === 0) return '';
  return entries.map((entry) => entry.content.trim()).filter(Boolean).join('\n\n');
}
