/**
 * 酒馆角色输出解析。
 *
 * 通用部分（默认）：
 *   - 剥离 <Analysis> / <UpdateVariable> / <JSONPatch> / <media_*>
 *   - 从 <StatusBlock>、<Status>、<State>、<Options>、【状态栏】、【状态】、【选项】 提取
 *   - 变量补丁按 JSONPatch 的 path 末段作为标签
 *   - 状态值原样保留，不做任何卡片专属翻译
 *
 * 卡片专属行为（数值截取、忽略字段、阶段名）由 `status_schema` 配置，
 * 见 lib/status.js；没有配置时不猜测语义。
 */
import { applyStatusSchema } from './status.js';

const MAX_STATUS = 12;

function statusBlockParser(block) {
  const lines = [];
  for (const rawLine of String(block).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').split(/\n+/)) {
    const line = rawLine
      .replace(/^[-*•\s]+/, '')
      .replace(/^【[^】]*】\s*/, '')
      .trim();
    if (line.length === 0) continue;
    const match = line.match(/^([^:：=]{1,24})\s*[:：=]\s*(.+)$/);
    if (match === null) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (label.length === 0 || value.length === 0) continue;
    lines.push({ label, value: value.slice(0, 160) });
  }
  return lines;
}

function parseOptions(block) {
  const options = [];
  for (const line of String(block).replace(/<br\s*\/?>/gi, '\n').split(/\n+/)) {
    for (const part of line.split('|')) {
      const cleaned = part
        .replace(/<[^>]+>/g, '')
        .replace(/^[-*•\s]+/, '')
        .replace(/^[A-Da-d1-9][.、)]\s*/, '')
        .replace(/^选项\s*[:：]?\s*/, '')
        .trim();
      if (cleaned.length > 0 && cleaned.length <= 300 && !options.includes(cleaned)) options.push(cleaned);
    }
  }
  return options.slice(0, 8);
}

function flattenValue(label, value, out) {
  if (label.length === 0 || value === undefined || value === null) return;
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) flattenValue(key, value[key], out);
    return;
  }
  const display = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);
  if (display.length === 0) return;
  if (!out.some((line) => line.label === label)) {
    out.push({ label, value: String(display).slice(0, 160) });
  }
}

function parseVariablePatch(block) {
  const lines = [];
  const source = String(block).trim();
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue;
        const path = typeof item.path === 'string' ? item.path : '';
        const label = path.split('/').filter(Boolean).pop() || '';
        flattenValue(label, item.value, lines);
      }
    } else if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.path === 'string') {
        const label = parsed.path.split('/').filter(Boolean).pop() || '';
        flattenValue(label, parsed.value, lines);
      } else {
        for (const key of Object.keys(parsed)) flattenValue(key, parsed[key], lines);
      }
    }
  } catch {
    // 不是合法 JSON：尝试按 JSONPatch 片段兜底。
    const pair = /"path"\s*:\s*"([^"]+)"[\s\S]{0,160}?"value"\s*:\s*("([^"]*)"|[-0-9.]+|true|false|\[[^\]]*\]|\{[^}]*\})/g;
    let match;
    while ((match = pair.exec(source)) !== null) {
      const label = match[1].split('/').filter(Boolean).pop() || '';
      flattenValue(label, match[2].replace(/^"|"$/g, ''), lines);
    }
  }
  return lines.slice(0, MAX_STATUS);
}

function collect(regex, text) {
  const out = [];
  let match;
  while ((match = regex.exec(text)) !== null) out.push(match[1]);
  return out;
}

export function extractReplyMeta(raw, schema = null) {
  let text = typeof raw === 'string' ? raw : '';
  const imageMatch = text.match(/<media_image>([\s\S]*?)(?:<\/media_image>|$)/i);
  const voiceMatch = text.match(/<media_voice>([\s\S]*?)(?:<\/media_voice>|$)/i);
  const imagePrompt = imageMatch === null ? '' : imageMatch[1].trim().slice(0, 600);
  const voiceText = voiceMatch === null ? '' : voiceMatch[1].trim().slice(0, 300);

  let statusLines = [];
  // 英文/混合标签
  const statusTags = /<(?:StatusBlock|Status|State)\b[^>]*>([\s\S]*?)<\/(?:StatusBlock|Status|State)>/gi;
  for (const block of collect(statusTags, text)) statusLines = statusLines.concat(statusBlockParser(block));
  // 中文方括号
  const statusChinese = text.matchAll(/【(?:状态栏|状态)】([\s\S]*?)(?=\n\s*\n|【|$)/g);
  for (const match of statusChinese) statusLines = statusLines.concat(statusBlockParser(match[1]));

  // 变量补丁：只解析显式标签，避免误吃正文 JSON。
  const variableBlock = text.match(/<(?:UpdateVariable|JSONPatch)>([\s\S]*?)(?:<\/(?:UpdateVariable|JSONPatch)>|$)/i);
  if (variableBlock !== null) statusLines = statusLines.concat(parseVariablePatch(variableBlock[1]));

  // 旧卡兼容：默认不把 <Analysis> 当状态；schema.parseAnalysis 显式开启后才解析。
  if (schema !== null && schema.parseAnalysis === true) {
    const analysisTags = /<Analysis>([\s\S]*?)(?:<\/Analysis>|$)/gi;
    for (const block of collect(analysisTags, text)) statusLines = statusLines.concat(statusBlockParser(block));
  }

  let quickOptions = [];
  const optionTags = /<(?:Options?|Choices?)\b[^>]*>([\s\S]*?)<\/(?:Options?|Choices?)>/gi;
  for (const block of collect(optionTags, text)) quickOptions = quickOptions.concat(parseOptions(block));
  const optionsChinese = text.matchAll(/【(?:选项|Options?)】([\s\S]*?)(?=\n\s*\n|【|$)/gi);
  for (const match of optionsChinese) quickOptions = quickOptions.concat(parseOptions(match[1]));

  const cleaned = applyStatusSchema(statusLines, schema);

  text = text
    .replace(/<media_image>[\s\S]*?(?:<\/media_image>|$)/gi, '')
    .replace(/<media_voice>[\s\S]*?(?:<\/media_voice>|$)/gi, '')
    .replace(/<UpdateVariable>[\s\S]*?(?:<\/UpdateVariable>|$)/gi, '')
    .replace(/<JSONPatch>[\s\S]*?(?:<\/JSONPatch>|$)/gi, '')
    .replace(/<Analysis>[\s\S]*?(?:<\/Analysis>|$)/gi, '')
    .replace(/<(?:StatusBlock|Status|State)\b[^>]*>[\s\S]*?<\/(?:StatusBlock|Status|State)>/gi, '')
    .replace(/【(?:状态栏|状态)】[\s\S]*?(?=\n\s*\n|【|$)/g, '')
    .replace(/<(?:Options?|Choices?)\b[^>]*>[\s\S]*?<\/(?:Options?|Choices?)>/gi, '')
    .replace(/【(?:选项|Options?)】[\s\S]*?(?=\n\s*\n|【|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: text.length > 0 ? text : '（角色只返回了状态更新）',
    statusLines: cleaned,
    quickOptions: dedupeStrings(quickOptions).slice(0, 8),
    imagePrompt,
    voiceText
  };
}

function dedupeStrings(values) {
  const out = [];
  for (const value of values) {
    const trimmed = String(value).trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
