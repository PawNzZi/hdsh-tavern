import assert from 'node:assert/strict';
import { detectMediaIntent } from '../lib/media-intent.js';

// explicit：明确要求
{
  const image = detectMediaIntent({ userText: '给我发张自拍看看', mode: 'explicit' });
  assert.equal(image.image, true);
  assert.equal(image.voice, false);

  const voice = detectMediaIntent({ userText: '想听听你的声音', mode: 'explicit' });
  assert.equal(voice.voice, true);
  assert.equal(voice.image, false);
}

// auto：自然表达
{
  const image = detectMediaIntent({ userText: '你现在长什么样呀', mode: 'auto' });
  assert.equal(image.image, true);
  assert.ok(image.reasons.includes('user-image'));

  const sceneImage = detectMediaIntent({ userText: '今天穿什么', mode: 'auto' });
  assert.equal(sceneImage.image, true);
  assert.ok(sceneImage.reasons.includes('user-image-auto'));

  const sceneVoice = detectMediaIntent({ userText: '说句话给我听', mode: 'auto' });
  assert.equal(sceneVoice.voice, true);
}

// auto：角色回复叙述“发来一张照片/一段语音”
{
  const image = detectMediaIntent({ userText: '在干嘛', replyText: '（她发来一张照片）在咖啡店。', mode: 'auto' });
  assert.equal(image.image, true);
  assert.ok(image.reasons.includes('reply-image-narration'));

  const voice = detectMediaIntent({ userText: '晚安', replyText: '她发来一段语音：“晚安。”', mode: 'auto' });
  assert.equal(voice.voice, true);
  assert.ok(voice.reasons.includes('reply-voice-narration'));
}

// explicit 模式不根据回复叙述自动发
{
  const result = detectMediaIntent({ userText: '在干嘛', replyText: '她发来一张照片。', mode: 'explicit' });
  assert.equal(result.image, false);
}

// off：只认标签，不由文本触发
{
  const result = detectMediaIntent({ userText: '发张自拍', replyText: '她发来一张照片。', mode: 'off' });
  assert.equal(result.image, false);
  assert.equal(result.voice, false);
}

// 否定句不触发
{
  const image = detectMediaIntent({ userText: '不要发照片', mode: 'auto' });
  assert.equal(image.image, false);
  const voice = detectMediaIntent({ userText: '别发语音了', mode: 'auto' });
  assert.equal(voice.voice, false);
}

// 过去式/评价句不触发
{
  const image = detectMediaIntent({ userText: '你发来的照片很好看', mode: 'auto' });
  assert.equal(image.image, false);
  const voice = detectMediaIntent({ userText: '你发的语音很好听', mode: 'auto' });
  assert.equal(voice.voice, false);
}

console.log('dsh-tavern media intent ok');
