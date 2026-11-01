/**
 * 酒馆角色输出解析：剥离 Analysis/JSONPatch，提取通用状态栏与快捷选项。
 * 不同角色卡标签不同，这里统一为 statusLines / quickOptions。
 */
function linesOf(block) {
  return block
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/【[^】]+】/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);
}

function parseStatus(block) {
  const lines = [];
  for (const line of linesOf(block)) {
    const match = line.match(/^([^:：]{1,16})[:：]\s*(.+)$/);
    if (match !== null) {
      const label = match[1].trim();
      const value = match[2].trim();
      if (label.length > 0 && value.length > 0) lines.push({ label, value: value.slice(0, 160) });
    } else if (line.length <= 160 && lines.length < 12) {
      lines.push({ label: '', value: line });
    }
  }
  return lines.slice(0, 12);
}

function parseOptions(block) {
  const options = [];
  for (const line of block.replace(/<br\s*\/?>/gi, '\n').split(/\n+/)) {
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

function parseAnalysisStatus(block) {
  const lines = [];
  for (const rawLine of block.split(/\n+/)) {
    const line = rawLine.replace(/^[-*•\s]+/, '').trim();
    const match = line.match(/^([^:：]{1,16})[:：]\s*(.+)$/);
    if (match === null) continue;
    const label = match[1].trim();
    if (label === '郑怡云' || label === 'History check' || label === 'Time' || label === 'Dramatic updates') continue;
    let value = match[2].trim();
    const arrow = value.lastIndexOf('→');
    if (arrow >= 0) value = value.substring(arrow + 1).trim();
    value = value.replace(/\s*\([^)]*\)\s*$/, '').replace(/[。.]$/, '').trim();
    if (value.length === 0 || value.length > 160) continue;
    if (!lines.some((lineValue) => lineValue.label === label)) lines.push({ label, value });
  }
  return lines;
}

function parseVariablePatch(text) {
  const lines = [];
  const patch = text.match(/<JSONPatch>([\s\S]*?)(?:<\/JSONPatch>|$)/i);
  const source = patch !== null ? patch[1] : text;
  const pushValue = (label, value) => {
    if (label.length === 0 || value === undefined || value === null) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        pushValue(key, value[key]);
      }
      return;
    }
    const display = typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
    if (display.length > 0 && !lines.some((line) => line.label === label)) {
      lines.push({ label, value: String(display).slice(0, 160) });
    }
  };
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue;
        const path = typeof item.path === 'string' ? item.path : '';
        const label = path.split('/').filter(Boolean).pop() || '';
        pushValue(label, item.value);
      }
    }
  } catch {
    // 不合法 JSONPatch 就交给正则兜底
  }
  if (lines.length === 0) {
    const pair = /"path"\s*:\s*"([^"]+)"[\s\S]{0,160}?"value"\s*:\s*("([^"]*)"|[-0-9.]+|true|false)/g;
    let match;
    while ((match = pair.exec(source)) !== null) {
      const label = match[1].split('/').filter(Boolean).pop() || '';
      const value = match[2].replace(/^"|"$/g, '');
      pushValue(label, value);
    }
  }
  return lines.slice(0, 12);
}

