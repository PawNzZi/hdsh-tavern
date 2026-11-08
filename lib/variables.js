/**
 * 角色变量：世界书声明 + 状态栏更新。
 *
 * 声明位置（任选其一，后者覆盖前者）：
 *   1. 世界书条目：comment / 第一个 key 为 `variables`、`variable_schema` 或 `变量`，内容为 JSON；
 *   2. 角色扩展：`extensions.hdsh_status.variables`；
 *   3. `status_schema.progress` 会自动合成一个进度变量。
 *
 * 变量声明示例：
 *   {
 *     "variables": {
 *       "affection": {
 *         "label": "好感度",
 *         "aliases": ["好感"],
 *         "type": "number",
 *         "initial": 0,
 *         "min": 0,
 *         "max": 100,
 *         "stages": [
 *           { "name": "陌生", "min": 0 },
 *           { "name": "熟悉", "min": 10 }
 *         ]
 *       }
 *     }
 *   }
 *
 * 状态栏更新：
 *   - `好感度: +3`  → 累加
 *   - `好感度: 12`  → 设为 12
 *   - `好感度: 熟悉` → 映射到该阶段的 min
 *   - 数值会被 clamp 到 min/max，并显示 `12 · 熟悉`
 */
import { stagesFromWorlds, statusSchemaFor } from './status.js';

const VARIABLE_ENTRY_NAMES = ['variables', 'variable_schema', 'variable schema', '变量'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function stringList(value, maxItems = 50, maxLength = 80) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, maxLength))
      .slice(0, maxItems)
    : [];
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

function normalizeVariable(key, raw) {
  const source = isObject(raw) ? raw : {};
  const id = text(key, 80).trim();
  if (id.length === 0) return null;
  const label = text(source.label ?? source.name, 40).trim() || id;
  const aliases = stringList(source.aliases, 20, 40);
  if (!aliases.includes(label)) aliases.push(label);
  if (!aliases.includes(id)) aliases.push(id);
  const stages = [];
  if (Array.isArray(source.stages)) {
    for (const stage of source.stages.slice(0, 50)) {
      if (!isObject(stage)) continue;
      const name = text(stage.name, 40).trim();
      const min = Number(stage.min);
      if (name.length > 0 && Number.isFinite(min)) stages.push({ name, min });
    }
    stages.sort((a, b) => a.min - b.min);
  }
  const hasMin = Number.isFinite(Number(source.min));
  const hasMax = Number.isFinite(Number(source.max));
  const initialRaw = source.initial ?? source.value ?? 0;
  const type = source.type === 'string' || source.type === 'number' || source.type === 'boolean'
    ? source.type
    : (stages.length > 0 || typeof initialRaw === 'number' ? 'number' : 'string');
  return {
    key: id,
    label,
    aliases,
    type,
    initial: type === 'number'
      ? (Number.isFinite(Number(initialRaw)) ? Number(initialRaw) : 0)
      : (type === 'boolean' ? initialRaw === true : String(initialRaw ?? '')),
    min: hasMin ? Number(source.min) : null,
    max: hasMax ? Number(source.max) : null,
    stages,
    unit: text(source.unit, 20),
    description: text(source.description ?? source.desc, 500)
  };
}

export function normalizeVariables(raw) {
  if (!isObject(raw)) return {};
  const source = isObject(raw.variables) ? raw.variables : raw;
  const out = {};
  for (const key of Object.keys(source).slice(0, 100)) {
    const normalized = normalizeVariable(key, source[key]);
    if (normalized !== null) out[normalized.key] = normalized;
  }
  return out;
}

function addVariables(out, variables) {
  for (const key of Object.keys(variables)) out[key] = variables[key];
  return out;
}

function schemaFromRaw(raw) {
  if (!isObject(raw)) return {};
  if (isObject(raw.variables)) return normalizeVariables(raw.variables);
  if (isObject(raw.progress)) {
    const label = text(raw.progress.label, 40).trim();
    if (label.length === 0) return {};
    const key = label;
    return normalizeVariables({
      [key]: {
        label,
        initial: raw.progress.initial,
        stages: Array.isArray(raw.progress.stages) ? raw.progress.stages : []
      }
    });
  }
  return {};
}

