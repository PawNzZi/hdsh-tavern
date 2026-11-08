/**
 * 状态栏解析规则。
 *
 * 默认行为是**通用**的：只提取 `标签: 值`，不翻译、不猜语义、不认具体卡片。
 * 需要旧式卡片的“数值推进/阶段名”等行为时，由卡片自己声明规则：
 *
 *   extensions.hdsh_status = {
 *     "ignoreLabels": ["Time", "History check"],
 *     "valueRules": [
 *       { "label": "攻略阶段", "pattern": ".*?([+-]\\d+(?:\\.\\d+)?).*", "replacement": "$1" }
 *     ],
 *     "progress": {
 *       "label": "攻略阶段",
 *       "initial": 0,
 *       "stages": [{ "name": "陌生", "min": 0 }, { "name": "熟悉", "min": 10 }]
 *     }
 *   }
 *
 * 也可以把同样 JSON 放进世界书条目：comment 或第一个 key 为 `status_schema`。
 * `progress.stages` 为空时会尝试从世界书的 `stage_names_overview` / `category:` 自动推导。
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function stringList(value, maxItems, maxLength) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, maxLength))
      .slice(0, maxItems)
    : [];
}

function safeFlags(value) {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  const flags = [...new Set(raw.replace(/[^imsu]/g, '').split(''))].join('');
  return flags;
}

export function normalizeStatusSchema(raw) {
  if (!isObject(raw)) return null;
  const ignoreLabels = stringList(raw.ignoreLabels ?? raw.ignore, 50, 40);
  const valueRules = [];
  if (Array.isArray(raw.valueRules)) {
    for (const rule of raw.valueRules.slice(0, 30)) {
      if (!isObject(rule)) continue;
      const label = text(rule.label, 40).trim();
      const pattern = text(rule.pattern, 300);
      if (label.length === 0 || pattern.length === 0) continue;
      valueRules.push({
        label,
        pattern,
        flags: safeFlags(rule.flags),
        replacement: text(rule.replacement, 200)
      });
    }
  }
  let progress = null;
  if (isObject(raw.progress)) {    const label = text(raw.progress.label, 40).trim();
    if (label.length > 0) {
      const stages = [];
      if (Array.isArray(raw.progress.stages)) {
        for (const stage of raw.progress.stages.slice(0, 50)) {
          if (!isObject(stage)) continue;
          const name = text(stage.name, 40).trim();
          const min = Number(stage.min);
          if (name.length > 0 && Number.isFinite(min)) stages.push({ name, min });
        }
        stages.sort((a, b) => a.min - b.min);
      }
      progress = {
        label,
        initial: Number.isFinite(Number(raw.progress.initial)) ? Number(raw.progress.initial) : 0,
        stages
      };
    }
  }
  const automations = {};
  if (isObject(raw.automations)) {
    for (const key of Object.keys(raw.automations).slice(0, 100)) {
      const id = text(key, 60).trim();
      if (id.length === 0) continue;
      const value = raw.automations[key];
      const list = Array.isArray(value) ? value : [value];
      const actions = list
        .map((item) => (typeof item === 'string' ? { action: 'script', script: item.slice(0, 4000) } : item))
        .filter((item) => isObject(item) && typeof item.action === 'string')
        .slice(0, 20)
        .map((item) => ({ ...item, action: item.action.slice(0, 40) }));
      if (actions.length > 0) automations[id] = actions;
    }
  }
  if (ignoreLabels.length === 0 && valueRules.length === 0 && progress === null
    && Object.keys(automations).length === 0 && raw.parseAnalysis !== true) return null;
  return {
    ignoreLabels,
    valueRules,
    progress,
    automations,
    // 兼容：有些旧卡把状态写在 <Analysis> 里；默认不解析，需要卡片显式开启。
    parseAnalysis: raw.parseAnalysis === true
  };
}

function parseJsonContent(value) {
  const source = text(value, 100000).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (source.length === 0) return null;
  try {
    const parsed = JSON.parse(source);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 读取卡级状态规则：优先角色扩展，其次世界书里的 `status_schema` 条目。
 */
