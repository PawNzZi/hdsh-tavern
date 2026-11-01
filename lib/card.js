/**
 * Character card V1/V2/V3 归一化与 PNG tEXt 解析。
 *
 * 兼容格式实现，不复制 SillyTavern 的 AGPL 代码。
 */
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { normalizeWorldBook } from './worldbook.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_CARD_BYTES = 32 * 1024 * 1024;

function text(value, max = 200000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function stripMarkup(value) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/** 从角色卡里提取状态栏和快捷选项；不同卡用不同标签，这里做统一归一化。 */
export function extractCardMeta(character) {
  const sources = [
    character.description,
    character.firstMes,
    ...(character.alternateGreetings || []),
    character.example,
    character.systemPrompt
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const statusLines = [];
  const quickOptions = [];
  const addStatusLine = (line) => {
    const cleaned = stripMarkup(line).replace(/^[-*•\s]+/, '').trim();
    if (cleaned.length === 0) return;
    const match = cleaned.match(/^([^:：]{1,14})[:：]\s*(.+)$/);
    if (match !== null) {
      const label = match[1].trim();
      const value = match[2].trim();
      if (label.length > 0 && value.length > 0 && !statusLines.some((item) => item.label === label)) {
        statusLines.push({ label, value: value.slice(0, 120) });
      }
    } else if (cleaned.length <= 120 && statusLines.length < 8) {
      statusLines.push({ label: '', value: cleaned });
    }
  };
  const addOption = (line) => {
    const cleaned = stripMarkup(line)
      .replace(/^[-*•\s]+/, '')
      .replace(/^[A-Da-d1-9][.、)]\s*/, '')
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 300 && !quickOptions.includes(cleaned)) {
      quickOptions.push(cleaned);
    }
  };

  for (const source of sources) {
    const statusBlocks = source.match(/<(?:status|状态|状态栏)[^>]*>([\s\S]*?)<\/(?:status|状态|状态栏)>/gi)
      || source.match(/【(?:状态栏|状态)】([\s\S]*?)(?=\n\n|$)/g)
      || [];
    for (const block of statusBlocks) {
      const inner = block.replace(/^<[^>]+>|<\/[^>]+>$/g, '').replace(/^【[^】]+】/, '');
      inner.split(/\n+/).forEach(addStatusLine);
    }
    const optionBlocks = source.match(/<(?:options?|选项)[^>]*>([\s\S]*?)<\/(?:options?|选项)>/gi)
      || source.match(/【(?:选项|Options?)】([\s\S]*?)(?=\n\n|$)/gi)
      || [];
    for (const block of optionBlocks) {
      const inner = block.replace(/^<[^>]+>|<\/[^>]+>$/g, '').replace(/^【[^】]+】/, '');
      inner.split(/\n+/).forEach(addOption);
    }
  }
  return { statusLines: statusLines.slice(0, 8), quickOptions: quickOptions.slice(0, 8) };
}

function strings(value, maxItems = 50) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.slice(0, 20000)).slice(0, maxItems)
    : [];
}

/** 有些卡把一段开场白拆成多个段落存进 alternate_greetings，这里把连续片段合回场景。 */
export function coalesceGreetings(list) {
  if (!Array.isArray(list) || list.length < 8) return list;
  const fragmented = list.every((item) => typeof item === 'string'
    && item.length < 900 && !item.includes('\n\n'));
  if (!fragmented) return list;
  const sceneStart = /^(距离|第[一二三四五六七八九十0-9]+[天章节]|[0-9]{4}年|爸的|那天|第二天|清晨|早晨|上午|中午|下午|傍晚|晚上|深夜|周末|放学|回家|门铃|电话)/;
  const groups = [];
  let current = '';
  for (const fragment of list) {
    const startsScene = sceneStart.test(fragment.trim()) && current.length > 200;
    if (startsScene && current.length > 0) {
      groups.push(current);
      current = fragment;
    } else {
      current = current.length > 0 ? `${current}\n\n${fragment}` : fragment;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 读取 PNG tEXt 里的 ccv3/chara；优先 ccv3。 */
export function readPngCard(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > MAX_CARD_BYTES) {
    throw new Error('PNG 文件为空或过大');
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是有效的 PNG 文件');
  }
  let offset = 8;
  let v3 = null;
  let v2 = null;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) {
      throw new Error('PNG 数据块损坏');
    }
    if (type === 'tEXt') {
      const data = buffer.subarray(start, end);
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = data.subarray(0, zero).toString('latin1').toLowerCase();
        const value = data.subarray(zero + 1).toString('latin1');
        if (keyword === 'ccv3') {
          v3 = value;
        } else if (keyword === 'chara') {
          v2 = value;
        }
      }
    }
    offset = end + 4; // CRC
    if (type === 'IEND') {
      break;
    }
  }
  const encoded = v3 || v2;
  if (encoded === null) {
    throw new Error('PNG 没有角色卡元数据（ccv3/chara）');
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('PNG 角色卡元数据不是合法 JSON');
  }
  return normalizeCard(raw);
}