/** 非 JSON 的简单声明：`好感度: 0 (0-100)` / `地点: 家`。 */
function parseSimpleVariableText(source) {
  const out = {};
  for (const rawLine of String(source).split(/\n+/)) {
    const line = rawLine.replace(/^[-*•\s]+/, '').trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('//') || line.startsWith('```')) continue;
    const match = line.match(/^([^:：]{1,30})\s*[:：]\s*(.+)$/);
    if (match === null) continue;
    const label = match[1].trim();
    let rest = match[2].trim();
    const range = rest.match(/\(([-+]?\d+(?:\.\d+)?)\s*[-~]\s*([-+]?\d+(?:\.\d+)?)\)/);
    const extra = {};
    if (range !== null) {
      extra.min = Number(range[1]);
      extra.max = Number(range[2]);
      rest = rest.replace(range[0], '').trim();
    }
    rest = rest.split('#')[0].trim();
    const numeric = rest.match(/^-?\d+(?:\.\d+)?/);
    const def = normalizeVariable(label, {
      label,
      initial: numeric !== null ? Number(numeric[0]) : rest,
      ...extra
    });
    if (def !== null) out[def.key] = def;
  }
  return out;
}

function variablesFromEntryContent(content) {
  const parsed = parseJsonContent(content);
  if (parsed !== null) return normalizeVariables(parsed);
  return parseSimpleVariableText(content);
}

/**
 * 汇总一个角色可用的变量声明。
 * @param {object} character
 * @param {object[]} worlds
 */
export function variableSchemaFor(character, worlds = []) {
  const out = {};
  for (const world of worlds) {
    for (const entry of world.entries || []) {
      const comment = text(entry.comment, 80).trim().toLowerCase();
      const firstKey = Array.isArray(entry.keys) && entry.keys.length > 0
        ? text(entry.keys[0], 80).trim().toLowerCase()
        : '';
      const isVariableEntry = VARIABLE_ENTRY_NAMES.includes(comment) || VARIABLE_ENTRY_NAMES.includes(firstKey);
      if (!isVariableEntry) continue;
      addVariables(out, variablesFromEntryContent(entry.content));
    }
  }
  const extensions = isObject(character?.extensions) ? character.extensions : {};
  for (const key of ['hdsh_status', 'status_schema', 'statusSchema']) {
    addVariables(out, schemaFromRaw(extensions[key]));
  }
  // status_schema 世界书条目里的 variables / progress
  for (const world of worlds) {
    for (const entry of world.entries || []) {
      const comment = text(entry.comment, 80).trim().toLowerCase();
      const firstKey = Array.isArray(entry.keys) && entry.keys.length > 0
        ? text(entry.keys[0], 80).trim().toLowerCase()
        : '';
      if (comment !== 'status_schema' && firstKey !== 'status_schema') continue;
      addVariables(out, schemaFromRaw(parseJsonContent(entry.content)));
    }
  }
  // 兜底：statusSchemaFor 已解析的 progress（character/world 都覆盖时）
  const statusSchema = statusSchemaFor(character, worlds);
  if (statusSchema?.progress) {
    addVariables(out, schemaFromRaw({ progress: statusSchema.progress }));
    const label = statusSchema.progress.label;
    const def = out[label];
    if (def !== undefined && def.stages.length === 0) {
      def.stages = stagesFromWorlds(label, worlds);
    }
  }
  return out;
}

export function initialVariables(schema) {
  const out = {};
  for (const key of Object.keys(schema || {})) {
    out[key] = schema[key].initial;
  }
  return out;
}

/** 从聊天历史重算变量（用于分支/删除/重新生成后的确定性状态）。 */
export function variablesFromMessages(messages, schema) {
  let values = initialVariables(schema);
  for (const message of messages || []) {
    if (message.role !== 'assistant' || !Array.isArray(message.statusLines)) continue;
    values = applyVariables(message.statusLines, values, schema).variables;
  }
  return values;
}