export function statusSchemaFor(character, worlds = []) {
  const extensions = isObject(character?.extensions) ? character.extensions : {};
  for (const key of ['hdsh_status', 'status_schema', 'statusSchema']) {
    const normalized = normalizeStatusSchema(extensions[key]);
    if (normalized !== null) return normalized;
  }
  for (const world of worlds) {
    for (const entry of world.entries || []) {
      const comment = text(entry.comment, 80).trim().toLowerCase();
      const firstKey = Array.isArray(entry.keys) && entry.keys.length > 0
        ? text(entry.keys[0], 80).trim().toLowerCase()
        : '';
      if (comment !== 'status_schema' && firstKey !== 'status_schema') continue;
      const normalized = normalizeStatusSchema(parseJsonContent(entry.content));
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

function compileRule(rule) {
  try {
    return new RegExp(rule.pattern, rule.flags);
  } catch {
    return null;
  }
}

function valueScore(value) {
  const trimmed = value.trim();
  let score = 0;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) score += 3;
  if (trimmed.length <= 16) score += 1;
  if (/[\u3400-\u9fff]/.test(trimmed)) score += 1;
  if (/^(no change|unchanged|none)$/i.test(trimmed)) score -= 2;
  if (trimmed.length > 40) score -= 1;
  return score;
}

function dedupe(lines) {
  const out = [];
  for (const line of lines) {
    const label = text(line.label, 40).trim();
    const value = text(line.value, 200).trim();
    if (label.length === 0 || value.length === 0) continue;
    const existing = out.findIndex((item) => item.label === label);
    if (existing < 0) {
      out.push({ label, value });
      continue;
    }
    if (valueScore(value) > valueScore(out[existing].value)) {
      out[existing] = { label, value };
    }
  }
  return out;
}

/**
 * 应用卡级规则：忽略字段、值替换、去重。
 * @param {{label: string, value: string}[]} lines
 */
export function applyStatusSchema(lines, schema) {
  if (!Array.isArray(lines)) return [];
  const ignore = new Set((schema?.ignoreLabels ?? []).map((item) => item.toLowerCase()));
  const rules = (schema?.valueRules ?? []).map((rule) => ({ ...rule, regex: compileRule(rule) }));
  const mapped = [];
  for (const line of lines) {
    if (line === null || typeof line !== 'object') continue;
    const label = text(line.label, 40).trim();
    let value = text(line.value, 200).trim();
    if (label.length === 0 || value.length === 0) continue;
    if (ignore.has(label.toLowerCase())) continue;
    for (const rule of rules) {
      if (rule.regex === null) continue;
      if (rule.label !== '*' && rule.label !== label) continue;
      try {
        value = value.replace(rule.regex, rule.replacement);
      } catch {
        // 单条规则失败不影响其它字段
      }
    }
    value = value.trim().slice(0, 160);
    if (value.length === 0) continue;
    mapped.push({ label, value });
  }
  return dedupe(mapped).slice(0, 8);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stagesFromWorlds(label, worlds) {  const worldText = (worlds || [])
    .flatMap((world) => (world.entries || []).map((entry) => String(entry.content || '')))
    .join('\n');
  if (worldText.length === 0) return [];
  const stages = [];
  const overview = worldText.match(/stage_names_overview:\s*\n([\s\S]*?)(?=\n\s{0,4}[\w\u4e00-\u9fff]+:|\n\s*$)/);
  if (overview !== null) {
    const pattern = /^\s*-\s*([^(\n]+?)\s*\((>=|<)\s*(-?\d+(?:\.\d+)?)\)/gm;
    let match;
    while ((match = pattern.exec(overview[1])) !== null) {
      const name = match[1].trim();
      const threshold = Number(match[3]);
      if (name.length === 0 || !Number.isFinite(threshold)) continue;
      // 统一成 “达到 min 进入该阶段”。
      stages.push({ name, min: match[2] === '>=' ? threshold : threshold + 0.0001 });
    }
  }
  if (stages.length === 0 && label.length > 0) {
    const labelPattern = escapeRegExp(label);
    const category = worldText.match(new RegExp(
      `${labelPattern}:[\\s\\S]*?category:\\s*\\n([\\s\\S]*?)(?=\\n\\s{0,4}[\\w\\u4e00-\\u9fff]+:\\s*\\n|$)`
    ));
    const block = category !== null ? category[1] : '';
    const pattern = /^\s*(-?\d+(?:\.\d+)?)\s*~\s*(-?\d+(?:\.\d+)?)\s*:\s*(.+)$/gm;
    let match;
    while ((match = pattern.exec(block)) !== null) {
      const min = Number(match[1]);
      const name = match[3].trim();
      if (name.length > 0 && Number.isFinite(min)) stages.push({ name, min });
    }
  }
  if (stages.length === 0) return [];
  stages.sort((a, b) => a.min - b.min);
  return stages;
}

function consumeProgress(current, value) {
  const absolute = String(value).match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:·|$)/);
  if (absolute !== null) return Number(absolute[1]);
  const deltas = String(value).match(/[+-]\s*\d+(?:\.\d+)?/g);
  if (deltas !== null && deltas.length > 0) {
    return current + Number(deltas[deltas.length - 1].replace(/\s+/g, ''));
  }
  return current;
}

/**
 * 通用“进度型”状态：按配置的 label 累积数值，并映射到阶段名。
 * 没有配置 progress 时原样返回，不做任何猜测。
 */
export function enrichProgress(lines, messages, worlds, schema) {
  const progress = schema?.progress;
  if (!progress || !Array.isArray(lines)) return lines;
  const target = lines.find((line) => line.label === progress.label);
  if (target === undefined) return lines;
  const stages = progress.stages.length > 0 ? progress.stages : stagesFromWorlds(progress.label, worlds);
  let current = Number(progress.initial) || 0;
  for (const message of messages || []) {
    if (message.role !== 'assistant' || !Array.isArray(message.statusLines)) continue;
    const line = message.statusLines.find((item) => item.label === progress.label);
    if (line !== undefined) current = consumeProgress(current, line.value);
  }
  current = consumeProgress(current, target.value);
  let stage = '';
  for (const item of stages) {
    if (current >= item.min) stage = item.name;
  }
  target.value = stage.length > 0
    ? `${Number.isInteger(current) ? current : Number(current.toFixed(2))} · ${stage}`
    : String(Number.isInteger(current) ? current : Number(current.toFixed(2)));
  return lines;
}