/** 把 V1/V2/V3 统一成内部角色对象（不含 id/avatar）。 */
export function normalizeCard(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('角色卡不是 JSON 对象');
  }
  const data = raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data
    : raw;
  const name = text(data.name, 120).trim();
  if (name.length === 0) {
    throw new Error('角色卡缺少 name');
  }
  const character = {
    name,
    description: text(data.description),
    personality: text(data.personality),
    scenario: text(data.scenario),
    firstMes: text(data.first_mes || data.firstMessage),
    example: text(data.mes_example || data.exampleDialogue),
    creatorNotes: text(data.creator_notes || data.creatorcomment),
    systemPrompt: text(data.system_prompt || data.systemPrompt),
    postHistory: text(data.post_history_instructions || data.postHistoryInstructions),
    alternateGreetings: strings(data.alternate_greetings || data.alternateGreetings),
    tags: strings(data.tags, 20),
    creator: text(data.creator, 120),
    characterVersion: text(data.character_version || data.characterVersion, 80),
    extensions: data.extensions !== null && typeof data.extensions === 'object' && !Array.isArray(data.extensions)
      ? data.extensions
      : {},
    voice: text(data.extensions?.hdsh_voice, 80),
    spec: text(raw.spec, 40),
    specVersion: text(raw.spec_version, 20),
    book: null
  };
  const book = data.character_book;
  if (book !== null && typeof book === 'object' && !Array.isArray(book)) {
    character.book = normalizeWorldBook(book, `${name} 的世界书`);
    const bookEntries = Array.isArray(book.entries) ? book.entries : [];
    const bookGreetings = [];
    for (const entry of bookEntries) {
      if (entry === null || typeof entry !== 'object') continue;
      const keys = Array.isArray(entry.keys) ? entry.keys.join(' ') : String(entry.keys || '');
      const label = `${entry.comment || ''} ${entry.name || ''} ${keys}`;
      if (!/开场白|开场|greeting|first[_ ]?mes|alternate/i.test(label)) continue;
      const content = entry.content || entry.entry || '';
      if (typeof content === 'string' && content.trim().length > 0) bookGreetings.push(content);
    }
    if (bookGreetings.length > 0) {
      character.alternateGreetings = character.alternateGreetings.concat(bookGreetings);
    }
  }
  const meta = extractCardMeta(character);
  character.statusLines = meta.statusLines;
  character.quickOptions = meta.quickOptions;
  return character;
}

/** JSON 角色卡解析。 */
export function readJsonCard(buffer) {
  let raw;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('JSON 文件格式错误');
  }
  return normalizeCard(raw);
}

/** 读取 ZIP（CHARX/BYAF）里的 JSON 角色卡；只解析需要的条目，不解压资源。 */
export function readZipCard(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('ZIP 文件为空或过小');
  }
  let eocd = -1;
  const lowerBound = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 目录损坏');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const candidates = [];
  for (let index = 0; index < count && cursor + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name.toLowerCase().endsWith('.json') && !name.toLowerCase().endsWith('settings.json')) {
      if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(dataStart, dataStart + compressedSize);
        let json;
        try {
          const raw = method === 8 ? zlib.inflateRawSync(data) : data;
          if (uncompressedSize > 32 * 1024 * 1024) continue;
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          continue;
        }
        candidates.push({ name, json });
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (candidates.length === 0) throw new Error('ZIP 里没有可解析的 JSON 角色卡');
  const preferred = candidates.find((item) => /(^|\/)(card|character|chara)\.json$/i.test(item.name))
    || candidates[0];
  return normalizeCard(preferred.json);
}

/** 根据文件名/MIME 自动选择 JSON、PNG 或 ZIP（CHARX/BYAF）。 */
export function parseCardBuffer(buffer, fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.charx') || lower.endsWith('.byaf') || lower.endsWith('.zip')
    || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50)) {
    return { card: readZipCard(buffer), image: null, source: lower.endsWith('.byaf') ? 'byaf' : 'charx' };
  }
  if (lower.endsWith('.png') || (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE))) {
    return { card: readPngCard(buffer), image: buffer, source: 'png' };
  }
  return { card: readJsonCard(buffer), image: null, source: 'json' };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 把角色 JSON 写入 PNG 的 chara tEXt chunk；没有头像时生成 1x1 透明 PNG。 */
export function writePngCard(image, character) {
  const base = image !== null && Buffer.isBuffer(image) && image.length >= 8 && image.subarray(0, 8).equals(PNG_SIGNATURE)
    ? image
    : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      first_mes: character.firstMes,
      mes_example: character.example,
      creator_notes: character.creatorNotes,
      system_prompt: character.systemPrompt,
      post_history_instructions: character.postHistory,
      alternate_greetings: character.alternateGreetings || [],
      tags: character.tags || [],
      creator: character.creator || '',
      character_version: character.characterVersion || '',
      extensions: { ...(character.extensions || {}), ...(character.voice ? { hdsh_voice: character.voice } : {}) },
      ...(character.embeddedBook === undefined ? {} : { character_book: character.embeddedBook })
    }
  };
  const textData = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1')
  ]);
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= base.length) {
    const length = base.readUInt32BE(offset);
    const type = base.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 8 + length + 4;
    if (type === 'tEXt') {
      const data = base.subarray(offset + 8, offset + 8 + length);
      const zero = data.indexOf(0);
      const keyword = zero > 0 ? data.subarray(0, zero).toString('latin1').toLowerCase() : '';
      if (keyword === 'chara' || keyword === 'ccv3') {
        offset = end;
        continue;
      }
    }
    if (type === 'IEND') {
      chunks.push(pngChunk('tEXt', textData));
    }
    chunks.push(base.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}
export function extractCardJson(raw) {
  const data = raw?.data !== null && typeof raw?.data === 'object' ? raw.data : raw;
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...data,
      character_book: data?.character_book
    }
  };
}