function findDefinition(line, schema) {
  const label = text(line?.label, 60).trim().toLowerCase();
  if (label.length === 0) return null;
  for (const key of Object.keys(schema)) {
    const def = schema[key];
    if (def.aliases.some((alias) => alias.toLowerCase() === label)) return def;
  }
  return null;
}

function clamp(def, value) {
  let next = value;
  if (def.min !== null) next = Math.max(def.min, next);
  if (def.max !== null) next = Math.min(def.max, next);
  return next;
}

function stageName(def, value) {
  let name = '';
  for (const stage of def.stages) {
    if (value >= stage.min) name = stage.name;
  }
  return name;
}

export function formatVariable(def, value) {
  if (def.type === 'boolean') return value === true ? '是' : '否';
  if (def.type !== 'number') return String(value ?? '');
  const rounded = Number.isInteger(value) ? value : Number(Number(value).toFixed(2));
  const stage = stageName(def, rounded);
  const unit = def.unit.length > 0 ? def.unit : '';
  return stage.length > 0 ? `${rounded}${unit} · ${stage}` : `${rounded}${unit}`;
}

function consume(def, current, rawValue) {
  const raw = text(rawValue, 200).trim();
  if (raw.length === 0) return current;
  if (def.type === 'boolean') {
    if (/^(true|yes|是|开)$/i.test(raw)) return true;
    if (/^(false|no|否|关)$/i.test(raw)) return false;
    return current;
  }
  if (def.type !== 'number') {
    const stage = def.stages.find((item) => item.name === raw);
    if (stage !== undefined) return stage.name;
    return raw;
  }
  const stage = def.stages.find((item) => item.name === raw);
  if (stage !== undefined) return clamp(def, stage.min);
  // 明确的正负号 = 增量；否则第一个数字 = 绝对值。
  const delta = raw.match(/^[+-]\s*\d+(?:\.\d+)?/);
  if (delta !== null) {
    const base = Number.isFinite(Number(current)) ? Number(current) : 0;
    return clamp(def, base + Number(delta[0].replace(/\s+/g, '')));
  }
  const absolute = raw.match(/^-?\d+(?:\.\d+)?/);
  if (absolute !== null) {
    return clamp(def, Number(absolute[0]));
  }
  return current;
}

/**
 * 把本轮状态栏映射到变量，并返回更新后的状态。
 * 未声明的标签原样保留（仍作为普通状态显示）。
 * @returns {{lines: object[], variables: Record<string, any>}}
 */
export function applyVariables(lines, previous, schema) {
  const values = { ...initialVariables(schema), ...(isObject(previous) ? previous : {}) };
  if (!Array.isArray(lines)) return { lines: [], variables: values };
  const out = [];
  for (const line of lines) {
    if (!isObject(line)) continue;
    const def = findDefinition(line, schema);
    if (def === null) {
      out.push({ ...line });
      continue;
    }
    values[def.key] = consume(def, values[def.key], line.value);
    out.push({
      ...line,
      key: def.key,
      label: def.label,
      value: formatVariable(def, values[def.key])
    });
  }
  return { lines: out, variables: values };
}

/** 生成本轮 Prompt 的变量快照；没有声明时返回空串。 */
export function renderVariables(values, schema) {
  const defs = Object.keys(schema || {});
  if (defs.length === 0) return '';
  const lines = [];
  for (const key of defs) {
    const def = schema[key];
    const value = values !== null && values !== undefined && values[key] !== undefined
      ? values[key]
      : def.initial;
    lines.push(`${def.label}：${formatVariable(def, value)}`);
  }
  return lines.join('\n');
}

/** 替换 {{getvar::key}} / {{getglobalvar::key}}；未知变量用默认值或空串。 */
export function substituteVariables(value, values) {
  return String(value).replace(
    /\{\{\s*(?:getvar|getglobalvar)::([^:}]+)(?:::([^}]*))?\}\}/gi,
    (_match, key, fallback) => {
      const name = String(key).trim();
      const found = isObject(values) ? values[name] : undefined;
      if (found !== undefined && found !== null) return String(found);
      return fallback === undefined ? '' : String(fallback);
    }
  );
}
