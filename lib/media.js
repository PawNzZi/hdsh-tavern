import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 阿里百炼客户端：Wan 2.7 生图 + CosyVoice v3.5-Flash 语音。 */

function hostOf(workspaceId) {
  const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  return workspace.length > 0
    ? `https://${workspace}.cn-beijing.maas.aliyuncs.com`
    : 'https://dashscope.aliyuncs.com';
}

async function postJson(url, apiKey, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok || json === null) {
    const message = json?.message || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(`百炼请求失败：${message}`);
  }
  if (json.code !== undefined && json.code !== null && json.code !== '') {
    throw new Error(`百炼返回错误：${json.message || json.code}`);
  }
  return json;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`媒体下载失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function mediaDir(root) {
  const dir = path.join(root, 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function generateImage({ apiKey, workspaceId, prompt, size = '1280*1280' }) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('还没有填写阿里百炼 API Key');
  }
  const text = String(prompt || '').trim().slice(0, 2000);
  if (text.length === 0) throw new Error('生图描述为空');
  const body = {
    model: 'wan2.7-image',
    input: {
      messages: [{ role: 'user', content: [{ text }] }]
    },
    parameters: {
      n: 1,
      size,
      prompt_extend: false,
      watermark: false
    }
  };
  const json = await postJson(
    `${hostOf(workspaceId)}/api/v1/services/aigc/multimodal-generation/generation`,
    apiKey.trim(),
    body
  );
  const content = json?.output?.choices?.[0]?.message?.content;
  const imageUrl = Array.isArray(content)
    ? content.find((item) => item?.type === 'image' || typeof item?.image === 'string')?.image
    : '';
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    throw new Error('百炼没有返回图片 URL');
  }
  return download(imageUrl);
}

export async function generateVoice({ apiKey, workspaceId, text, voice = 'longanhuan_v3' }) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('还没有填写阿里百炼 API Key');
  }
  const content = String(text || '').trim().slice(0, 300);
  if (content.length === 0) throw new Error('语音文本为空');
  const body = {
    model: 'cosyvoice-v3.5-flash',
    input: {
      text: content,
      voice: typeof voice === 'string' && voice.trim().length > 0 ? voice.trim() : 'longanhuan_v3',
      format: 'mp3',
      sample_rate: 24000
    }
  };
  const json = await postJson(
    `${hostOf(workspaceId)}/api/v1/services/audio/tts/SpeechSynthesizer`,
    apiKey.trim(),
    body
  );
  const audioUrl = json?.output?.audio?.url;
  if (typeof audioUrl !== 'string' || audioUrl.length === 0) {
    throw new Error('百炼没有返回语音 URL');
  }
  return download(audioUrl);
}

export function saveMedia(root, buffer, extension) {
  const dir = mediaDir(root);
  const id = `m_${randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(dir, id), buffer);
  return id;
}