export function extractReplyMeta(raw) {
  let text = typeof raw === 'string' ? raw : '';
  let statusLines = [];
  let quickOptions = [];
  const imageMatch = text.match(/<media_image>([\s\S]*?)(?:<\/media_image>|$)/i);
  const voiceMatch = text.match(/<media_voice>([\s\S]*?)(?:<\/media_voice>|$)/i);
  const imagePrompt = imageMatch === null ? '' : imageMatch[1].trim().slice(0, 600);
  const voiceText = voiceMatch === null ? '' : voiceMatch[1].trim().slice(0, 300);

  const statusMatches = [
    ...text.matchAll(/<(?:StatusBlock|Status|status|状态栏)[^>]*>([\s\S]*?)<\/(?:StatusBlock|Status|status|状态栏)>/gi)
  ];
  for (const match of statusMatches) {
    statusLines = statusLines.concat(parseStatus(match[1]));
  }
  const statusChinese = text.match(/【(?:状态栏|状态)】([\s\S]*?)(?=\n\s*\n|【|$)/);
  if (statusChinese !== null) statusLines = statusLines.concat(parseStatus(statusChinese[1]));

  const variableBlock = text.match(/<UpdateVariable>([\s\S]*?)(?:<\/UpdateVariable>|$)/i);
  if (variableBlock !== null) statusLines = statusLines.concat(parseVariablePatch(variableBlock[1]));
  else statusLines = statusLines.concat(parseVariablePatch(text));
  const analysisBlock = text.match(/<Analysis>([\s\S]*?)(?:<\/Analysis>|$)/i);
  if (analysisBlock !== null) statusLines = statusLines.concat(parseAnalysisStatus(analysisBlock[1]));

  const optionMatches = [
    ...text.matchAll(/<(?:Options?|options?|选项)[^>]*>([\s\S]*?)(?:<\/(?:Options?|options?|选项)>|$)/gi)
  ];
  for (const match of optionMatches) {
    quickOptions = quickOptions.concat(parseOptions(match[1]));
  }
  const optionsChinese = text.match(/【(?:选项|Options?)】([\s\S]*?)(?=\n\s*\n|【|$)/i);
  if (optionsChinese !== null) quickOptions = quickOptions.concat(parseOptions(optionsChinese[1]));

  text = text
    .replace(/<media_image>[\s\S]*?(?:<\/media_image>|$)/gi, '')
    .replace(/<media_voice>[\s\S]*?(?:<\/media_voice>|$)/gi, '')
    .replace(/<UpdateVariable>[\s\S]*?(?:<\/UpdateVariable>|$)/gi, '')
    .replace(/<Analysis>[\s\S]*?(?:<\/Analysis>|$)/gi, '')
    .replace(/<JSONPatch>[\s\S]*?(?:<\/JSONPatch>|$)/gi, '')
    .replace(/<(?:StatusBlock|Status|status|状态栏)[^>]*>[\s\S]*?<\/(?:StatusBlock|Status|status|状态栏)>/gi, '')
    .replace(/【(?:状态栏|状态)】[\s\S]*?(?=\n\s*\n|【|$)/g, '')
    .replace(/<(?:Options?|options?|选项)[^>]*>[\s\S]*?(?:<\/(?:Options?|options?|选项)>|$)/gi, '')
    .replace(/【(?:选项|Options?)】[\s\S]*?(?=\n\s*\n|【|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text: text.length > 0 ? text : '（角色只返回了状态更新）',
    statusLines: dedupeStatus(statusLines).slice(0, 8),
    quickOptions: quickOptions.slice(0, 8),
    imagePrompt,
    voiceText
  };
}

export function normalizeStatusValue(label, value) {
  const text = String(value);
  if (label === '攻略阶段' || label === '警惕程度' || label === '好感度'
    || label === '身体开放度' || label === '攻略进度') {
    const signed = text.match(/[+-]\d+(?:\.\d+)?/g);
    if (signed !== null && signed.length > 0) return signed[signed.length - 1];
    if (/no change|unchanged/i.test(text)) return '无变化';
    if (/small|slight|minor|rise|push/i.test(text)) return '小幅推进';
  }
  if (label === '对user态度' || label === '对用户态度') {
    if (/anger|angry|furious/i.test(text)) return '愤怒';
    if (/calm|neutral/i.test(text)) return '平静';
    if (/wary|alert/i.test(text)) return '警惕';
  }
  return text;
}

function dedupeStatus(lines) {
  const ignored = new Set(['Time', 'Time passed', 'History check', 'Dramatic updates', '郑怡云']);
  const unique = [];
  for (const line of lines) {
    if (line === null || typeof line.label !== 'string' || line.label.length === 0) continue;
    if (ignored.has(line.label)) continue;
    const existing = unique.findIndex((item) => item.label === line.label);
    const normalized = { label: line.label, value: normalizeStatusValue(line.label, line.value) };
    if (existing < 0) {
      unique.push(normalized);
      continue;
    }
    const current = unique[existing];
    const currentHasCjk = /[\u3400-\u9fff]/.test(current.value);
    const nextHasCjk = /[\u3400-\u9fff]/.test(line.value);
    const currentLooksProse = current.value.length > 24 && !/^[+\-\d]/.test(current.value);
    const nextLooksShort = line.value.length <= 24 || /^[+\-\d]/.test(line.value);
    if ((!currentHasCjk && nextHasCjk) || (currentLooksProse && nextLooksShort)) {
      unique[existing] = normalized;
    }
  }
  return unique;
}

export function enrichStatus(statusLines, messages, worlds) {
  const target = statusLines.find((line) => line.label === '攻略阶段');
  if (target === undefined) return statusLines;
  const worldText = (worlds || []).flatMap((world) => (world.entries || []).map((entry) => entry.content || '')).join('\n');
  const stageNames = [];
  const overview = worldText.match(/stage_names_overview:\s*\n([\s\S]*?)(?=\n\s{0,4}[\w\u4e00-\u9fff]+:|\n\s*$)/);
  if (overview !== null) {
    const pattern = /^\s*-\s*([^\(\n]+?)\s*\((<|>=)\s*(\d+)\)/gm;
    let match;
    while ((match = pattern.exec(overview[1])) !== null) {
      stageNames.push({ name: match[1].trim(), operator: match[2], threshold: Number(match[3]) });
    }
  }
  const categoryNames = [];
  const categoryBlock = worldText.match(/攻略阶段:[\s\S]*?category:\s*\n([\s\S]*?)(?=\n\s{0,4}[\w\u4e00-\u9fff]+:\s*\n|$)/);
  if (categoryBlock !== null) {
    const pattern = /^\s*(\d+)\s*~\s*(\d+)\s*:\s*(.+)$/gm;
    let match;
    while ((match = pattern.exec(categoryBlock[1])) !== null) {
      categoryNames.push({ min: Number(match[1]), max: Number(match[2]), name: match[3].trim() });
    }
  }
  let current = 0;
  const initial = worldText.match(/^\s*攻略阶段:\s*(\d+)\s*$/m);
  if (initial !== null) current = Number(initial[1]);
  const consume = (value) => {
    if (typeof value !== 'string') return;
    const absolute = value.match(/^\s*(\d+(?:\.\d+)?)(?:\s*·|$)/);
    if (absolute !== null) {
      current = Number(absolute[1]);
      return;
    }
    const deltas = value.match(/[+-]\s*\d+(?:\.\d+)?/g);
    if (deltas !== null && deltas.length > 0) {
      current += Number(deltas[deltas.length - 1].replace(/\s+/g, ''));
    }
  };
  for (const message of messages || []) {
    if (message.role !== 'assistant' || !Array.isArray(message.statusLines)) continue;
    const line = message.statusLines.find((item) => item.label === '攻略阶段');
    if (line !== undefined) consume(String(line.value));
  }
  consume(String(target.value));
  let stage = '';
  for (const item of stageNames) {
    if (item.operator === '<' && current < item.threshold) {
      stage = item.name;
      break;
    }
    if (item.operator === '>=' && current >= item.threshold) {
      stage = item.name;
      break;
    }
  }
  if (stage.length === 0) {
    const category = categoryNames.find((item) => current >= item.min && current <= item.max);
    if (category !== undefined) stage = category.name;
  }
  target.value = stage.length > 0 ? `${current} · ${stage}` : String(current);
  return statusLines;
}
